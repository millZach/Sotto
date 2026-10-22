// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

// A minute of the window's profile spent 1.4 s building a date formatter per clock label (#1328). These pin that the
// labels are the strings toLocale*String made, and that one formatter now serves every call until the locale or the
// time zone moves.

const ZONES = ['America/Chicago', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', 'UTC']
const START = Date.parse('2026-01-01T00:00:00.000Z')
// Every 97 minutes for a year: every hour of the day, both halves of daylight saving, both sides of noon.
const INSTANTS = Array.from({ length: 5_420 }, (_, index) => START + index * 97 * 60_000)

const zoneBefore = process.env.TZ
const NativeFormat = Intl.DateTimeFormat
let built = 0
function countFormatters(): void {
  built = 0
  class Counted extends NativeFormat {
    constructor(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) { super(...args); built += 1 }
  }
  Intl.DateTimeFormat = Counted as typeof Intl.DateTimeFormat
}

afterEach(() => {
  Intl.DateTimeFormat = NativeFormat
  vi.unstubAllGlobals()
  if (zoneBefore === undefined) delete process.env.TZ
  else process.env.TZ = zoneBefore
})

async function freshModules() {
  vi.resetModules()
  const [threadFacts, babysitting] = await Promise.all([
    import('../../../src/renderer/src/agents/threadFacts'),
    import('../../../src/renderer/src/agents/babysitting'),
  ])
  return { clockLabel: threadFacts.clockLabel, babysitClock: babysitting.babysitClock }
}

describe('clock labels made with one formatter', () => {
  it.each(ZONES)('says what toLocaleTimeString said, byte for byte, in %s', async zone => {
    process.env.TZ = zone
    const { clockLabel } = await freshModules()
    for (const at of INSTANTS) {
      expect(clockLabel(at)).toBe(new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLocaleLowerCase())
    }
  })

  it.each(ZONES)('says what the babysitting line said, byte for byte, in %s', async zone => {
    process.env.TZ = zone
    const { babysitClock } = await freshModules()
    const now = new Date(START + 200 * 86_400_000)
    for (const at of INSTANTS.filter((_, index) => index % 7 === 0)) {
      const date = new Date(at)
      const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLocaleLowerCase()
      const before = date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
      expect(babysitClock(date.toISOString(), now)).toBe(before)
    }
  })

  it('pins the label, lowercased, and leaves a moment it cannot read empty', async () => {
    process.env.TZ = 'America/Chicago'
    const { clockLabel } = await freshModules()
    expect(clockLabel(Date.parse('2026-09-10T19:02:00.000Z'))).toBe(new Date('2026-09-10T19:02:00.000Z').toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLocaleLowerCase())
    if (new NativeFormat().resolvedOptions().locale === 'en-US') {
      // ICU's space before the day period is a plain or a narrow no-break one depending on its version, and \s matches both.
      expect(clockLabel(Date.parse('2026-09-10T19:02:00.000Z'))).toMatch(/^2:02\spm$/u)
      expect(clockLabel(Date.parse('2026-09-10T05:30:00.000Z'))).toMatch(/^12:30\sam$/u)
    }
    for (const unreadable of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 9e15]) expect(clockLabel(unreadable)).toBe('')
  })

  it('builds the formatter once for every label, and again only when the time zone or the language moves', async () => {
    process.env.TZ = 'America/Chicago'
    countFormatters()
    const { clockLabel } = await freshModules()
    expect(built).toBe(0)
    for (const at of INSTANTS) clockLabel(at)
    expect(built).toBe(1)

    process.env.TZ = 'Asia/Kolkata'
    expect(clockLabel(INSTANTS[0]!)).toBe(new Date(INSTANTS[0]!).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLocaleLowerCase())
    for (const at of INSTANTS) clockLabel(at)
    expect(built).toBe(2)

    vi.stubGlobal('navigator', { language: 'fr-FR' })
    for (const at of INSTANTS) clockLabel(at)
    expect(built).toBe(3)
  })

  it('builds one formatter for each of the babysitting line’s time and day', async () => {
    process.env.TZ = 'Europe/London'
    countFormatters()
    const { babysitClock } = await freshModules()
    const now = new Date(START)
    for (const at of INSTANTS.slice(0, 2_000)) babysitClock(new Date(at).toISOString(), now)
    expect(built).toBe(2)
  })
})
