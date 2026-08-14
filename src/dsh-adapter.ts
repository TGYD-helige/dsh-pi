import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition as DshToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { AgentToolResult, ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from '@earendil-works/pi-coding-agent'
import { toDshParameters } from './schema.js'

interface CanonicalToolValue {
  content: ContentBlock[]
  details?: JsonValue
  terminate?: true
}

export interface DshToolAdapterOptions {
  tool: PiToolDefinition
  execute(args: unknown, options: { callId: string; signal: AbortSignal }): Promise<AgentToolResult<unknown> & {
    isError?: boolean
    aborted?: true
  }>
  saveImage?(input: { data: Uint8Array; mediaType: ImageMediaType }): Promise<ImageAttachmentRef>
  imageLimits?: ImageAttachmentLimits
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || Buffer.byteLength(serialized) > DEFAULT_MAX_BYTES) return undefined
    return JSON.parse(serialized) as JsonValue
  } catch {
    return undefined
  }
}

function errorText(result: AgentToolResult<unknown>): string {
  const text = result.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return truncateHead(text || 'Pi tool execution failed').content || 'Pi tool execution failed'
}

function boundedContent(content: AgentToolResult<unknown>['content']): AgentToolResult<unknown>['content'] {
  const output: AgentToolResult<unknown>['content'] = []
  let maxBytes = DEFAULT_MAX_BYTES
  let maxLines = DEFAULT_MAX_LINES
  for (const block of content) {
    if (block.type !== 'text') {
      output.push(block)
      continue
    }
    if (maxBytes <= 0 || maxLines <= 0) continue
    const truncated = truncateHead(block.text, { maxBytes, maxLines })
    if (truncated.content.length > 0) output.push({ type: 'text', text: truncated.content })
    maxBytes -= truncated.outputBytes
    maxLines -= truncated.outputLines
  }
  return output
}

export async function piContentToDsh(
  content: AgentToolResult<unknown>['content'],
  saveImage: DshToolAdapterOptions['saveImage'],
  imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 20 * 1024 * 1024,
    maxImagePixels: Number.MAX_SAFE_INTEGER,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
): Promise<ContentBlock[]> {
  const output: ContentBlock[] = []
  let imageBytes = 0
  let imageCount = 0
  for (const block of content) {
    if (block.type === 'text') {
      output.push({ type: 'text', text: block.text })
      continue
    }
    if (saveImage === undefined) {
      throw new Error('Pi tool returned an image but the DSH attachment service is unavailable')
    }
    const mediaType = block.mimeType as ImageMediaType
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)
      || !imageLimits.mediaTypes.includes(mediaType)) {
      throw new Error(`Unsupported Pi image media type: ${block.mimeType}`)
    }
    const bytes = Buffer.byteLength(block.data, 'base64')
    imageBytes += bytes
    imageCount += 1
    if (bytes > imageLimits.maxImageBytes
      || imageBytes > imageLimits.maxMessageImageBytes
      || imageCount > imageLimits.maxImagesPerMessage) {
      throw new Error('Pi image exceeds DSH attachment limits')
    }
    try {
      output.push({
        type: 'image',
        attachment: await saveImage({ data: Buffer.from(block.data, 'base64'), mediaType }),
      })
    } catch {
      throw new Error('Failed to persist Pi image attachment')
    }
  }
  return output
}

const outputSchema = {
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
    details: {},
    terminate: { type: 'boolean' },
  },
  required: ['content'] as string[],
  additionalProperties: false,
} as const

/** Adapt one Pi tool into DSH's canonical execute + pure render contract. */
export function createDshToolDefinition(options: DshToolAdapterOptions): DshToolDefinition {
  return {
    name: options.tool.name,
    description: options.tool.description,
    parameters: toDshParameters(options.tool.parameters) as unknown as Record<string, unknown>,
    output: {
      schema: outputSchema,
      render: (_args, value) => (value as unknown as CanonicalToolValue).content,
    },
    ...(options.tool.executionMode === 'parallel' ? { isConcurrencySafe: () => true } : {}),
    async execute(args, exec): Promise<CanonicalToolValue> {
      const result = await options.execute(args, { callId: String(exec.callId), signal: exec.signal })
      if (result.aborted === true) return { content: [] }
      if (result.isError === true) throw new Error(errorText(result))
      if (result.terminate === true) exec.concludeTurn()
      const details = jsonValue(result.details)
      return {
        content: await piContentToDsh(boundedContent(result.content), options.saveImage, options.imageLimits),
        ...(details === undefined ? {} : { details }),
        ...(result.terminate === true ? { terminate: true } : {}),
      }
    },
  }
}
