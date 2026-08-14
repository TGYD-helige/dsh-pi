import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.on('session_start', async () => {
    pi.appendEntry('state', { value: 1 })
    pi.sendUserMessage('continue', { deliverAs: 'followUp' })
    pi.setSessionName('named')
  })
}
