import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'hidden', label: 'Hidden', description: 'Hidden after startup', parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: 'hidden' }], details: {} } },
  })
  pi.on('session_start', async () => {
    pi.setActiveTools(['hidden', 'missing'])
  })
}
