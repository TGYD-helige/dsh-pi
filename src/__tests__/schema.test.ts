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
      type: 'object', properties: { count: { type: 'integer', minimum: 1 } },
    })).toThrow(/minimum/)
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
