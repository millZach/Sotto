// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  afterRead,
  barFor,
  buttonsFor,
  dictationNumber,
  displayFor,
  effectiveState,
  failureNotice,
  idle,
  issuedFor,
  key,
  lostNotice,
  maxLength,
  messageWidth,
  nextExpiry,
  noNotice,
  noticeFor,
  noticeHolds,
  noticeOnFailure,
  noticeOnLoss,
  parse,
  pillFor,
  processGone,
  restingPosition,
  sentenceLines,
  snapEdge,
  startsDictation,
  UNREADABLE,
  watchesProcess,
  workArea,
  type DictationRecord,
  type DictationStatus,
} from '../../../apps/omarchy/shell-plugin/sotto.dictation/Model.mjs'

const file = (fields: Record<string, unknown>): string => JSON.stringify({
  version: 1, state: 'listening', since: 1_000, updatedAt: 1_000, detail: null, kept: false, edge: 'top', pid: 4242, pidStart: 177_000, dictation: 'd1', ...fields,
})
const record = (state: DictationStatus, since: number, fields: Partial<DictationRecord> = {}): DictationRecord =>
  ({ state, since, updatedAt: since, detail: '', kept: false, edge: 'top', pid: 4242, pidStart: null, dictation: null, ...fields })
// A /proc/<pid>/stat line: fields 4 to 21 as Linux writes them, then field
// 22, the start time, and a few after it.
const stat = (pid: number, name: string, state: string, start: number | string): string =>
  `${pid} (${name}) ${state} 1 ${pid} ${pid} 0 -1 4194560 2048 0 0 0 120 30 0 0 20 0 31 0 ${start} 1234567 890 18446744073709551615 1 1 0\n`

describe('reading the state file', () => {
  it('reads a missing, malformed or unknown file as idle and hidden', () => {
    for (const text of ['', 'not json', '[]', 'null', '{"state":"listening"}', file({ version: 2 })]) {
      expect(parse(text)).toEqual(idle())
    }
    expect(parse(undefined)).toEqual({ state: 'idle', since: 0, updatedAt: 0, detail: '', kept: false, edge: 'top', pid: 0, pidStart: null, dictation: null })
  })

  it('keeps a valid edge from a state it does not know', () => {
    expect(parse(file({ state: 'paused', edge: 'left' }))).toEqual(idle('left'))
  })

  it('ignores fields it does not know, a transcript among them', () => {
    const parsed = parse(file({ transcript: 'what the user said', level: 0.4, next: { version: 2 } }))
    expect(parsed).toEqual({ state: 'listening', since: 1_000, updatedAt: 1_000, detail: '', kept: false, edge: 'top', pid: 4242, pidStart: 177_000, dictation: 'd1' })
    expect(JSON.stringify(parsed)).not.toContain('what the user said')
  })

  it('falls back field by field', () => {
    expect(parse(file({ state: 'failed', since: '1000', updatedAt: Infinity, detail: 7, kept: 'true', edge: 'middle' })))
      .toEqual({ state: 'failed', since: 0, updatedAt: 0, detail: '', kept: false, edge: 'top', pid: 4242, pidStart: 177_000, dictation: 'd1' })
    expect(parse(file({ state: 'failed', detail: '  Sotto could not reach OpenRouter.\n Recording kept. ' })).detail)
      .toBe('Sotto could not reach OpenRouter. Recording kept.')
  })

  it('reads pid only as a positive whole number, and 0 when an older Sotto names none', () => {
    const older = JSON.parse(file({})) as Record<string, unknown>
    delete older.pid
    expect(parse(JSON.stringify(older)).pid).toBe(0)
    for (const pid of [0, -1, 1.5, '4242', null, true, Number.NaN]) expect(parse(file({ pid })).pid).toBe(0)
    expect(parse(file({ pid: 1 })).pid).toBe(1)
    expect(parse(file({ pid: 4_194_304 })).pid).toBe(4_194_304)
  })

  it('reads pidStart only as a whole number, and null when an older Sotto gives none', () => {
    const older = JSON.parse(file({})) as Record<string, unknown>
    delete older.pidStart
    expect(parse(JSON.stringify(older)).pidStart).toBeNull()
    for (const pidStart of [-1, 1.5, '177000', null, true, Number.NaN]) expect(parse(file({ pidStart })).pidStart).toBeNull()
    expect(parse(file({ pidStart: 0 })).pidStart).toBe(0)
    expect(parse(file({ pidStart: 9_007_199_254_740_991 })).pidStart).toBe(9_007_199_254_740_991)
  })

  it('reads dictation as an opaque identifier, "" when the file says there is none, and null when it does not say', () => {
    expect(parse(file({ dictation: 'session-7f3a (2)' })).dictation).toBe('session-7f3a (2)')
    expect(parse(file({ dictation: null })).dictation).toBe('')
    expect(parse(file({ dictation: '' })).dictation).toBe('')
    const older = JSON.parse(file({})) as Record<string, unknown>
    delete older.dictation
    expect(parse(JSON.stringify(older)).dictation).toBeNull()
    for (const dictation of [7, true, {}, []]) expect(parse(file({ dictation })).dictation).toBeNull()
  })
})

describe('a state file that cannot be read', () => {
  const listening = record('listening', 1_000)

  it('takes only a missing file as idle', () => {
    expect(afterRead(listening, null, true)).toEqual({ record: idle(), unreadable: false })
  })

  it('keeps the last state through any other failed read, and says the file could not be read', () => {
    const kept = afterRead(listening, null, false)
    expect(kept.record).toBe(listening)
    expect(kept.unreadable).toBe(true)
    expect(effectiveState(kept.record, 3_600_000, '')).toBe('listening')
    expect(watchesProcess(kept.record)).toBe(true)
    const look = pillFor('listening', kept.record, noticeFor('', kept.unreadable, 'listening'))
    expect(look).toEqual({ glyph: 'alert', tone: 'error', message: UNREADABLE, buttons: ['stop', 'cancel'] })
    expect(UNREADABLE).toBe("Could not read Sotto's dictation state. Trying again.")
  })

  it('keeps a kept failure and its buttons too', () => {
    const failure = record('failed', 1_000, { kept: true, detail: 'The transcription service is busy. Recording kept.' })
    const kept = afterRead(failure, null, false)
    expect(kept.record).toBe(failure)
    expect(pillFor('failed', kept.record, noticeFor('', true, 'failed')).buttons).toEqual(['retry', 'discard'])
  })

  it('treats text that is not JSON as a failed read, not as idle', () => {
    for (const text of ['', '{"version":1,"state":"lis', 'not json']) {
      expect(afterRead(listening, text, false)).toEqual({ record: listening, unreadable: true })
    }
  })

  it('reads JSON that is not a v1 state as idle, as parse does', () => {
    for (const text of ['null', '[]', '{"state":"listening"}', file({ version: 2 })]) {
      expect(afterRead(listening, text, false)).toEqual({ record: idle(), unreadable: false })
    }
  })

  it('starts from idle when the first read fails, and takes the next good read whole', () => {
    expect(afterRead(null, null, false)).toEqual({ record: idle(), unreadable: true })
    const next = afterRead(listening, file({ state: 'transcribing', since: 2_000 }), false)
    expect(next.unreadable).toBe(false)
    expect(next.record.state).toBe('transcribing')
  })

  it('puts a command that did not get through, or Sotto quitting, before the unreadable notice', () => {
    const stop = failureNotice('stop', true, 'listening')
    expect(noticeFor(stop, true, 'listening')).toBe(stop)
    expect(noticeFor('', true, 'transcribing')).toBe(UNREADABLE)
    expect(noticeFor('', false, 'listening')).toBe('')
  })

  it('shows no pill for it while nothing is on screen, only the glyph', () => {
    expect(noticeFor('', true, 'idle')).toBe('')
    expect(barFor('idle', idle(), true)).toEqual({
      glyph: 'alert', alert: true, time: false, tooltip: "Start dictation. Could not read Sotto's dictation state. Trying again.",
    })
    expect(barFor('idle', idle(), false).tooltip).toBe('Start dictation')
    expect(barFor('listening', listening, true)).toEqual(barFor('listening', listening, false))
  })
})

describe("checking that Sotto's process is alive", () => {
  it('looks only while the file shows a dictation and names a process', () => {
    expect(watchesProcess(record('idle', 0))).toBe(false)
    expect(watchesProcess(record('listening', 1, { pid: 0 }))).toBe(false)
    for (const state of ['starting', 'listening', 'transcribing', 'delivered', 'copied', 'failed'] as const) {
      expect(watchesProcess(record(state, 1))).toBe(true)
    }
    expect(watchesProcess(null)).toBe(false)
  })

  it('takes a missing /proc entry, a zombie or a dead process as gone', () => {
    expect(processGone(null, 4242)).toBe(true)
    expect(processGone(undefined, 4242)).toBe(true)
    expect(processGone('4242 (electron) Z 1 4242 4242 0 -1', 4242)).toBe(true)
    expect(processGone('4242 (electron) X 1 4242 4242 0 -1', 4242)).toBe(true)
    expect(processGone('4242 (sotto) S 1 4242 4242 0 -1', 4242)).toBe(false)
    expect(processGone('4242 (sotto) R 1 4242 4242 0 -1', 4242)).toBe(false)
  })

  it('reads the state after the last parenthesis, since a name may contain one', () => {
    expect(processGone('4242 (a) Z (b) S 1 2', 4242)).toBe(false)
    expect(processGone('4242 (a) S (b) Z 1 2', 4242)).toBe(true)
  })

  it('counts Sotto alive only while its PID started when pidStart says', () => {
    expect(processGone(stat(4242, 'sotto', 'S', 177_000), 4242, 177_000)).toBe(false)
    expect(processGone(stat(4242, 'sotto', 'R', 177_000), 4242, 177_000)).toBe(false)
  })

  it('takes a PID that another process now has as gone', () => {
    expect(processGone(stat(4242, 'bash', 'S', 177_812), 4242, 177_000)).toBe(true)
    expect(processGone(stat(4242, 'sotto', 'S', 0), 4242, 177_000)).toBe(true)
    expect(processGone(stat(4242, 'sotto', 'Z', 177_000), 4242, 177_000)).toBe(true)
  })

  it('finds field 22 after a command name with spaces and parentheses', () => {
    expect(processGone(stat(4242, 'Web Content', 'S', 177_000), 4242, 177_000)).toBe(false)
    expect(processGone(stat(4242, 'Web Content', 'S', 177_001), 4242, 177_000)).toBe(true)
    // A name that looks like the fields after it: `) S 1 ... 177000` inside it.
    const tricky = 'a) S 1 2 3 (b'
    expect(processGone(stat(4242, tricky, 'S', 177_000), 4242, 177_000)).toBe(false)
    expect(processGone(stat(4242, tricky, 'S', 5), 4242, 177_000)).toBe(true)
    expect(processGone(stat(4242, ') Z (', 'S', 177_000), 4242, 177_000)).toBe(false)
    expect(processGone(stat(4242, '(sotto)', 'S', 177_000), 4242, 177_000)).toBe(false)
  })

  it('decides nothing from a start time it cannot read', () => {
    expect(processGone(stat(4242, 'sotto', 'S', 'x'), 4242, 177_000)).toBe(false)
    expect(processGone('4242 (sotto) S 1 4242', 4242, 177_000)).toBe(false)
    expect(processGone('4242 (sotto S 1 4242', 4242, 177_000)).toBe(false)
  })

  it('falls back to the PID alone without pidStart, as for an older Sotto', () => {
    expect(processGone(stat(4242, 'bash', 'S', 177_812), 4242, null)).toBe(false)
    expect(processGone(stat(4242, 'bash', 'S', 177_812), 4242)).toBe(false)
    expect(processGone(null, 4242, null)).toBe(true)
  })

  it('puts away a file that was already stale when first read, its PID taken by another process', () => {
    const first = afterRead(null, file({ state: 'listening', pid: 4242, pidStart: 177_000 }), false)
    expect(watchesProcess(first.record)).toBe(true)
    expect(processGone(stat(4242, 'kworker/3:1-events', 'I', 177_900), first.record.pid, first.record.pidStart)).toBe(true)
    expect(lostNotice(first.record)).toBe('Sotto quit. This dictation was lost. Open Sotto to dictate again.')
    const kept = afterRead(null, file({ state: 'failed', kept: true, pid: 4242, pidStart: 177_000 }), false)
    expect(processGone(stat(4242, 'bash', 'S', 177_900), kept.record.pid, kept.record.pidStart)).toBe(true)
    expect(lostNotice(kept.record)).toBe('Sotto quit. The kept recording was lost. Open Sotto to dictate again.')
  })

  it('decides nothing from text that names another process or cannot be read', () => {
    expect(processGone('4243 (sotto) Z 1', 4242)).toBe(false)
    expect(processGone('', 4242)).toBe(false)
    expect(processGone('garbage', 4242)).toBe(false)
  })

  it('says what went with a crash, and nothing for a dictation already delivered', () => {
    expect(lostNotice(record('listening', 1))).toBe('Sotto quit. This dictation was lost. Open Sotto to dictate again.')
    expect(lostNotice(record('starting', 1))).toBe(lostNotice(record('transcribing', 1)))
    expect(lostNotice(record('failed', 1, { kept: true }))).toBe('Sotto quit. The kept recording was lost. Open Sotto to dictate again.')
    expect(lostNotice(record('failed', 1))).toBe('Sotto quit. Open Sotto to dictate again.')
    for (const state of ['idle', 'delivered', 'copied'] as const) expect(lostNotice(record(state, 1))).toBe('')
  })

  it('gives a crash notice only Dismiss', () => {
    const look = pillFor('idle', record('listening', 1), lostNotice(record('listening', 1)), true)
    expect(look).toEqual({ glyph: 'alert', tone: 'error', message: 'Sotto quit. This dictation was lost. Open Sotto to dictate again.', buttons: ['dismiss'] })
  })
})

describe('holds and Dismiss', () => {
  it('holds Pasted for 1.5 s and Copied for 4 s from since, if Sotto never writes idle', () => {
    expect(effectiveState(record('delivered', 10_000), 11_499, '')).toBe('delivered')
    expect(effectiveState(record('delivered', 10_000), 11_500, '')).toBe('idle')
    expect(effectiveState(record('copied', 10_000), 13_999, '')).toBe('copied')
    expect(effectiveState(record('copied', 10_000), 14_000, '')).toBe('idle')
    expect(nextExpiry(record('copied', 10_000), 12_000)).toBe(14_000)
    expect(nextExpiry(record('copied', 10_000), 14_000)).toBe(0)
  })

  it('never expires a dictation under way or a failure', () => {
    for (const state of ['starting', 'listening', 'transcribing', 'failed'] as const) {
      expect(effectiveState(record(state, 10_000), 10_000 + 3_600_000, '')).toBe(state)
      expect(nextExpiry(record(state, 10_000), 10_000)).toBe(0)
    }
  })

  it('puts away the dismissed state only, until Sotto moves on', () => {
    const failure = record('failed', 10_000)
    expect(effectiveState(failure, 20_000, key(failure))).toBe('idle')
    expect(effectiveState(record('failed', 30_000), 30_000, key(failure))).toBe('failed')
    expect(effectiveState(record('listening', 10_000), 20_000, key(failure))).toBe('listening')
    expect(effectiveState(failure, 20_000, '')).toBe('failed')
  })

  it('offers Dismiss only for a failure with nothing kept', () => {
    expect(buttonsFor('failed', record('failed', 1))).toEqual(['dismiss'])
    expect(buttonsFor('failed', record('failed', 1, { kept: true }))).toEqual(['retry', 'discard'])
    expect(buttonsFor('listening', record('listening', 1))).toEqual(['stop', 'cancel'])
    expect(buttonsFor('transcribing', record('transcribing', 1))).toEqual(['cancel'])
    for (const state of ['idle', 'delivered', 'copied'] as const) expect(buttonsFor(state, record(state, 1))).toEqual([])
  })
})

describe('a command that does not get through', () => {
  it('keeps the pill and its buttons while a dictation is on screen', () => {
    const listening = record('listening', 1)
    const look = pillFor('listening', listening, failureNotice('stop', true, 'listening'))
    expect(look.buttons).toEqual(['stop', 'cancel'])
    expect(look.message).toBe('Stop did not get through. Recording may still be running. Open Sotto to stop it.')
    const kept = record('failed', 1, { kept: true })
    expect(pillFor('failed', kept, failureNotice('retry', true, 'failed')).buttons).toEqual(['retry', 'discard'])
    expect(pillFor('transcribing', record('transcribing', 1), failureNotice('cancel', true, 'transcribing')).buttons).toEqual(['cancel'])
  })

  it('holds a notice about a dictation on screen, and times out any other', () => {
    for (const state of ['starting', 'listening', 'transcribing', 'failed'] as const) {
      for (const verb of ['toggle', 'stop', 'cancel', 'retry', 'discard'] as const) expect(noticeHolds(verb, state)).toBe(true)
      expect(noticeHolds('place', state)).toBe(false)
    }
    for (const state of ['idle', 'delivered', 'copied'] as const) expect(noticeHolds('toggle', state)).toBe(false)
  })

  it('says what did not get through, whether anything is still running or kept, and to open Sotto', () => {
    expect(failureNotice('stop', false, 'listening')).toBe(failureNotice('stop', true, 'listening'))
    expect(failureNotice('toggle', true, 'starting')).toBe(failureNotice('stop', true, 'starting'))
    expect(failureNotice('cancel', true, 'listening')).toBe('Cancel did not get through. Recording may still be running. Open Sotto to cancel it.')
    expect(failureNotice('cancel', true, 'transcribing')).toBe('Cancel did not get through. Open Sotto to cancel.')
    expect(failureNotice('retry', true, 'failed')).toBe('Try again did not get through. Recording kept. Open Sotto to try again.')
    expect(failureNotice('discard', true, 'failed')).toBe('Discard did not get through. Recording kept. Open Sotto to discard it.')
    expect(failureNotice('place', true, 'listening')).toBe('Sotto did not save this edge. Open Sotto and drag again.')
    expect(failureNotice('toggle', false, 'idle')).toBe('Could not run sotto. Check the command path.')
    expect(failureNotice('toggle', true, 'idle')).toBe('Sotto did not answer. Open Sotto and try again.')
  })
})

describe('a command result that arrives after Sotto quit', () => {
  // Dictation 1 listening, with Stop pressed on its pill before Sotto's
  // process was found gone. The plugin then puts the dictation away, so the
  // state on screen is idle under the notice.
  const listening = record('listening', 1_000, { dictation: 'a', pidStart: 177_000 })
  const stopAbout = issuedFor(1, true)
  const lost = noticeOnLoss(lostNotice(listening), listening, 1)
  const lateStop = (notice: ReturnType<typeof noNotice>, about = stopAbout) =>
    noticeOnFailure(notice, about, 'stop', true, 'idle', listening)
  const pill = (notice: ReturnType<typeof noNotice>, unreadable: boolean) =>
    pillFor('idle', listening, noticeFor(notice.text, unreadable, 'idle'), notice.lost)
  const sottoQuit = { glyph: 'alert', tone: 'error', message: 'Sotto quit. This dictation was lost. Open Sotto to dictate again.', buttons: ['dismiss'] }

  it('keeps "Sotto quit" and its Dismiss when a Stop issued before it fails late', () => {
    expect(lost).toEqual({ text: sottoQuit.message, lost: true, shownFor: key(listening), holds: true, lostFor: 1 })
    const after = lateStop(lost)
    expect(after).toBe(lost)
    expect(after.holds).toBe(true)
    expect(pill(after, false)).toEqual(sottoQuit)
  })

  it('keeps it with a state file that cannot be read', () => {
    const read = afterRead(listening, null, false)
    expect(read).toEqual({ record: listening, unreadable: true })
    expect(watchesProcess(read.record)).toBe(true)
    const after = lateStop(noticeOnLoss(lostNotice(read.record), read.record, 1))
    expect(after.lost).toBe(true)
    expect(pill(after, read.unreadable)).toEqual(sottoQuit)
  })

  it('outranks every verb, a failed edge included, for that dictation or an older one', () => {
    for (const verb of ['toggle', 'stop', 'cancel', 'retry', 'discard', 'place'] as const) {
      for (const about of [0, 1]) expect(noticeOnFailure(lost, about, verb, false, 'idle', listening)).toBe(lost)
    }
  })

  it('still outranks it once the notice is put away, by Dismiss or by Sotto writing again', () => {
    const dismissed = noNotice(lost.lostFor)
    expect(lateStop(dismissed)).toBe(dismissed)
    expect(pill(lateStop(dismissed), true).message).toBe('')
  })

  it('gives way to a press made after it, which is for the next dictation', () => {
    const toggle = noticeOnFailure(noNotice(lost.lostFor), issuedFor(1, false), 'toggle', false, 'idle', listening)
    expect(toggle).toEqual({ text: 'Could not run sotto. Check the command path.', lost: false, shownFor: key(listening), holds: false, lostFor: 1 })
  })

  it('gives way to a result for a newer dictation, and keeps the loss for older ones', () => {
    const next = record('listening', 9_000, { dictation: 'b' })
    const newer = noticeOnFailure(lost, 2, 'stop', true, 'listening', next)
    expect(newer.lost).toBe(false)
    expect(newer.text).toBe('Stop did not get through. Recording may still be running. Open Sotto to stop it.')
    expect(newer.lostFor).toBe(1)
    expect(lateStop(newer)).toBe(newer)
  })

  it('shows a failed command as before when nothing was lost', () => {
    const shown = noticeOnFailure(noNotice(), 1, 'stop', true, 'listening', listening)
    expect(shown).toEqual({ text: failureNotice('stop', true, 'listening'), lost: false, shownFor: key(listening), holds: true, lostFor: null })
    expect(noticeOnFailure(null, 0, 'place', true, 'idle', idle()).holds).toBe(false)
  })

  it('numbers dictations as they begin, by dictation where Sotto names them', () => {
    const a = record('listening', 1_000, { dictation: 'a' })
    expect(dictationNumber(0, idle(), a)).toBe(1)
    expect(dictationNumber(1, a, record('transcribing', 2_000, { dictation: 'a' }))).toBe(1)
    expect(dictationNumber(1, a, record('idle', 3_000, { dictation: '' }))).toBe(1)
    expect(dictationNumber(1, a, record('listening', 1_000, { dictation: 'b' }))).toBe(2)
    expect(dictationNumber(1, record('idle', 0), record('starting', 5_000))).toBe(2)
    expect(issuedFor(3, true)).toBe(3)
    expect(issuedFor(3, false)).toBe(4)
  })
})

describe('failure words', () => {
  it("shows Sotto's detail word for word", () => {
    const detail = 'The transcription service is busy. Recording kept.'
    expect(pillFor('failed', record('failed', 1, { kept: true, detail }), '').message).toBe(detail)
    expect(pillFor('failed', record('failed', 1, { detail: 'No speech was heard. Nothing was kept.' }), '').message)
      .toBe('No speech was heard. Nothing was kept.')
  })

  it('says whether the recording was kept in its own words when Sotto gives none', () => {
    expect(pillFor('failed', record('failed', 1, { kept: true }), '').message).toBe('Transcription failed. Recording kept.')
    expect(pillFor('failed', record('failed', 1), '').message).toBe('Dictation failed. Nothing was kept.')
  })
})

describe('snapping to an edge', () => {
  const area = { x: 0, y: 26, width: 1600, height: 974 }

  it('snaps to the nearest edge of the work area', () => {
    expect(snapEdge({ x: 20, y: 400, width: 44, height: 300 }, area)).toBe('left')
    expect(snapEdge({ x: 1500, y: 400, width: 44, height: 300 }, area)).toBe('right')
    expect(snapEdge({ x: 600, y: 900, width: 400, height: 44 }, area)).toBe('bottom')
    expect(snapEdge({ x: 600, y: 60, width: 400, height: 44 }, area)).toBe('top')
  })

  it('breaks ties bottom, then top, then left, then right, as Windows does', () => {
    const square = { x: 0, y: 0, width: 100, height: 100 }
    expect(snapEdge({ x: 40, y: 40, width: 20, height: 20 }, square)).toBe('bottom')
    expect(snapEdge({ x: 40, y: 10, width: 20, height: 80 }, square)).toBe('bottom')
    expect(snapEdge({ x: 10, y: 10, width: 20, height: 20 }, square)).toBe('top')
    expect(snapEdge({ x: 10, y: 40, width: 80, height: 20 }, square)).toBe('left')
    expect(snapEdge({ x: 70, y: 40, width: 20, height: 20 }, square)).toBe('right')
  })
})

describe('where the pill rests', () => {
  it('centres the pill on its edge, a gap in from the bar', () => {
    const area = workArea(1600, 1000, 'top', 26)
    expect(area).toEqual({ x: 0, y: 26, width: 1600, height: 974 })
    expect(restingPosition('top', area, 600, 44, 5)).toEqual({ x: 500, y: 31 })
    expect(restingPosition('bottom', area, 600, 44, 5)).toEqual({ x: 500, y: 951 })
    expect(restingPosition('left', area, 44, 300, 5)).toEqual({ x: 5, y: 363 })
    expect(restingPosition('right', area, 44, 300, 5)).toEqual({ x: 1551, y: 363 })
    expect(restingPosition('left', workArea(1600, 1000, 'left', 28), 44, 300, 5)).toEqual({ x: 33, y: 350 })
  })

  // Glyph, Try again and Discard with their spacing and padding: what a
  // kept failure's words share the pill's length with.
  const fixed = 212
  const fits = (screenWidth: number, screenHeight: number) => {
    const area = workArea(screenWidth, screenHeight, 'top', 26)
    const length = maxLength('left', area, 5)
    const words = messageWidth(length, fixed, 470, 120)
    const pill = fixed + words
    const at = restingPosition('left', area, 44, pill, 5)
    return { length, words, pill, top: at.y, bottom: at.y + pill, areaTop: area.y, areaBottom: area.y + area.height }
  }

  it('keeps an upright failure pill and its buttons on an 820x560 display', () => {
    const small = fits(820, 560)
    expect(small.length).toBe(524)
    expect(small.words).toBe(312)
    expect(small.pill).toBeLessThanOrEqual(small.length)
    expect(small.top).toBeGreaterThanOrEqual(small.areaTop)
    expect(small.bottom).toBeLessThanOrEqual(small.areaBottom)
  })

  it('keeps it on a full-HD display at 200% scale, 960x540 logical', () => {
    const scaled = fits(1920 / 2, 1080 / 2)
    expect(scaled.length).toBe(504)
    expect(scaled.pill).toBeLessThanOrEqual(scaled.length)
    expect(scaled.top).toBeGreaterThanOrEqual(scaled.areaTop)
    expect(scaled.bottom).toBeLessThanOrEqual(scaled.areaBottom)
  })

  it('lets the words run to 470 px where the screen has room, and no less than the minimum', () => {
    expect(messageWidth(maxLength('top', workArea(820, 560, 'top', 26), 5), fixed, 470, 120)).toBe(470)
    expect(messageWidth(maxLength('left', workArea(1600, 1000, 'top', 26), 5), fixed, 470, 120)).toBe(470)
    expect(messageWidth(200, fixed, 470, 120)).toBe(120)
  })

  it('breaks words that do not fit between sentences, and sizes them to the widest line', () => {
    const measure = (text: string) => text.length * 8
    expect(sentenceLines('Transcribing', 470, measure)).toEqual({ text: 'Transcribing', width: 96 })
    expect(sentenceLines('Sotto quit. This dictation was lost. Open Sotto to dictate again.', 470, measure))
      .toEqual({ text: 'Sotto quit. This dictation was lost.\nOpen Sotto to dictate again.', width: 288 })
    expect(sentenceLines('OpenRouter has no credit left. Add credit. Recording kept.', 312, measure))
      .toEqual({ text: 'OpenRouter has no credit left.\nAdd credit. Recording kept.', width: 240 })
    expect(sentenceLines('Stop did not get through. Recording may still be running. Open Sotto to stop it.', 312, measure).text)
      .toBe('Stop did not get through.\nRecording may still be running.\nOpen Sotto to stop it.')
  })

  it('leaves a sentence longer than the line to wrap on its own', () => {
    const measure = (text: string) => text.length * 8
    expect(sentenceLines('Copied, paste with Super+V into any app you like', 200, measure))
      .toEqual({ text: 'Copied, paste with Super+V into any app you like', width: 200 })
  })

  it('starts a pill longer than the room at the start, so its glyph and words show', () => {
    const area = workArea(820, 560, 'top', 26)
    expect(restingPosition('left', area, 44, 700, 5)).toEqual({ x: 5, y: 26 })
    expect(restingPosition('top', { x: 0, y: 26, width: 400, height: 534 }, 600, 44, 5)).toEqual({ x: 0, y: 31 })
  })
})

describe('the display for each dictation (rule A)', () => {
  it('tells a new dictation from the next state of the same one', () => {
    expect(startsDictation(null, record('starting', 1))).toBe(true)
    expect(startsDictation(record('idle', 0), record('listening', 1))).toBe(true)
    expect(startsDictation(record('starting', 1), record('listening', 2))).toBe(false)
    expect(startsDictation(record('listening', 1), record('listening', 1, { edge: 'left' }))).toBe(false)
    expect(startsDictation(record('listening', 1), record('listening', 9))).toBe(true)
    expect(startsDictation(record('listening', 1), record('starting', 9))).toBe(true)
    expect(startsDictation(record('copied', 1), record('starting', 9))).toBe(true)
    expect(startsDictation(record('failed', 1, { kept: true }), record('listening', 9))).toBe(true)
    expect(startsDictation(record('listening', 1), record('transcribing', 9))).toBe(false)
  })

  // Each step: the file Sotto wrote, whether the pill shows, and the display
  // the mouse is on.
  const run = (steps: [DictationRecord, boolean, string][]): string[] => {
    let display = ''
    let previous: DictationRecord | null = null
    return steps.map(([next, shown, focused]) => {
      display = displayFor(display, previous, next, shown, focused)
      previous = next
      return display
    })
  }

  it('keeps a dictation on the display it started on', () => {
    expect(run([
      [record('starting', 1), true, 'DP-1'],
      [record('listening', 2), true, 'DP-2'],
      [record('transcribing', 3), true, 'DP-2'],
      [record('copied', 4), true, 'DP-2'],
      [record('idle', 5), false, 'DP-2'],
    ])).toEqual(['DP-1', 'DP-1', 'DP-1', 'DP-1', ''])
  })

  it('moves a new dictation to the focused display while a copied result still shows', () => {
    expect(run([
      [record('listening', 1), true, 'DP-1'],
      [record('copied', 2), true, 'DP-1'],
      [record('starting', 3), true, 'DP-2'],
      [record('listening', 4), true, 'DP-1'],
    ])).toEqual(['DP-1', 'DP-1', 'DP-2', 'DP-2'])
  })

  it('moves a new dictation while a kept failure still shows, or when idle was coalesced away', () => {
    expect(run([
      [record('failed', 1, { kept: true }), true, 'DP-1'],
      [record('listening', 2), true, 'DP-2'],
    ])).toEqual(['DP-1', 'DP-2'])
    expect(run([
      [record('listening', 1), true, 'DP-1'],
      [record('listening', 9), true, 'DP-2'],
    ])).toEqual(['DP-1', 'DP-2'])
  })

  const named = (state: DictationStatus, since: number, dictation: string | null, fields: Partial<DictationRecord> = {}) =>
    record(state, since, { dictation, ...fields })

  it("starts a dictation when Sotto names a new one, whatever its state", () => {
    expect(startsDictation(null, named('starting', 1, 'A'))).toBe(true)
    expect(startsDictation(idle(), named('listening', 1, 'A'))).toBe(true)
    expect(startsDictation(named('starting', 1, 'A'), named('listening', 2, 'B'))).toBe(true)
    expect(startsDictation(named('copied', 1, 'A'), named('failed', 2, 'B'))).toBe(true)
    expect(startsDictation(named('idle', 1, ''), named('transcribing', 2, 'B'))).toBe(true)
    expect(startsDictation(record('listening', 1), named('listening', 1, 'A'))).toBe(true)
  })

  it('keeps one named dictation one, whatever its states and since', () => {
    expect(startsDictation(named('starting', 1, 'A'), named('listening', 2, 'A'))).toBe(false)
    expect(startsDictation(named('listening', 1, 'A'), named('listening', 9, 'A'))).toBe(false)
    expect(startsDictation(named('failed', 1, 'A', { kept: true }), named('starting', 9, 'A'))).toBe(false)
    expect(startsDictation(named('listening', 1, 'A'), named('idle', 2, ''))).toBe(false)
    expect(startsDictation(null, named('idle', 0, ''))).toBe(false)
  })

  it("sends B to the new display when A's starting and B's listening arrive with nothing between", () => {
    expect(run([
      [named('starting', 1, 'A'), true, 'DP-1'],
      [named('listening', 60, 'B'), true, 'DP-2'],
      [named('transcribing', 90, 'B'), true, 'DP-1'],
    ])).toEqual(['DP-1', 'DP-2', 'DP-2'])
  })

  it('keeps the same pair on the first display without dictation, as an older Sotto writes it', () => {
    expect(run([
      [record('starting', 1), true, 'DP-1'],
      [record('listening', 60), true, 'DP-2'],
    ])).toEqual(['DP-1', 'DP-1'])
  })

  it('keeps a named dictation on its display through every state, and moves the next one', () => {
    expect(run([
      [named('starting', 1, 'A'), true, 'DP-1'],
      [named('listening', 2, 'A'), true, 'DP-2'],
      [named('transcribing', 3, 'A'), true, 'DP-2'],
      [named('copied', 4, 'A'), true, 'DP-2'],
      [named('starting', 5, 'B'), true, 'DP-2'],
      [named('failed', 6, 'B'), true, 'DP-1'],
      [idle(), false, 'DP-1'],
      [named('listening', 7, 'C'), true, 'DP-1'],
    ])).toEqual(['DP-1', 'DP-1', 'DP-1', 'DP-1', 'DP-2', 'DP-2', '', 'DP-1'])
  })

  it('puts a pill without a dictation, such as a notice, on the focused display', () => {
    const quiet = record('idle', 0)
    expect(displayFor('', quiet, quiet, true, 'DP-2')).toBe('DP-2')
    expect(displayFor('DP-1', quiet, quiet, true, 'DP-2')).toBe('DP-1')
    expect(displayFor('DP-1', quiet, quiet, false, 'DP-2')).toBe('')
  })
})
