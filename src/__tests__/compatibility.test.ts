import { describe, expect, it } from 'vitest'
import { inventoryWorkspace } from '../compatibility.js'
import {
  extensionApiCapabilities,
  extensionContextCapabilities,
  extensionEventCapabilities,
} from '../capabilities.js'

describe('inventoryWorkspace', () => {
  it('treats the existing Pi monorepo as read-only compatibility fixtures', async () => {
    const workspace = process.env.PI_FIXTURE_WORKSPACE
    if (workspace === undefined) return

    const report = await inventoryWorkspace(workspace)
    expect(report.packages.length).toBeGreaterThanOrEqual(17)
    expect(report.packages.every(item => item.extensionEntries.length > 0)).toBe(true)
    expect(report.extensionApiMethods).toContain('registerTool')
    expect(report.extensionEvents).toContain('session_start')
    expect(report.extensionContextMembers).toEqual(expect.arrayContaining(['cwd', 'signal', 'ui']))
    expect(report.extensionApiMethods.every(method => method in extensionApiCapabilities)).toBe(true)
    expect(report.extensionContextMembers.every(member => member in extensionContextCapabilities)).toBe(true)
    expect(report.extensionEvents.every(event => event in extensionEventCapabilities)).toBe(true)
  })
})
