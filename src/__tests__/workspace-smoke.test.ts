import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createDshToolDefinition } from '../dsh-adapter.js'
import { PiExtensionRuntime } from '../runtime.js'

describe('current Pi workspace smoke', () => {
  it('loads representative built extensions through the public runtime seam', async () => {
    const workspace = process.env.PI_FIXTURE_WORKSPACE
    if (workspace === undefined) return
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const cases = [
      { package: 'pi-image-gen', entry: 'dist/index.js', tools: ['image_generate'], commands: ['image-gen'] },
      {
        package: 'pi-video-gen', entry: 'dist/index.js',
        tools: ['video_generate', 'video_compose', 'video_render', 'video_capabilities'], commands: ['video-gen'],
        unsupported: ['video_generate'],
      },
      { package: 'pi-goal', entry: 'dist/index.js', tools: [], commands: ['goal'] },
      {
        package: 'pi-memory', entry: 'dist/index.js',
        tools: ['memory_add', 'memory_replace', 'memory_remove', 'memory_read'], commands: ['memory'],
      },
      {
        package: 'pi-task-scheduler', entry: 'dist/index.js',
        tools: ['scheduler_create', 'scheduler_list', 'scheduler_get', 'scheduler_update', 'scheduler_delete', 'scheduler_run_now'],
        commands: ['cron'],
      },
      { package: 'pi-channels', entry: 'dist/index.js', tools: ['notify'], commands: ['channel'] },
    ]

    for (const fixture of cases) {
      const runtime = await PiExtensionRuntime.fromPaths([
        resolve(workspace, 'packages', fixture.package, fixture.entry),
      ], { cwd: workspace, projectTrusted: false })
      await runtime.start('startup')
      expect(runtime.tools().map(tool => tool.name)).toEqual(fixture.tools)
      expect(runtime.commands().map(command => command.invocationName)).toEqual(fixture.commands)
      for (const tool of runtime.tools()) {
        const adapt = () => createDshToolDefinition({
          tool, execute: async () => ({ content: [{ type: 'text', text: 'unused' }], details: {} }),
        })
        if (fixture.unsupported?.includes(tool.name) === true) {
          expect(adapt).toThrow(/cannot be represented/)
          continue
        }
        const definition = adapt()
        const dispose = ctx.tools.register(definition)
        expect(ctx.tools.schemas().some(schema => schema.name === tool.name)).toBe(true)
        dispose()
      }
      await runtime.shutdown()
    }
  })
})
