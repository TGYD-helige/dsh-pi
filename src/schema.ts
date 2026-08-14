import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

const annotations = new Set(['description', 'title', 'default', 'examples'])
const supportedKeywords = new Set([
  'type', 'oneOf', 'anyOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  ...annotations,
])

function isDisjointLiteralUnion(branches: unknown[]): boolean {
  const values = new Set<unknown>()
  for (const branch of branches) {
    if (typeof branch !== 'object' || branch === null || Array.isArray(branch) || !('const' in branch)) return false
    const value = (branch as Record<string, unknown>).const
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return false
    if (typeof value === 'number' && !Number.isFinite(value)) return false
    if (values.has(value)) return false
    values.add(value)
  }
  return branches.length > 0
}

function convert(value: unknown, path: string): JsonSchemaNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a JSON Schema object`)
  }
  const input = value as Record<string, unknown>
  for (const keyword of Object.keys(input)) {
    if (!supportedKeywords.has(keyword)) {
      throw new TypeError(`${path}.${keyword} cannot be represented by the DSH tool schema subset`)
    }
  }

  const output: Record<string, unknown> = {}
  if (input.type !== undefined) output.type = structuredClone(input.type)
  const union = input.oneOf ?? input.anyOf
  if (input.anyOf !== undefined && (!Array.isArray(input.anyOf) || input.oneOf !== undefined || !isDisjointLiteralUnion(input.anyOf))) {
    throw new TypeError(`${path}.anyOf cannot be represented by the DSH tool schema subset`)
  }
  if (input.oneOf !== undefined && !Array.isArray(input.oneOf)) {
    throw new TypeError(`${path}.oneOf must be an array`)
  }
  if (Array.isArray(union)) {
    const keyword = input.oneOf === undefined ? 'anyOf' : 'oneOf'
    output.oneOf = union.map((branch, index) => convert(branch, `${path}.${keyword}[${index}]`))
  }
  if (input.properties !== undefined) {
    if (typeof input.properties !== 'object' || input.properties === null || Array.isArray(input.properties)) {
      throw new TypeError(`${path}.properties must be an object`)
    }
    output.properties = Object.fromEntries(Object.entries(input.properties)
      .map(([name, property]) => [name, convert(property, `${path}.properties.${name}`)]))
  }
  if (input.required !== undefined) output.required = structuredClone(input.required)
  if (input.additionalProperties !== undefined) output.additionalProperties = structuredClone(input.additionalProperties)
  if (input.items !== undefined) output.items = convert(input.items, `${path}.items`)
  if (input.enum !== undefined) output.enum = structuredClone(input.enum)
  if (Object.hasOwn(input, 'const')) output.const = structuredClone(input.const)
  for (const key of annotations) {
    if (input[key] !== undefined) output[key] = structuredClone(input[key])
  }
  return output as JsonSchemaNode
}

/** Project a TypeBox schema onto the strict JSON Schema subset accepted by DSH tools. */
export function toDshParameters(schema: unknown): ObjectJsonSchema {
  const converted = convert(schema, '$')
  assertObjectJsonSchema(converted)
  return converted
}
