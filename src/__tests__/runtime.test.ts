import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VERSION } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { PiExtensionRuntime } from '../runtime.js'

const fixture = (name: string) => new URL(`./fixtures/${name}.ts`, import.meta.url).pathname

/** A second, complete Pi install under `root`, like a linked checkout's own node_modules. */
async function installPiCopy(root: string, version: string): Promise<void> {
  const directory = join(root, 'node_modules/@earendil-works/pi-coding-agent')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent', version, main: 'index.js',
  }))
  await writeFile(join(directory, 'index.js'), `export const VERSION = ${JSON.stringify(version)}\n`)
}

describe('PiExtensionRuntime', () => {
  it('loads only explicitly selected extension entries', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pi-explicit-'))
    ;(globalThis as { __implicitPiExtensionLoaded?: boolean }).__implicitPiExtensionLoaded = false
    try {
      await mkdir(join(cwd, '.pi/extensions'), { recursive: true })
      await writeFile(join(cwd, '.pi/extensions/implicit.js'), `export default function () { globalThis.__implicitPiExtensionLoaded = true }`)

      const runtime = await PiExtensionRuntime.fromPaths([fixture('full')], { cwd })

      expect((globalThis as { __implicitPiExtensionLoaded?: boolean }).__implicitPiExtensionLoaded).toBe(false)
      await runtime.shutdown()
    } finally {
      delete (globalThis as { __implicitPiExtensionLoaded?: boolean }).__implicitPiExtensionLoaded
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('loads a Pi factory and exposes its tools, commands, flags, and lifecycle', async () => {
    const events: string[] = []
    ;(globalThis as { __piHostEvents?: string[] }).__piHostEvents = events
    const runtime = await PiExtensionRuntime.fromPaths([fixture('full')], { cwd: '/workspace' })
    await runtime.start('startup')

    expect(runtime.tools().map(tool => tool.name)).toEqual(['echo'])
    expect(runtime.commands().map(command => command.name)).toEqual(['echo'])
    expect(runtime.flags()).toEqual(new Map([['feature', true]]))
    await runtime.shutdown()
    expect(events).toEqual(['session_start', 'session_shutdown'])
  })

  it('preserves active tools selected during session_start', async () => {
    const runtime = await PiExtensionRuntime.fromPaths([fixture('active')], { cwd: '/workspace' })

    await runtime.start('startup')

    expect(runtime.tools().map(tool => tool.name)).toEqual(['hidden'])
    expect(runtime.activeToolNames()).toEqual(['hidden'])
    await runtime.shutdown()
  })

  it('emits session_shutdown before re-running session_start on restart', async () => {
    const events: string[] = []
    ;(globalThis as { __piRestartEvents?: string[] }).__piRestartEvents = events
    try {
      const runtime = await PiExtensionRuntime.fromPaths([fixture('restart')], { cwd: '/workspace' })

      await runtime.start('startup')
      await runtime.start('resume')

      expect(events).toEqual(['session_start:startup', 'session_shutdown:resume', 'session_start:resume'])
      expect(runtime.tools().map(tool => tool.name)).toEqual(['browser'])
      const result = await runtime.executeTool('browser', {}, { callId: 'restart' })
      expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
      await runtime.shutdown()
      expect(events).toEqual([
        'session_start:startup', 'session_shutdown:resume', 'session_start:resume', 'session_shutdown:quit',
      ])
    } finally {
      delete (globalThis as { __piRestartEvents?: string[] }).__piRestartEvents
    }
  })

  it('serializes back-to-back session transitions in shutdown-start order', async () => {
    const events: string[] = []
    ;(globalThis as { __piRestartEvents?: string[] }).__piRestartEvents = events
    try {
      const runtime = await PiExtensionRuntime.fromPaths([fixture('restart')], { cwd: '/workspace' })
      await runtime.start('startup')

      await Promise.all([runtime.start('resume'), runtime.start('reload')])

      expect(events).toEqual([
        'session_start:startup',
        'session_shutdown:resume', 'session_start:resume',
        'session_shutdown:reload', 'session_start:reload',
      ])
      await runtime.shutdown()
    } finally {
      delete (globalThis as { __piRestartEvents?: string[] }).__piRestartEvents
    }
  })

  it('uses prepareArguments, forwards cancellation and publishes streaming updates', async () => {
    const update = vi.fn()
    const controller = new AbortController()
    const runtime = await PiExtensionRuntime.fromPaths([fixture('prepared')], { cwd: '/workspace' })

    const result = await runtime.executeTool('prepared', { value: '42' }, {
      callId: 'call-1', signal: controller.signal, onUpdate: update,
    })

    expect(result.content).toEqual([{ type: 'text', text: '42' }])
    expect(update).toHaveBeenCalledOnce()
    expect(result.details).toEqual({ callId: 'call-1', sameSignal: true, sameContextSignal: true })
  })

  it('keeps ctx.signal invocation-scoped for parallel tools', async () => {
    const runtime = await PiExtensionRuntime.fromPaths([fixture('prepared')], { cwd: '/workspace' })
    const first = new AbortController()
    const second = new AbortController()

    const results = await Promise.all([
      runtime.executeTool('prepared', { value: '1' }, { callId: 'first', signal: first.signal }),
      runtime.executeTool('prepared', { value: '2' }, { callId: 'second', signal: second.signal }),
    ])

    expect(results.map(result => (result.details as { sameContextSignal: boolean }).sameContextSignal))
      .toEqual([true, true])
  })

  it('emits a terminal lifecycle event when a tool throws', async () => {
    const events: string[] = []
    const reportError = vi.fn()
    ;(globalThis as { __piToolEvents?: string[] }).__piToolEvents = events
    const runtime = await PiExtensionRuntime.fromPaths([fixture('failing')], {
      cwd: '/workspace', bridge: { reportError },
    })

    const result = await runtime.executeTool('failing', {}, { callId: 'failure' })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Pi tool execution failed unexpectedly' }])
    expect(reportError).toHaveBeenCalledWith('Pi tool "failing" execution failed unexpectedly')
    expect(JSON.stringify(result)).not.toContain('expected failure')
    expect(events).toEqual(['start', 'end:true'])
    await runtime.shutdown()
    delete (globalThis as { __piToolEvents?: string[] }).__piToolEvents
  })

  it('keeps cooperative cancellation distinct from an unexpected tool failure', async () => {
    const reportError = vi.fn()
    const controller = new AbortController()
    const runtime = await PiExtensionRuntime.fromPaths([fixture('cancelling')], {
      cwd: '/workspace', bridge: { reportError },
    })

    const execution = runtime.executeTool('cancelling', {}, {
      callId: 'cancelled', signal: controller.signal,
    })
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(execution).resolves.toMatchObject({ aborted: true, isError: true })
    expect(reportError).not.toHaveBeenCalled()
    await runtime.shutdown()
  })

  it('runs Pi update handlers in order before the terminal tool event', async () => {
    const state = globalThis as { __piUpdateEvents?: string[]; __releasePiUpdate?: () => void }
    state.__piUpdateEvents = []
    const runtime = await PiExtensionRuntime.fromPaths([fixture('updates')], { cwd: '/workspace' })

    const execution = runtime.executeTool('updates', {}, { callId: 'updates' })
    await vi.waitFor(() => expect(state.__piUpdateEvents).toEqual(['update:first:start']))
    await new Promise(resolve => setImmediate(resolve))
    expect(state.__piUpdateEvents).toEqual(['update:first:start'])
    state.__releasePiUpdate?.()
    await execution

    expect(state.__piUpdateEvents).toEqual([
      'update:first:start', 'update:first:end',
      'update:second:start', 'update:second:end',
      'end',
    ])
    await runtime.shutdown()
    delete state.__piUpdateEvents
    delete state.__releasePiUpdate
  })

  it('reports Pi lifecycle handler failures without exposing their message', async () => {
    const reportError = vi.fn()
    const runtime = await PiExtensionRuntime.fromPaths([fixture('handler-error')], {
      cwd: '/workspace', bridge: { reportError },
    })

    await runtime.start('startup')

    expect(reportError).toHaveBeenCalledOnce()
    expect(reportError.mock.calls[0]?.[0]).toContain('session_start')
    expect(reportError.mock.calls[0]?.[0]).not.toContain('secret lifecycle detail')
    await runtime.shutdown()
  })

  it('sanitizes extension failures before tool execution starts', async () => {
    const reportError = vi.fn()
    const runtime = await PiExtensionRuntime.fromPaths([fixture('pre-failing')], {
      cwd: '/workspace', bridge: { reportError },
    })

    const results = await Promise.all([
      runtime.executeTool('prepare_failure', {}, { callId: 'prepare' }),
      runtime.executeTool('hook_failure', {}, { callId: 'hook' }),
    ])

    expect(results.map(result => result.content)).toEqual([
      [{ type: 'text', text: 'Pi tool execution failed unexpectedly' }],
      [{ type: 'text', text: 'Pi tool execution failed unexpectedly' }],
    ])
    expect(results.every(result => result.isError === true)).toBe(true)
    expect(JSON.stringify({ results, calls: reportError.mock.calls })).not.toContain('secret')
    expect(reportError).toHaveBeenCalledTimes(2)
    await runtime.shutdown()
  })

  it('bridges session state and messages without leaking them through stdout', async () => {
    const appended: unknown[] = []
    const sent: unknown[] = []
    const runtime = await PiExtensionRuntime.fromPaths([fixture('bridge')], {
      cwd: '/workspace',
      bridge: {
        appendEntry: (type, data) => appended.push({ type, data }),
        sendUserMessage: (content, options) => sent.push({ content, options }),
      },
    })

    await runtime.start('startup')
    expect(appended).toEqual([{ type: 'state', data: { value: 1 } }])
    expect(sent).toEqual([{ content: 'continue', options: { deliverAs: 'followUp' } }])
    expect(runtime.sessionName()).toBe('named')
  })

  it('returns command notifications for the DSH command response', async () => {
    const runtime = await PiExtensionRuntime.fromPaths([fixture('command')], { cwd: '/workspace' })

    const notifications = await runtime.executeCommand('notify', '')

    expect(notifications).toEqual([{ message: 'command complete', type: 'info' }])
    await runtime.shutdown()
  })

  it('fails unsupported Pi command-context operations explicitly', async () => {
    const runtime = await PiExtensionRuntime.fromPaths([fixture('command')], { cwd: '/workspace' })

    await expect(runtime.executeCommand('unsupported-session', ''))
      .rejects.toThrow('Pi command context newSession is unsupported by DSH')
    await runtime.shutdown()
  })

  it('sanitizes unexpected Pi command failures', async () => {
    const reportError = vi.fn()
    const runtime = await PiExtensionRuntime.fromPaths([fixture('command')], {
      cwd: '/workspace', bridge: { reportError },
    })

    await expect(runtime.executeCommand('failing', ''))
      .rejects.toThrow('Pi command execution failed unexpectedly')
    expect(reportError).toHaveBeenCalledWith('Pi command "failing" execution failed unexpectedly')
    expect(JSON.stringify(reportError.mock.calls)).not.toContain('secret command response')
    await runtime.shutdown()
  })

  // A linked checkout (README "point the profile at this checkout") resolves its own Pi copy,
  // so the guard must key on the version, not on one shared realpath.
  it('loads an extension that resolves a same-version Pi copy at another realpath', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pi-linked-'))
    try {
      await installPiCopy(cwd, VERSION)
      const extension = join(cwd, 'extension.js')
      await writeFile(extension, 'export default function extension() {}\n')

      const runtime = await PiExtensionRuntime.fromPaths([extension], { cwd })

      expect(runtime.tools()).toEqual([])
      await runtime.shutdown()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('refuses an extension that resolves a different Pi version', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pi-mixed-'))
    try {
      await installPiCopy(cwd, '0.80.0')
      const extension = join(cwd, 'extension.js')
      await writeFile(extension, 'export default function extension() {}\n')

      await expect(PiExtensionRuntime.fromPaths([extension], { cwd }))
        .rejects.toThrow(/Pi instance mismatch: .*0\.80\.0/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
