/**
 * Upstream compatibility gate — read-only registry and declaration checks.
 *
 * Findings are separated by who has to act:
 *
 *   drift            this repository contradicts itself or the declared support range.
 *                    Exit 1: fix the manifest, the pin, or the declaration.
 *   pending-release  this version is not on the dist-tag its release line promotes. A stable
 *                    version promotes `latest`, a prerelease promotes `next` and leaves `latest`
 *                    on the previous release. Expected before a release; exit 1 only with
 *                    `--fail-on-release-drift`, which the release checklist uses after promoting.
 *   notice           upstream published a release outside the declared range. An evaluation
 *                    decision, never an automatic bump. Exit 2 with `--fail-on-upstream`.
 *
 * Usage: pnpm compat:upstream [--fail-on-release-drift] [--fail-on-upstream]
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { SUPPORTED_NODE, SUPPORTED_UPSTREAMS, type Upstream } from '../src/support.js'

interface Release {
  major: number
  minor: number
  patch: number
  prerelease: string | undefined
}

function parse(version: string): Release {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version)
  if (match === null) throw new Error(`Unsupported version format: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

function compare(left: string, right: string): number {
  const a = parse(left)
  const b = parse(right)
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

const sameLine = (version: string, line: { major: number; minor: number }) => {
  const release = parse(version)
  return release.major === line.major && release.minor === line.minor
}

export type Status = 'ok' | 'drift' | 'pending-release' | 'notice'

export interface Finding {
  status: Status
  scope: string
  detail: string
}

/** npm puts prereleases on `next` and stable versions on `latest`; `release.yml` does the same. */
export const distTagFor = (version: string) => version.includes('-') ? 'next' : 'latest'

export interface OwnReleaseInput {
  version: string
  distTags: Record<string, string | undefined>
}

/**
 * Own-release findings for one repository version and the registry's dist-tags.
 *
 * Only the tag this release line promotes is compared against `version`. A prerelease is published
 * to `next`, and `npm publish` does not move `latest` for it, so `latest` still resolving to the
 * previous release is the expected state until a stable version ships — not a pending release. A
 * stable version does land on `latest`, which is also the default install, so that tag is compared
 * there.
 */
export function ownReleaseFindings({ version, distTags }: OwnReleaseInput): Finding[] {
  const findings: Finding[] = []
  const expectedTag = distTagFor(version)
  const promoted = distTags[expectedTag]
  if (promoted === version) {
    findings.push({ status: 'ok', scope: 'own release', detail: `npm \`${expectedTag}\` is ${version}` })
  } else {
    findings.push({ status: 'pending-release', scope: 'own release', detail: `npm \`${expectedTag}\` is ${promoted ?? 'missing'}, repository is ${version}` })
  }

  const defaultInstall = distTags.latest
  if (expectedTag === 'latest') {
    findings.push({ status: 'ok', scope: 'own release', detail: '`latest` is both the promotion target and the default install for a stable version' })
  } else if (defaultInstall === version) {
    findings.push({ status: 'ok', scope: 'own release', detail: `npm \`latest\` also resolves to ${version}` })
  } else {
    findings.push({ status: 'ok', scope: 'own release', detail: `npm \`latest\` stays at ${defaultInstall ?? 'nothing published'}; a prerelease promotes \`next\` only, so the default install is expected to differ` })
  }

  findings.push({ status: 'ok', scope: 'own release', detail: `publishing ${version} would set dist-tag \`${expectedTag}\`; verify with \`npm view dsh-pi-host dist-tags\`` })
  return findings
}

export interface GateFlags {
  failOnReleaseDrift: boolean
  failOnUpstream: boolean
}

/** Exit code of a finished report: drift always fails, the other two statuses only when flagged. */
export function exitCodeFor(findings: readonly Finding[], flags: GateFlags): number {
  const count = (status: Status) => findings.filter(item => item.status === status).length
  if (count('drift') > 0) return 1
  if (count('pending-release') > 0 && flags.failOnReleaseDrift) return 1
  if (count('notice') > 0 && flags.failOnUpstream) return 2
  return 0
}

interface RegistryDocument {
  'dist-tags': Record<string, string>
  versions: Record<string, { deprecated?: string }>
}

async function registry(pkg: string): Promise<RegistryDocument> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${pkg}: registry returned ${response.status}`)
  return await response.json() as RegistryDocument
}

const findings: Finding[] = []
const add = (status: Status, scope: string, detail: string) => { findings.push({ status, scope, detail }) }

async function checkOwnRelease(version: string): Promise<void> {
  const document = await registry('dsh-pi-host')
  findings.push(...ownReleaseFindings({ version, distTags: document['dist-tags'] }))
}

async function checkUpstream(label: string, upstream: Upstream, dependency: string | undefined): Promise<void> {
  const document = await registry(upstream.package)
  const latest = document['dist-tags'].latest ?? ''
  const pinned = document.versions[upstream.pinned]

  if (dependency !== upstream.pinned) add('drift', label, `package.json pins ${dependency ?? 'nothing'}, declaration pins ${upstream.pinned}`)
  else add('ok', label, `package.json pins ${upstream.pinned}`)

  if (pinned === undefined) add('drift', label, `${upstream.pinned} is not published`)
  else if (pinned.deprecated !== undefined) add('drift', label, `${upstream.pinned} is deprecated: ${pinned.deprecated}`)
  else add('ok', label, `${upstream.pinned} is published and not deprecated`)

  // An exact pin has no "newer release inside the range": anything else is a different version
  // and therefore a range decision, which the notice row below reports.
  if (upstream.range === upstream.pinned) {
    add('ok', label, `range is the exact pinned release ${upstream.pinned}; newer releases need a range decision`)
  } else {
    const newerInsideRange = Object.keys(document.versions)
      .filter(version => sameLine(version, upstream.newest))
      .filter(version => compare(version, upstream.pinned) > 0)
    if (newerInsideRange.length === 0) add('ok', label, `no release newer than ${upstream.pinned} inside ${upstream.range}`)
    else add('drift', label, `newer release inside ${upstream.range}: ${newerInsideRange.join(', ')} — verify it, then bump the pin and src/support.ts`)
  }

  if (latest === '' || sameLine(latest, upstream.newest)) return
  const direction = compare(latest, upstream.pinned) > 0 ? 'newer line' : 'older line'
  add('notice', label, `registry latest is ${latest} (${direction} than declared ${upstream.range}) — evaluate, do not auto-bump`)
}

async function main(): Promise<void> {
  const failOnReleaseDrift = process.argv.includes('--fail-on-release-drift')
  const failOnUpstream = process.argv.includes('--fail-on-upstream')
  const repoRoot = new URL('../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', repoRoot), 'utf8')) as {
    version: string
    dependencies: Record<string, string>
    peerDependencies: Record<string, string>
    engines: { node: string }
  }

  await checkOwnRelease(manifest.version)
  await checkUpstream('Pi coding agent', SUPPORTED_UPSTREAMS.pi, manifest.dependencies[SUPPORTED_UPSTREAMS.pi.package])
  await checkUpstream('DSH', SUPPORTED_UPSTREAMS.dsh, manifest.dependencies['@deepseek-ai/dsh-llm'])

  const dshPeers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  const pinnedPeerRange = `^${SUPPORTED_UPSTREAMS.dsh.pinned}`
  const driftedPeers = dshPeers.filter(([, range]) => range !== pinnedPeerRange)
  if (dshPeers.length === 0) add('drift', 'DSH', 'no @deepseek-ai/dsh-* peer dependencies declared')
  else if (driftedPeers.length === 0) add('ok', 'DSH', `${dshPeers.length} peers use ${pinnedPeerRange}`)
  else add('drift', 'DSH', `peers must use ${pinnedPeerRange}: ${driftedPeers.map(([name, range]) => `${name}@${range}`).join(', ')}`)

  if (manifest.engines.node === SUPPORTED_NODE) add('ok', 'Node.js', `engines.node is ${SUPPORTED_NODE}`)
  else add('drift', 'Node.js', `engines.node is ${manifest.engines.node}, declaration is ${SUPPORTED_NODE}`)

  const drift = findings.filter(item => item.status === 'drift')
  const pending = findings.filter(item => item.status === 'pending-release')
  const notices = findings.filter(item => item.status === 'notice')
  console.log('# Upstream compatibility report\n')
  console.log('| Area | Status | Detail |')
  console.log('|---|---|---|')
  for (const item of findings) console.log(`| ${item.scope} | ${item.status} | ${item.detail} |`)
  console.log(`\nRepository: \`dsh-pi-host@${manifest.version}\`. Drift: ${drift.length}. Pending release: ${pending.length}. Upstream notices: ${notices.length}.`)
  if (drift.length > 0) console.log('\nAction required: `drift` rows contradict the repository or the declared support.')
  if (pending.length > 0) console.log('`pending-release` rows resolve when this version is published and the dist-tag its release line promotes is moved; see docs/upstream-compat.md#release-checklist.')
  if (notices.length > 0) console.log('Notices need an evaluation decision; see docs/upstream-compat.md.')

  process.exitCode = exitCodeFor(findings, { failOnReleaseDrift, failOnUpstream })
}

// `pnpm compat:upstream` runs the gate; a test importing the pure helpers must not hit the registry.
// Every invocation outside a test runner is treated as the gate, so a stale path check can never
// make the CI step pass by doing nothing.
const invokedAsGate = process.env['VITEST'] === undefined
  || (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url)

if (invokedAsGate) await main()
