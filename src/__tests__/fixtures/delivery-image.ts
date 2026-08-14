import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.on('session_start', () => {
    pi.sendMessage({
      customType: 'image-delivery', display: true, details: {},
      content: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }],
    })
  })
}
