import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'prepare_failure', label: 'Prepare failure', description: 'Fails preparing', parameters: Type.Object({}),
    prepareArguments() { throw new Error('secret prepare detail') },
    async execute() { return { content: [{ type: 'text', text: 'unused' }], details: {} } },
  })
  pi.registerTool({
    name: 'hook_failure', label: 'Hook failure', description: 'Fails in tool_call', parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: 'unused' }], details: {} } },
  })
  pi.on('tool_call', async event => {
    if (event.toolName === 'hook_failure') throw new Error('secret hook detail')
  })
}
