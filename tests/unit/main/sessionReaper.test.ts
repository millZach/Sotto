// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SessionReaper, busyHolds, type SessionBusyHold } from '../../../src/main/agents/sessionReaper'
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

describe('SessionReaper held-sessions read (#2398)', () => {
  /** A fake adapter's answers, each a set the case fills, and the names it gives for them. */
  function named(overrides: Partial<{ why: Map<string, SessionBusyHold[]>; live: boolean }> = {}) {
    const busy = new Set<string>(), watched = new Set<string>(), reading = new Set<string>()
    const why = overrides.why ?? new Map<string, SessionBusyHold[]>()
    const asked: string[] = [], stopped: string[] = []
    let now = 1_000
    const subject = new SessionReaper({
      idleAfterMs: 1_000, now: () => now,
      isBusy: id => busy.has(id), isWatched: id => watched.has(id), isReading: id => reading.has(id),
      whyBusy: id => { asked.push(id); return why.get(id) ?? [] },
      whyWatched: () => overrides.live ? 'live-session' : 'watched',
      stop: id => { stopped.push(id) },
    })
    return { subject, busy, watched, reading, why, asked, stopped, advance: (ms: number) => { now += ms } }
  }
  const holds = (subject: SessionReaper) => Object.fromEntries(subject.held().map(session => [session.id, session.holds]))

  it('names every rule keeping each session, in one fixed order, and only rules that hold it now', () => {
    const r = named({ why: new Map<string, SessionBusyHold[]>([['asking', ['request']], ['both', ['busy', 'request']], ['shell', ['background']], ['compacting', ['compaction']]]) })
    for (const id of ['asking', 'both', 'shell', 'compacting', 'turn', 'read', 'open', 'all']) r.subject.touch(id)
    for (const id of ['asking', 'both', 'shell', 'compacting', 'turn', 'all']) r.busy.add(id)
    r.reading.add('read'); r.reading.add('all')
    r.watched.add('open'); r.watched.add('all')
    r.why.set('all', ['request', 'background'])
    expect(holds(r.subject)).toEqual({
      asking: ['request'], both: ['busy', 'request'], shell: ['background'], compacting: ['compaction'],
      // A busy rule that names nothing still says it is busy, so the read never calls a held session free.
      turn: ['busy'],
      read: ['reading'], open: ['watched'], all: ['request', 'background', 'reading', 'watched'],
    })
  })

  it('asks the busy names only of a session the busy rule holds, so a name never outlives what it names', () => {
    const r = named({ why: new Map<string, SessionBusyHold[]>([['idle', ['request']]]) })
    r.subject.touch('idle')
    expect(holds(r.subject)).toEqual({ idle: ['recent'] })
    expect(r.asked).toEqual([])
  })

  it('says live-session where the adapter keeps Claude Code’s live-session set rather than its watched set', () => {
    const r = named({ live: true })
    r.subject.touch('live'); r.watched.add('live')
    expect(holds(r.subject)).toEqual({ live: ['live-session'] })
  })

  it('says recent inside the idle window and none once it has run out, and none is what the next sweep stops', async () => {
    const r = named()
    r.subject.touch('quiet')
    r.advance(999)
    expect(holds(r.subject)).toEqual({ quiet: ['recent'] })
    r.advance(1)
    expect(holds(r.subject)).toEqual({ quiet: ['none'] })
    await r.subject.sweep()
    expect(r.stopped).toEqual(['quiet'])
    expect(r.subject.held()).toEqual([])
  })

  it.each([
    { busy: false, watched: false, reading: false, past: false }, { busy: false, watched: false, reading: false, past: true },
    { busy: true, watched: false, reading: false, past: true }, { busy: false, watched: true, reading: false, past: true },
    { busy: false, watched: false, reading: true, past: true }, { busy: false, watched: false, reading: true, past: false },
  ])('agrees with the sweep: none exactly when the next sweep stops the session (%o)', async state => {
    const r = named()
    r.subject.touch('session')
    if (state.busy) r.busy.add('session')
    if (state.watched) r.watched.add('session')
    if (state.reading) r.reading.add('session')
    r.advance(state.past ? 1_000 : 500)
    const [read] = r.subject.held()
    await r.subject.sweep()
    expect(read!.holds.includes('none')).toBe(r.stopped.includes('session'))
  })

  it('counts idle time from the session’s own last activity, though a sweep that spares it renews its window', async () => {
    const r = named()
    r.subject.touch('open'); r.watched.add('open')
    r.advance(5_000)
    await r.subject.sweep()
    r.advance(200)
    expect(r.subject.held()).toEqual([{ id: 'open', idleMs: 5_200, holds: ['watched'] }])
    // Its window began at that sweep, so once it leaves the watched set it is recent, not stopped, for a full window.
    r.watched.clear()
    expect(r.subject.held()).toEqual([{ id: 'open', idleMs: 5_200, holds: ['recent'] }])
    r.subject.touch('open')
    expect(r.subject.held()[0]!.idleMs).toBe(0)
  })

  it('keeps the idle age of a session whose stop failed, so a stop that never takes shows as recent with a long idle', async () => {
    let now = 0
    const subject = new SessionReaper({ idleAfterMs: 10, now: () => now, isBusy: () => false, isWatched: () => false,
      stop: () => { throw new Error('Synthetic stop failure') } })
    subject.touch('stuck')
    now += 20
    await subject.sweep()
    now += 5
    expect(subject.held()).toEqual([{ id: 'stuck', idleMs: 25, holds: ['recent'] }])
  })

  it('gives each session’s process where the adapter knows it, and forgets a session the adapter ended', () => {
    const r = named()
    r.subject.touch('running'); r.subject.touch('unknown'); r.subject.touch('ended')
    r.subject.forget('ended')
    expect(r.subject.held(id => id === 'running' ? 4242 : undefined)).toEqual([
      { id: 'running', idleMs: 0, holds: ['recent'], pid: 4242 }, { id: 'unknown', idleMs: 0, holds: ['recent'] }])
  })
})

describe('busyHolds', () => {
  it('names the parts that hold, in the read’s order', () => {
    expect(busyHolds({ compaction: true, background: true, busy: true, request: true })).toEqual(['busy', 'request', 'background', 'compaction'])
    expect(busyHolds({ request: true })).toEqual(['request'])
    expect(busyHolds({})).toEqual([])
  })
})
