import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.on('session_start', async (event) => {
    ;(globalThis as { __piRestartEvents?: string[] }).__piRestartEvents?.push(`session_start:${event.reason}`)
    pi.registerTool({
      name: 'browser',
      label: 'Browser',
      description: 'Re-registered on every session start, like pi-browser-use',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], details: {} }
      },
    })
  })
  pi.on('session_shutdown', async (event) => {
    ;(globalThis as { __piRestartEvents?: string[] }).__piRestartEvents?.push(`session_shutdown:${event.reason}`)
  })
}
