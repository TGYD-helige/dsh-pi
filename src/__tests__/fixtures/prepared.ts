import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'prepared',
    label: 'Prepared',
    description: 'Prepare arguments',
    parameters: Type.Object({ value: Type.Number() }),
    prepareArguments: raw => ({ value: Number((raw as { value: string }).value) }),
    async execute(id, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: 'text', text: 'working' }], details: {} })
      await new Promise(resolve => setTimeout(resolve, 5))
      return {
        content: [{ type: 'text', text: String(params.value) }],
        details: { callId: id, sameSignal: signal !== undefined, sameContextSignal: ctx.signal === signal },
      }
    },
  })
}
