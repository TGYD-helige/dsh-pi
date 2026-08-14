import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  const record = (value: string) => {
    ;(globalThis as { __piUpdateEvents?: string[] }).__piUpdateEvents?.push(value)
  }
  pi.registerTool({
    name: 'updates', label: 'Updates', description: 'Publishes ordered updates', parameters: Type.Object({}),
    async execute(_id, _params, _signal, onUpdate) {
      onUpdate?.({ content: [{ type: 'text', text: 'first' }], details: {} })
      onUpdate?.({ content: [{ type: 'text', text: 'second' }], details: {} })
      return { content: [{ type: 'text', text: 'done' }], details: {} }
    },
  })
  pi.on('tool_execution_update', async event => {
    const text = event.partialResult.content[0]?.type === 'text'
      ? event.partialResult.content[0].text
      : 'unknown'
    record(`update:${text}:start`)
    if (text === 'first') {
      await new Promise<void>(resolve => {
        ;(globalThis as { __releasePiUpdate?: () => void }).__releasePiUpdate = resolve
      })
    }
    record(`update:${text}:end`)
  })
  pi.on('tool_execution_end', async () => { record('end') })
}
