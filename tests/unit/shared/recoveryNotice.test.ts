// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { pastePermissionNoticeCodeSchema, recoveryNoticeEventSchema, recoveryNoticeSchema, recoveryNoticesSchema } from '../../../src/shared/recoveryNotice'

const ALL_CODES = [
  { code: 'SETTINGS_RECOVERED' },
  { code: 'OPENROUTER_KEY_MIGRATION_FAILED' },
  { code: 'HISTORY_RECOVERED' },
  { code: 'CREDENTIALS_RECOVERED' },
  { code: 'ACCESSIBILITY_PERMISSION_REQUIRED' },
  { code: 'AUTOMATION_PERMISSION_REQUIRED' },
  { code: 'DESKTOP_CLIPBOARD_UNAVAILABLE' },
  { code: 'OPENROUTER_KEY_UNREADABLE' },
  { code: 'RETIRED_CHAT_HISTORY_NOT_CLEARED' },
  { code: 'ANSWER_HISTORY_NOT_CLEARED' },
  { code: 'REMOTE_DRAFT_STORAGE_NOT_UPDATED' },
  { code: 'REMOTE_DRAFTS_UNREADABLE' },
] as const

describe('recoveryNoticeSchema', () => {
  it.each(ALL_CODES)('accepts the $code notice with no other fields', (notice) => {
    expect(recoveryNoticeSchema.parse({ ...notice })).toEqual(notice)
  })

  it('rejects unknown codes and extra fields that could carry private detail', () => {
    expect(() => recoveryNoticeSchema.parse({ code: 'UNKNOWN' })).toThrow()
    expect(() =>
      recoveryNoticeSchema.parse({
        code: 'SETTINGS_RECOVERED',
        path: 'C:\\private\\settings.json',
      }),
    ).toThrow()
  })
})

describe('recoveryNoticesSchema', () => {
  it('round-trips a full list of every code as frozen values', () => {
    const parsed = recoveryNoticesSchema.parse(ALL_CODES.map((notice) => ({ ...notice })))

    expect(parsed).toEqual([...ALL_CODES])
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(parsed.every((notice) => Object.isFrozen(notice))).toBe(true)
  })

  it('rejects a list longer than the number of distinct codes', () => {
    expect(() =>
      recoveryNoticesSchema.parse([...ALL_CODES, { code: 'SETTINGS_RECOVERED' }]),
    ).toThrow()
  })
})

it.each([true, false])('carries a cleared=%s event without accepting private detail or non-permission dismissals', cleared => {
  expect(recoveryNoticeEventSchema.parse({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED', cleared }))
    .toEqual({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED', cleared })
  expect(recoveryNoticeEventSchema.safeParse({ code: 'ACCESSIBILITY_PERMISSION_REQUIRED', cleared, text: 'private' }).success).toBe(false)
  expect(pastePermissionNoticeCodeSchema.safeParse('AUTOMATION_PERMISSION_REQUIRED').success).toBe(true)
  expect(pastePermissionNoticeCodeSchema.safeParse('HISTORY_RECOVERED').success).toBe(false)
})
