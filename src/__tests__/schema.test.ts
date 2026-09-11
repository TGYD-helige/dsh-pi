import { describe, expect, it } from 'vitest'
import { toDshParameters } from '../schema.js'

describe('toDshParameters', () => {
  it('keeps the DSH JSON Schema subset', () => {
    expect(toDshParameters({
      type: 'object',
      properties: {
        count: { type: 'integer' },
        mode: { oneOf: [{ const: 'fast', type: 'string' }, { const: 'safe', type: 'string' }] },
      },
      required: ['count'],
      additionalProperties: false,
    })).toEqual({
      type: 'object',
      properties: {
        count: { type: 'integer' },
        mode: { oneOf: [{ const: 'fast', type: 'string' }, { const: 'safe', type: 'string' }] },
      },
      required: ['count'],
      additionalProperties: false,
    })
  })

  it('fails rather than publishing schemas whose meaning cannot be preserved', () => {
    expect(() => toDshParameters({ $ref: '#/$defs/Input', $defs: { Input: { type: 'object' } } }))
      .toThrow(/\$ref/)
  })

  it('rejects validation constraints that DSH cannot enforce', () => {
    expect(() => toDshParameters({
      type: 'object', properties: { name: { type: 'string', minLength: 1 } },
    })).toThrow(/minLength/)
    expect(() => toDshParameters({
      type: 'object', properties: { name: { type: 'string', pattern: '^a' } },
    })).toThrow(/pattern/)
  })

  it('drops the $schema draft marker without failing', () => {
    expect(toDshParameters({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { url: { type: 'string' } },
    })).toEqual({
      type: 'object',
      properties: { url: { type: 'string' } },
    })
  })

  it('passes numeric bounds through to the model-facing schema', () => {
    expect(toDshParameters({
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 10 },
        ratio: { type: 'number', exclusiveMinimum: 0 },
        items: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    })).toEqual({
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 10 },
        ratio: { type: 'number', exclusiveMinimum: 0 },
        items: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    })
  })

  it('rejects anyOf instead of narrowing overlapping alternatives to oneOf', () => {
    expect(() => toDshParameters({
      type: 'object',
      properties: { value: { anyOf: [{ type: 'number' }, { type: 'integer' }] } },
    })).toThrow(/anyOf/)
  })

  it('preserves mutually exclusive TypeBox literal unions', () => {
    expect(toDshParameters({
      type: 'object',
      properties: {
        target: {
          anyOf: [
            { const: 'memory', type: 'string' },
            { const: 'user', type: 'string' },
          ],
          description: 'Memory target',
        },
      },
    })).toEqual({
      type: 'object',
      properties: {
        target: {
          oneOf: [
            { const: 'memory', type: 'string' },
            { const: 'user', type: 'string' },
          ],
          description: 'Memory target',
        },
      },
    })
  })
})
