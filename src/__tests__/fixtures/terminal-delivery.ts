import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.on('agent_end', async () => {
    pi.sendUserMessage([{ type: 'image', data: 'AQID', mimeType: 'image/png' }])
    ;(globalThis as { __piTerminalDeliveryEvents?: string[] }).__piTerminalDeliveryEvents?.push('agent_end')
  })
  pi.on('agent_settled', async () => {
    ;(globalThis as { __piTerminalDeliveryEvents?: string[] }).__piTerminalDeliveryEvents?.push('agent_settled')
  })
}
