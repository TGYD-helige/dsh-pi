import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_NODE, SUPPORTED_UPSTREAMS } from '../support.js'

interface Manifest {
  version: string
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  engines: { node: string }
}

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
const manifest = async () => JSON.parse(await read('../../package.json')) as Manifest

describe('declared upstream support', () => {
  it('matches the package manifest pins, peers, and engines', async () => {
    const current = await manifest()
    expect(current.dependencies[SUPPORTED_UPSTREAMS.pi.package]).toBe(SUPPORTED_UPSTREAMS.pi.pinned)
    expect(current.dependencies['@deepseek-ai/dsh-llm']).toBe(SUPPORTED_UPSTREAMS.dsh.pinned)
    expect(current.engines.node).toBe(SUPPORTED_NODE)
    const peers = Object.entries(current.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(peers.length).toBeGreaterThan(0)
    for (const [name, range] of peers) {
      expect(`${name}: ${range}`).toBe(`${name}: ^${SUPPORTED_UPSTREAMS.dsh.pinned}`)
    }
  })

  it('is declared in the README and the compatibility matrix', async () => {
    const declared = [
      SUPPORTED_UPSTREAMS.pi.range,
      SUPPORTED_UPSTREAMS.pi.pinned,
      SUPPORTED_UPSTREAMS.dsh.pinned,
      SUPPORTED_NODE,
    ]
    for (const file of ['../../README.md', '../../docs/compatibility.md']) {
      const text = await read(file)
      for (const value of declared) expect(`${file} declares ${value}: ${text.includes(value)}`).toBe(`${file} declares ${value}: true`)
    }
  })

  // The install command is what a new user copies. If it is not pinned to this version, the
  // default install silently serves whatever `latest` happens to be, which is the defect this
  // declaration exists to prevent.
  it('pins the documented install command to the package version', async () => {
    const current = await manifest()
    const readme = await read('../../README.md')
    expect(readme).toContain(`dsh plugin --profile demo add dsh-pi-host@${current.version}`)
    expect(readme).not.toMatch(/dsh plugin --profile demo add dsh-pi-host \\?\n/)
  })
})

describe('Pi version gate', () => {
  it('accepts the supported range and rejects everything else', async () => {
    const { isSupportedPiVersion } = await import('../support.js')
    for (const version of ['1.5.0', '1.5.1', '1.9.4']) {
      expect(`1.x ${version}: ${isSupportedPiVersion(version)}`).toBe(`1.x ${version}: true`)
    }
    // 0.80.x still loads and still mounts tools, so the version check is the only thing that
    // refuses it before a tool call or event handler fails at the wrong layer.
    for (const version of ['0.80.10', '1.4.9', '2.0.0', '2.0.0-rc.1']) {
      expect(`rejected ${version}: ${isSupportedPiVersion(version)}`).toBe(`rejected ${version}: false`)
    }
  })
})
