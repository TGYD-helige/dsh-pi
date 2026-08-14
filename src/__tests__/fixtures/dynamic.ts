import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.registerCommand('replaceable', {
    description: 'Initial command',
    async handler(_args, ctx) { ctx.ui.notify('initial command') },
  })
  pi.registerTool({
    name: 'dynamic', label: 'Dynamic', description: 'Initial definition', parameters: Type.Object({ value: Type.String() }),
    async execute() { return { content: [{ type: 'text', text: 'initial' }], details: {} } },
  })
  pi.on('agent_start', async () => {
    pi.registerCommand('replaceable', {
      description: 'Updated command',
      async handler(_args, ctx) { ctx.ui.notify('updated command') },
    })
    pi.registerTool({
      name: 'dynamic', label: 'Dynamic', description: 'Updated definition', parameters: Type.Object({ count: Type.Number() }),
      async execute() { return { content: [{ type: 'text', text: 'updated' }], details: {} } },
    })
    pi.registerTool({
      name: 'late-tool', label: 'Late tool', description: 'Registered after startup', parameters: Type.Object({}),
      async execute() { return { content: [{ type: 'text', text: 'late' }], details: {} } },
    })
    pi.registerCommand('late', {
      description: 'Registered after startup',
      async handler(_args, ctx) { ctx.ui.notify('late command') },
    })
  })
}
