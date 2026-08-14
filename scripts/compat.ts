import { resolve } from 'node:path'
import { inventoryWorkspace } from '../src/compatibility.js'
import {
  extensionApiCapabilities,
  extensionContextCapabilities,
  extensionEventCapabilities,
} from '../src/capabilities.js'

const workspace = resolve(process.argv[2] ?? '../pi')
const report = await inventoryWorkspace(workspace)
const status = (value: string, table: Record<string, { status: string }>) => table[value]?.status ?? 'unknown'

console.log(`# Pi fixture compatibility\n\nWorkspace: \`${workspace}\`\n`)
console.log(`Packages: ${report.packages.length}\n`)
console.log('| Package | Manifest entries | API surface | Context surface | Events |')
console.log('|---|---|---|---|---|')
for (const item of report.packages) {
  console.log(`| ${item.name} | ${item.extensionEntries.join('<br>')} | ${item.extensionApiMethods.map(value => `${value} (${status(value, extensionApiCapabilities)})`).join('<br>')} | ${item.extensionContextMembers.map(value => `${value} (${status(value, extensionContextCapabilities)})`).join('<br>')} | ${item.extensionEvents.map(value => `${value} (${status(value, extensionEventCapabilities)})`).join('<br>')} |`)
}
