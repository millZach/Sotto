// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DictationTiming } from '../../../src/main/performance/dictationTiming'

describe('local dictation timing log', () => {
  it('groups serial presses without persisting identities or absolute clocks', async () => {
    const lines: string[] = []
    const timing = new DictationTiming(async line => { lines.push(line) })
    timing.mark({ event: 'widget-ready', atMs: 90 })
    timing.begin(100)
    timing.mark({ event: 'first-audio-chunk', atMs: 112.3456 })
    timing.begin(200)
    // A late report stamped before this press belongs to the old recording.
    timing.mark({ event: 'widget-ready', atMs: 199 })
    timing.mark({ event: 'started-dispatched', atMs: 207 })
    await timing.flush()
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { event: 'hotkey-received', elapsedMs: 0 },
      { event: 'first-audio-chunk', elapsedMs: 12.346 },
      { event: 'hotkey-received', elapsedMs: 0 },
      { event: 'started-dispatched', elapsedMs: 7 },
    ])
  })
})
