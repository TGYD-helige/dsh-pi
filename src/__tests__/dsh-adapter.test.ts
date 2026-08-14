import { Type } from 'typebox'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent'
import { createDshToolDefinition } from '../dsh-adapter.js'

describe('createDshToolDefinition', () => {
  it('returns a DSH canonical value and renders Pi text content', async () => {
    const piTool: PiToolDefinition = {
      name: 'echo',
      label: 'Echo',
      description: 'Echo text',
      parameters: Type.Object({ text: Type.String() }),
      async execute() {
        throw new Error('the runtime owns execution')
      },
    }
    const definition = createDshToolDefinition({
      tool: piTool,
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: { trace: 1 } }),
    })
    const value = await definition.execute({ text: 'x' }, {
      callId: 'call-1', rootCallId: 'call-1', name: 'echo', arguments: { text: 'x' },
      signal: new AbortController().signal, token: Symbol('tool'),
      deferContext: () => {}, concludeTurn: () => {},
    } as never)

    expect(value).toEqual({ content: [{ type: 'text', text: 'ok' }], details: { trace: 1 } })
    expect(definition.output.render({}, value as never)).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('turns expected Pi error results into sanitized DSH failures', async () => {
    const piTool: PiToolDefinition = {
      name: 'fails', label: 'Fails', description: 'Fail', parameters: Type.Object({}),
      async execute() { throw new Error('unused') },
    }
    const definition = createDshToolDefinition({
      tool: piTool,
      execute: async () => ({ isError: true, content: [{ type: 'text', text: 'configuration missing' }], details: {} }),
    })

    await expect(definition.execute({}, { callId: 'x', signal: new AbortController().signal } as never))
      .rejects.toThrow('configuration missing')
  })

  it('bounds expected Pi error text by bytes and lines', async () => {
    const piTool: PiToolDefinition = {
      name: 'large-failure', label: 'Large failure', description: 'Fail', parameters: Type.Object({}),
      async execute() { throw new Error('unused') },
    }
    const definition = createDshToolDefinition({
      tool: piTool,
      execute: async () => ({
        isError: true,
        content: [{ type: 'text', text: '😀\n'.repeat(30_000) }],
        details: {},
      }),
    })

    const error = await definition.execute({}, {
      callId: 'large-failure', signal: new AbortController().signal,
    } as never).then(() => undefined, value => value as Error)

    expect(error).toBeInstanceOf(Error)
    expect(Buffer.byteLength(error?.message ?? '')).toBeLessThanOrEqual(50 * 1024)
    expect((error?.message ?? '').split('\n')).toHaveLength(2_000)
  })

  it('bounds successful Pi text before returning a DSH value', async () => {
    const piTool: PiToolDefinition = {
      name: 'large', label: 'Large', description: 'Large output', parameters: Type.Object({}),
      async execute() { throw new Error('unused') },
    }
    const definition = createDshToolDefinition({
      tool: piTool,
      execute: async () => ({
        content: [{ type: 'text', text: `${'line\n'.repeat(3_000)}${'x'.repeat(60_000)}` }],
        details: {},
      }),
    })

    const value = await definition.execute({}, {
      callId: 'large', signal: new AbortController().signal,
    } as never) as { content: Array<{ type: 'text'; text: string }> }
    const text = value.content.map(block => block.text).join('')

    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024)
    expect(text.split('\n')).toHaveLength(2_000)
  })

  it('omits Pi details that exceed the persisted JSON budget', async () => {
    const piTool: PiToolDefinition = {
      name: 'details', label: 'Details', description: 'Large details', parameters: Type.Object({}),
      async execute() { throw new Error('unused') },
    }
    const definition = createDshToolDefinition({
      tool: piTool,
      execute: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        details: { payload: 'x'.repeat(60_000) },
      }),
    })

    await expect(definition.execute({}, {
      callId: 'details', signal: new AbortController().signal,
    } as never)).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('rejects Pi images before decoding beyond DSH attachment limits', async () => {
    const piTool: PiToolDefinition = {
      name: 'image', label: 'Image', description: 'Large image', parameters: Type.Object({}),
      async execute() { throw new Error('unused') },
    }
    const saveImage = vi.fn()
    const definition = createDshToolDefinition({
      tool: piTool,
      execute: async () => ({
        content: [{ type: 'image', data: Buffer.from([1, 2, 3, 4]).toString('base64'), mimeType: 'image/png' }],
        details: {},
      }),
      saveImage,
      imageLimits: {
        maxImageBytes: 3, maxImagesPerMessage: 1, maxMessageImageBytes: 3,
        maxImagePixels: 1, mediaTypes: ['image/png'],
      },
    })

    await expect(definition.execute({}, {
      callId: 'image', signal: new AbortController().signal,
    } as never)).rejects.toThrow('Pi image exceeds DSH attachment limits')
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('does not expose DSH image persistence exception text', async () => {
    const piTool: PiToolDefinition = {
      name: 'image', label: 'Image', description: 'Image', parameters: Type.Object({}),
      async execute() { throw new Error('unused') },
    }
    const definition = createDshToolDefinition({
      tool: piTool,
      execute: async () => ({
        content: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }],
        details: {},
      }),
      saveImage: async () => { throw new Error('/private/token=secret') },
    })

    const execution = definition.execute({}, {
      callId: 'image', signal: new AbortController().signal,
    } as never)
    await expect(execution).rejects.toThrow('Failed to persist Pi image attachment')
    await expect(execution).rejects.not.toThrow('/private/token=secret')
  })

  it('returns a successful placeholder so DSH can canonicalize cancellation', async () => {
    const piTool: PiToolDefinition = {
      name: 'cancelled', label: 'Cancelled', description: 'Cancel', parameters: Type.Object({}),
      async execute() { throw new Error('unused') },
    }
    const definition = createDshToolDefinition({
      tool: piTool,
      execute: async () => ({
        aborted: true, isError: true,
        content: [{ type: 'text', text: 'Tool execution aborted' }], details: {},
      }),
    })
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(definition.execute({}, { callId: 'x', signal: controller.signal } as never))
      .resolves.toEqual({ content: [] })
  })

  it('lets the DSH tool pipeline publish its canonical cancellation code', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const controller = new AbortController()
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const piTool: PiToolDefinition = {
      name: 'cancelled', label: 'Cancelled', description: 'Cancel', parameters: Type.Object({}),
      async execute() { throw new Error('unused') },
    }
    ctx.tools.register(createDshToolDefinition({
      tool: piTool,
      execute: async () => {
        markStarted?.()
        await new Promise<void>(resolve => { release = resolve })
        return {
          aborted: true, isError: true,
          content: [{ type: 'text', text: 'Tool execution aborted' }], details: {},
        }
      },
    }))

    const execution = ctx.tools.execute({
      callId: 'cancelled', name: 'cancelled', arguments: {}, signal: controller.signal,
    } as never)
    await started
    controller.abort(new DOMException('cancelled', 'AbortError'))
    release?.()

    await expect(execution).resolves.toMatchObject({
      isError: true,
      error: { info: { code: 'ABORTED' } },
    })
  })
})
