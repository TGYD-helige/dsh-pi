import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.on('session_shutdown', async () => {
    const state = globalThis as {
      __piShutdownEvents?: string[]
      __releasePiShutdown?: () => void
    }
    state.__piShutdownEvents?.push('start')
    await new Promise<void>(resolve => { state.__releasePiShutdown = resolve })
    state.__piShutdownEvents?.push('end')
  })
}
