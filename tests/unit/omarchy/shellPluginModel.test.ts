// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buttonsFor,
  displayFor,
  effectiveState,
  failureNotice,
  idle,
  key,
  lostNotice,
  maxLength,
  messageWidth,
  nextExpiry,
  noticeHolds,
  parse,
  pillFor,
  processGone,
  restingPosition,
  snapEdge,
  startsDictation,
  watchesProcess,
  workArea,
  type DictationRecord,
  type DictationStatus,
} from '../../../apps/omarchy/shell-plugin/sotto.dictation/Model.mjs'

const file = (fields: Record<string, unknown>): string => JSON.stringify({
  version: 1, state: 'listening', since: 1_000, updatedAt: 1_000, detail: null, kept: false, edge: 'top', pid: 4242, ...fields,
})
const record = (state: DictationStatus, since: number, fields: Partial<DictationRecord> = {}): DictationRecord =>
  ({ state, since, updatedAt: since, detail: '', kept: false, edge: 'top', pid: 4242, ...fields })

describe('reading the state file', () => {
  it('reads a missing, malformed or unknown file as idle and hidden', () => {
    for (const text of ['', 'not json', '[]', 'null', '{"state":"listening"}', file({ version: 2 })]) {
      expect(parse(text)).toEqual(idle())
    }
    expect(parse(undefined)).toEqual({ state: 'idle', since: 0, updatedAt: 0, detail: '', kept: false, edge: 'top', pid: 0 })
  })

  it('keeps a valid edge from a state it does not know', () => {
    expect(parse(file({ state: 'paused', edge: 'left' }))).toEqual(idle('left'))
  })

  it('ignores fields it does not know, a transcript among them', () => {
    const parsed = parse(file({ transcript: 'what the user said', level: 0.4, next: { version: 2 } }))
    expect(parsed).toEqual({ state: 'listening', since: 1_000, updatedAt: 1_000, detail: '', kept: false, edge: 'top', pid: 4242 })
    expect(JSON.stringify(parsed)).not.toContain('what the user said')
  })

  it('falls back field by field', () => {
    expect(parse(file({ state: 'failed', since: '1000', updatedAt: Infinity, detail: 7, kept: 'true', edge: 'middle' })))
      .toEqual({ state: 'failed', since: 0, updatedAt: 0, detail: '', kept: false, edge: 'top', pid: 4242 })
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

  it('puts a pill without a dictation, such as a notice, on the focused display', () => {
    const quiet = record('idle', 0)
    expect(displayFor('', quiet, quiet, true, 'DP-2')).toBe('DP-2')
    expect(displayFor('DP-1', quiet, quiet, true, 'DP-2')).toBe('DP-1')
    expect(displayFor('DP-1', quiet, quiet, false, 'DP-2')).toBe('')
  })
})
