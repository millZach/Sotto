import { describe, expect, it } from 'vitest'

import { countWords, deliveredAppName, dictationRecordSchema, MAX_DELIVERED_APP_LENGTH } from '../../../src/shared/dictationRecord'
import { finishedDictationSchema, historyEntrySchema } from '../../../src/shared/history'

describe('dictation record', () => {
  it('counts words the way a reader would', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   ')).toBe(0)
    expect(countWords('Hello, world.')).toBe(2)
    expect(countWords("Don't stop — it's 2026!")).toBe(4)
    expect(countWords('line one\nline two')).toBe(4)
  })

  it('keeps only numbers and an app name', () => {
    const record = { id: 'one', createdAt: 1, durationMs: 2, words: 3, app: 'Outlook' }
    expect(dictationRecordSchema.parse(record)).toEqual(record)
    expect(dictationRecordSchema.parse({ id: 'one', createdAt: 1, durationMs: 2, words: 0 })).toEqual({ id: 'one', createdAt: 1, durationMs: 2, words: 0 })
    expect(() => dictationRecordSchema.parse({ ...record, text: 'private words' })).toThrow()
    expect(() => dictationRecordSchema.parse({ ...record, title: 'Inbox - private' })).toThrow()
    expect(() => dictationRecordSchema.parse({ ...record, words: 1.5 })).toThrow()
    expect(() => dictationRecordSchema.parse({ ...record, durationMs: -1 })).toThrow()
    expect(() => dictationRecordSchema.parse({ ...record, app: '' })).toThrow()
    expect(() => dictationRecordSchema.parse({ ...record, app: 'x'.repeat(MAX_DELIVERED_APP_LENGTH + 1) })).toThrow()
  })

  it('lets a transcript carry its app, but never a finished dictation from the window', () => {
    const finished = { id: 'one', text: 'words', createdAt: 1, durationMs: 2, language: 'en', modelPreset: 'parakeet' as const }
    expect(historyEntrySchema.parse({ ...finished, app: 'Slack' })).toEqual({ ...finished, app: 'Slack' })
    expect(finishedDictationSchema.parse(finished)).toEqual(finished)
    expect(() => finishedDictationSchema.parse({ ...finished, app: 'Slack' })).toThrow()
  })

  it('makes a system app name fit to keep', () => {
    expect(deliveredAppName('  Microsoft   Outlook \u0000')).toBe('Microsoft Outlook')
    expect(deliveredAppName('Adobe Acrobat ')).toBe('Adobe Acrobat')
    expect(deliveredAppName('Line\nbreak')).toBe('Line break')
    expect(deliveredAppName(' \u0007 ')).toBeNull()
    expect(deliveredAppName(undefined)).toBeNull()
    expect(deliveredAppName(42)).toBeNull()
    expect(deliveredAppName('é'.repeat(200))).toHaveLength(MAX_DELIVERED_APP_LENGTH)
    expect(deliveredAppName('😀'.repeat(40))!.length).toBeLessThanOrEqual(MAX_DELIVERED_APP_LENGTH)
  })
})
