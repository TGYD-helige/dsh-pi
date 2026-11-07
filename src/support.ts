/**
 * Declared upstream support for this host, in one machine-readable place.
 *
 * `README.md`, `docs/compatibility.md`, `package.json`, and the upstream compatibility gate
 * (`scripts/upstream-compat.ts`) must agree with this declaration.
 * `src/__tests__/support.test.ts` fails when they drift.
 */
export interface Upstream {
  /** npm package that provides the upstream contract. */
  package: string
  /** Exact version this repository builds, tests, and ships against. */
  pinned: string
  /** Declared support range, written for humans and reproduced in the docs. */
  range: string
  /** Major/minor of the newest release line accepted by `range`. */
  newest: { major: number; minor: number }
}

export const SUPPORTED_UPSTREAMS = {
  pi: {
    package: '@earendil-works/pi-coding-agent',
    pinned: '1.5.0',
    range: '>=1.5.0 <2.0.0',
    newest: { major: 1, minor: 5 },
  },
  dsh: {
    package: '@deepseek-ai/dsh',
    pinned: '0.1.5-rc.2',
    range: '0.1.5-rc.2',
    newest: { major: 0, minor: 1 },
  },
} as const satisfies Record<string, Upstream>

/** Node.js floor declared in `package.json#engines` and in the user-facing support table. */
export const SUPPORTED_NODE = '>=22.19.0'

/** pnpm version used by the release and compatibility workflows. */
export const SUPPORTED_PNPM = '10.28.2'

/**
 * Pi `1.x` replaced the `before_agent_start` call contract and added required fields to the
 * tool, context-action, and boundary-event types. This host is built against that contract, so
 * the `0.80.x` line is out of range: loading it would fail at runtime instead of degrading.
 */
export const PI_CONTRACT = 'trigger + normalized system-prompt options (Pi 1.x)'
interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string | undefined
}

function parseVersion(version: string): ParsedVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/u.exec(version)
  if (match === null) throw new Error(`Unsupported version format: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

/** Compare two dotted versions, treating a release as newer than any of its prereleases. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/**
 * Whether a resolved Pi version is inside the declared support range.
 *
 * A DSH profile can hoist or override `@earendil-works/pi-coding-agent` to a version this host was
 * not built for. That install still loads and still mounts tools, then fails later inside a tool
 * call or an event handler, so the host checks the loaded version instead of trusting the manifest.
 */
export function isSupportedPiVersion(version: string): boolean {
  // The declaration is a lower bound plus an exclusive major bound, e.g. ">=1.5.0 <2.0.0".
  const bounds = /^>=(\d+\.\d+\.\d+) <(\d+)\.\d+\.\d+$/u.exec(SUPPORTED_UPSTREAMS.pi.range)
  const lower = bounds?.[1]
  const upperMajor = bounds?.[2]
  if (lower === undefined || upperMajor === undefined) {
    throw new Error(`Unsupported Pi support range: ${SUPPORTED_UPSTREAMS.pi.range}`)
  }
  return compareVersions(version, lower) >= 0 && parseVersion(version).major < Number(upperMajor)
}
