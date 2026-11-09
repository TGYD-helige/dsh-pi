// Runs inside an installed DSH profile directory and lists the Pi extension tools that
// `dsh-pi-host` mounts, without contacting a model provider.
//
// Usage: node list-tools.mjs <pi-extension-package> [...]
// Output: `HOST_VERSION=`, `PI_VERSION=`, `ENTRIES=`, `TOOLS=`, `COMMANDS=` lines on stdout.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveExtensionEntries, PiExtensionRuntime } from 'dsh-pi-host'

const specs = process.argv.slice(2)
if (specs.length === 0) {
  console.error('usage: node list-tools.mjs <pi-extension-package> [...]')
  process.exit(2)
}

const host = JSON.parse(readFileSync(resolve('node_modules/dsh-pi-host/package.json'), 'utf8'))
const pi = JSON.parse(readFileSync(resolve('node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'))
const entries = await resolveExtensionEntries(specs, { cwd: process.cwd(), allowLocalPaths: false })
const runtime = await PiExtensionRuntime.fromPaths(entries, { cwd: process.cwd(), projectTrusted: false })
await runtime.start('startup')
try {
  const tools = runtime.tools().map(tool => tool.name)
  const commands = runtime.commands().map(command => command.invocationName)
  console.log(`HOST_VERSION=${host.version}`)
  console.log(`PI_DEPENDENCY=${host.dependencies?.['@earendil-works/pi-coding-agent'] ?? ''}`)
  console.log(`PI_VERSION=${pi.version}`)
  console.log(`ENTRIES=${JSON.stringify(entries)}`)
  console.log(`TOOLS=${JSON.stringify(tools)}`)
  console.log(`COMMANDS=${JSON.stringify(commands)}`)
  if (tools.length === 0) {
    console.error('no Pi extension tools were mounted')
    process.exit(1)
  }
} finally {
  await runtime.shutdown()
}