// @vitest-environment node
/**
 * What a host sends its paired clients while one thread streams, at forge's scale (#2390, the November 10, 2026 audit):
 * bytes per thread list push to a desktop and to an iPhone, how many of each push's parts are as the push before had them,
 * and bytes of `watcher-state` per change of Watcher's progress alone. It builds the host as the data-transfer benchmark
 * does (`hostSocketScale`), on Owl with short threads, and counts what each peer is sent. Sizes and counts only, the same
 * on every run, so it runs in the default suite (`docs/perf/2026-11-10-real-size-transfer-benchmarks.md`).
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

/**
 * Bytes of JSON in one thread list push to a desktop while a thread streams: about 200 KB, nearly all of it parts that did
 * not change. #2393 sends a socket client those parts once. The room is wider than the Watcher budget's because the host's
 * folders are in a push, and a temporary folder's path is longer on Windows and macOS than on Linux.
 */
const DESKTOP_PUSH_BYTES = 204_000
/** Bytes of JSON in one thread list push to an iPhone: about 199 KB. #2392 leaves out what no phone reads, and #2393 the rest. */
const PHONE_PUSH_BYTES = 203_000
/**
 * The parts of a push to a desktop, and to an iPhone, that are as the push before had them: 42 and 43. A part added to
 * every push goes as one more of them. #2392 and #2393 lower these.
 */
const DESKTOP_UNCHANGED_PARTS = 42
const PHONE_UNCHANGED_PARTS = 43
/**
 * Bytes of JSON in one `watcher-state` push whose only change is where a watched thread has got: about 1.99 MB, every
 * request and operation of the desktop's Watcher sent again, and the parts of it as the push before had them: six of its
 * nine. #2391 sends the progress without them.
 */
const WATCHER_STATE_PROGRESS_BYTES = 2_006_000
const WATCHER_STATE_UNCHANGED_PARTS = 6

// The fake clock, stepped as the data-transfer benchmark steps it, waiting for file work between steps.
const STEP_MS = 5
const turn = globalThis.setImmediate
const fileWorkInFlight = (): boolean => process.getActiveResourcesInfo().some(name => /^(FSReq|FileHandle|CloseReq)/u.test(name))
async function filesSettled(): Promise<void> {
  for (let quiet = 0; quiet < 3;) {
    await new Promise<void>(resolve => { turn(resolve) })
    quiet = fileWorkInFlight() ? 0 : quiet + 1
  }
}
async function step(): Promise<void> { await vi.advanceTimersByTimeAsync(STEP_MS); await filesSettled() }
async function pass(ms: number): Promise<void> { for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) await step() }
async function until<T>(work: Promise<T>): Promise<T> {
  let done = false
  void work.then(() => { done = true }, () => { done = true })
  await filesSettled()
  for (let elapsed = 0; !done; elapsed += STEP_MS) { if (elapsed > 120_000) throw new Error('not done'); await step() }
  return work
}

const roots: string[] = []
beforeAll(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }) })
afterAll(async () => {
  vi.useRealTimers()
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

it('sends a desktop and an iPhone no more per push than forge\'s host did, while one thread streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-push-')); roots.push(root)
  const h = await hostSocketScale(root, { until, step, pass })
  try {
    const { p, desktop, phone, io, ask } = h
    expect(h.watcherReads, 'The desktop did not read its Watcher\'s projection, so it is pushed no watcher-state').toBe(true)
    const session = p.streamSessions[0]!, threadId = h.streamIds[0]!
    for (const [name, peer] of [['desktop', desktop], ['phone', phone]] as const) await ask(peer, `observe-${name}`, { op: 'observe', threadIds: [threadId] })
    const thread = p.adapter.state.threads.find(item => item.id === session)!
    p.adapter.log.add(session, { id: 'prompt', role: 'user', text: 'Synthetic prompt', createdAt: new Date().toISOString() }); thread.status = 'running'; p.adapter.mark(session)
    p.adapter.log.add(session, { id: 'reply', role: 'assistant', text: 'First', createdAt: new Date().toISOString() })
    p.adapter.publish(true)
    await pass(1_000); await io()
    // A stretch first, so what goes once after observing (the thread whole, the catalog) is behind what is counted.
    await h.stream([session], 'reply', 10)
    await pass(500); await io()
    const marks = { desktop: desktop.messages.length, phone: phone.messages.length }
    await h.stream([session], 'reply', 40)
    await pass(1_000); await io()
    const toDesktop = tallyPeer(desktop.messages, marks.desktop, false), toPhone = tallyPeer(phone.messages, marks.phone, false)
    const shellToDesktop = toDesktop.shell!, shellToPhone = toPhone.shell!, watcherState = toDesktop.watcherState!, progress = watcherState.progressOnly
    // Some of each, so no budget passes on nothing. How many depends on how fast the peers read: the host sends a client
    // that is behind the newest push once it catches up (push pacing), so a slow machine counts fewer.
    expect(shellToDesktop.pushes).toBeGreaterThanOrEqual(2)
    expect(shellToPhone.pushes).toBeGreaterThanOrEqual(2)
    expect(progress.pushes).toBeGreaterThanOrEqual(2)
    const report = JSON.stringify({ desktop: { pushes: shellToDesktop.pushes, bytesPerPush: shellToDesktop.bytesPerPush, unchangedPartsPerPush: shellToDesktop.unchangedPartsPerPush },
      phone: { pushes: shellToPhone.pushes, bytesPerPush: shellToPhone.bytesPerPush, unchangedPartsPerPush: shellToPhone.unchangedPartsPerPush },
      watcherState: { pushes: watcherState.pushes, unchangedPartsPerPush: watcherState.unchangedPartsPerPush, progressOnly: { pushes: progress.pushes, bytesPerPush: progress.bytesPerPush } } })
    if (process.env.SOTTO_PUSH_SIZES === '1') console.log(`HOST-PUSH-SIZES ${report}`)
    expect(shellToDesktop.bytesPerPush, `A thread list push to a desktop grew past its budget: ${report}`).toBeLessThanOrEqual(DESKTOP_PUSH_BYTES)
    expect(shellToPhone.bytesPerPush, `A thread list push to an iPhone grew past its budget: ${report}`).toBeLessThanOrEqual(PHONE_PUSH_BYTES)
    expect(shellToDesktop.unchangedPartsPerPush, `A push to a desktop carries more parts that did not change: send a new part only when it changes. ${report}`).toBeLessThanOrEqual(DESKTOP_UNCHANGED_PARTS)
    expect(shellToPhone.unchangedPartsPerPush, `A push to an iPhone carries more parts that did not change: send a new part only when it changes. ${report}`).toBeLessThanOrEqual(PHONE_UNCHANGED_PARTS)
    expect(progress.bytesPerPush, `A watcher-state push for progress alone grew past its budget: ${report}`).toBeLessThanOrEqual(WATCHER_STATE_PROGRESS_BYTES)
    expect(watcherState.unchangedPartsPerPush, `A watcher-state push carries more parts that did not change: ${report}`).toBeLessThanOrEqual(WATCHER_STATE_UNCHANGED_PARTS)
  } finally {
    await h.close(); vi.clearAllTimers()
  }
}, 120_000)
