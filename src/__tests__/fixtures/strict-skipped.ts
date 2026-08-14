import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'unsupported', label: 'Unsupported', description: 'Unsupported schema',
    parameters: Type.Object({ value: Type.String({ minLength: 1 }) }),
    async execute() { return { content: [{ type: 'text', text: 'unused' }], details: {} } },
  })
  pi.registerCommand('active', {
    description: 'Show active adapted tools',
    handler: async (_args, ctx) => { ctx.ui.notify(pi.getActiveTools().join(',') || 'none') },
  })
  pi.on('session_start', () => { pi.setActiveTools(['unsupported']) })
}
