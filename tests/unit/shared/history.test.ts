import { ZodError } from 'zod'
import { describe, expect, it } from 'vitest'

import { historyEntrySchema, parseHistoryEntry, type HistoryEntry } from '../../../src/shared/history'

const validEntry = {
  id: 'entry-1',
  text: 'Hello from Sotto.',
  createdAt: 1_725_000_000_000,
  durationMs: 2_450,
  language: 'en',
  modelPreset: 'balanced',
} satisfies HistoryEntry

describe('history entry contract', () => {
  it('accepts entries produced by the instant preset', () => {
    expect(parseHistoryEntry({ ...validEntry, modelPreset: 'instant' }).modelPreset).toBe('instant')
  })

  it('parses exactly the persisted transcript fields', () => {
    expect(parseHistoryEntry(validEntry)).toEqual(validEntry)
    expect(Object.keys(historyEntrySchema.parse(validEntry))).toEqual([
      'id',
      'text',
      'createdAt',
      'durationMs',
      'language',
      'modelPreset',
    ])
  })

  it('discards raw audio, personal metadata, and every other unknown field', () => {
    const parsed = parseHistoryEntry({
      ...validEntry,
      rawAudio: new Uint8Array([1, 2, 3]),
      microphoneId: 'private-device-id',
      cloudAccount: 'person@example.com',
    })

    expect(parsed).toEqual(validEntry)
    expect(parsed).not.toHaveProperty('rawAudio')
    expect(parsed).not.toHaveProperty('microphoneId')
    expect(parsed).not.toHaveProperty('cloudAccount')
  })

  it.each([
    ['id', ''],
    ['text', ''],
    ['createdAt', -1],
    ['createdAt', 1.5],
    ['durationMs', -1],
    ['durationMs', 1.5],
    ['language', ''],
    ['modelPreset', 'cloud-large'],
  ] as const)('rejects an invalid %s value with a ZodError', (field, value) => {
    expect(() => parseHistoryEntry({ ...validEntry, [field]: value })).toThrow(ZodError)
  })

  it('accepts zero-valued epoch and duration boundaries', () => {
    expect(parseHistoryEntry({ ...validEntry, createdAt: 0, durationMs: 0 })).toEqual({
      ...validEntry,
      createdAt: 0,
      durationMs: 0,
    })
  })
})
