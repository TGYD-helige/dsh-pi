import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export const name = 'dsh-pi-smoke-probe'
export const inject = ['agents', 'loader', 'tools']

export async function apply(ctx) {
  const expectedTool = process.env.DSH_SMOKE_EXPECTED_TOOL
  const witness = process.env.DSH_SMOKE_WITNESS
  assert(expectedTool && witness, 'DSH smoke probe environment is incomplete')

  const deadline = Date.now() + 10_000
  let lifecycleHooks
  while (!(lifecycleHooks = ctx.events._hooks['agent/session-start'] ?? [])
    .some(hook => ctx.loader.locate(hook.ctx.fiber)?.endsWith(':dsh-pi'))) {
    if (Date.now() >= deadline) {
      const owners = lifecycleHooks.map(hook => ctx.loader.locate(hook.ctx.fiber) ?? 'unknown').join(', ')
      throw new Error(`dsh-pi did not register its agent lifecycle hook (owners: ${owners})`)
    }
    await delay(25)
  }

  let handle
  while (handle === undefined) {
    try {
      handle = await ctx.agents.create({
        sessionId: randomUUID(),
        meta: { cwd: process.cwd() },
      })
    } catch (error) {
      if (Date.now() >= deadline || error?.message !== 'no agent factory registered (load an agent-loop plugin)') {
        throw error
      }
      await delay(25)
    }
  }

  try {
    while (ctx.tools.get(expectedTool, handle.agent) === undefined) {
      if (Date.now() >= deadline) throw new Error(`DSH did not mount tool: ${expectedTool}`)
      await delay(25)
    }
    await writeFile(witness, expectedTool)
  } finally {
    await handle.dispose()
  }

  void ctx.root.fiber.dispose()
}
