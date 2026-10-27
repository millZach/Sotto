// @vitest-environment node
// #1312 (Zach, October 27): when a check's snapshot was taken is written as the computer writes a time, in the
// interface language main shows, not always on a 24-hour clock.
import { i18n } from '@lingui/core'
import { afterEach, expect, it } from 'vitest'
import { interfaceClockTime } from '../../../src/main/interfaceClock'
import { systemClockTime } from '../../../src/shared/branchMoves'

const before = i18n.locale
afterEach(() => { if (before) i18n.activate(before) })
/** Intl puts a narrow no-break space before AM and PM; the words read the same with a plain one. */
const plain = (text: string): string => text.replace(/\s/gu, ' ')
const at = new Date(2026, 9, 23, 14, 2)

it('writes the time in the interface language', () => {
  i18n.loadAndActivate({ locale: 'en-US', messages: {} })
  expect(plain(interfaceClockTime(at))).toBe('2:02 PM')
  i18n.loadAndActivate({ locale: 'de', messages: {} })
  expect(interfaceClockTime(at)).toBe('14:02')
})

it('falls back to this computer’s own way when the language is not one Intl reads', () => {
  i18n.loadAndActivate({ locale: 'not a language', messages: {} })
  expect(interfaceClockTime(at)).toBe(systemClockTime(at))
})
