import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.on('session_start', async () => {
    pi.sendMessage({ customType: 'delivery', content: [{ type: 'text', text: 'default' }], display: true, details: {} })
    pi.sendMessage({ customType: 'delivery', content: [{ type: 'text', text: 'next' }], display: true, details: {} }, { deliverAs: 'nextTurn' })
    pi.sendMessage({ customType: 'delivery', content: [{ type: 'text', text: 'wake' }], display: true, details: {} }, { triggerTurn: true })
  })
}
