import { i18n } from '@lingui/core'

import { SOURCE_INTERFACE_LANGUAGE } from '../../../shared/interfaceLanguages'

/**
 * Numbers a message places where `#` would go, written the way the interface language writes them (ADR-0123). English
 * keeps each number exactly as Sotto wrote it before its words were translated, so English reads the same in every
 * build; the other languages use their own digits and grouping. A plural's own `#` would group English ("1,000"), so a
 * count that can pass 999 goes into its message as one of these instead.
 */
const english = (): boolean => i18n.locale === SOURCE_INTERFACE_LANGUAGE

/** A count: English writes its digits ungrouped ("1000 commits behind main"), as it always did. */
export function shownCount(value: number): string {
  return english() ? String(value) : new Intl.NumberFormat(i18n.locale).format(value)
}

/** A number with a fixed count of decimals: English ungrouped, as `toFixed` wrote it ("1234.5"). */
export function shownDecimal(value: number, digits: number): string {
  return english() ? value.toFixed(digits) : new Intl.NumberFormat(i18n.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}

/**
 * A count where English always wrote the computer's own grouping (`toLocaleString()`): "1,240" on an American computer,
 * "1.240" on a German one. The other languages group as they do.
 */
export function shownLocalCount(value: number): string {
  return english() ? value.toLocaleString() : new Intl.NumberFormat(i18n.locale).format(value)
}

/** A short count, "1.2K": in English the computer's own short form, as it always was; the other languages their own. */
export function shownCompactCount(value: number): string {
  return new Intl.NumberFormat(english() ? undefined : i18n.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
