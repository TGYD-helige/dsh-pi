import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

/** The markdown body of one `## ` section, so an assertion cannot be satisfied elsewhere. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start === -1) throw new Error(`missing section: ${heading}`)
  const body = text.slice(start + heading.length)
  const end = body.indexOf('\n## ')
  return end === -1 ? body : body.slice(0, end)
}

// `pnpm compat:upstream` exits 0 while a release is still pending, so a checklist that tells the
// release owner to run the plain command claims a failure that never happens. These tests tie the
// documented command to the form whose exit code actually changes.
describe('documented gate command', () => {
  it('uses the flagged command for the post-promotion check', async () => {
    const checklist = section(await read('../../docs/upstream-compat.md'), '## Release checklist')
    expect(checklist).toContain('pnpm compat:upstream --fail-on-release-drift')
    expect(checklist).toMatch(/exits `0`/)
    expect(checklist).toMatch(/exits `1`/)
  })

  it('does not claim the plain command fails on a pending release', async () => {
    for (const path of ['../../README.md', '../../docs/upstream-compat.md']) {
      const text = await read(path)
      expect(`${path} claims the plain command fails: ${/`pnpm compat:upstream` fails/.test(text)}`)
        .toBe(`${path} claims the plain command fails: false`)
    }
  })

  it('tabulates the exit code of every invocation it recommends', async () => {
    const checks = section(await read('../../docs/upstream-compat.md'), '## The three checks')
    expect(checks).toMatch(/\| `pnpm compat:upstream` \|[^\n]*\| drift \|/)
    expect(checks).toMatch(/\| `pnpm compat:upstream --fail-on-release-drift` \|[^\n]*pending-release[^\n]*\|/)
  })
})
