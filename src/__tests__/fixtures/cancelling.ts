import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'cancelling', label: 'Cancelling', description: 'Stops when cancelled', parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      await new Promise(resolve => setImmediate(resolve))
      signal?.throwIfAborted()
      return { content: [{ type: 'text', text: 'completed' }], details: {} }
    },
  })
}
