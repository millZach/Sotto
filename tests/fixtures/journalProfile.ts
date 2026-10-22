import { countWords, type DictationRecord } from '../../src/shared/dictationRecord'
import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import type { HistoryEntry } from '../../src/shared/history'

/**
 * A Journal worth looking at for the design captures and the Journal's verification: transcripts over the week
 * before the instant the end-to-end window counts from (`E2E_THREADS_NOW`, Sunday July 12, 2026, 12:41 pm in
 * America/Los_Angeles), most with the app they went to, one older than the first week, and ninety days of dictation
 * records behind them, as a long-time user whose older transcripts retention trimmed would have. Every time is
 * written in Los Angeles summer time (UTC-7), the zone the captures pin.
 */
const pacific = (month: number, day: number, hour: number, minute: number): number => Date.UTC(2026, month - 1, day, hour + 7, minute)

function transcript(id: string, text: string, createdAt: number, seconds: number, app?: string): HistoryEntry {
  return { id, text, createdAt, durationMs: Math.round(seconds * 1_000), language: 'en', modelPreset: 'parakeet', ...(app === undefined ? {} : { app }) }
}

export const journalHistory: readonly HistoryEntry[] = [
  // The first three are the captures' long-standing transcripts; their text is what older specs look for.
  transcript('review-1', 'Draft the launch summary and send it to the product team before lunch.', pacific(7, 11, 9, 30), 8.4, 'Microsoft Outlook'),
  transcript('review-2', 'Remember to confirm the accessibility review and installer smoke test.', pacific(7, 10, 15, 15), 6.2, 'Slack'),
  // From before transcripts carried an app, and with no record that knows one.
  transcript('review-3', 'The microphone notes stay local and the final transcript is copied automatically.', pacific(7, 9, 11, 5), 10.7),
  transcript('today-1', 'Okay, that looks good. Run the typecheck and the unit suite, and if they pass, open a pull request against main with a plain English title.', pacific(7, 12, 11, 52), 11.6, 'Windows Terminal'),
  transcript('today-2', 'Hi Darren, attached are the updated loop drawings for the boiler feed pumps. The only change from last week is the added flow transmitter on the recirculation line.', pacific(7, 12, 10, 14), 13.9, 'Microsoft Outlook'),
  transcript('today-3', 'Running about ten minutes late, still at the switchgear.', pacific(7, 12, 9, 3), 4.1, 'Slack'),
  transcript('yesterday-2', 'Can you make the rows open in place instead of navigating away, and keep keyboard focus on the row that was opened?', pacific(7, 11, 14, 40), 9.2, 'Sotto'),
  transcript('tuesday-1', 'Punch list for Thursday: label the new junction boxes, torque the lugs in the VFD cabinet, and update the as-builts.', pacific(7, 7, 16, 20), 9.8, 'Notepad'),
  transcript('older-1', 'Write a short note in docs verification about how you checked this in the running app, with the screenshots it names.', pacific(7, 3, 13, 45), 10.4, 'Windows Terminal'),
]

const APPS = ['Windows Terminal', 'Microsoft Outlook', 'Slack', 'Sotto', 'Microsoft Teams', 'Google Chrome', 'Notepad']

function numbersOnly(): DictationRecord[] {
  let seed = 11
  const next = (): number => { seed = (seed * 1_664_525 + 1_013_904_223) >>> 0; return seed / 4_294_967_296 }
  const records: DictationRecord[] = []
  const today = new Date(E2E_THREADS_NOW)
  // Older than every transcript: retention trims the oldest text first, and the numbers stay.
  for (let back = 90; back >= 10; back -= 1) {
    // A two-week break, and a few quiet days, so the calendar and the streak have something to say.
    if ((back >= 40 && back <= 52) || next() < 0.18) continue
    const count = 1 + Math.floor(next() * 4)
    for (let index = 0; index < count; index += 1) {
      const words = 30 + Math.floor(next() * 140)
      const wpm = 108 + Math.round((90 - back) / 4) + Math.floor(next() * 22)
      records.push({
        id: `numbers-${back}-${index}`,
        createdAt: Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back, 15 + Math.floor(next() * 9), Math.floor(next() * 60)),
        durationMs: Math.round((words / wpm) * 60_000),
        words,
        app: APPS[Math.floor(next() * APPS.length)]!,
      })
    }
  }
  return records
}

/** Every dictation's record, newest first: the transcripts' own, then the numbers whose text is gone. */
export const journalRecords: readonly DictationRecord[] = [
  ...journalHistory.map((entry) => ({ id: entry.id, createdAt: entry.createdAt, durationMs: entry.durationMs, words: countWords(entry.text), ...(entry.app === undefined ? {} : { app: entry.app }) })),
  ...numbersOnly(),
].sort((first, second) => second.createdAt - first.createdAt)
