import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.registerCommand('notify', {
    description: 'Notify through DSH',
    handler: async (_args, ctx) => {
      ctx.ui.notify('command complete', 'info')
    },
  })
  pi.registerCommand('unsupported-session', {
    description: 'Try unsupported session control',
    handler: async (_args, ctx) => {
      await ctx.newSession()
      ctx.ui.notify('must not continue')
    },
  })
  pi.registerCommand('wait', {
    description: 'Wait for DSH agent idle',
    handler: async (_args, ctx) => {
      await ctx.waitForIdle()
      ctx.ui.notify('agent idle')
    },
  })
  pi.registerCommand('failing', {
    description: 'Throw an unexpected command failure',
    handler: async () => { throw new Error('secret command response') },
  })
}
