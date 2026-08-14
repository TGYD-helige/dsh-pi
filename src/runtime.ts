import {
  createEventBus,
  ExtensionRunner,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  AgentToolResult,
  ExtensionActions,
  ExtensionContextActions,
  ExtensionEvent,
  ExtensionRuntime,
  LoadExtensionsResult,
  ProviderConfig,
  RegisteredTool,
  ResolvedCommand,
} from '@earendil-works/pi-coding-agent'
import { Value } from 'typebox/value'

export interface RuntimeBridge {
  reportError?(context: string): void
  sendMessage?(message: unknown, options?: unknown): void
  sendUserMessage?(content: unknown, options?: unknown): void
  appendEntry?(type: string, data: unknown): void
  setLabel?(entryId: string, label: string | undefined): void
  setModel?(model: unknown): boolean | Promise<boolean>
  registerProvider?(name: string, config: ProviderConfig): void
  unregisterProvider?(name: string): void
  shutdown?(): void
  abort?(): void
  compact?(options: unknown): void
  refreshTools?(): void
  getSystemPrompt?(): string
  getContextUsage?(): ReturnType<ExtensionContextActions['getContextUsage']>
  hasPendingMessages?(): boolean
  isIdle?(): boolean
  waitForIdle?(): Promise<void>
}

export interface RuntimeOptions {
  cwd: string
  bridge?: RuntimeBridge
  projectTrusted?: boolean
  mode?: 'tui' | 'rpc' | 'json' | 'print'
  flags?: Record<string, boolean | string>
}

export interface ExecuteToolOptions {
  callId: string
  signal?: AbortSignal
  onUpdate?: (result: AgentToolResult<unknown>) => void
}

export interface PiToolExecutionResult extends AgentToolResult<unknown> {
  isError?: boolean
  /** Internal marker: let DSH materialize its canonical cancellation result. */
  aborted?: true
}

export interface CommandNotification {
  message: string
  type?: 'info' | 'warning' | 'error'
}

function unexpectedToolFailure(options: RuntimeOptions, name: string): PiToolExecutionResult {
  options.bridge?.reportError?.(`Pi tool "${name}" execution failed unexpectedly`)
  return {
    content: [{ type: 'text', text: 'Pi tool execution failed unexpectedly' }],
    details: {},
    isError: true,
  }
}

function abortedToolResult(): PiToolExecutionResult {
  return {
    content: [{ type: 'text', text: 'Tool execution aborted' }],
    details: {},
    isError: true,
    aborted: true,
  }
}

function isAbortFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
}

class UnsupportedCommandContextError extends Error {}

function unsupportedCommandContext(name: string): never {
  throw new UnsupportedCommandContextError(`Pi command context ${name} is unsupported by DSH`)
}

interface RuntimeLoad {
  result: LoadExtensionsResult
  runner: ExtensionRunner
  state: RuntimeState
}

interface RuntimeState {
  activeTools: Set<string>
  knownTools: Set<string>
  activeToolsExplicitlySet: boolean
  unavailableTools: Map<string, RegisteredTool['definition']>
  signalStore: AsyncLocalStorage<AbortSignal | undefined>
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  sessionManager: SessionManager
  sessionName?: string
}

async function loadSelectedExtensions(paths: string[], cwd: string): Promise<LoadExtensionsResult> {
  const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  const loader = await import(pathToFileURL(join(dirname(piEntry), 'core/extensions/loader.js')).href) as {
    loadExtensions(paths: string[], cwd: string, eventBus: ReturnType<typeof createEventBus>): Promise<LoadExtensionsResult>
  }
  return loader.loadExtensions(paths, cwd, createEventBus())
}

function modelRegistryFacade(bridge: RuntimeBridge): object {
  const providers = new Map<string, ProviderConfig>()
  return {
    getAll: () => [],
    getAvailable: () => [],
    find: () => undefined,
    hasConfiguredAuth: () => false,
    getApiKeyAndHeaders: async () => ({ ok: false, error: 'No Pi model credentials are exposed by DSH' }),
    getProviderAuthStatus: () => ({ type: 'none' }),
    getProviderDisplayName: (name: string) => name,
    getApiKeyForProvider: async () => undefined,
    isUsingOAuth: () => false,
    registerProvider: (name: string, config: ProviderConfig) => {
      providers.set(name, config)
      bridge.registerProvider?.(name, config)
    },
    unregisterProvider: (name: string) => {
      providers.delete(name)
      bridge.unregisterProvider?.(name)
    },
    getRegisteredProviderConfig: (name: string) => providers.get(name),
    getRegisteredProviderIds: () => [...providers.keys()],
  }
}

function bindActions(
  runtime: ExtensionRuntime,
  options: RuntimeOptions,
  state: RuntimeState,
  getRunner: () => ExtensionRunner | undefined,
): { actions: ExtensionActions; context: ExtensionContextActions } {
  const bridge = options.bridge ?? {}
  const actions: ExtensionActions = {
    sendMessage: (message, delivery) => { bridge.sendMessage?.(message, delivery) },
    sendUserMessage: (content, delivery) => { bridge.sendUserMessage?.(content, delivery) },
    appendEntry: (type, data) => {
      state.sessionManager.appendCustomEntry(type, data)
      bridge.appendEntry?.(type, data)
    },
    setSessionName: (name) => {
      state.sessionName = name
      state.sessionManager.appendSessionInfo(name)
    },
    getSessionName: () => state.sessionName,
    setLabel: (entryId, label) => {
      state.sessionManager.appendLabelChange(entryId, label)
      bridge.setLabel?.(entryId, label)
    },
    getActiveTools: () => [...state.activeTools].filter(name => {
      const unavailable = state.unavailableTools.get(name)
      if (unavailable === undefined) return true
      const current = getRunner()?.getAllRegisteredTools().find(tool => tool.definition.name === name)
      return current?.definition !== unavailable
    }),
    getAllTools: () => (getRunner()?.getAllRegisteredTools() ?? []).map(({ definition, sourceInfo }) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      ...(definition.promptGuidelines === undefined ? {} : { promptGuidelines: definition.promptGuidelines }),
      sourceInfo,
    })),
    setActiveTools: (names) => {
      const available = new Set((getRunner()?.getAllRegisteredTools() ?? []).map(tool => tool.definition.name))
      state.activeTools = new Set(names.filter(name => available.has(name)))
      state.activeToolsExplicitlySet = true
      bridge.refreshTools?.()
    },
    refreshTools: () => {
      const names = new Set((getRunner()?.getAllRegisteredTools() ?? []).map(tool => tool.definition.name))
      for (const name of names) {
        if (!state.knownTools.has(name)) state.activeTools.add(name)
      }
      state.knownTools = names
      bridge.refreshTools?.()
    },
    getCommands: () => (getRunner()?.getRegisteredCommands() ?? []).map(command => ({
      name: command.invocationName,
      description: command.description ?? '',
      source: 'extension' as const,
      sourceInfo: command.sourceInfo,
    })),
    setModel: async model => bridge.setModel === undefined ? false : bridge.setModel(model),
    getThinkingLevel: () => state.thinkingLevel,
    setThinkingLevel: (level) => { state.thinkingLevel = level },
  }
  Object.assign(runtime, actions)
  return {
    actions,
    context: {
      getModel: () => undefined,
      isIdle: () => bridge.isIdle?.() ?? true,
      isProjectTrusted: () => options.projectTrusted ?? false,
      getSignal: () => state.signalStore.getStore(),
      abort: () => { bridge.abort?.() },
      hasPendingMessages: () => bridge.hasPendingMessages?.() ?? false,
      shutdown: () => { bridge.shutdown?.() },
      getContextUsage: () => bridge.getContextUsage?.(),
      compact: compactOptions => { bridge.compact?.(compactOptions) },
      getSystemPrompt: () => bridge.getSystemPrompt?.() ?? '',
      getSystemPromptOptions: () => ({ cwd: options.cwd }),
    },
  }
}

async function finishLoad(result: LoadExtensionsResult, options: RuntimeOptions): Promise<RuntimeLoad> {
  if (result.errors.length > 0) {
    options.bridge?.reportError?.(`Failed to load ${result.errors.length} selected Pi extension(s)`)
    throw new Error('Failed to load selected Pi extensions')
  }
  const state: RuntimeState = {
    activeTools: new Set(),
    knownTools: new Set(),
    activeToolsExplicitlySet: false,
    unavailableTools: new Map(),
    signalStore: new AsyncLocalStorage<AbortSignal | undefined>(),
    thinkingLevel: 'off',
    sessionManager: SessionManager.inMemory(options.cwd),
  }
  let runner: ExtensionRunner | undefined
  const bound = bindActions(result.runtime, options, state, () => runner)
  runner = new ExtensionRunner(
    result.extensions,
    result.runtime,
    options.cwd,
    state.sessionManager,
    modelRegistryFacade(options.bridge ?? {}) as never,
  )
  runner.bindCore(bound.actions, bound.context, {
    registerProvider: (name, config) => options.bridge?.registerProvider?.(name, config),
    unregisterProvider: name => options.bridge?.unregisterProvider?.(name),
  })
  runner.bindCommandContext({
    waitForIdle: async () => options.bridge?.waitForIdle === undefined
      ? unsupportedCommandContext('waitForIdle')
      : options.bridge.waitForIdle(),
    newSession: async () => unsupportedCommandContext('newSession'),
    fork: async () => unsupportedCommandContext('fork'),
    navigateTree: async () => unsupportedCommandContext('navigateTree'),
    switchSession: async () => unsupportedCommandContext('switchSession'),
    reload: async () => unsupportedCommandContext('reload'),
  })
  runner.onError(error => {
    options.bridge?.reportError?.(`Pi extension "${error.extensionPath}" handler "${error.event}" failed`)
  })
  runner.setUIContext(undefined, options.mode ?? 'rpc')
  state.knownTools = new Set(runner.getAllRegisteredTools().map(tool => tool.definition.name))
  state.activeTools = new Set(state.knownTools)
  for (const [name, value] of Object.entries(options.flags ?? {})) runner.setFlagValue(name, value)
  return { result, runner, state }
}

export class PiExtensionRuntime {
  private started = false

  private constructor(
    private readonly load: RuntimeLoad,
    private readonly options: RuntimeOptions,
  ) {}

  static async fromPaths(paths: string[], options: RuntimeOptions): Promise<PiExtensionRuntime> {
    const result = await loadSelectedExtensions(paths, options.cwd)
    return new PiExtensionRuntime(await finishLoad(result, options), options)
  }

  tools(): RegisteredTool['definition'][] {
    return this.load.runner.getAllRegisteredTools().map(tool => tool.definition)
  }

  commands(): ResolvedCommand[] {
    return this.load.runner.getRegisteredCommands()
  }

  flags(): Map<string, boolean | string> {
    return this.load.runner.getFlagValues()
  }

  activeToolNames(): string[] {
    return this.load.runner.getActiveTools()
  }

  requestedActiveToolNames(): string[] {
    return [...this.load.state.activeTools]
  }

  markToolUnavailable(name: string, definition: RegisteredTool['definition']): void {
    this.load.state.unavailableTools.set(name, definition)
  }

  clearToolUnavailable(name: string): void {
    this.load.state.unavailableTools.delete(name)
  }

  sessionName(): string | undefined {
    return this.load.state.sessionName
  }

  async start(reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork' = 'startup'): Promise<void> {
    if (this.started && reason === 'startup') return
    this.load.state.activeToolsExplicitlySet = false
    await this.load.runner.emit({ type: 'session_start', reason })
    await this.load.runner.emitResourcesDiscover(this.options.cwd, reason === 'reload' ? 'reload' : 'startup')
    if (!this.load.state.activeToolsExplicitlySet) {
      this.load.state.activeTools = new Set(this.tools().map(tool => tool.name))
    }
    this.started = true
    this.options.bridge?.refreshTools?.()
  }

  async emit(event: ExtensionEvent, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.load.state.signalStore.run(signal, async () => {
        if (event.type === 'tool_call') return this.load.runner.emitToolCall(event)
        if (event.type === 'tool_result') return this.load.runner.emitToolResult(event)
        if (event.type === 'context') return this.load.runner.emitContext(event.messages)
        if (event.type === 'before_provider_request') return this.load.runner.emitBeforeProviderRequest(event.payload)
        if (event.type === 'before_provider_headers') return this.load.runner.emitBeforeProviderHeaders(event.headers)
        if (event.type === 'before_agent_start') {
          return this.load.runner.emitBeforeAgentStart(event.prompt, event.images, event.systemPrompt, event.systemPromptOptions)
        }
        if (event.type === 'message_end') return this.load.runner.emitMessageEnd(event)
        if (event.type === 'user_bash') return this.load.runner.emitUserBash(event)
        if (event.type === 'input') {
          return this.load.runner.emitInput(event.text, event.images, event.source, event.streamingBehavior)
        }
        if (event.type === 'project_trust' || event.type === 'resources_discover') return undefined
        return this.load.runner.emit(event)
      })
    } finally {
      this.options.bridge?.refreshTools?.()
    }
  }

  async executeTool(name: string, rawArgs: unknown, options: ExecuteToolOptions): Promise<PiToolExecutionResult> {
    return this.load.state.signalStore.run(options.signal, async () => {
      const registered = this.load.runner.getAllRegisteredTools().find(tool => tool.definition.name === name)
      if (registered === undefined) throw new Error(`Unknown Pi tool: ${name}`)
      const definition = registered.definition
      let input: Record<string, unknown>
      let decision: { block?: boolean; reason?: string } | undefined
      try {
        const prepared = definition.prepareArguments?.(rawArgs) ?? rawArgs
        if (!Value.Check(definition.parameters, prepared)) throw new TypeError(`Invalid arguments for Pi tool: ${name}`)
        input = prepared as Record<string, unknown>
        decision = await this.load.runner.emitToolCall({
          type: 'tool_call', toolCallId: options.callId, toolName: name, input,
        })
      } catch (error) {
        return isAbortFailure(error, options.signal) ? abortedToolResult() : unexpectedToolFailure(this.options, name)
      }
      if (decision?.block === true) throw new Error(decision.reason ?? `Pi extension blocked tool: ${name}`)
      await this.load.runner.emit({
        type: 'tool_execution_start', toolCallId: options.callId, toolName: name, args: input,
      })
      let result: PiToolExecutionResult
      let updates = Promise.resolve<unknown>(undefined)
      try {
        result = await definition.execute(options.callId, input, options.signal, partial => {
          options.onUpdate?.(partial)
          updates = updates.then(() => this.load.runner.emit({
            type: 'tool_execution_update', toolCallId: options.callId, toolName: name, args: input, partialResult: partial,
          }))
        }, this.load.runner.createContext()) as PiToolExecutionResult
      } catch (error) {
        result = isAbortFailure(error, options.signal) ? abortedToolResult() : unexpectedToolFailure(this.options, name)
      }
      await updates
      const intercepted = await this.load.runner.emitToolResult({
        type: 'tool_result', toolCallId: options.callId, toolName: name, input,
        content: result.content, details: result.details, isError: result.isError ?? false,
      })
      const finalResult = intercepted === undefined ? result : { ...result, ...intercepted }
      await this.load.runner.emit({
        type: 'tool_execution_end', toolCallId: options.callId, toolName: name,
        result: finalResult, isError: finalResult.isError ?? false,
      })
      this.options.bridge?.refreshTools?.()
      return finalResult
    })
  }

  async executeCommand(name: string, args: string, signal?: AbortSignal): Promise<CommandNotification[]> {
    return this.load.state.signalStore.run(signal, async () => {
      const command = this.load.runner.getCommand(name)
      if (command === undefined) throw new Error(`Unknown Pi command: ${name}`)
      try {
        const notifications: CommandNotification[] = []
        const context = this.load.runner.createCommandContext()
        const ui = new Proxy(context.ui, {
          get(target, property, receiver) {
            if (property !== 'notify') return Reflect.get(target, property, receiver) as unknown
            return (message: string, type?: CommandNotification['type']) => {
              notifications.push({ message, ...(type === undefined ? {} : { type }) })
            }
          },
        })
        Object.defineProperty(context, 'ui', { value: ui })
        await command.handler(args, context)
        return notifications
      } catch (error) {
        if (error instanceof UnsupportedCommandContextError || isAbortFailure(error, signal)) throw error
        this.options.bridge?.reportError?.(`Pi command "${name}" execution failed unexpectedly`)
        throw new Error('Pi command execution failed unexpectedly')
      }
    })
  }

  async shutdown(): Promise<void> {
    if (this.started) await this.load.runner.emit({ type: 'session_shutdown', reason: 'quit' })
    this.load.runner.invalidate('Pi extension runtime disposed by DSH')
    this.started = false
  }
}
