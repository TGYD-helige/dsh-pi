import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveExtensionEntries } from '../resolver.js'

const piWorkspace = process.env.PI_FIXTURE_WORKSPACE

describe('resolveExtensionEntries', () => {
  it('expands every Pi manifest entry from an explicitly allowed local package', async () => {
    if (piWorkspace === undefined) return
    const entries = await resolveExtensionEntries(
      [`${piWorkspace}/packages/pi-security`],
      { cwd: piWorkspace, allowLocalPaths: true },
    )
    expect(entries).toEqual([`${piWorkspace}/packages/pi-security/dist/extension.js`])
  })

  it('rejects local paths unless the trust boundary is explicitly enabled', async () => {
    if (piWorkspace === undefined) return
    await expect(resolveExtensionEntries(
      [`${piWorkspace}/packages/pi-image-gen`],
      { cwd: piWorkspace, allowLocalPaths: false },
    )).rejects.toThrow(/allowLocalPaths/)
  })

  it('resolves encoded file URLs with spaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-pi resolver '))
    const entry = join(directory, 'extension file.js')
    try {
      await writeFile(entry, '')
      await expect(resolveExtensionEntries(
        [pathToFileURL(entry).href],
        { cwd: directory, allowLocalPaths: true },
      )).resolves.toEqual([entry])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resolves a plain Pi dependency installed in a fresh DSH profile', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'dsh-pi-profile-'))
    const packageRoot = join(profile, 'node_modules/@amaster.ai/pi-image-gen')
    const entry = join(packageRoot, 'dist/index.js')
    try {
      await mkdir(join(packageRoot, 'dist'), { recursive: true })
      await writeFile(join(profile, 'package.json'), '{"private":true}')
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@amaster.ai/pi-image-gen', pi: { extensions: ['./dist/index.js'] },
      }))
      await writeFile(entry, '')

      await expect(resolveExtensionEntries(
        ['@amaster.ai/pi-image-gen'],
        { cwd: profile, baseUrl: pathToFileURL(`${profile}/`).href, allowLocalPaths: false },
      )).resolves.toEqual([await realpath(entry)])
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  })
})
