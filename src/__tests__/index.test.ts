import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../index.js'

const fixture = (name: string) => new URL(`./fixtures/${name}.ts`, import.meta.url).pathname

function createHarness(extension: string, options: { strict?: boolean } = {}) {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const commands = new Map<string, { description?: string; handler(invocation: unknown): Promise<unknown> }>()
  const tools = new Set<string>()
  const throwingToolRegistrations = new Set<string>()
  const throwingToolDisposals = new Set<string>()
  const toolDefinitions = new Map<string, { name: string; description: string; parameters: unknown }>()
  let cleanup: (() => Promise<void>) | undefined
  const sessionMessages: unknown[] = []
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const inbox = { hasPending: false }
  const ctx = {
    logger,
    on: (event: string, handler: (...args: never[]) => unknown) => { handlers.set(event, handler) },
    effect: (factory: () => () => Promise<void>) => { cleanup = factory() },
  }
  const agent = {
    id: 'agent-1', status: 'idle', options: {}, inbox, cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    send: vi.fn(), followup: vi.fn(() => { inbox.hasPending = true }), steer: vi.fn(), inject: vi.fn(),
    session: { header: { cwd: '/workspace' }, deriveMessages: () => sessionMessages },
    ctx: {
      tools: { register: (tool: { name: string }) => {
        if (throwingToolRegistrations.has(tool.name)) throw new Error('registration secret')
        tools.add(tool.name)
        toolDefinitions.set(tool.name, tool as never)
        return () => {
          tools.delete(tool.name)
          if (toolDefinitions.get(tool.name) === tool) toolDefinitions.delete(tool.name)
          if (throwingToolDisposals.has(tool.name)) throw new Error('disposer secret')
        }
      } },
      commands: { register: (command: { name: string; description?: string; handler(invocation: unknown): Promise<unknown> }) => {
        commands.set(command.name, command)
        return () => { commands.delete(command.name) }
      } },
      systemPrompt: { section: () => () => {} },
      attachments: {
        saveImage: vi.fn(async (input: { data: Uint8Array; mediaType: string }) => ({
          attachmentId: 'saved-image', mediaType: input.mediaType,
          bytes: input.data.byteLength, width: 1, height: 1,
        })),
        readImage: vi.fn(async (ref: unknown) => ({ ref, data: Uint8Array.from([1, 2, 3]) })),
      },
    },
  }
  apply(ctx as never, {
    extensions: [extension], projectTrusted: false, allowLocalPaths: true,
    strict: options.strict ?? true, flags: {},
  })
  const enterStep = async (turn = 1, step = 1, downstreamExtra: unknown[] = [], claimed?: unknown[]) => {
    const messages = claimed ?? [createUserMessage({
      content: [{ type: 'text', text: 'hello' }], source: { kind: 'plugin', plugin: 'test' },
    })]
    return handlers.get('agent/pre-step')?.(
      { agent, messages, turn, step, signal: new AbortController().signal } as never,
      (() => Promise.resolve({ kind: 'enter', messages: [...messages, ...downstreamExtra] })) as never,
    )
  }
  return {
    agent, commands, enterStep, handlers, logger, sessionMessages, tools, toolDefinitions,
    throwingToolDisposals, throwingToolRegistrations, cleanup: () => cleanup?.(),
  }
}

describe('dsh-pi plugin', () => {
  it('does not wake an idle agent for non-triggering Pi messages', async () => {
    const harness = createHarness(fixture('delivery'))
    await harness.enterStep()
    await new Promise(resolve => setImmediate(resolve))

    expect(harness.agent.inject).toHaveBeenCalledTimes(1)
    expect(harness.agent.send).toHaveBeenCalledWith(expect.anything(), 'next-turn', false)
    expect(harness.agent.followup).toHaveBeenCalledTimes(1)
    expect(harness.agent.steer).not.toHaveBeenCalled()
    await harness.cleanup()
  })

  it('drains session-start Pi message delivery before the first DSH step', async () => {
    const harness = createHarness(fixture('delivery-image'))
    let release: (() => void) | undefined
    harness.agent.ctx.attachments.saveImage.mockImplementation(async (input) => {
      await new Promise<void>(resolve => { release = resolve })
      return {
        attachmentId: 'delayed-image', mediaType: input.mediaType,
        bytes: input.data.byteLength, width: 1, height: 1,
      }
    })

    let settled = false
    const step = Promise.resolve(harness.enterStep()).then(() => { settled = true })
    await vi.waitFor(() => expect(harness.agent.ctx.attachments.saveImage).toHaveBeenCalledOnce())

    expect(settled).toBe(false)
    expect(harness.agent.inject).not.toHaveBeenCalled()
    release?.()
    await step
    expect(harness.agent.inject).toHaveBeenCalledOnce()
    await harness.cleanup()
  })

  it('does not expose attachment persistence errors from Pi message delivery', async () => {
    const harness = createHarness(fixture('delivery-image'))
    harness.agent.ctx.attachments.saveImage.mockRejectedValue(new Error('secret persistence path'))

    await harness.enterStep()

    expect(harness.agent.inject).not.toHaveBeenCalled()
    expect(harness.logger.warn).toHaveBeenCalledWith('dsh-pi: Pi message delivery failed')
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain('secret persistence path')
    await harness.cleanup()
  })

  it('suppresses Pi messages requested after runtime disposal begins', async () => {
    const harness = createHarness(fixture('shutdown-delivery'))
    await harness.enterStep()

    harness.handlers.get('agent/disposed')?.({ agent: harness.agent } as never)
    await harness.cleanup()

    expect(harness.agent.inject).not.toHaveBeenCalled()
    expect(harness.agent.followup).not.toHaveBeenCalled()
    expect(harness.agent.steer).not.toHaveBeenCalled()
  })

  it('transforms only claimed input and preserves downstream DSH context', async () => {
    delete (globalThis as { __piInputText?: string }).__piInputText
    const harness = createHarness(fixture('input-transform'))
    const runtimeContext = createUserMessage({
      content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'plugin', plugin: 'dsh-system-prompt' },
    })

    const decision = await harness.enterStep(1, 1, [runtimeContext]) as {
      kind: 'enter'
      messages: Array<{ content: Array<{ type: string; text?: string }> }>
    }

    expect((globalThis as { __piInputText?: string }).__piInputText).toBe('hello')
    expect(decision.messages.map(message => message.content[0]?.text)).toEqual(['HELLO', 'runtime context'])
    delete (globalThis as { __piInputText?: string }).__piInputText
    await harness.cleanup()
  })

  it('passes claimed DSH images through the Pi input transform', async () => {
    const state = globalThis as { __piInputImages?: unknown }
    delete state.__piInputImages
    const harness = createHarness(fixture('input-transform'))
    const attachment = {
      attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }
    const claimed = createUserMessage({
      content: [
        { type: 'text', text: 'image prompt' },
        { type: 'image', attachment },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    } as never)

    const decision = await harness.enterStep(1, 1, [], [claimed]) as {
      kind: 'enter'
      messages: Array<{ content: Array<{ type: string; text?: string; attachment?: unknown }> }>
    }

    expect(state.__piInputImages).toEqual([
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
    ])
    expect(decision.messages[0]?.content).toEqual([
      { type: 'text', text: 'IMAGE PROMPT' },
      { type: 'image', attachment: {
        attachmentId: 'saved-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
      } },
    ])
    delete state.__piInputImages
    await harness.cleanup()
  })

  it('sanitizes DSH attachment read failures at the Pi input boundary', async () => {
    const harness = createHarness(fixture('input-transform'))
    harness.agent.ctx.attachments.readImage.mockRejectedValue(new Error('secret attachment path'))
    const claimed = createUserMessage({
      content: [{
        type: 'image',
        attachment: { attachmentId: 'secret', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
      }],
      source: { kind: 'plugin', plugin: 'test' },
    } as never)

    await expect(harness.enterStep(1, 1, [], [claimed]))
      .rejects.toThrow('Failed to read DSH input image')
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain('secret attachment path')
    await harness.cleanup()
  })

  it('sanitizes DSH attachment persistence failures from Pi input transforms', async () => {
    const harness = createHarness(fixture('input-transform'))
    harness.agent.ctx.attachments.saveImage.mockRejectedValue(new Error('/private/token=secret'))
    const claimed = createUserMessage({
      content: [
        { type: 'text', text: 'image prompt' },
        {
          type: 'image',
          attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
        },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    } as never)

    const step = Promise.resolve(harness.enterStep(1, 1, [], [claimed]))
    await expect(step).rejects.toThrow('Failed to persist Pi image attachment')
    await expect(step).rejects.not.toThrow('/private/token=secret')
    await harness.cleanup()
  })

  it('presents the initial claimed DSH message batch as one Pi input', async () => {
    const state = globalThis as { __piInputText?: string }
    delete state.__piInputText
    const harness = createHarness(fixture('input-transform'))
    const claimed = ['first', 'second'].map(text => createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'test' },
    }))

    const decision = await harness.enterStep(1, 1, [], claimed) as {
      kind: 'enter'
      messages: Array<{ content: Array<{ type: string; text?: string }> }>
    }

    expect(state.__piInputText).toBe('first\nsecond')
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0]?.content[0]?.text).toBe('FIRST\nSECOND')
    delete state.__piInputText
    await harness.cleanup()
  })

  it('returns Pi command notifications as DSH command text', async () => {
    const harness = createHarness(fixture('command'))
    await harness.enterStep()

    const result = await harness.commands.get('notify')?.handler({
      rawInput: '', signal: new AbortController().signal,
    })

    expect(result).toEqual({ kind: 'success', text: 'command complete' })
    await harness.cleanup()
  })

  it('maps Pi command waitForIdle to DSH agent settlement', async () => {
    const harness = createHarness(fixture('command'))
    await harness.enterStep()

    const result = await harness.commands.get('wait')?.handler({
      rawInput: '', signal: new AbortController().signal,
    })

    expect(harness.agent.whenIdle).toHaveBeenCalledOnce()
    expect(result).toEqual({ kind: 'success', text: 'agent idle' })
    await harness.cleanup()
  })

  it('remounts a Pi tool when its same-name definition changes', async () => {
    const harness = createHarness(fixture('dynamic'))

    await harness.enterStep()

    expect(harness.toolDefinitions.get('dynamic')).toMatchObject({
      description: 'Updated definition',
      parameters: { type: 'object', properties: { count: { type: 'number' } } },
    })
    await harness.cleanup()
  })

  it('mounts a new Pi tool registered after startup', async () => {
    const harness = createHarness(fixture('dynamic'))

    await harness.enterStep()

    expect(harness.tools).toContain('late-tool')
    await harness.cleanup()
  })

  it('mounts commands registered by a Pi lifecycle handler', async () => {
    const harness = createHarness(fixture('dynamic'))

    await harness.enterStep()

    const result = await harness.commands.get('late')?.handler({
      rawInput: '', signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'success', text: 'late command' })
    await harness.cleanup()
  })

  it('remounts a Pi command when its same-name definition changes', async () => {
    const harness = createHarness(fixture('dynamic'))

    await harness.enterStep()

    const command = harness.commands.get('replaceable')
    expect(command?.description).toBe('Updated command')
    await expect(command?.handler({ rawInput: '', signal: new AbortController().signal }))
      .resolves.toEqual({ kind: 'success', text: 'updated command' })
    await harness.cleanup()
  })

  it('maps one Pi agent run across paired DSH step turns', async () => {
    const events: string[] = []
    ;(globalThis as { __piLifecycleEvents?: string[] }).__piLifecycleEvents = events
    const harness = createHarness(fixture('lifecycle'))

    await harness.enterStep(1, 1)
    harness.sessionMessages.push({
      role: 'assistant', content: [{ type: 'text', text: 'tool call' }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    })
    await harness.enterStep(1, 2)
    await harness.handlers.get('agent/turn-stopping')?.({
      agent: harness.agent, turn: 1, signal: new AbortController().signal,
    } as never)
    expect(events).not.toContain('agent_end')
    harness.sessionMessages.push({
      role: 'assistant', content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    })
    await harness.handlers.get('session/event')?.(harness.agent.session as never, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    } as never)

    expect(events).toEqual([
      'input:hello', 'before_agent_start', 'agent_start',
      'turn_start:0', 'turn_end:0', 'turn_start:1', 'turn_end:1', 'agent_end', 'agent_settled',
    ])
    delete (globalThis as { __piLifecycleEvents?: string[] }).__piLifecycleEvents
    await harness.cleanup()
  })

  it('pairs the final Pi turn and agent end on a DSH error boundary', async () => {
    const events: string[] = []
    ;(globalThis as { __piLifecycleEvents?: string[] }).__piLifecycleEvents = events
    const harness = createHarness(fixture('lifecycle'))

    await harness.enterStep(1, 1)
    await harness.handlers.get('agent/error')?.({
      agent: harness.agent, turn: 1, step: 1, error: new Error('provider secret'),
    } as never)
    await harness.handlers.get('session/event')?.(harness.agent.session as never, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'provider secret', code: 'UNKNOWN' } } },
    } as never)

    expect(events).toEqual([
      'input:hello', 'before_agent_start', 'agent_start',
      'turn_start:0', 'turn_end:0', 'agent_end', 'agent_settled',
    ])
    delete (globalThis as { __piLifecycleEvents?: string[] }).__piLifecycleEvents
    await harness.cleanup()
  })

  it('drains agent-end delivery before deciding whether the agent settled', async () => {
    const state = globalThis as { __piTerminalDeliveryEvents?: string[] }
    state.__piTerminalDeliveryEvents = []
    const harness = createHarness(fixture('terminal-delivery'))
    let release: (() => void) | undefined
    harness.agent.ctx.attachments.saveImage.mockImplementation(async (input) => {
      await new Promise<void>(resolve => { release = resolve })
      return {
        attachmentId: 'terminal-image', mediaType: input.mediaType,
        bytes: input.data.byteLength, width: 1, height: 1,
      }
    })
    await harness.enterStep()

    const terminal = Promise.resolve(harness.handlers.get('session/event')?.(harness.agent.session as never, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    } as never))
    await vi.waitFor(() => expect(harness.agent.ctx.attachments.saveImage).toHaveBeenCalledOnce())

    expect(state.__piTerminalDeliveryEvents).toEqual(['agent_end'])
    release?.()
    await terminal
    expect(harness.agent.followup).toHaveBeenCalledOnce()
    expect(state.__piTerminalDeliveryEvents).toEqual(['agent_end'])
    delete state.__piTerminalDeliveryEvents
    await harness.cleanup()
  })

  it('pairs a Pi turn when strict reconciliation fails after turn_start', async () => {
    const state = globalThis as { __piInvalidTurnEvents?: string[] }
    state.__piInvalidTurnEvents = []
    const harness = createHarness(fixture('turn-invalid'))

    await expect(harness.enterStep()).rejects.toThrow(/minLength/)
    harness.handlers.get('session/event')?.(harness.agent.session as never, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'adapter failure', code: 'UNKNOWN' } } },
    } as never)
    await vi.waitFor(() => expect(state.__piInvalidTurnEvents).toContain('agent_end'))

    expect(state.__piInvalidTurnEvents).toEqual(['turn_start', 'turn_end', 'agent_end'])
    delete state.__piInvalidTurnEvents
    await harness.cleanup()
  })

  it('drains an in-progress Pi session shutdown during plugin teardown', async () => {
    const state = globalThis as {
      __piShutdownEvents?: string[]
      __releasePiShutdown?: () => void
    }
    state.__piShutdownEvents = []
    const harness = createHarness(fixture('shutdown'))
    await harness.enterStep()

    harness.handlers.get('agent/disposed')?.({ agent: harness.agent } as never)
    const cleanup = harness.cleanup()
    if (cleanup === undefined) throw new Error('plugin cleanup was not registered')
    let settled = false
    void cleanup.then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))

    expect(state.__piShutdownEvents).toEqual(['start'])
    expect(settled).toBe(false)
    state.__releasePiShutdown?.()
    await cleanup
    expect(state.__piShutdownEvents).toEqual(['start', 'end'])
    delete state.__piShutdownEvents
    delete state.__releasePiShutdown
  })

  it('does not remount Pi tools registered during session shutdown', async () => {
    const harness = createHarness(fixture('shutdown-register'))
    await harness.enterStep()
    expect([...harness.tools]).toEqual(['initial'])

    harness.handlers.get('agent/disposed')?.({ agent: harness.agent } as never)
    await harness.cleanup()

    expect([...harness.tools]).toEqual([])
  })

  it('continues teardown when one DSH registration disposer throws', async () => {
    const state = globalThis as { __piDisposeShutdown?: boolean }
    delete state.__piDisposeShutdown
    const harness = createHarness(fixture('dispose-tools'))
    harness.throwingToolDisposals.add('first')
    await harness.enterStep()

    harness.handlers.get('agent/disposed')?.({ agent: harness.agent } as never)
    await harness.cleanup()

    expect([...harness.tools]).toEqual([])
    expect(state.__piDisposeShutdown).toBe(true)
    delete state.__piDisposeShutdown
  })

  it('rolls back a Pi runtime when strict mounting fails', async () => {
    const state = globalThis as { __piMountEvents?: string[] }
    state.__piMountEvents = []
    const harness = createHarness(fixture('mount-failing'))

    await expect(harness.enterStep()).rejects.toThrow(/minLength/)

    expect(state.__piMountEvents).toEqual(['start', 'shutdown'])
    expect([...harness.tools]).toEqual([])
    delete state.__piMountEvents
    await harness.cleanup()
  })

  it('reports a strict-false skipped tool once and excludes it from Pi active tools', async () => {
    const harness = createHarness(fixture('strict-skipped'), { strict: false })

    await harness.enterStep(1, 1)
    await harness.enterStep(1, 2)
    const active = await harness.commands.get('active')?.handler({
      rawInput: '', signal: new AbortController().signal,
    })

    expect(active).toEqual({ kind: 'success', text: 'none' })
    expect(harness.logger.warn.mock.calls.filter(call => String(call[0]).includes('skipped Pi tool')))
      .toHaveLength(1)
    await harness.cleanup()
  })

  it('does not expose extension loader exception text', async () => {
    const harness = createHarness(fixture('load-failing'))

    await expect(harness.enterStep()).rejects.toThrow('Failed to load selected Pi extensions')
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain('secret loader configuration')
    await harness.cleanup()
  })

  it('does not expose DSH registration exception text', async () => {
    const harness = createHarness(fixture('full'))
    harness.throwingToolRegistrations.add('echo')

    await expect(harness.enterStep()).rejects.toThrow('Failed to synchronize Pi tool "echo" with DSH')
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain('registration secret')
    await harness.cleanup()
  })

  it('drains fire-and-forget DSH session events before session shutdown', async () => {
    const state = globalThis as { __piSettlingEvents?: string[]; __releasePiSettling?: () => void }
    state.__piSettlingEvents = []
    const harness = createHarness(fixture('settling'))
    await harness.enterStep()

    harness.handlers.get('session/event')?.(harness.agent.session as never, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    } as never)
    harness.handlers.get('agent/disposed')?.({ agent: harness.agent } as never)
    const cleanup = harness.cleanup()
    await vi.waitFor(() => expect(state.__piSettlingEvents).toEqual(['turn:start']))

    expect(state.__piSettlingEvents).toEqual(['turn:start'])
    state.__releasePiSettling?.()
    await cleanup
    expect(state.__piSettlingEvents).toEqual(['turn:start', 'turn:end', 'shutdown'])
    delete state.__piSettlingEvents
    delete state.__releasePiSettling
  })
})
