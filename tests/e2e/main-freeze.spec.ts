import { expectPromptText, promptField } from './support/prompt'
import { agentState } from './support/agentAccess'
import { setTimeout } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { bareEntityId, closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

/**
 * `docs/perf/2026-10-15-main-freeze.md`: a live profile of the owner's Sotto, with 232 threads in the
 * sidebar and a few streaming, found main's JavaScript thread busy about 82% of the time over 5.5 minutes, with
 * 1,032 stretches of 100 ms or more without going idle (longest 1.5 s), from whole-state deep copies on every
 * streamed update. This reproduces the shape in the built app: about 230 threads in the sidebar and 1, then 3,
 * of them streaming a reply at a realistic rate, while measuring main's event-loop delay and keystroke-to-screen
 * latency in an idle thread's composer. It asserts no time budget, so it runs only when asked:
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npm run build; npx playwright test tests/e2e/main-freeze.spec.ts
 *   sh:          SOTTO_PERF_BENCH=1 npm run build && npx playwright test tests/e2e/main-freeze.spec.ts
 *
 * `docs/perf/2026-10-15-main-freeze.md` has what the numbers mean and where to record a run's results.
 */
const PROJECT_ID = 'project'
const MODEL_ID = 'claude:test'
/** Threads created beyond the fixture's own two (`workshop`, `docs`), so the sidebar holds about 232. */
const PADDING_THREADS = 230
const STREAM_CHUNKS_PER_SECOND = 20
const STREAM_DURATION_MS = 15_000
const SYNTHETIC_TEXT = 'Synthetic benchmark text for keystrokes.'
const KEY_DELAY_MS = Math.round(STREAM_DURATION_MS / SYNTHETIC_TEXT.length)
const COMPOSER_THREAD_TITLE = 'Docs'

declare global { interface Window { __freezeTyping?: number[] } }

interface FreezeSample { maxMs: number; meanMs: number; p99Ms: number; stallCount: number; samples: number }
interface Distribution { count: number; p50: number | null; p95: number | null; max: number | null }
interface CaseResult {
  readonly name: string
  readonly streamingThreads: number
  readonly chunksEmitted: number[]
  readonly eventLoopDelay: FreezeSample
  readonly keystrokeLatencyMs: Distribution
}

function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) return { count: 0, p50: null, p95: null, max: null }
  const sorted = [...samples].sort((first, second) => first - second)
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!
  return { count: sorted.length, p50: round(median(sorted), 2), p95: round(percentile(0.95), 2), max: round(sorted.at(-1)!, 2) }
}

/** Creates `count` threads in the fixture's own project, so the sidebar grows without touching any provider. Returns each thread's (qualified) ID, in creation order. */
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
 * the host holds no thread until its first message starts a native session. One synthetic prompt each, so the
 * threads this benchmark streams to exist there before `streamReplies` addresses them by their bare ID.
 */
async function registerThreads(page: Page, threadIds: readonly string[]): Promise<void> {
  await page.evaluate(async ids => {
    const agents = window.sotto!.agents!
    for (const threadId of ids) {
      const sent = await agents.command({ type: 'manual-send', threadId, text: 'Freeze bench registration.' })
      if (sent.error) throw new Error(sent.error)
    }
  }, threadIds)
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
      requestAnimationFrame(() => window.__freezeTyping!.push(globalThis.performance.now() - startedAt))
    }, true)
  })
}

async function resetTyping(page: Page): Promise<void> { await page.evaluate(() => { window.__freezeTyping = [] }) }
async function readTyping(page: Page): Promise<number[]> { return page.evaluate(() => window.__freezeTyping ?? []) }

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
async function runCase(launched: LaunchedSotto, composer: Locator, bareStreamIds: readonly string[]): Promise<{ chunksEmitted: number[]; freeze: FreezeSample; typingSamples: number[] }> {
  await resetTyping(launched.page)
  await beginFreezeMonitor(launched)
  const [chunksEmitted] = await Promise.all([
    streamReplies(launched.page, bareStreamIds, STREAM_DURATION_MS),
    composer.pressSequentially(SYNTHETIC_TEXT, { delay: KEY_DELAY_MS }),
  ])
  const freeze = await endFreezeMonitor(launched)
  // A busy renderer queues the typing samples' requestAnimationFrame callbacks behind its backlog; give it a
  // moment to drain before reading them, or the last several keystrokes of a heavily loaded case read as missing.
  await setTimeout(2_000)
  const typingSamples = await readTyping(launched.page)
  // `fillPrompt` sets the field's full value at once, which a controlled ProseMirror editor does not always
  // pick up; backspacing what was actually typed, key by key, is what this composer already answers to.
  for (let remaining = SYNTHETIC_TEXT.length; remaining > 0; remaining--) await composer.press('Backspace')
  await expectPromptText(composer, '')
  return { chunksEmitted, freeze, typingSamples }
}

test('main stays responsive while a large sidebar streams', async () => {
  test.skip(!PERF_BENCH, 'A timing benchmark: run with SOTTO_PERF_BENCH=1 after npm run build.')
  test.setTimeout(600_000)
  const launched = await launchSotto()
  const { page } = launched
  const results: CaseResult[] = []
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    const paddingThreadIds = await padSidebar(page, PADDING_THREADS)
    await expect.poll(async () => (await agentState(page)).host.threads.length).toBe(PADDING_THREADS + 2)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: COMPOSER_THREAD_TITLE, exact: true }).click()
    const composer = promptField(page)
    await composer.click()
    await expect(page.locator('section.thread-pane')).toHaveAttribute('data-focused')
    await attachTypingInstrumentation(page)

    // The first three padding threads, once a prompt starts their native session, are what the streaming
    // cases address; their bare (pre-qualification) IDs are what `sottoE2E.agentEvent` reaches in the fixture host.
    const streamThreadIds = paddingThreadIds.slice(0, 3)
    const bareStreamIds = streamThreadIds.map(id => bareEntityId(id)!)

    const runCases: readonly { name: string; streamIds: readonly string[] }[] = [
      { name: 'baseline (nothing streaming)', streamIds: [] },
      { name: '1 thread streaming', streamIds: bareStreamIds.slice(0, 1) },
      { name: '3 threads streaming', streamIds: bareStreamIds.slice(0, 3) },
    ]
    for (const { name, streamIds } of runCases) {
      if (streamIds.length > 0 && results.every(result => result.streamingThreads === 0)) await registerThreads(page, streamThreadIds)
      const { chunksEmitted, freeze, typingSamples } = await runCase(launched, composer, streamIds)
      const result: CaseResult = { name, streamingThreads: streamIds.length, chunksEmitted, eventLoopDelay: freeze, keystrokeLatencyMs: distribution(typingSamples) }
      results.push(result)
      console.log(`main freeze: ${JSON.stringify(result)}`)
    }

    // Shape only: this benchmark reports numbers, it does not budget them (`SOTTO_PERF_ASSERT` is the opt-in for that).
    expect(results).toHaveLength(runCases.length)
    for (const result of results) {
      expect(result.eventLoopDelay.samples).toBeGreaterThan(0)
      expect(result.keystrokeLatencyMs.count).toBeGreaterThan(0)
    }
    expect(results[1]!.chunksEmitted).toHaveLength(1)
    expect(results[2]!.chunksEmitted).toHaveLength(3)
  } finally { await closeSotto(launched) }
})
