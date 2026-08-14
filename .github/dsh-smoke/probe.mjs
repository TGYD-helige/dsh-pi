import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

export const name = 'dsh-pi-smoke-probe'

const calls = new Map()

function textOf(blocks = []) {
  return blocks.flatMap(block => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-result') return [textOf(block.content)]
    return []
  }).join('\n')
}

function preview(text, limit = 2_000) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n... [truncated by CI probe]`
}

function log(event, data = {}) {
  console.error(`[dsh-pi-e2e] ${JSON.stringify({ seq: event.seq, type: event.type, ...data })}`)
}

export function apply(ctx) {
  const expectedTool = process.env.DSH_SMOKE_EXPECTED_TOOL
  const expectedResult = process.env.DSH_SMOKE_EXPECTED_RESULT
  const witness = process.env.DSH_SMOKE_WITNESS
  assert(expectedTool && expectedResult && witness, 'DSH smoke probe environment is incomplete')

  let restricted = false
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!restricted) {
      assert(agent.ctx.tools.get(expectedTool, agent), `DSH did not mount tool: ${expectedTool}`)
      agent.ctx.tools.restrict({ allow: [] })
      restricted = true
      console.error(`[dsh-pi-e2e] mounted agent tool and hid global tools: ${expectedTool}`)
    }
    return decision
  })

  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/start' || event.type === 'step/start' || event.type === 'step/end') {
      log(event, event.data)
      return
    }
    if (event.type === 'assistant/message') {
      log(event, { text: preview(textOf(event.data.message.content)) })
      return
    }
    if (event.type === 'tool/call') {
      const callId = String(event.data.callId)
      calls.set(callId, event.data.name)
      log(event, { tool: event.data.name, callId, arguments: preview(event.data.arguments) })
      return
    }
    if (event.type === 'tool/result') {
      const callId = String(event.data.message.source.callId)
      const tool = calls.get(callId) ?? 'unknown'
      const result = event.data.message.content.find(block => block.type === 'tool-result')
      const text = textOf(result?.content)
      const isError = result?.isError === true
      log(event, { tool, callId, isError, text: preview(text) })
      if (tool === expectedTool && !isError && text.includes(expectedResult)) {
        writeFileSync(witness, expectedTool)
      }
      return
    }
    if (event.type === 'turn/end') {
      log(event, { reason: event.data.reason })
    }
  })
}
