import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  const record = (value: string) => {
    ;(globalThis as { __piMountEvents?: string[] }).__piMountEvents?.push(value)
  }
  pi.registerTool({
    name: 'mounted_first', label: 'Mounted first', description: 'Mounts before the failure',
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: 'unused' }], details: {} } },
  })
  pi.registerTool({
    name: 'unsupported_schema', label: 'Unsupported', description: 'Cannot mount',
    parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
    async execute() { return { content: [{ type: 'text', text: 'unused' }], details: {} } },
  })
  pi.on('session_start', async () => { record('start') })
  pi.on('session_shutdown', async () => { record('shutdown') })
}
