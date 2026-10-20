import { expectPromptText, promptField } from './support/prompt'
import { agentState } from './support/agentAccess'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { onReleaseTrack } from './support/releaseTrack'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import type { RemoteHostE2EConnection } from '../../src/main/e2e/remoteHost'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { AGENT_STATE, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'
import { parseHostEntityKey } from '../../src/shared/clientIdentity'
import type { WatcherRecord } from '../../src/shared/watcher'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { addWatcherHistory, OWNER_SCALE, ownerRequestDrafts } from '../fixtures/ownerScale'
import { bareEntityId, closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

/**
 * `docs/perf/2026-10-15-main-freeze.md`: a live profile of the owner's Sotto, with 232 threads in the
 * sidebar and a few streaming, found main's JavaScript thread busy about 82% of the time over 5.5 minutes, with
 * 1,032 stretches of 100 ms or more without going idle (longest 1.5 s), from whole-state deep copies on every
 * streamed update. This reproduces the shape in the built app at the owner's scale (#1232): Sotto Owl with about 230
 * threads beyond the fixture's two, each with a provider session, a current Watcher with the owner's record and 5 standing
 * watches on the threads that stream (`tests/fixtures/ownerScale.ts`), the owner's answer retirements, and a connected
 * remote host with 40 threads of its own. 1, then 3, of the threads stream a reply at a realistic rate while it measures main's event-loop delay and
 * keystroke-to-screen latency in an idle thread's composer. It runs only when asked:
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npm run build; npx playwright test tests/e2e/main-freeze.spec.ts
 *   sh:          SOTTO_PERF_BENCH=1 npm run build && npx playwright test tests/e2e/main-freeze.spec.ts
 *
 * With `SOTTO_PERF_ASSERT=1` as well, the switch every stopwatch budget takes, it fails when main stalls past
 * `FREEZE_LIMITS`; the nightly Main freeze workflow runs it that way. Each case also reports what the window did: frames
 * drawn, state broadcasts main sent it, time spent handling each key and in long tasks. `SOTTO_FREEZE_PROFILE` names a
 * folder to write a CPU profile of the window per case into. The window must stay on screen: one minimized, covered or
 * behind a locked screen draws about one frame a second, and every keystroke then reads as half a second (October 20,
 * 2026). A case that drew too few frames is marked invalid in what it prints, and with `SOTTO_PERF_ASSERT=1` it fails.
 * `SOTTO_FREEZE_THREADS` sets the padding, and scales the rest of the history with it, for a quick check of the setup. `docs/perf/2026-10-15-main-freeze.md` has what the numbers mean and where to record a run's results.
 */
const PROJECT_ID = 'project'
const MODEL_ID = 'claude:test'
/** Threads created beyond the fixture's own two (`workshop`, `docs`): with Watcher's, about the owner's 250. */
const PADDING_THREADS = Number(process.env.SOTTO_FREEZE_THREADS ?? 230)
/** The owner's history beyond this computer's threads, scaled with the padding. */
const history = (count: number): number => Math.max(1, Math.round(count * PADDING_THREADS / 230))
/** Stopwatch limits are opt-in through the switch every stopwatch budget takes (`docs/ci.md`, `tests/fixtures/perfBudget.ts`). */
const PERF_ASSERT = process.env.SOTTO_PERF_ASSERT === '1'
/**
 * The most main may stall in a case, by how many threads stream, before the nightly run fails on a GitHub-hosted Windows
 * runner: the longest stretch without going idle, and how many stretches of 100 ms or more in its 15 seconds. First set
 * October 20, 2026 from the October 15 numbers with a runner's headroom; like the copy budgets, they only tighten.
 */
const FREEZE_LIMITS: Readonly<Record<number, { readonly maxMs: number; readonly stalls: number }>> = {
  0: { maxMs: 250, stalls: 2 },
  1: { maxMs: 750, stalls: 15 },
  3: { maxMs: 1_000, stalls: 20 },
}
const STREAM_CHUNKS_PER_SECOND = 20
const STREAM_DURATION_MS = 15_000
const SYNTHETIC_TEXT = 'Synthetic benchmark text for keystrokes.'
/**
 * Below this many frames a second the window was not on screen, not slow: Chromium draws a window that is minimized,
 * covered or behind a locked screen about once a second, and every keystroke's next frame waits for that. A busy
 * window on screen still drew 26 a second with three threads streaming at the owner's scale.
 */
const MIN_FRAMES_PER_SECOND = 5
const KEY_DELAY_MS = Math.round(STREAM_DURATION_MS / SYNTHETIC_TEXT.length)
const COMPOSER_THREAD_TITLE = 'Docs'

declare global { interface Window { __freezeTyping?: number[]; __freezeKeyHandling?: number[]; __freezeWindow?: WindowProbe } }
interface WindowProbe { frames: number; longTasks: number; longTaskMs: number; stop: () => void }

interface FreezeSample { maxMs: number; meanMs: number; p99Ms: number; stallCount: number; samples: number }
interface Distribution { count: number; p50: number | null; p95: number | null; max: number | null }
interface CaseResult {
  readonly name: string
  readonly streamingThreads: number
  readonly chunksEmitted: number[]
  readonly eventLoopDelay: FreezeSample
  readonly keystrokeLatencyMs: Distribution
  /** Keydown to the composer's input event: the window's own handling of a key, without the wait for the next frame. */
  readonly keyHandlingMs: Distribution
  readonly window: WindowSample
  /** Whether the window was on screen, so its keystroke times measure Sotto; when not, `invalid` says why. */
  readonly valid: boolean
  readonly invalid?: string
}
interface WindowSample { framesPerSecond: number; stateBroadcastsPerSecond: number; longTasks: number; longTaskMs: number }

function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) return { count: 0, p50: null, p95: null, max: null }
  const sorted = [...samples].sort((first, second) => first - second)
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!
  return { count: sorted.length, p50: round(median(sorted), 2), p95: round(percentile(0.95), 2), max: round(sorted.at(-1)!, 2) }
}

/** Creates `count` threads in the fixture's own project. Returns each thread's (qualified) ID, in creation order. */
async function padSidebar(page: Page, count: number): Promise<string[]> {
  return page.evaluate(async ({ count, projectId, modelId }) => {
    const agents = window.sotto!.agents!
    const ids: string[] = []
    for (let index = 0; index < count; index++) {
      const created = await agents.command({ type: 'create-thread', projectId, title: `Freeze bench ${index + 1}`, titleSource: 'user', modelId, workingCopy: 'shared' })
      if (created.error || !created.activeThreadId) throw new Error(created.error ?? 'No thread was created.')
      ids.push(created.activeThreadId)
    }
    return ids
  }, { count, projectId: PROJECT_ID, modelId: MODEL_ID })
}

/**
 * A fresh thread is a local draft until it is sent: `sottoE2E.agentEvent` reaches the fixture host directly, and
 * the host holds no thread until its first message starts a native session. One synthetic prompt and reply each, so
 * every padding thread has a provider session the coordinator, the workspace and Watcher walk, idle as most of the
 * owner's threads are, and the threads this benchmark streams to exist there before `streamReplies` addresses them by
 * their bare ID.
 */
async function registerThreads(page: Page, threadIds: readonly string[]): Promise<void> {
  await page.evaluate(async ids => {
    const agents = window.sotto!.agents!
    for (const threadId of ids) {
      const sent = await agents.command({ type: 'manual-send', threadId, text: 'Freeze bench registration.' })
      if (sent.error) throw new Error(sent.error)
      await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: threadId.replace(/^host:[0-9a-f-]+:/iu, ''), text: 'Synthetic reply.', status: 'idle' })
    }
  }, threadIds)
}

/**
 * A remote host on this machine with the owner's threads, each a conversation its provider holds, paired with `profile`
 * so the launched app can join it. Returns it, its connection and its threads' IDs as it names them.
 */
async function remoteHost(profile: string) {
  const native = new E2EAgentHost()
  await native.initializeWorkingFolders(join(profile, 'working-folders', 'remote'))
  // The provider's own threads, as a host that has worked for weeks lists them, each with an answered exchange.
  const provider = (native as unknown as { state: AgentHostSnapshot }).state
  const at = new Date().toISOString()
  provider.threads = Array.from({ length: history(OWNER_SCALE.remoteThreads) }, (_, index): AgentThread => ({ id: `remote-${index}`,
    title: `Remote bench ${index + 1}`, projectId: provider.projects[0]!.id, modelId: MODEL_ID, status: 'idle', requests: [],
    messages: [{ id: `remote-${index}-prompt`, role: 'user', text: 'Synthetic prompt', createdAt: at }, { id: `remote-${index}-reply`, role: 'assistant', text: 'Synthetic reply', createdAt: at }] }))
  const host = await startHeadlessHost({ dataDirectory: join(profile, 'remote-host'), port: 0, providers: { claude: native } })
  const url = `http://127.0.0.1:${host.descriptor!.port}`
  try {
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
    await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: randomUUID(), name: 'Forge fixture', target: 'forge', identityFile: '',
      installPath: '/opt/sotto', dataDirectory: '/data/sotto', enabled: false, hostId: paired.hostId, clientId: paired.clientId }]))
    const socket = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false })
    try {
      await socket.connect()
      await socket.command({ type: 'configure', patch: { provider: 'claude', enabledProviders: ['claude'] } })
      await socket.command({ type: 'connect', provider: 'claude' })
      const threadIds = socket.shell().host.threads.map(thread => thread.id)
      if (threadIds.length !== provider.threads.length) throw new Error(`The remote host lists ${threadIds.length} threads of its provider's ${provider.threads.length}.`)
      const connection: RemoteHostE2EConnection = { url, token: paired.token, hostId: paired.hostId }
      return { host, connection, threadIds }
    } finally { await socket.close() }
  } catch (error) { await host.close(); throw error }
}

/**
 * The rest of the owner's history, written into the closed profile in the app's own files: Watcher's record in
 * `agents.json`, with `watcher` as the current Watcher, standing watches on `watched` and its past requests and
 * operations on `others` and the remote host's threads, and the answer retirements and Watcher owners in
 * `request-drafts.json`. The fixture's provider has no Watcher model, so Watcher cannot be opened from the window; the
 * record names one of the padding threads as the current Watcher instead, as if it had been, so main's wake-up pass reads
 * the standing watches and gathers their evidence on every update, as it does for the owner (`watcherWakeUp.ts`).
 */
async function writeHistory(profile: string, localHostId: string, watcher: string, watched: readonly string[], others: readonly string[],
  remote: { hostId: string; threadIds: readonly string[] }): Promise<void> {
  const file = join(profile, 'agents.json')
  const saved = JSON.parse(await readFile(file, 'utf8')) as { watcher: WatcherRecord }
  const at = new Date().toISOString()
  saved.watcher.current = { target: { hostId: localHostId, threadId: watcher }, projectId: PROJECT_ID, provider: 'claude', creationOperationId: randomUUID(), createdAt: at }
  saved.watcher.watches = watched.map(threadId => ({ id: randomUUID(), target: { hostId: localHostId, threadId }, createdAt: at, generation: 0 }))
  addWatcherHistory(saved.watcher, [...others.map(threadId => ({ hostId: localHostId, threadId })), ...remote.threadIds.map(threadId => ({ hostId: remote.hostId, threadId }))],
    { requests: history(OWNER_SCALE.requests), operations: history(OWNER_SCALE.operations) })
  await writeFile(file, JSON.stringify(saved), 'utf8')
  await writeFile(join(profile, 'request-drafts.json'), ownerRequestDrafts(others, remote, { retirements: history(OWNER_SCALE.retirements),
    remoteRetirements: history(OWNER_SCALE.remoteRetirements), watcherOwners: history(OWNER_SCALE.watcherOwners) }), 'utf8')
}

/** Starts `monitorEventLoopDelay` and a 50 ms drift sampler in main; both run until `endFreezeMonitor` reads them. */
async function beginFreezeMonitor(launched: LaunchedSotto): Promise<void> {
  await launched.app.evaluate(() => {
    const perfHooks = process.getBuiltinModule('node:perf_hooks') as typeof import('node:perf_hooks')
    const histogram = perfHooks.monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()
    const state = { lastTick: globalThis.performance.now(), stalls: 0 }
    const interval = setInterval(() => {
      const now = globalThis.performance.now()
      if (now - state.lastTick >= 100) state.stalls += 1
      state.lastTick = now
    }, 50)
    ;(globalThis as unknown as { __freezeMonitor?: unknown }).__freezeMonitor = { histogram, interval, state }
  })
}

async function endFreezeMonitor(launched: LaunchedSotto): Promise<FreezeSample> {
  return launched.app.evaluate(() => {
    type Monitor = { histogram: import('node:perf_hooks').IntervalHistogram; interval: NodeJS.Timeout; state: { stalls: number } }
    const monitor = (globalThis as unknown as { __freezeMonitor?: Monitor }).__freezeMonitor
    if (!monitor) throw new Error('E2E_FREEZE_MONITOR_MISSING')
    clearInterval(monitor.interval)
    monitor.histogram.disable()
    const result = { maxMs: Number(monitor.histogram.max) / 1e6, meanMs: Number(monitor.histogram.mean) / 1e6,
      p99Ms: Number(monitor.histogram.percentile(99)) / 1e6, stallCount: monitor.state.stalls, samples: Number(monitor.histogram.count) }
    monitor.histogram.reset()
    delete (globalThis as unknown as { __freezeMonitor?: unknown }).__freezeMonitor
    return result
  })
}

/**
 * A keydown-to-input-to-next-frame sample per printable keystroke in the composer, the way
 * `workspace-performance.spec.ts` measures typing. `globalThis.performance`, not the bare name: this module
 * also imports `performance` from `node:perf_hooks` for `streamReplies`' Node-side pacing, and that import
 * shadows the browser global in whatever this function serializes to for `page.evaluate`.
 */
async function attachTypingInstrumentation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const started = new WeakMap<Element, number>()
    window.__freezeTyping = []
    window.__freezeKeyHandling = []
    document.addEventListener('keydown', event => {
      const target = event.target as Element
      if (!target.matches?.('.prompt-editor[role="textbox"]')) return
      if (event.key.length === 1) started.set(target, globalThis.performance.now())
    }, true)
    document.addEventListener('input', event => {
      const target = event.target as Element
      const startedAt = started.get(target)
      if (startedAt === undefined) return
      started.delete(target)
      window.__freezeKeyHandling!.push(globalThis.performance.now() - startedAt)
      requestAnimationFrame(() => window.__freezeTyping!.push(globalThis.performance.now() - startedAt))
    }, true)
  })
}

async function resetTyping(page: Page): Promise<void> { await page.evaluate(() => { window.__freezeTyping = []; window.__freezeKeyHandling = [] }) }
async function readTyping(page: Page): Promise<{ latency: number[]; handling: number[] }> {
  return page.evaluate(() => ({ latency: window.__freezeTyping ?? [], handling: window.__freezeKeyHandling ?? [] }))
}

/**
 * Starts counting what the window does in a case: animation frames, long tasks, and in main, the state broadcasts sent
 * to it. With `SOTTO_FREEZE_PROFILE` set, also a CPU profile of the window. `endWindowProbe` reads them all back.
 */
async function beginWindowProbe(launched: LaunchedSotto) {
  await launched.page.evaluate(() => {
    let stopped = false
    const probe: WindowProbe = { frames: 0, longTasks: 0, longTaskMs: 0, stop: () => { stopped = true; observer.disconnect() } }
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) { probe.longTasks++; probe.longTaskMs += entry.duration } })
    observer.observe({ type: 'longtask' })
    const frame = (): void => { if (stopped) return; probe.frames++; requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
    window.__freezeWindow = probe
  })
  // Counted where main sends them: the window's own listener sits behind the preload's bridge.
  await launched.app.evaluate(({ BrowserWindow }, channel) => {
    const counter = { sent: 0, restore: [] as (() => void)[] }
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents
      const send = contents.send
      contents.send = function (sent: string, ...args: unknown[]) { if (sent === channel) counter.sent++; return send.call(this, sent, ...args) }
      counter.restore.push(() => { contents.send = send })
    }
    ;(globalThis as unknown as { __freezeBroadcasts?: typeof counter }).__freezeBroadcasts = counter
  }, AGENT_STATE)
  const folder = process.env.SOTTO_FREEZE_PROFILE
  if (!folder) return { startedAt: performance.now() }
  const cdp = await launched.page.context().newCDPSession(launched.page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.start')
  return { startedAt: performance.now(), profile: { cdp, folder } }
}

async function endWindowProbe(launched: LaunchedSotto, probe: Awaited<ReturnType<typeof beginWindowProbe>>, name: string): Promise<WindowSample> {
  const seconds = (performance.now() - probe.startedAt) / 1_000
  if (probe.profile) {
    const { profile } = await probe.profile.cdp.send('Profiler.stop')
    await writeFile(join(probe.profile.folder, `${name.replace(/[^a-z0-9]+/giu, '-')}.cpuprofile`), JSON.stringify(profile))
    await probe.profile.cdp.detach()
  }
  const broadcasts = await launched.app.evaluate(() => {
    const counter = (globalThis as unknown as { __freezeBroadcasts?: { sent: number; restore: (() => void)[] } }).__freezeBroadcasts!
    for (const restore of counter.restore) restore()
    delete (globalThis as unknown as { __freezeBroadcasts?: unknown }).__freezeBroadcasts
    return counter.sent
  })
  const drawn = await launched.page.evaluate(() => {
    const probe = window.__freezeWindow!
    probe.stop()
    return { frames: probe.frames, longTasks: probe.longTasks, longTaskMs: probe.longTaskMs }
  })
  return { framesPerSecond: round(drawn.frames / seconds, 1), stateBroadcastsPerSecond: round(broadcasts / seconds, 1),
    longTasks: drawn.longTasks, longTaskMs: Math.round(drawn.longTaskMs) }
}

/** Streams one growing assistant message a thread, at `STREAM_CHUNKS_PER_SECOND`, for `durationMs`. Bare (unqualified) thread IDs: `sottoE2E.agentEvent` reaches the fixture host directly. */
async function streamReplies(page: Page, bareThreadIds: readonly string[], durationMs: number): Promise<number[]> {
  const cadenceMs = 1_000 / STREAM_CHUNKS_PER_SECOND
  return Promise.all(bareThreadIds.map(async bareId => {
    const startedAt = performance.now()
    let text = 'Synthetic streaming reply.'
    let chunk = 0
    for (; performance.now() - startedAt < durationMs; chunk++) {
      const delay = startedAt + chunk * cadenceMs - performance.now()
      if (delay > 0) await setTimeout(delay)
      text += ` chunk-${chunk}`
      await page.evaluate(async ({ threadId, messageId, text }) => window.sottoE2E!.agentEvent!({
        type: 'stream', threadId, messageId, text, status: 'running',
      }), { threadId: bareId, messageId: `freeze-stream-${bareId}`, text })
    }
    return chunk
  }))
}

/** Streams `bareStreamIds` (if any) while typing a synthetic string into `composer`, then reads both measurements back. */
async function runCase(launched: LaunchedSotto, composer: Locator, bareStreamIds: readonly string[], name: string): Promise<{ chunksEmitted: number[]; freeze: FreezeSample; typingSamples: number[]; keyHandling: number[]; window: WindowSample; invalid?: string }> {
  await resetTyping(launched.page)
  const probe = await beginWindowProbe(launched)
  await beginFreezeMonitor(launched)
  const [chunksEmitted] = await Promise.all([
    streamReplies(launched.page, bareStreamIds, STREAM_DURATION_MS),
    // A frozen main holds every key, so typing may take far longer than the stream; the limits below say so, not a timeout.
    composer.pressSequentially(SYNTHETIC_TEXT, { delay: KEY_DELAY_MS, timeout: 10 * STREAM_DURATION_MS }),
  ])
  const freeze = await endFreezeMonitor(launched)
  const window = await endWindowProbe(launched, probe, name)
  // A validity guard, not a limit: an off-screen window's keystroke times measure Chromium's throttling, not Sotto.
  const invalid = window.framesPerSecond < MIN_FRAMES_PER_SECOND
    ? `The window drew ${window.framesPerSecond} frames a second in "${name}", so it was minimized, covered or behind a locked screen, where Chromium draws about once a second: its keystroke times measure that, not Sotto. Keep the window on screen and run the spec again.`
    : undefined
  if (invalid && PERF_ASSERT) throw new Error(invalid)
  // A busy renderer queues the typing samples' requestAnimationFrame callbacks behind its backlog; give it a
  // moment to drain before reading them, or the last several keystrokes of a heavily loaded case read as missing.
  await setTimeout(2_000)
  const { latency: typingSamples, handling: keyHandling } = await readTyping(launched.page)
  // `fillPrompt` sets the field's full value at once, which a controlled ProseMirror editor does not always
  // pick up; backspacing what was actually typed, key by key, is what this composer already answers to.
  for (let remaining = SYNTHETIC_TEXT.length; remaining > 0; remaining--) await composer.press('Backspace')
  await expectPromptText(composer, '')
  return { chunksEmitted, freeze, typingSamples, keyHandling, window, ...invalid ? { invalid } : {} }
}

test('main stays responsive while threads stream with the owner\'s history', async () => {
  test.skip(!PERF_BENCH, 'A timing benchmark: run with SOTTO_PERF_BENCH=1 after npm run build.')
  test.setTimeout(1_200_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-main-freeze-' })).directory
  let remote: Awaited<ReturnType<typeof remoteHost>> | undefined
  const results: CaseResult[] = []
  try {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
    remote = await remoteHost(profile)
    const joined = remote
    // On Owl, where Watcher runs, as the owner's build does.
    await onReleaseTrack('owl', async () => {
      // First the threads, then the rest of the history in the app's own files while the app is closed.
      let paddingThreadIds: string[]
      let watcherThread: string
      const first = await launchSotto('success', profile)
      try {
        const { page } = first
        await page.evaluate(async () => {
          await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, checkClientUpdates: false } })
          await window.sotto!.agents!.command({ type: 'connect' })
        })
        await page.reload()
        paddingThreadIds = await padSidebar(page, PADDING_THREADS)
        await expect.poll(async () => (await agentState(page)).host.threads.length).toBe(PADDING_THREADS + 2)
        const bare = paddingThreadIds.map(id => bareEntityId(id)!)
        const localHostId = parseHostEntityKey(paddingThreadIds[0]!)!.hostId
        await closeSotto(first)
        // The first threads stream in the cases below and are watched, the last is Watcher's own, and Watcher's past work
        // names the others.
        const watches = history(OWNER_SCALE.watches)
        watcherThread = bare.at(-1)!
        await writeHistory(profile, localHostId, watcherThread, bare.slice(0, watches), bare.slice(watches, -1), { hostId: joined.connection.hostId, threadIds: joined.threadIds })
      } catch (error) { await closeSotto(first); throw error }

      const launched = await launchSotto('success', profile)
      const { page } = launched
      try {
        // The fixture's provider keeps its sessions only while the app runs, so each thread starts one now. Watcher's own
        // takes no message from the window: main refuses a send to it without the launch profile a real Watcher has.
        await registerThreads(page, paddingThreadIds.filter(id => bareEntityId(id) !== watcherThread))
        await launched.app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, joined.connection)
        await expect.poll(async () => (await agentState(page)).host.threads.length).toBeGreaterThanOrEqual(PADDING_THREADS + 2 + joined.threadIds.length)
        // Main read Watcher's record whole from the file written for it, with the current Watcher and its standing watches.
        const room = await page.evaluate(async () => window.sotto!.watcher!.get())
        expect(room.status === 'ok' ? { current: room.state.current?.target.threadId, watches: room.state.standingWatches?.length ?? 0,
          requests: room.state.requests.length, operations: room.state.receipts.length } : room)
          .toEqual({ current: watcherThread, watches: history(OWNER_SCALE.watches), requests: history(OWNER_SCALE.requests), operations: history(OWNER_SCALE.operations) })
        await openThreads(page)
        const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
        // Opened from the keyboard: on Owl the row's Open beside action sits over the middle of the row and takes a click.
        await sidebar.getByRole('button', { name: COMPOSER_THREAD_TITLE, exact: true }).focus()
        await page.keyboard.press('Enter')
        const composer = promptField(page)
        await composer.click()
        await expect(page.locator('section.thread-pane')).toHaveAttribute('data-focused')
        await attachTypingInstrumentation(page)

        // The first three padding threads stream; their bare (pre-qualification) IDs are what `sottoE2E.agentEvent`
        // reaches in the fixture host.
        const bareStreamIds = paddingThreadIds.slice(0, 3).map(id => bareEntityId(id)!)
        const runCases: readonly { name: string; streamIds: readonly string[] }[] = [
          { name: 'baseline (nothing streaming)', streamIds: [] },
          { name: '1 thread streaming', streamIds: bareStreamIds.slice(0, 1) },
          { name: '3 threads streaming', streamIds: bareStreamIds.slice(0, 3) },
        ]
        for (const { name, streamIds } of runCases) {
          const { chunksEmitted, freeze, typingSamples, keyHandling, window, invalid } = await runCase(launched, composer, streamIds, name)
          const result: CaseResult = { name, streamingThreads: streamIds.length, chunksEmitted, eventLoopDelay: freeze,
            keystrokeLatencyMs: distribution(typingSamples), keyHandlingMs: distribution(keyHandling), window, valid: invalid === undefined, ...invalid ? { invalid } : {} }
          results.push(result)
          console.log(`main freeze: ${JSON.stringify(result)}`)
        }

        expect(results).toHaveLength(runCases.length)
        for (const result of results) {
          expect(result.eventLoopDelay.samples).toBeGreaterThan(0)
          expect(result.keystrokeLatencyMs.count).toBeGreaterThan(0)
        }
        expect(results[1]!.chunksEmitted).toHaveLength(1)
        expect(results[2]!.chunksEmitted).toHaveLength(3)
        // Watcher's wake-up pass ran through the cases: it still watches the threads that streamed, and observed them again.
        const after = await page.evaluate(async () => window.sotto!.watcher!.get())
        if (room.status !== 'ok' || after.status !== 'ok') throw new Error(`Watcher's room could not be read: ${JSON.stringify(after)}`)
        expect(after.state.watchedThreads.filter(thread => thread.watched !== false).length).toBeGreaterThanOrEqual(history(OWNER_SCALE.watches))
        expect(Date.parse(after.state.observedAt)).toBeGreaterThan(Date.parse(room.state.observedAt))
        // Limits only when asked, as the nightly run asks: a stopwatch is never a pull request's gate.
        if (PERF_ASSERT) {
          const over = results.flatMap(result => {
            const limit = FREEZE_LIMITS[result.streamingThreads]!
            return [
              ...result.eventLoopDelay.maxMs > limit.maxMs ? [`${result.name}: main's longest stall was ${round(result.eventLoopDelay.maxMs, 1)} ms, limit ${limit.maxMs} ms`] : [],
              ...result.eventLoopDelay.stallCount > limit.stalls ? [`${result.name}: main stalled 100 ms or more ${result.eventLoopDelay.stallCount} times, limit ${limit.stalls}`] : [],
            ]
          })
          expect(over, `Main froze past its limits with the owner's history: ${over.join('; ')}. Count the work per update with tests/perf/ownerScaleWorkBudget.perf.test.ts, and profile main as docs/perf/2026-10-20-main-lag.md describes.`).toEqual([])
        }
      } finally { await closeSotto(launched) }
    })
  } finally {
    await remote?.host.close()
    await removeOwnedE2EProfile(profile)
  }
})
