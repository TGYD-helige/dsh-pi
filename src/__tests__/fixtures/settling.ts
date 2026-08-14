import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  const state = globalThis as {
    __piSettlingEvents?: string[]
    __releasePiSettling?: () => void
  }
  pi.on('turn_end', async () => {
    state.__piSettlingEvents?.push('turn:start')
    await new Promise<void>(resolve => { state.__releasePiSettling = resolve })
    state.__piSettlingEvents?.push('turn:end')
  })
  pi.on('session_shutdown', async () => { state.__piSettlingEvents?.push('shutdown') })
}
