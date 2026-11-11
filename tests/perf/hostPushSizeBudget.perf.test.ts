// @vitest-environment node
/**
 * What a host sends its paired clients while one thread streams, at forge's scale (#2390, the November 10, 2026 audit):
 * bytes per thread list push to a desktop and to an iPhone, how many of each push's parts are as the push before had them,
 * and, for each change of Watcher's progress alone, the bytes the desktop is sent and how many whole `watcher-state` pushes
 * carry it. It builds the host as the data-transfer benchmark does (`hostSocketScale`), on Owl with short threads, and
 * counts what each peer is sent. The fake clock steps only once the sockets have carried what the last step sent, so the
 * sizes and counts are the same on every run and on any machine, and it runs in the default suite
 * (`docs/perf/2026-11-10-real-size-transfer-benchmarks.md`).
 *
 * Each budget is today's number with a little room, and only tightens: a change that lowers a number lowers its budget in
 * the same pull request, and a raise needs its reason in the pull request. The numbers are large on purpose, since they
 * are what forge's host sends; the issues named beside each are the fixes that will lower them. To read today's numbers:
 *
 *   SOTTO_PUSH_SIZES=1 npx vitest run tests/perf/hostPushSizeBudget.perf.test.ts --disable-console-intercept
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { hostSocketScale, tallyPeer } from '../fixtures/hostSocketScale'
import { stepClock } from '../fixtures/stepClock'

/**
 * Bytes of JSON in one thread list push to a desktop while a thread streams: 2,850, the thread record that changed and the
 * names of the parts kept. Before #2393 it was about 200 KB, nearly all of it parts that did not change; now a socket
 * client is sent those once (`kept-parts`). The room is wider than the Watcher budget's because the changed record names
 * the host's folder twice, and a temporary folder's path is longer on Windows and macOS than on Linux.
 */
const DESKTOP_PUSH_BYTES = 3_100
/** Bytes of JSON in one thread list push to an iPhone: 1,826. It was about 199 KB; #2392 left out what no phone reads, and #2393 the rest. */
const PHONE_PUSH_BYTES = 2_100
/**
 * The parts of a push to a desktop, and to an iPhone, that are as the push before had them: 7 each, the frame's `v` and
 * `event`, the state's `kept` and its host's, the host's empty `threads` and catalog revision, and the event page. They were
 * 44 and 45 before #2392 and #2393. A part added to every push goes as one more of them, unless it is kept.
 */
const DESKTOP_UNCHANGED_PARTS = 7
const PHONE_UNCHANGED_PARTS = 7
/**
 * Bytes of JSON the desktop is sent for a change of where a watched thread has got and nothing else: 451, a
 * `watcher-progress` push with the one entry that moved (#2391). Before it this was a whole `watcher-state`, about
 * 1.99 MB, with every request and operation of the desktop's Watcher in it again. The two parts that do not change are
 * the frame's `v` and `event`.
 */
const PROGRESS_CHANGE_BYTES = 600
const PROGRESS_CHANGE_UNCHANGED_PARTS = 2
/** Whole `watcher-state` pushes per change of progress alone: none since #2391, where it was every one. */
const WHOLE_WATCHER_STATE_PER_PROGRESS_CHANGE = 0

const clock = stepClock()
const roots: string[] = []
beforeAll(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }) })
afterAll(async () => {
  vi.useRealTimers()
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

it('sends a desktop and an iPhone no more per push than forge\'s host did, while one thread streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-push-')); roots.push(root)
  const h = await hostSocketScale(root, clock)
  try {
    const { p, desktop, phone, ask } = h
    expect(h.watcherReads, 'The desktop did not read its Watcher\'s projection, so it is pushed no watcher-state').toBe(true)
    const session = p.streamSessions[0]!, threadId = h.streamIds[0]!
    for (const [name, peer] of [['desktop', desktop], ['phone', phone]] as const) await ask(peer, `observe-${name}`, { op: 'observe', threadIds: [threadId] })
    const thread = p.adapter.state.threads.find(item => item.id === session)!
    p.adapter.log.add(session, { id: 'prompt', role: 'user', text: 'Synthetic prompt', createdAt: new Date().toISOString() }); thread.status = 'running'; p.adapter.mark(session)
    p.adapter.log.add(session, { id: 'reply', role: 'assistant', text: 'First', createdAt: new Date().toISOString() })
    p.adapter.publish(true)
    await h.clock.pass(1_000)
    // A stretch first, so what goes once after observing (the thread whole, the catalog) is behind what is counted.
    await h.stream([session], 'reply', 10)
    await h.clock.pass(500)
    const marks = { desktop: desktop.messages.length, phone: phone.messages.length }
    await h.stream([session], 'reply', 40)
    await h.clock.pass(1_000)
    const toDesktop = tallyPeer(desktop.messages, marks.desktop, false), toPhone = tallyPeer(phone.messages, marks.phone, false)
    const shellToDesktop = toDesktop.events.shell, shellToPhone = toPhone.events.shell, progress = toDesktop.progressOnly
    const report = JSON.stringify({ desktop: { pushes: shellToDesktop?.frames, bytesPerPush: shellToDesktop?.bytesPerFrame, unchangedPartsPerPush: shellToDesktop?.unchangedPartsPerFrame },
      phone: { pushes: shellToPhone?.frames, bytesPerPush: shellToPhone?.bytesPerFrame, unchangedPartsPerPush: shellToPhone?.unchangedPartsPerFrame },
      progressOnly: progress && { changes: progress.changes, bytesPerChange: progress.bytesPerChange, unchangedPartsPerChange: progress.unchangedPartsPerChange, wholeWatcherStatePerChange: progress.wholePushesPerChange } })
    if (process.env.SOTTO_PUSH_SIZES === '1') console.log(`HOST-PUSH-SIZES ${report}`)
    // Some of each, so no budget passes on nothing.
    expect(shellToDesktop?.frames ?? 0, `The desktop was sent too few thread list pushes to measure: ${report}`).toBeGreaterThanOrEqual(2)
    expect(shellToPhone?.frames ?? 0, `The iPhone was sent too few thread list pushes to measure: ${report}`).toBeGreaterThanOrEqual(2)
    expect(progress?.changes ?? 0, `The desktop was told of too few changes of Watcher's progress to measure: ${report}`).toBeGreaterThanOrEqual(2)
    expect(shellToDesktop!.bytesPerFrame, `A thread list push to a desktop grew past its budget: ${report}`).toBeLessThanOrEqual(DESKTOP_PUSH_BYTES)
    expect(shellToPhone!.bytesPerFrame, `A thread list push to an iPhone grew past its budget: ${report}`).toBeLessThanOrEqual(PHONE_PUSH_BYTES)
    expect(shellToDesktop!.unchangedPartsPerFrame, `A push to a desktop carries more parts that did not change: send a new part only when it changes. ${report}`).toBeLessThanOrEqual(DESKTOP_UNCHANGED_PARTS)
    expect(shellToPhone!.unchangedPartsPerFrame, `A push to an iPhone carries more parts that did not change: send a new part only when it changes. ${report}`).toBeLessThanOrEqual(PHONE_UNCHANGED_PARTS)
    expect(progress!.bytesPerChange, `What a desktop is sent for a change of Watcher's progress alone grew past its budget: ${report}`).toBeLessThanOrEqual(PROGRESS_CHANGE_BYTES)
    expect(progress!.unchangedPartsPerChange, `What a desktop is sent for a change of Watcher's progress alone carries more parts that did not change: ${report}`).toBeLessThanOrEqual(PROGRESS_CHANGE_UNCHANGED_PARTS)
    expect(progress!.wholePushesPerChange, `A change of Watcher's progress alone went to the desktop as a whole watcher-state more often: ${report}`).toBeLessThanOrEqual(WHOLE_WATCHER_STATE_PER_PROGRESS_CHANGE)
  } finally {
    await h.close(); vi.clearAllTimers()
  }
}, 120_000)
