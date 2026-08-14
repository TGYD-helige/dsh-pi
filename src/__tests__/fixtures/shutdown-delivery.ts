import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.on('session_shutdown', () => {
    pi.sendMessage({ customType: 'late', content: 'too late', display: true, details: {} })
  })
}
