import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Buffer } from 'node:buffer'
import type { Agent, PreStepDecision, SessionStartSource } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ExtensionEvent, ResolvedCommand } from '@earendil-works/pi-coding-agent'
import { createDshToolDefinition, piContentToDsh } from './dsh-adapter.js'
import { resolveExtensionEntries } from './resolver.js'
import { PiExtensionRuntime } from './runtime.js'

export { inventoryWorkspace } from './compatibility.js'
export {
  extensionApiCapabilities,
  extensionContextCapabilities,
  extensionEventCapabilities,
} from './capabilities.js'
export { createDshToolDefinition } from './dsh-adapter.js'
export { resolveExtensionEntries } from './resolver.js'
export { PiExtensionRuntime } from './runtime.js'
export { toDshParameters } from './schema.js'

export const name = 'dsh-pi'
export const inject = ['agents', 'tools', 'commands', 'systemPrompt', 'attachments']

export interface Config {
  /** Installed Pi package names, or local package/entry paths when allowLocalPaths is enabled. */
  extensions: string[]
  /** Explicit trust gate for project-local Pi settings and policies. */
  projectTrusted?: boolean
  /** Required before an absolute/relative path may execute as trusted extension code. */
  allowLocalPaths?: boolean
  /** Fail agent composition when a Pi schema/command cannot be represented exactly enough. */
  strict?: boolean
  /** Pi extension flag values. */
  flags?: Record<string, boolean | string>
}

export const Config: z<Config> = z.object({
  extensions: z.array(z.string()).default([]),
  projectTrusted: z.boolean().default(false),
  allowLocalPaths: z.boolean().default(false),
  strict: z.boolean().default(true),
  flags: z.dict(z.union([z.boolean(), z.string()])).default({}),
})

interface MountedRuntime {
  runtime: PiExtensionRuntime
  reconcile(): void
  drainDeliveries(): Promise<void>
  dispose(): Promise<void>
  lastTurn?: number
  openTurn?: { piTurnIndex: number; assistantCount: number }
  settling?: Promise<void>
}

type PiContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

function sourceReason(source: SessionStartSource): 'startup' | 'resume' | 'new' | 'reload' {
  if (source === 'resume') return 'resume'
  if (source === 'clear') return 'new'
  if (source === 'compact') return 'reload'
  return 'startup'
}

function messageText(messages: readonly UserMessage[]): string {
  return messages.flatMap(message => message.content)
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

async function messageImages(
  messages: readonly UserMessage[],
  attachments: AttachmentStore,
  signal?: AbortSignal,
): Promise<Extract<PiContent, { type: 'image' }>[]> {
  const refs = messages.flatMap(message => message.content)
    .filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
    .map(block => block.attachment)
  return Promise.all(refs.map(async ref => {
    try {
      const stored = await attachments.readImage(ref, signal)
      return { type: 'image' as const, data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mediaType }
    } catch (error) {
      if (signal?.aborted === true
        && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))) throw error
      throw new Error('Failed to read DSH input image')
    }
  }))
}

function asPiMessages(agent: Agent): unknown[] {
  return agent.session.deriveMessages().flatMap((message) => {
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => ({ type: 'text', text: block.text }))
    if (message.role === 'user') {
      return [{ role: 'user', content: text, timestamp: Date.now() }]
    }
    if (message.role === 'assistant' && message.source.kind === 'model') {
      return [{
        role: 'assistant', content: text,
        api: 'openai-completions', provider: message.source.provider, model: message.source.model,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop', timestamp: Date.now(),
      }]
    }
    return []
  })
}

function piStopReason(reason: TurnEndReason | undefined): 'stop' | 'length' | 'error' | 'aborted' {
  if (reason?.kind === 'max-tokens') return 'length'
  if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') return 'aborted'
  if (reason?.kind === 'error') return 'error'
  return 'stop'
}

function syntheticPiAssistant(reason: TurnEndReason | undefined): unknown {
  return {
    role: 'assistant', content: [], api: 'openai-completions', provider: 'dsh', model: 'dsh',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: piStopReason(reason),
    ...(reason?.kind === 'error' ? { errorMessage: 'DSH agent turn failed' } : {}),
    timestamp: Date.now(),
  }
}

async function endPiTurn(
  mounted: MountedRuntime,
  agent: Agent,
  signal?: AbortSignal,
  reason?: TurnEndReason,
): Promise<{ message: unknown; usedExisting: boolean } | undefined> {
  const open = mounted.openTurn
  if (open === undefined) return
  delete mounted.openTurn
  const messages = asPiMessages(agent)
  const assistants = messages.filter(message => (message as { role?: string }).role === 'assistant')
  const usedExisting = assistants.length > open.assistantCount
  const last = usedExisting ? assistants.at(-1)! : syntheticPiAssistant(reason)
  const message = reason === undefined ? last : { ...(last as object), stopReason: piStopReason(reason) }
  await mounted.runtime.emit({
    type: 'turn_end', turnIndex: open.piTurnIndex, message, toolResults: [],
  } as unknown as ExtensionEvent, signal)
  return { message, usedExisting }
}

async function piMessageContent(
  content: string | PiContent[],
  attachments: AttachmentStore,
): Promise<ContentBlock[]> {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return piContentToDsh(
    content,
    input => attachments.saveImage(input),
    attachments.imageLimits,
  )
}

function deliverUserMessage(agent: Agent, message: UserMessage, mode: 'steer' | 'followUp' | undefined): void {
  if (agent.status === 'running' && mode !== 'followUp') agent.steer(message)
  else agent.followup(message)
}

function deliverCustomMessage(
  agent: Agent,
  message: UserMessage,
  options: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' } | undefined,
): void {
  if (options?.deliverAs === 'nextTurn') {
    agent.send(message, 'next-turn', false)
  } else if (agent.status === 'idle' && options?.triggerTurn !== true) {
    agent.inject(message)
  } else if (agent.status === 'running' && options?.deliverAs !== 'followUp') {
    agent.steer(message)
  } else {
    agent.followup(message)
  }
}

function dshSyncError(kind: 'tool' | 'command', name: string): Error {
  return new Error(`Failed to synchronize Pi ${kind} "${name}" with DSH`)
}

async function mountAgent(ctx: Context, agent: Agent, config: Config, reason: SessionStartSource): Promise<MountedRuntime> {
  const entries = await resolveExtensionEntries(config.extensions, {
    cwd: agent.session.header.cwd ?? process.cwd(),
    ...(ctx.baseUrl === undefined ? {} : { baseUrl: ctx.baseUrl }),
    allowLocalPaths: config.allowLocalPaths ?? false,
  })
  let mounted: MountedRuntime | undefined
  let disposing = false
  let deliveries = Promise.resolve()
  let warnedProvider = false
  const queueDelivery = (
    content: string | PiContent[],
    deliver: (blocks: ContentBlock[]) => void,
  ): void => {
    deliveries = deliveries.then(async () => {
      if (disposing) return
      try {
        const blocks = await piMessageContent(content, ctx.attachments)
        if (!disposing) deliver(blocks)
      } catch {
        ctx.logger.warn(`${name}: Pi message delivery failed`)
      }
    })
  }
  const runtime = await PiExtensionRuntime.fromPaths(entries, {
    cwd: agent.session.header.cwd ?? process.cwd(),
    projectTrusted: config.projectTrusted ?? false,
    ...(config.flags === undefined ? {} : { flags: config.flags }),
    bridge: {
      reportError: context => { ctx.logger.error(`${name}: ${context}`) },
      refreshTools: () => { if (!disposing) mounted?.reconcile() },
      isIdle: () => agent.status === 'idle',
      waitForIdle: () => agent.whenIdle(),
      hasPendingMessages: () => agent.inbox.hasPending,
      abort: () => { agent.cancel({ kind: 'hook', reason: 'Pi extension requested abort' }) },
      shutdown: () => { agent.cancel({ kind: 'hook', reason: 'Pi extension requested shutdown' }) },
      sendUserMessage: (content, options) => {
        const delivery = options as { deliverAs?: 'steer' | 'followUp' } | undefined
        queueDelivery(content as string | PiContent[], blocks => {
          deliverUserMessage(agent, createUserMessage({ content: blocks, source: { kind: 'plugin', plugin: name } }), delivery?.deliverAs)
        })
      },
      sendMessage: (message, options) => {
        const custom = message as { content: string | PiContent[] }
        const delivery = options as { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' } | undefined
        queueDelivery(custom.content, blocks => {
          const user = createUserMessage({ content: blocks, source: { kind: 'plugin', plugin: name } })
          deliverCustomMessage(agent, user, delivery)
        })
      },
      setModel: (model) => {
        const selected = model as { provider?: string; id?: string }
        if (selected.provider === undefined || selected.id === undefined) return false
        agent.options.provider = selected.provider
        agent.options.model = selected.id
        return true
      },
      registerProvider: () => {
        if (warnedProvider) return
        warnedProvider = true
        ctx.logger.warn(`${name}: Pi registerProvider is recorded but cannot create a DSH adapter; configure @deepseek-ai/dsh-llm-pi-ai separately`)
      },
    },
  })
  let commandContext: Context | undefined
  const commandFiber = agent.ctx.inject(['commands'], scoped => { commandContext = scoped })
  await commandFiber
  if (commandContext === undefined) throw new Error('Failed to create the Pi command scope')
  const scopedCommands = commandContext.commands

  const toolEffects = new Map<string, { definition: object; dispose: () => void }>()
  const skippedToolDefinitions = new Map<string, object>()
  const commandEffects = new Map<string, { command: ResolvedCommand; dispose: () => void }>()
  const promptEffects = new Map<string, () => void>()
  const reconcile = (): void => {
    const active = new Set(runtime.requestedActiveToolNames())
    const requestedTools = new Map(runtime.tools().filter(tool => active.has(tool.name)).map(tool => [tool.name, tool]))
    for (const [toolName, definition] of skippedToolDefinitions) {
      if (requestedTools.get(toolName) === definition) continue
      skippedToolDefinitions.delete(toolName)
      runtime.clearToolUnavailable(toolName)
    }
    const currentTools = new Map([...requestedTools].filter(([toolName, definition]) => (
      skippedToolDefinitions.get(toolName) !== definition
    )))
    for (const [toolName, mountedTool] of toolEffects) {
      if (currentTools.get(toolName) === mountedTool.definition) continue
      try {
        mountedTool.dispose()
        promptEffects.get(toolName)?.()
      } catch {
        throw dshSyncError('tool', toolName)
      } finally {
        toolEffects.delete(toolName)
        promptEffects.delete(toolName)
      }
    }
    for (const [toolName, tool] of currentTools) {
      if (toolEffects.has(toolName)) continue
      let definition
      try {
        definition = createDshToolDefinition({
          tool,
          execute: async (args, execution) => {
            try {
              return await runtime.executeTool(toolName, args, execution)
            } finally {
              await mounted?.drainDeliveries()
            }
          },
          saveImage: input => ctx.attachments.saveImage(input),
          imageLimits: ctx.attachments.imageLimits,
        })
      } catch (error) {
        if (config.strict ?? true) throw error
        skippedToolDefinitions.set(toolName, tool)
        runtime.markToolUnavailable(toolName, tool)
        ctx.logger.warn(`${name}: skipped Pi tool "${toolName}": ${String(error)}`)
        continue
      }
      const guidance = [tool.promptSnippet, ...(tool.promptGuidelines ?? [])].filter(Boolean).join('\n- ')
      let disposePrompt: (() => void) | undefined
      try {
        if (guidance.length > 0) {
          disposePrompt = agent.ctx.systemPrompt.section({
            name: `pi-tool:${toolName}`,
            order: 150,
            text: `Pi tool \`${toolName}\`:\n- ${guidance}`,
          })
        }
        const disposeTool = agent.ctx.tools.register(definition)
        toolEffects.set(toolName, { definition: tool, dispose: disposeTool })
        if (disposePrompt !== undefined) promptEffects.set(toolName, disposePrompt)
        runtime.clearToolUnavailable(toolName)
      } catch {
        try { disposePrompt?.() } catch {}
        const error = dshSyncError('tool', toolName)
        if (config.strict ?? true) throw error
        skippedToolDefinitions.set(toolName, tool)
        runtime.markToolUnavailable(toolName, tool)
        ctx.logger.warn(`${name}: skipped Pi tool "${toolName}": ${error.message}`)
      }
    }
    const currentCommands = new Map(runtime.commands().map(command => [command.invocationName, command]))
    for (const [commandName, mountedCommand] of commandEffects) {
      const current = currentCommands.get(commandName)
      if (current?.handler === mountedCommand.command.handler
        && current.description === mountedCommand.command.description
        && current.getArgumentCompletions === mountedCommand.command.getArgumentCompletions) continue
      try {
        mountedCommand.dispose()
      } catch {
        throw dshSyncError('command', commandName)
      } finally {
        commandEffects.delete(commandName)
      }
    }
    for (const [commandName, command] of currentCommands) {
      if (commandEffects.has(commandName)) continue
      try {
        const dispose = scopedCommands.register({
          name: commandName,
          description: command.description?.trim() || `Run Pi command /${commandName}`,
          input: { hint: '<args>' },
          async handler(invocation: CommandInvocation) {
            let notifications
            try {
              notifications = await runtime.executeCommand(commandName, invocation.rawInput.trimStart(), invocation.signal)
            } finally {
              await mounted?.drainDeliveries()
            }
            const text = notifications.map(item => item.message).join('\n')
            return { kind: 'success', ...(text.length === 0 ? {} : { text }) }
          },
        })
        commandEffects.set(commandName, { command, dispose })
      } catch {
        const error = dshSyncError('command', commandName)
        if (config.strict ?? true) throw error
        ctx.logger.warn(`${name}: skipped Pi command "${commandName}": ${error.message}`)
      }
    }
  }
  let disposal: Promise<void> | undefined
  mounted = {
    runtime,
    reconcile,
    drainDeliveries: () => deliveries,
    dispose() {
      if (disposal === undefined) {
        disposing = true
        disposal = (async () => {
          await deliveries
          if (mounted?.settling !== undefined) await Promise.allSettled([mounted.settling])
          const registrations = [
            ...[...toolEffects.values()].map(effect => effect.dispose),
            ...[...commandEffects.values()].map(effect => effect.dispose),
            ...promptEffects.values(),
          ]
          const disposed = await Promise.allSettled(registrations.map(async dispose => { dispose() }))
          try {
            await runtime.shutdown()
          } catch {
            ctx.logger.warn(`${name}: Pi runtime shutdown failed`)
          }
          await deliveries
          if (disposed.some(result => result.status === 'rejected')) {
            ctx.logger.warn(`${name}: one or more DSH registrations failed to dispose`)
          }
          await commandFiber.dispose()
        })()
      }
      return disposal
    },
  }
  try {
    await runtime.start(sourceReason(reason))
    await mounted.drainDeliveries()
    reconcile()
    return mounted
  } catch (error) {
    await mounted.dispose()
    throw error
  }
}

export function apply(ctx: Context, config: Config): void {
  if (config.extensions.length === 0) {
    ctx.logger.info(`${name}: no Pi extensions configured`)
    return
  }
  const runtimes = new WeakMap<Agent, Promise<MountedRuntime>>()
  const sessions = new WeakMap<object, { agent: Agent; pending: Promise<MountedRuntime> }>()
  const live = new Set<Promise<MountedRuntime>>()
  const ready = new WeakSet<Agent>()

  const ensure = (agent: Agent, reason: SessionStartSource = 'startup'): Promise<MountedRuntime> => {
    const existing = runtimes.get(agent)
    if (existing !== undefined) {
      if (reason !== 'startup') void existing.then(item => item.runtime.start(sourceReason(reason)))
      return existing
    }
    const pending = mountAgent(ctx, agent, config, reason).then((mounted) => {
      ready.add(agent)
      return mounted
    })
    runtimes.set(agent, pending)
    sessions.set(agent.session, { agent, pending })
    live.add(pending)
    void pending.catch(error => ctx.logger.error(`${name}: agent ${String(agent.id)} failed: ${String(error)}`))
    return pending
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    if (agent === undefined || ready.has(agent)) return next()
    await ensure(agent)
    return ctx.systemPrompt.assemble(context)
  })
  ctx.on('agent/session-start', ({ agent, source }) => { void ensure(agent, source) })
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
    const mounted = await ensure(agent)
    await mounted.settling
    await mounted.drainDeliveries()
    const downstream = await next()
    if (downstream.kind === 'reject') return downstream
    let entered = downstream.messages
    if (mounted.lastTurn !== turn) {
      let prompt = messageText(messages)
      let images = await messageImages(messages, ctx.attachments, signal)
      const input = await mounted.runtime.emit({
        type: 'input', text: prompt, source: 'rpc', ...(images.length === 0 ? {} : { images }),
      }, signal) as
        | { action: 'continue' }
        | { action: 'handled' }
        | { action: 'transform'; text: string; images?: Extract<PiContent, { type: 'image' }>[] }
      await mounted.drainDeliveries()
      if (input.action === 'handled') return { kind: 'reject' }
      if (input.action === 'transform') {
        prompt = input.text
        images = input.images ?? images
        const transformed = createUserMessage({
          content: await piMessageContent(images.length === 0
            ? input.text
            : [{ type: 'text', text: input.text }, ...images], ctx.attachments),
          source: { kind: 'plugin', plugin: name },
        })
        const claimedIds = new Set(messages.map(message => message.id))
        let inserted = false
        entered = downstream.messages.flatMap((message) => {
          if (!claimedIds.has(message.id)) return [message]
          if (inserted) return []
          inserted = true
          return [transformed]
        })
        if (!inserted) entered.unshift(transformed)
      }
      await mounted.runtime.emit({
        type: 'before_agent_start', prompt, systemPrompt: '',
        ...(images.length === 0 ? {} : { images }),
        systemPromptOptions: { cwd: agent.session.header.cwd ?? process.cwd() },
      }, signal)
      mounted.lastTurn = turn
      await mounted.runtime.emit({ type: 'agent_start' }, signal)
      await mounted.drainDeliveries()
    }
    await endPiTurn(mounted, agent, signal)
    const piTurnIndex = Math.max(0, step - 1)
    mounted.openTurn = {
      piTurnIndex,
      assistantCount: asPiMessages(agent).filter(message => (message as { role?: string }).role === 'assistant').length,
    }
    await mounted.runtime.emit({ type: 'turn_start', turnIndex: piTurnIndex, timestamp: Date.now() }, signal)
    await mounted.drainDeliveries()
    return { kind: 'enter', messages: entered }
  })
  ctx.on('session/event', async (session, event) => {
    if (event.type !== 'turn/end') return
    const entry = sessions.get(session)
    if (entry === undefined) return
    const mounted = await entry.pending
    if (mounted.lastTurn !== event.data.turn) return
    const settling = (mounted.settling ?? Promise.resolve()).then(async () => {
      let ended: Awaited<ReturnType<typeof endPiTurn>>
      let failed = false
      try {
        ended = await endPiTurn(mounted, entry.agent, undefined, event.data.reason)
      } catch {
        failed = true
      }
      const messages = asPiMessages(entry.agent)
      if (ended !== undefined) {
        const index = messages.findLastIndex(message => (message as { role?: string }).role === 'assistant')
        if (ended.usedExisting && index >= 0) messages[index] = ended.message
        else messages.push(ended.message)
      }
      try {
        await mounted.runtime.emit({ type: 'agent_end', messages } as ExtensionEvent)
      } catch {
        failed = true
      }
      await mounted.drainDeliveries()
      if (!entry.agent.inbox.hasPending) {
        try {
          await mounted.runtime.emit({ type: 'agent_settled' })
        } catch {
          failed = true
        }
      }
      await mounted.drainDeliveries()
      if (failed) ctx.logger.warn(`${name}: Pi terminal lifecycle reconciliation failed`)
    })
    mounted.settling = settling
    try {
      await settling
    } finally {
      if (mounted.settling === settling) delete mounted.settling
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const pending = runtimes.get(agent)
    runtimes.delete(agent)
    sessions.delete(agent.session)
    if (pending === undefined) return
    void pending.then(item => item.dispose()).then(
      () => { live.delete(pending) },
      () => {
        live.delete(pending)
        ctx.logger.warn(`${name}: agent disposal failed`)
      },
    )
  })
  ctx.effect(() => async () => {
    const settled = await Promise.allSettled([...live])
    await Promise.allSettled(settled.flatMap(item => item.status === 'fulfilled' ? [item.value.dispose()] : []))
  }, `${name}: drain Pi extension runtimes`)
}

export default Object.assign(apply, { Config, inject })
