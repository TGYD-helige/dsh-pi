import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ResolveOptions {
  cwd: string
  baseUrl?: string
  allowLocalPaths: boolean
}

interface PiManifest {
  name?: string
  pi?: { extensions?: string[] }
}

const isPathSpecifier = (value: string) => value.startsWith('.') || value.startsWith('/') || value.startsWith('file:')

function requireFrom(options: ResolveOptions) {
  if (options.baseUrl?.startsWith('file:') === true) return createRequire(options.baseUrl)
  const anchor = options.baseUrl === undefined
    ? join(options.cwd, 'package.json')
    : isAbsolute(options.baseUrl) ? options.baseUrl : resolve(options.cwd, options.baseUrl)
  return createRequire(anchor)
}

async function packageManifestPath(specifier: string, options: ResolveOptions): Promise<string> {
  if (isPathSpecifier(specifier)) {
    if (!options.allowLocalPaths) throw new Error(`Local Pi extension paths require allowLocalPaths: true (${specifier})`)
    const local = specifier.startsWith('file:') ? fileURLToPath(specifier) : resolve(options.cwd, specifier)
    const info = await stat(local)
    return info.isDirectory() ? join(local, 'package.json') : local
  }
  const loader = requireFrom(options)
  try {
    return loader.resolve(`${specifier}/package.json`)
  } catch {
    let current = dirname(loader.resolve(specifier))
    while (dirname(current) !== current) {
      const candidate = join(current, 'package.json')
      try {
        const manifest = JSON.parse(await readFile(candidate, 'utf8')) as PiManifest
        if (manifest.name === specifier) return candidate
      } catch {}
      current = dirname(current)
    }
    throw new Error(`Cannot resolve package manifest for Pi extension: ${specifier}`)
  }
}

/** Resolve package manifests to concrete Pi extension entry files. */
export async function resolveExtensionEntries(specifiers: string[], options: ResolveOptions): Promise<string[]> {
  const entries: string[] = []
  for (const specifier of specifiers) {
    if (isPathSpecifier(specifier) && options.allowLocalPaths) {
      const local = specifier.startsWith('file:') ? fileURLToPath(specifier) : resolve(options.cwd, specifier)
      if (!(await stat(local)).isDirectory()) {
        entries.push(local)
        continue
      }
    }
    const manifestPath = await packageManifestPath(specifier, options)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PiManifest
    const declared = manifest.pi?.extensions
    if (declared === undefined || declared.length === 0) {
      throw new Error(`${manifest.name ?? specifier} does not declare pi.extensions`)
    }
    entries.push(...declared.map(entry => resolve(dirname(manifestPath), entry)))
  }
  return [...new Set(entries)]
}
