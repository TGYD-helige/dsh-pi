import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'initial', label: 'Initial', description: 'Initial tool', parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: 'initial' }], details: {} } },
  })
  pi.on('session_shutdown', async () => {
    pi.registerTool({
      name: 'late_shutdown', label: 'Late shutdown', description: 'Must not mount', parameters: Type.Object({}),
      async execute() { return { content: [{ type: 'text', text: 'late' }], details: {} } },
    })
    pi.setActiveTools(['late_shutdown'])
  })
}
