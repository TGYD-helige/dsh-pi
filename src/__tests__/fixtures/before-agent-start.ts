import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * Records the trigger shape Pi hands a `before_agent_start` handler, so a test can assert the
 * host emits a user trigger with the DSH prompt instead of a custom trigger with no message.
 */
export default function extension(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async event => {
    ;(globalThis as { __piBeforeAgentStart?: unknown[] }).__piBeforeAgentStart?.push(
      'prompt' in event
        ? { messageType: event.messageType, prompt: event.prompt }
        : { messageType: event.messageType, message: event.message },
    )
  })
}
