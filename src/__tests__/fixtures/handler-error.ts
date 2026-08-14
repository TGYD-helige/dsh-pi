import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.on('session_start', async () => { throw new Error('secret lifecycle detail') })
}
