// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SessionReaper } from '../../../src/main/agents/sessionReaper'
import { deferred } from '../../fixtures/deferred'

/** A reaper with an injected clock, so every case names a time rather than waiting for one. */
function reaper(overrides: Partial<{ busy: Set<string>; watched: Set<string>; reading: Set<string>; idleAfterMs: number }> = {}) {
  const busy = overrides.busy ?? new Set<string>()
  const watched = overrides.watched ?? new Set<string>()
  const reading = overrides.reading ?? new Set<string>()
  const stopped: string[] = []
  let now = 1_000
  const subject = new SessionReaper({
    idleAfterMs: overrides.idleAfterMs ?? 1_000,
    now: () => now,
    isBusy: id => busy.has(id),
    isWatched: id => watched.has(id),
    isReading: id => reading.has(id),
    stop: id => { stopped.push(id) },
  })
  return { subject, busy, watched, reading, stopped, advance: (ms: number) => { now += ms }, at: () => now }
}

describe('SessionReaper', () => {
  it.each(['activity', 'forgotten'] as const)('rechecks later session %s while another close is held', async change => {
    let now = 0
    const entered = deferred<void>()
    const release = deferred<void>()
    const reading = new Set(['second'])
    const stopped: string[] = []
    const subject = new SessionReaper({
      idleAfterMs: 1_000, now: () => now, isBusy: () => false, isWatched: () => false,
      isReading: id => reading.has(id),
      stop: async id => {
        stopped.push(id)
        if (id === 'first') { entered.resolve(); await release.promise }
      },
    })
    subject.touch('first'); subject.touch('second')
    now = 1_000
    const sweeping = subject.sweep()
    try {
      await entered.promise
      reading.clear()
      if (change === 'activity') subject.touch('second')
      else subject.forget('second')
      release.resolve()
      await sweeping
      expect(stopped).toEqual(['first'])
      if (change === 'activity') {
        now += 999
        await subject.sweep()
        expect(stopped).toEqual(['first'])
        now += 1
        await subject.sweep()
        expect(stopped).toEqual(['first', 'second'])
      } else expect(subject.tracked()).toEqual([])
    } finally { release.resolve(); await sweeping; subject.dispose() }
  })

  it('defers an owned read without renewing idle age or holding another session open', async () => {
    const r = reaper({ reading: new Set(['reading']) })
    r.subject.touch('reading')
    r.subject.touch('other')
    r.advance(1_000)
    for (let cycle = 0; cycle < 20; cycle++) {
      await r.subject.sweep()
      r.advance(100)
    }
    expect(r.stopped).toEqual(['other'])
    expect(r.subject.tracked()).toEqual(['reading'])
    r.reading.delete('reading')
    await r.subject.sweep()
    expect(r.stopped).toEqual(['other', 'reading'])
  })

  it.each(['activity', 'watch', 'work'] as const)('rechecks %s when a deferred read settles', async protection => {
    const r = reaper({ reading: new Set(['reading']) })
    r.subject.touch('reading')
    r.advance(1_000)
    await r.subject.sweep()
    r.reading.delete('reading')
    if (protection === 'activity') r.subject.touch('reading')
    if (protection === 'watch') r.watched.add('reading')
    if (protection === 'work') r.busy.add('reading')
    await r.subject.sweep()
    expect(r.stopped).toEqual([])
    r.watched.clear(); r.busy.clear()
    r.advance(999)
    await r.subject.sweep()
    expect(r.stopped).toEqual([])
    r.advance(1)
    await r.subject.sweep()
    expect(r.stopped).toEqual(['reading'])
  })

  it('stops a session that has sat past the idle threshold, and only that one', async () => {
    const r = reaper()
    r.subject.touch('old')
    r.advance(600)
    r.subject.touch('recent')
    r.advance(500)
    await r.subject.sweep()
    expect(r.stopped).toEqual(['old'])
    expect(r.subject.tracked()).toEqual(['recent'])
  })

  it('never stops a session with a running turn, and gives it the full window once it is free', async () => {
    const r = reaper({ busy: new Set(['working']) })
    r.subject.touch('working')
    r.advance(5_000)
    await r.subject.sweep()
    expect(r.stopped).toEqual([])
    r.busy.delete('working')
    r.advance(999)
    await r.subject.sweep()
    expect(r.stopped).toEqual([])
    r.advance(1)
    await r.subject.sweep()
    expect(r.stopped).toEqual(['working'])
  })

  it('never stops a watched session, and starts its window when it leaves the watched set', async () => {
    const r = reaper({ watched: new Set(['open']) })
    r.subject.touch('open')
    r.advance(10_000)
    await r.subject.sweep()
    expect(r.stopped).toEqual([])
    r.watched.delete('open')
    r.advance(1_000)
    await r.subject.sweep()
    expect(r.stopped).toEqual(['open'])
  })

  it('forgets a session the adapter stopped itself, and does not stop it again', async () => {
    const r = reaper()
    r.subject.touch('gone')
    r.subject.forget('gone')
    r.advance(5_000)
    await r.subject.sweep()
    expect(r.stopped).toEqual([])
    expect(r.subject.tracked()).toEqual([])
  })

  it('keeps a session whose stop failed, so a later sweep tries again', async () => {
    let now = 0
    const attempts: string[] = []
    const subject = new SessionReaper({
      idleAfterMs: 10, now: () => now, isBusy: () => false, isWatched: () => false,
      stop: id => { attempts.push(id); if (attempts.length === 1) throw new Error('Synthetic stop failure') },
    })
    subject.touch('stuck')
    now += 20
    await subject.sweep()
    expect(attempts).toEqual(['stuck'])
    expect(subject.tracked()).toEqual(['stuck'])
    now += 20
    await subject.sweep()
    expect(attempts).toEqual(['stuck', 'stuck'])
    expect(subject.tracked()).toEqual([])
  })

  it('runs one sweep at a time, and stops sweeping when disposed', async () => {
    const { promise: gate, resolve: release } = deferred()
    const stops: string[] = []
    const subject = new SessionReaper({
      sweepEveryMs: 1, idleAfterMs: 0, now: () => 1_000, isBusy: () => false, isWatched: () => false,
      stop: async id => { stops.push(id); await gate },
    })
    subject.touch('slow')
    subject.start()
    const first = subject.sweep()
    expect(subject.sweep()).toBe(first)
    release()
    await first
    expect(stops).toEqual(['slow'])
    subject.dispose()
    subject.touch('after')
    subject.dispose()
    expect(subject.tracked()).toEqual([])
  })
})
