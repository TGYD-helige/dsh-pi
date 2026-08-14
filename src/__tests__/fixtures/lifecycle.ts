import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  const record = (value: string) => {
    ;(globalThis as { __piLifecycleEvents?: string[] }).__piLifecycleEvents?.push(value)
  }
  pi.on('input', async event => { record(`input:${event.text}`) })
  pi.on('before_agent_start', async () => { record('before_agent_start') })
  pi.on('agent_start', async () => { record('agent_start') })
  pi.on('turn_start', async event => { record(`turn_start:${event.turnIndex}`) })
  pi.on('turn_end', async event => { record(`turn_end:${event.turnIndex}`) })
  pi.on('agent_end', async () => { record('agent_end') })
  pi.on('agent_settled', async () => { record('agent_settled') })
}
