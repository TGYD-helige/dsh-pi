import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  const record = (event: string) => {
    ;(globalThis as { __piInvalidTurnEvents?: string[] }).__piInvalidTurnEvents?.push(event)
  }
  pi.on('turn_start', () => {
    record('turn_start')
    pi.registerTool({
      name: 'invalid_after_turn', label: 'Invalid', description: 'Invalid after turn start',
      parameters: Type.Object({ value: Type.String({ minLength: 1 }) }),
      async execute() { return { content: [{ type: 'text', text: 'unused' }], details: {} } },
    })
    pi.setActiveTools(['invalid_after_turn'])
  })
  pi.on('turn_end', () => { record('turn_end') })
  pi.on('agent_end', () => { record('agent_end') })
}
