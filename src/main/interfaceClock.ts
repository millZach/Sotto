import { i18n } from '@lingui/core'
import { systemClockTime } from '../shared/branchMoves'

/**
 * A time of day, hours and minutes, as the user's computer writes it in the interface language main shows (ADR-0123):
 * "2:02 PM" in US English, "14:02" in German. For what main says with a time in it, such as when a check's snapshot was
 * taken (#1312). A language Intl cannot read, such as a pseudo-language, falls back to this computer's own default.
 */
export function interfaceClockTime(at: Date): string {
  try { return new Intl.DateTimeFormat(i18n.locale, { hour: 'numeric', minute: '2-digit' }).format(at) }
  catch { return systemClockTime(at) }
}
