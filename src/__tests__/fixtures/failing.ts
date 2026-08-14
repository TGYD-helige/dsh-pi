import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'failing', label: 'Failing', description: 'Always fails', parameters: Type.Object({}),
    async execute() { throw new Error('expected failure') },
  })
  pi.on('tool_execution_start', async () => {
    ;(globalThis as { __piToolEvents?: string[] }).__piToolEvents?.push('start')
  })
  pi.on('tool_execution_end', async event => {
    ;(globalThis as { __piToolEvents?: string[] }).__piToolEvents?.push(`end:${event.isError}`)
  })
}
