import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.on('input', async event => {
    const state = globalThis as { __piInputText?: string; __piInputImages?: unknown }
    state.__piInputText = event.text
    state.__piInputImages = event.images
    return { action: 'transform', text: event.text.toUpperCase() }
  })
}
