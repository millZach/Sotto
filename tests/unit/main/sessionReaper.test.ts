// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SessionReaper } from '../../../src/main/agents/sessionReaper'

/** A reaper with an injected clock, so every case names a time rather than waiting for one. */
function reaper(overrides: Partial<{ busy: Set<string>; watched: Set<string>; idleAfterMs: number }> = {}) {
  const busy = overrides.busy ?? new Set<string>()
  const watched = overrides.watched ?? new Set<string>()
  const stopped: string[] = []
  let now = 1_000
  const subject = new SessionReaper({
    idleAfterMs: overrides.idleAfterMs ?? 1_000,
    now: () => now,
    isBusy: id => busy.has(id),
    isWatched: id => watched.has(id),
    stop: id => { stopped.push(id) },
  })
  return { subject, busy, watched, stopped, advance: (ms: number) => { now += ms }, at: () => now }
}

describe('SessionReaper', () => {
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
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
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
