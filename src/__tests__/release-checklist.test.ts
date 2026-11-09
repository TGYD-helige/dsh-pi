import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { distTagFor, exitCodeFor, ownReleaseFindings } from '../../scripts/upstream-compat.js'

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

const strict = { failOnReleaseDrift: true, failOnUpstream: false }
const plain = { failOnReleaseDrift: false, failOnUpstream: false }
const nonOk = (findings: ReturnType<typeof ownReleaseFindings>) =>
  findings.filter(item => item.status !== 'ok').map(item => `${item.status}: ${item.detail}`)
const blocking = (version: string, distTags: Record<string, string>) =>
  nonOk(ownReleaseFindings({ version, distTags }))

/** The markdown body of one `## ` section, so an assertion cannot be satisfied elsewhere. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start === -1) throw new Error(`missing section: ${heading}`)
  const body = text.slice(start + heading.length)
  const end = body.indexOf('\n## ')
  return end === -1 ? body : body.slice(0, end)
}

// The release checklist promotes `next` for a prerelease, so the gate must not also demand that a
// prerelease be `latest`: `npm publish` does not move `latest` for a prerelease, and the previous
// release stays reachable there. These tests pin that decision to the statuses and exit codes
// instead of to the prose that describes them.
describe('own-release gate', () => {
  it('promotes `next` for a prerelease and `latest` for a stable version', () => {
    expect(distTagFor('0.1.0-rc.4')).toBe('next')
    expect(distTagFor('1.0.0')).toBe('latest')
  })

  it('passes a prerelease whose `next` is promoted even though `latest` is older', () => {
    const findings = ownReleaseFindings({ version: '0.1.0-rc.4', distTags: { next: '0.1.0-rc.4', latest: '0.1.0-rc.2' } })
    expect(blocking('0.1.0-rc.4', { next: '0.1.0-rc.4', latest: '0.1.0-rc.2' })).toEqual([])
    expect(exitCodeFor(findings, strict)).toBe(0)
  })

  it('still fails a prerelease whose `next` lags behind', () => {
    const tags = { next: '0.1.0-rc.3', latest: '0.1.0-rc.2' }
    const findings = ownReleaseFindings({ version: '0.1.0-rc.4', distTags: tags })
    expect(blocking('0.1.0-rc.4', tags)).toHaveLength(1)
    expect(blocking('0.1.0-rc.4', tags)[0]).toMatch(/^pending-release: npm `next` is 0\.1\.0-rc\.3/)
    expect(exitCodeFor(findings, strict)).toBe(1)
    expect(exitCodeFor(findings, plain)).toBe(0)
  })

  it('fails a prerelease that was never published to `next`', () => {
    const tags = { latest: '0.1.0-rc.2' }
    expect(blocking('0.1.0-rc.4', tags)).toEqual([
      'pending-release: npm `next` is missing, repository is 0.1.0-rc.4',
    ])
    expect(exitCodeFor(ownReleaseFindings({ version: '0.1.0-rc.4', distTags: tags }), strict)).toBe(1)
  })

  it('compares `latest` for a stable version', () => {
    const promoted = ownReleaseFindings({ version: '1.0.0', distTags: { latest: '1.0.0', next: '0.1.0-rc.4' } })
    expect(nonOk(promoted)).toEqual([])
    expect(exitCodeFor(promoted, strict)).toBe(0)

    const behind = ownReleaseFindings({ version: '1.0.0', distTags: { latest: '0.9.0' } })
    expect(behind.filter(item => item.status === 'pending-release').map(item => item.detail))
      .toEqual(['npm `latest` is 0.9.0, repository is 1.0.0'])
    expect(exitCodeFor(behind, strict)).toBe(1)
  })

  it('keeps drift and notice exit codes independent of the release flags', () => {
    const drift = ownReleaseFindings({ version: '0.1.0-rc.4', distTags: { next: '0.1.0-rc.3', latest: '0.1.0-rc.2' } })
    expect(exitCodeFor([...drift, { status: 'drift', scope: 'DSH', detail: 'pin mismatch' }], plain)).toBe(1)
    expect(exitCodeFor([...drift, { status: 'notice', scope: 'Pi coding agent', detail: 'newer line' }], plain)).toBe(0)
    expect(exitCodeFor([...drift, { status: 'notice', scope: 'Pi coding agent', detail: 'newer line' }], { failOnReleaseDrift: false, failOnUpstream: true })).toBe(2)
  })
})

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

  it('promotes the tag each release line actually moves', async () => {
    const checklist = section(await read('../../docs/upstream-compat.md'), '## Release checklist')
    expect(checklist).toMatch(/npm dist-tag add dsh-pi-host@<version> next\b[^\n]*`latest` for a stable version/)
    const readme = await read('../../README.md')
    expect(readme).toMatch(/npm dist-tag add dsh-pi-host@<version> next\b[^\n]*`latest` for a stable version/)
  })
})
