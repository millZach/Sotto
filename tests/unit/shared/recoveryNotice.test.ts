import { describe, expect, it } from 'vitest'

import { recoveryNoticeSchema, recoveryNoticesSchema } from '../../../src/shared/recoveryNotice'

const ALL_CODES = [
  { code: 'SETTINGS_RECOVERED' },
  { code: 'HISTORY_RECOVERED' },
  { code: 'ACCESSIBILITY_PERMISSION_REQUIRED' },
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
