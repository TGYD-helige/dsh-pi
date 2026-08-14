import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  for (const name of ['first', 'second']) {
    pi.registerTool({
      name, label: name, description: name, parameters: Type.Object({}),
      async execute() { return { content: [{ type: 'text', text: name }], details: {} } },
    })
  }
  pi.on('session_shutdown', () => {
    ;(globalThis as { __piDisposeShutdown?: boolean }).__piDisposeShutdown = true
  })
}
