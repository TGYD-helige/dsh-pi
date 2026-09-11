import { readFileSync } from 'node:fs'

// Poll Langfuse for the smoke run's session traces. Prints status codes and
// the session id only — keys stay inside the Authorization header.
const baseUrl = process.env.LANGFUSE_BASE_URL
const publicKey = process.env.LANGFUSE_PUBLIC_KEY
const secretKey = process.env.LANGFUSE_SECRET_KEY
const sessionFile = process.env.DSH_SMOKE_SESSION_FILE

if (!baseUrl || !publicKey || !secretKey || !sessionFile) {
  console.error('[dsh-pi-e2e] Langfuse verification environment is incomplete')
  process.exit(1)
}
const sessionId = readFileSync(sessionFile, 'utf8').trim()
if (sessionId.length === 0) {
  console.error('[dsh-pi-e2e] session id file is empty')
  process.exit(1)
}

const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64')
const url = `${baseUrl.replace(/\/+$/, '')}/api/public/traces?sessionId=${encodeURIComponent(sessionId)}`

const deadline = Date.now() + 120_000
let lastStatus = 'no response'
while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { headers: { authorization: `Basic ${auth}` } })
    lastStatus = `HTTP ${response.status}`
    // Auth failures cannot heal by retrying; fail fast with the status only.
    if (response.status === 401 || response.status === 403) {
      console.error(`[dsh-pi-e2e] Langfuse rejected the configured credentials (${lastStatus})`)
      process.exit(1)
    }
    if (response.ok) {
      const body = await response.json()
      const traces = Array.isArray(body?.data) ? body.data : []
      if (traces.length > 0) {
        console.error(`[dsh-pi-e2e] Langfuse session ${sessionId}: ${traces.length} trace(s), first named ${JSON.stringify(traces[0]?.name)}`)
        process.exit(0)
      }
    }
  } catch (error) {
    lastStatus = error instanceof Error ? error.name : 'fetch error'
  }
  await new Promise(resolve => setTimeout(resolve, 5_000))
}
console.error(`[dsh-pi-e2e] no Langfuse trace for session ${sessionId} within 2 minutes (${lastStatus})`)
process.exit(1)
