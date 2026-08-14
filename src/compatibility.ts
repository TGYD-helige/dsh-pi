import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface PackageInventory {
  name: string
  path: string
  extensionEntries: string[]
  extensionApiMethods: string[]
  extensionContextMembers: string[]
  extensionEvents: string[]
}

export interface WorkspaceInventory {
  workspace: string
  packages: PackageInventory[]
  extensionApiMethods: string[]
  extensionContextMembers: string[]
  extensionEvents: string[]
}

async function sourceFiles(directory: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await sourceFiles(path))
    else if (/\.[cm]?[jt]sx?$/u.test(entry.name) && !entry.name.endsWith('.test.ts')) output.push(path)
  }
  return output
}

function matches(text: string, expression: RegExp): string[] {
  return [...text.matchAll(expression)].map(match => match[1]).filter((value): value is string => value !== undefined)
}

/** Build a read-only inventory of Pi packages; it never imports or changes fixture code. */
export async function inventoryWorkspace(workspace: string): Promise<WorkspaceInventory> {
  const packagesRoot = join(workspace, 'packages')
  const packages: PackageInventory[] = []
  for (const directory of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!directory.isDirectory() || !directory.name.startsWith('pi-')) continue
    const path = join(packagesRoot, directory.name)
    let manifest: { name?: string; pi?: { extensions?: string[] } }
    try {
      manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as typeof manifest
    } catch {
      continue
    }
    const texts = await Promise.all((await sourceFiles(join(path, 'src'))).map(file => readFile(file, 'utf8')))
    const text = texts.join('\n')
    const methods = new Set(matches(text, /\b(?:pi|api)\.(registerTool|registerCommand|registerShortcut|registerFlag|getFlag|registerMessageRenderer|registerEntryRenderer|sendMessage|sendUserMessage|appendEntry|setSessionName|getSessionName|setLabel|exec|getActiveTools|getAllTools|setActiveTools|getCommands|setModel|getThinkingLevel|setThinkingLevel|registerProvider|unregisterProvider)\b/gu))
    const contextMembers = new Set(matches(text, /\b(?:ctx|context)\.(ui|mode|hasUI|cwd|sessionManager|modelRegistry|model|isIdle|isProjectTrusted|signal|abort|hasPendingMessages|shutdown|getContextUsage|compact|getSystemPrompt|getSystemPromptOptions|waitForIdle|newSession|fork|navigateTree|switchSession|reload)\b/gu))
    const events = new Set(matches(text, /\b(?:pi|api)\.on\(\s*['"]([^'"]+)['"]/gu))
    packages.push({
      name: manifest.name ?? directory.name,
      path,
      extensionEntries: manifest.pi?.extensions ?? [],
      extensionApiMethods: [...methods].sort(),
      extensionContextMembers: [...contextMembers].sort(),
      extensionEvents: [...events].sort(),
    })
  }
  packages.sort((left, right) => left.name.localeCompare(right.name))
  return {
    workspace,
    packages,
    extensionApiMethods: [...new Set(packages.flatMap(item => item.extensionApiMethods))].sort(),
    extensionContextMembers: [...new Set(packages.flatMap(item => item.extensionContextMembers))].sort(),
    extensionEvents: [...new Set(packages.flatMap(item => item.extensionEvents))].sort(),
  }
}
