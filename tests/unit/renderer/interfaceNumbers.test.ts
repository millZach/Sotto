// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { shownCompactCount, shownCount, shownDecimal, shownLocalCount } from '../../../src/renderer/src/state/interfaceNumbers'

afterEach(() => { i18n.activate('en') })

it('writes English counts as Sotto always did: ungrouped, or the computer’s own grouping where that was the way', () => {
  expect(shownCount(1234)).toBe('1234')
  expect(shownCount(1_000_000)).toBe('1000000')
  expect(shownDecimal(1234.56, 1)).toBe('1234.6')
  expect(shownLocalCount(1234)).toBe((1234).toLocaleString())
  expect(shownCompactCount(1234)).toBe(new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(1234))
})

it('groups and writes decimals the way another interface language does', () => {
  i18n.loadAndActivate({ locale: 'de', messages: {} })
  expect(shownCount(1234)).toBe('1.234')
  expect(shownDecimal(1234.56, 1)).toBe('1.234,6')
  expect(shownLocalCount(1234)).toBe('1.234')
  expect(shownCompactCount(1234)).toBe(new Intl.NumberFormat('de', { notation: 'compact', maximumFractionDigits: 1 }).format(1234))
})
