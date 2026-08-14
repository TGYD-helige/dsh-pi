import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.registerFlag('feature', { type: 'boolean', default: true })
  pi.registerTool({
    name: 'echo',
    label: 'Echo',
    description: 'Echo text',
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: 'text', text: params.text }], details: { echoed: true } }
    },
  })
  pi.registerCommand('echo', {
    description: 'Echo text',
    handler: async () => {},
  })
  pi.on('session_start', async () => {
    ;(globalThis as { __piHostEvents?: string[] }).__piHostEvents?.push('session_start')
  })
  pi.on('session_shutdown', async () => {
    ;(globalThis as { __piHostEvents?: string[] }).__piHostEvents?.push('session_shutdown')
  })
}
