import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, release, totalmem } from 'node:os'
import { expect, test, type Page } from '@playwright/test'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

const THREADS = ['grok-previews', 'footer-links', 'weekly-note', 'visual-gate']
const TITLES = ['Grok voice previews', 'Footer links', 'Weekly note', 'Visual gate flake']
const SEND_ROUNDS = 20
const STREAM_UPDATES = 40
const STREAM_CADENCE_MS = 50
const FOCUS_ROUNDS = 32
const CONCURRENT_MIN_UPDATES = 80
const CONCURRENT_MAX_UPDATES = 240
const CONCURRENT_CADENCE_MS = 100
const CONCURRENT_SENDS = 8
const CONCURRENT_FOCUS = 12
type Sample = { dom: number; frame: number; startedAt: number }
type StreamSample = Sample & { sequence: number; transport: number; displayedAt: number }
interface Measurements {
  send: Sample[]
  focus: Sample[]
  typing: Sample[]
  acknowledged: Sample[]
  stream: StreamSample[]
  injections: Record<string, number>
  arrivals: Record<string, number>
  rendered: Record<string, boolean>
  emitted: number[]
}
interface Timing extends Measurements { interacting: boolean; interactionsDone: boolean; concurrent: Measurements }
declare global { interface Window { __workspacePerformance: Timing } }

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null
  return { count: values.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null }
}

async function instrumentation(page: Page, streamKey: string): Promise<void> {
  await page.evaluate(streamKey => {
    const empty = (): Measurements => ({ send: [], focus: [], typing: [], acknowledged: [], stream: [], injections: {}, arrivals: {}, rendered: {}, emitted: [] })
    const timing: Timing = window.__workspacePerformance = { ...empty(), interacting: false, interactionsDone: false, concurrent: empty() }
    const observe = (root: Element, ready: () => boolean, done: (sample: Sample) => void, started = performance.now()) => {
      const observer = new MutationObserver(() => {
        if (!ready()) return
        observer.disconnect()
        const dom = performance.now() - started
        requestAnimationFrame(() => done({ dom, frame: performance.now() - started, startedAt: started }))
      })
      observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })
      setTimeout(() => observer.disconnect(), 10_000)
    }
    const typing = new WeakMap<HTMLElement, { startedAt: number; target: Measurements }>()
    document.addEventListener('keydown', event => {
      const prompt = event.target as HTMLElement
      if (!prompt.matches('textarea[aria-label="Prompt"], textarea[id^="thread-"]')) return
      const target = timing.interacting ? timing.concurrent : timing
      if (event.key.length === 1) typing.set(prompt, { startedAt: performance.now(), target })
      if (event.key !== 'Enter' || event.shiftKey) return
      const pane = prompt.closest('section.thread-pane')!
      const submittedText = (prompt as HTMLTextAreaElement).value.trim()
      observe(pane, () => [...pane.querySelectorAll('article.thread-message[data-role="user"]')]
        .some(message => message.textContent?.includes(submittedText)), sample => target.send.push(sample))
      // The prompt empties only once the main process accepts the send, so this crosses the
      // renderer/main round trip that the pending-message DOM does not.
      const startedAt = performance.now()
      const cleared = () => {
        const elapsed = performance.now() - startedAt
        if ((prompt as HTMLTextAreaElement).value === '') target.acknowledged.push({ dom: elapsed, frame: elapsed, startedAt })
        else if (elapsed < 10_000) requestAnimationFrame(cleared)
      }
      requestAnimationFrame(cleared)
    }, true)
    document.addEventListener('input', event => {
      const prompt = event.target as HTMLElement
      const key = typing.get(prompt)
      if (!key) return
      typing.delete(prompt)
      const dom = performance.now() - key.startedAt
      requestAnimationFrame(() => key.target.typing.push({ dom, frame: performance.now() - key.startedAt, startedAt: key.startedAt }))
    }, true)
    document.addEventListener('pointerdown', event => {
      const pane = (event.target as HTMLElement).closest('section.thread-pane')
      if (!pane || pane.hasAttribute('data-focused')) return
      const target = timing.interacting ? timing.concurrent : timing
      observe(pane, () => pane.hasAttribute('data-focused'), sample => target.focus.push(sample))
    }, true)
    // The shell carries summaries; the viewed pane's messages arrive on the detail channel.
    // This callback runs after preload validates the detail, including any streamed delta.
    const pane = document.querySelector(`section.thread-pane[data-thread-id="${streamKey}"]`)!
    const recordRender = () => {
      const messages = pane.querySelectorAll('.thread-message[data-role="assistant"]')
      const marker = /PERF_(STREAM|CONCURRENT)_(\d+)\b/.exec(messages[messages.length - 1]?.textContent ?? '')
      const sequence = marker?.[2]
      const target = marker?.[1] === 'CONCURRENT' ? timing.concurrent : timing
      if (sequence === undefined || target.rendered[sequence] || target.arrivals[sequence] === undefined) return
      target.rendered[sequence] = true
      const arrival = target.arrivals[sequence]!
      const dom = performance.now() - arrival
      requestAnimationFrame(() => {
        const displayedAt = performance.now()
        target.stream.push({ dom, frame: displayedAt - arrival, startedAt: arrival, sequence: Number(sequence), transport: arrival - target.injections[sequence]!, displayedAt })
      })
    }
    window.sotto!.agents!.onThreadDetail!(update => {
      if (update.threadId !== streamKey) return
      const text = 'messages' in update
        ? update.messages.at(-1)?.text ?? ''
        : update.messageDeltas.findLast(item => 'message' in item)?.message.text ?? ''
      const marker = /PERF_(STREAM|CONCURRENT)_(\d+)\b/.exec(text)
      const sequence = marker?.[2]
      const target = marker?.[1] === 'CONCURRENT' ? timing.concurrent : timing
      if (sequence === undefined || target.arrivals[sequence] !== undefined) return
      const arrival = performance.now()
      target.arrivals[sequence] = arrival
      recordRender()
    })
    // One observer, regardless of coalescing: an observer per skipped intermediate update
    // would keep scanning the transcript and become part of the load being measured.
    new MutationObserver(recordRender).observe(pane, { childList: true, subtree: true, characterData: true })
  }, streamKey)
}

test('long histories retain local send, streaming and four-pane responsiveness independently of provider latency', async () => {
  test.setTimeout(240_000)
  const testInfo = test.info()
  const rendererSource = 'src/renderer/src/agents/MessageContent.tsx'
  const sourceInputs = {
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceState: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() ? 'uncommitted working tree' : 'clean checkout',
    rendererSource, rendererSourceSha256: createHash('sha256').update(await readFile(rendererSource)).digest('hex'),
  }
  const launched = await launchSotto('phase3-workspace')
  const { page } = launched
  const scenarios: unknown[] = []
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    const hostId = (await page.evaluate(() => window.sotto!.agents!.get())).hostId
    const key = (id: string): string => hostEntityKey(hostId, id)
    await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      window.setContentSize(1600, 1000)
    })
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: TITLES[0]!, exact: true }).click()
    for (const title of TITLES.slice(1)) {
      await sidebar.getByRole('button', { name: title, exact: true }).hover()
      await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click()
    }
    const pane = (id: string) => page.locator(`section.thread-pane[data-thread-id="${key(id)}"]`)
    await expect(page.locator('section.thread-pane:not([data-hidden])')).toHaveCount(4)
    await instrumentation(page, key(THREADS[0]!))

    for (const historyLength of [80, 2_000]) {
      // Same four panes and rendering budget; only stored transcript length changes.
      // Alternate prompts and Markdown replies with lists, inline code, and fenced code.
      const seeded = await page.evaluate(async ({ ids, count }) => {
        let textBytes = 0
        for (const threadId of ids) {
          const messages = Array.from({ length: count }, (_, index) => {
            const text = index % 2 === 0
              ? `Review step ${index}: verify the controls preserve the thread's working copy and explain the result. Check the saved draft, the selected project and the next action before continuing.`
              : `### Inspection ${index}\n\nThe working copy retains its project context and the saved draft is scoped to this thread.\n\n- Read the configuration and compare the active values.\n- Keep the previous result available for review.\n\n\`\`\`ts\nconst result = { thread: '${threadId}', step: ${index}, ready: true }\n\`\`\`\n\nThe next step can use \`result.ready\` after verification.`
            textBytes += new TextEncoder().encode(text).length
            return { id: `perf-${threadId}-${index}`, role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
              text, createdAt: new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString() }
          })
          await window.sottoE2E!.agentEvent!({ type: 'history', threadId, text: '', messages, status: 'idle', activities: [] })
        }
        return { textBytes }
      }, { ids: THREADS, count: historyLength })
      await expect(pane(THREADS[0]!).getByLabel('Thread transcript')).toContainText(`Inspection ${historyLength - 1}`)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await page.evaluate(() => {
        const empty = (): Measurements => ({ send: [], focus: [], typing: [], acknowledged: [], stream: [], injections: {}, arrivals: {}, rendered: {}, emitted: [] })
        Object.assign(window.__workspacePerformance, { ...empty(), interacting: false, interactionsDone: false, concurrent: empty() })
      })
      const prompt = pane(THREADS[0]!).getByRole('textbox', { name: 'Prompt', exact: true })
      for (let round = 0; round < SEND_ROUNDS; round++) {
        await prompt.fill(`Performance ${historyLength} send ${round}`)
        await prompt.press('Enter')
        await expect(prompt).toHaveValue('')
        await page.evaluate(async ({ threadId, round }) => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, text: `Completed measured send ${round}.` }), { threadId: THREADS[0]!, round })
        await expect(pane(THREADS[0]!).getByLabel('Thread transcript')).toContainText(`Completed measured send ${round}.`)
      }
      await page.evaluate(async ({ updates, cadence, threadId }) => {
        const timing = window.__workspacePerformance
        const pending: Promise<void>[] = []
        const started = performance.now()
        for (let sequence = 0; sequence < updates; sequence++) {
          const delay = started + sequence * cadence - performance.now()
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
          timing.injections[sequence] = performance.now()
          timing.emitted.push(performance.now() - started)
          // A same-ID growing assistant message exercises actual incremental Markdown rendering.
          pending.push(window.sottoE2E!.agentEvent!({ type: 'stream', threadId, messageId: 'perf-stream', status: 'running',
            text: `PERF_STREAM_${sequence} update\n\n${'A measured incremental response preserves thread context. '.repeat(sequence + 1)}` }))
        }
        await Promise.all(pending)
      }, { updates: STREAM_UPDATES, cadence: STREAM_CADENCE_MS, threadId: THREADS[0]! })
      await expect(pane(THREADS[0]!).getByLabel('Thread transcript')).toContainText(`PERF_STREAM_${STREAM_UPDATES - 1} `)
      for (let round = 0; round < FOCUS_ROUNDS; round++) {
        const id = THREADS[(round + 1) % THREADS.length]!
        await pane(id).getByRole('textbox', { name: 'Prompt', exact: true }).click()
        await expect(pane(id)).toHaveAttribute('data-focused')
      }
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      // Keep the isolated baseline above comparable. This additional burst tests foreground
      // typing/sending/focus competition after removing deferred Markdown scheduling.
      await page.evaluate(() => { window.__workspacePerformance.interacting = true })
      // Stream until every foreground interaction has finished, so none of them can fall after
      // the burst on a slower run; the cap keeps a stalled interaction from streaming forever.
      const concurrentStream = page.evaluate(async ({ minimum, maximum, cadence, threadId }) => {
        const shared = window.__workspacePerformance
        const timing = shared.concurrent
        const pending: Promise<void>[] = []
        const started = performance.now()
        let sequence = 0
        for (; sequence < maximum && (sequence < minimum || !shared.interactionsDone); sequence++) {
          const delay = started + sequence * cadence - performance.now()
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
          timing.injections[sequence] = performance.now()
          timing.emitted.push(performance.now() - started)
          pending.push(window.sottoE2E!.agentEvent!({ type: 'stream', threadId, messageId: 'perf-stream', status: 'running',
            text: `PERF_CONCURRENT_${sequence} update\n\n${'Streaming continues while another pane receives input. '.repeat(sequence + 1)}` }))
        }
        await Promise.all(pending)
        return sequence
      }, { minimum: CONCURRENT_MIN_UPDATES, maximum: CONCURRENT_MAX_UPDATES, cadence: CONCURRENT_CADENCE_MS, threadId: THREADS[0]! })
      // Report the interaction failure itself rather than this stream's later closed-page rejection.
      concurrentStream.catch(() => undefined)
      for (let round = 0; round < CONCURRENT_FOCUS; round++) {
        const id = THREADS[1 + round % 3]!
        const input = pane(id).getByRole('textbox', { name: 'Prompt', exact: true })
        await input.click()
        await expect(pane(id)).toHaveAttribute('data-focused')
        if (round >= CONCURRENT_SENDS) continue
        const text = `C${round}`
        await input.pressSequentially(text)
        await expect(input).toHaveValue(text)
        await input.press('Enter')
        await expect(input).toHaveValue('')
        await page.evaluate(async ({ threadId, round }) => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, text: `Concurrent send ${round} completed.` }), { threadId: id, round })
        await expect(pane(id).getByLabel('Thread transcript')).toContainText(`Concurrent send ${round} completed.`)
      }
      await page.evaluate(() => { window.__workspacePerformance.interactionsDone = true })
      const concurrentUpdates = await concurrentStream
      await expect(pane(THREADS[0]!).getByLabel('Thread transcript')).toContainText(`PERF_CONCURRENT_${concurrentUpdates - 1} `)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await page.evaluate(() => { window.__workspacePerformance.interacting = false })
      const timing = await page.evaluate(() => window.__workspacePerformance)
      const concurrent = timing.concurrent
      const duringArrivals = (sample: Sample) => sample.startedAt >= concurrent.injections[0]! && sample.startedAt <= concurrent.arrivals[concurrentUpdates - 1]!
      const rendered = await page.locator('section.thread-pane').evaluateAll(panes => panes.map(pane => ({
        threadId: (pane as HTMLElement).dataset.threadId, messageCount: pane.querySelectorAll('article.thread-message').length,
      })))
      const metrics = {
        historyMessagesPerThread: historyLength, paneCount: THREADS.length, ...seeded, rendered,
        send: { domMs: distribution(timing.send.map(sample => sample.dom)), nextFrameMs: distribution(timing.send.map(sample => sample.frame)),
          acknowledgedMs: distribution(timing.acknowledged.map(sample => sample.frame)) },
        stream: { rendererDomMs: distribution(timing.stream.map(sample => sample.dom)), rendererNextFrameMs: distribution(timing.stream.map(sample => sample.frame)),
          controlledTransportMs: distribution(Object.entries(timing.arrivals).map(([sequence, arrival]) => arrival - timing.injections[sequence]!)),
          visibleUpdateGapMs: distribution(timing.stream.map((sample, index) => sample.displayedAt - (timing.stream[index - 1]?.displayedAt ?? timing.injections[0]!))),
          observedSnapshots: Object.keys(timing.arrivals).length,
          emittedUpdates: STREAM_UPDATES, renderedUpdates: timing.stream.length, coalescedUpdates: STREAM_UPDATES - timing.stream.length,
          requestedCadenceMs: STREAM_CADENCE_MS, actualEmissionIntervalMs: distribution(timing.emitted.slice(1).map((value, index) => value - timing.emitted[index]!)) },
        focus: { domMs: distribution(timing.focus.map(sample => sample.dom)), nextFrameMs: distribution(timing.focus.map(sample => sample.frame)) },
        concurrent: {
          emittedUpdates: concurrentUpdates, requestedCadenceMs: CONCURRENT_CADENCE_MS, observedSnapshots: Object.keys(concurrent.arrivals).length,
          renderedUpdates: concurrent.stream.length, coalescedUpdates: concurrentUpdates - concurrent.stream.length,
          actualEmissionIntervalMs: distribution(concurrent.emitted.slice(1).map((value, index) => value - concurrent.emitted[index]!)),
          rendererNextFrameMs: distribution(concurrent.stream.map(sample => sample.frame)),
          controlledTransportMs: distribution(Object.entries(concurrent.arrivals).map(([sequence, arrival]) => arrival - concurrent.injections[sequence]!)),
          visibleUpdateGapMs: distribution(concurrent.stream.map((sample, index) => sample.displayedAt - (concurrent.stream[index - 1]?.displayedAt ?? concurrent.injections[0]!))),
          injectionToDisplayMs: distribution(concurrent.stream.map(sample => sample.displayedAt - concurrent.injections[sample.sequence]!)),
          sendNextFrameMs: distribution(concurrent.send.map(sample => sample.frame)), sendAcknowledgedMs: distribution(concurrent.acknowledged.map(sample => sample.frame)),
          typingNextFrameMs: distribution(concurrent.typing.map(sample => sample.frame)),
          focusNextFrameMs: distribution(concurrent.focus.map(sample => sample.frame)),
          sendsDuringStream: concurrent.send.filter(duringArrivals).length, typingDuringStream: concurrent.typing.filter(duringArrivals).length,
          focusDuringStream: concurrent.focus.filter(duringArrivals).length,
        },
        samples: timing,
      }
      scenarios.push(metrics)
      await mkdir(testInfo.outputDir, { recursive: true })
      await page.screenshot({ path: testInfo.outputPath(`four-panes-${historyLength}.png`) })
      await writeFile(testInfo.outputPath('performance.json'), JSON.stringify({
        measuredAt: new Date().toISOString(), ...sourceInputs,
        environment: { platform: process.platform, osRelease: release(), cpu: cpus()[0]?.model, logicalProcessors: cpus().length, memoryGiB: totalmem() / 2 ** 30,
          electron: await launched.app.evaluate(() => process.versions), renderer: await page.evaluate(() => ({ userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio })) },
        definitions: { localSend: 'Captured Enter keydown to pending-message DOM and next requestAnimationFrame callback.',
          sendAcknowledged: 'Captured Enter keydown to the first animation frame whose prompt is empty. The prompt clears only after the main process accepts the send, so this includes the renderer/main round trip and any main-process backlog.',
          typing: 'Captured printable keydown to the textarea input event and next requestAnimationFrame callback; actual typed value is asserted before sending.',
          rendererStream: 'Validated renderer bridge thread-detail callback to matching assistant text DOM and next requestAnimationFrame callback. This is a frame opportunity, not a physical display timestamp.',
          visibleUpdateGap: 'Time between frame callbacks containing distinct streamed versions, including first injection to first rendered frame. Includes transport, coalescing and lateness of the in-renderer injector timers; no provider/network latency.',
          injectionToDisplay: 'E2E event injection of one streamed version to the next frame callback showing it: how stale visible text is, independent of when the injector managed to emit.',
          controlledTransport: 'E2E event injection to renderer bridge callback, including fixture/main controller/IPC/preload parsing. No provider or network timing is measured.',
          paneFocus: 'Captured pointerdown on another pane to its data-focused DOM attribute and next requestAnimationFrame callback.' },
        scenarios,
      }, null, 2))
      console.log(JSON.stringify({ historyLength, send: metrics.send, stream: metrics.stream, focus: metrics.focus, concurrent: metrics.concurrent }))
      // Soft guards: a miss in the shorter history must not hide the long-history measurement.
      expect.soft(timing.send).toHaveLength(SEND_ROUNDS)
      expect.soft(timing.focus).toHaveLength(FOCUS_ROUNDS)
      expect.soft(Object.keys(timing.arrivals).length).toBeGreaterThan(0)
      expect.soft(timing.stream.at(-1)?.sequence).toBe(STREAM_UPDATES - 1)
      expect.soft(metrics.send.nextFrameMs.p95).toBeLessThan(100)
      expect.soft(metrics.send.nextFrameMs.max).toBeLessThan(100)
      expect.soft(metrics.stream.rendererNextFrameMs.p95).toBeLessThan(200)
      expect.soft(metrics.stream.visibleUpdateGapMs.max).toBeLessThan(200)
      expect.soft(metrics.focus.nextFrameMs.p95).toBeLessThan(100)
      expect.soft(concurrent.send).toHaveLength(CONCURRENT_SENDS)
      expect.soft(concurrent.focus).toHaveLength(CONCURRENT_FOCUS)
      expect.soft(concurrent.typing).toHaveLength(CONCURRENT_SENDS * 2)
      expect.soft(concurrentUpdates).toBeLessThan(CONCURRENT_MAX_UPDATES)
      expect.soft(Object.keys(concurrent.arrivals).length).toBeGreaterThan(0)
      expect.soft(concurrent.stream.at(-1)?.sequence).toBe(concurrentUpdates - 1)
      expect.soft(metrics.concurrent.sendsDuringStream).toBe(CONCURRENT_SENDS)
      expect.soft(metrics.concurrent.typingDuringStream).toBe(CONCURRENT_SENDS * 2)
      expect.soft(metrics.concurrent.focusDuringStream).toBe(CONCURRENT_FOCUS)
      expect.soft(metrics.concurrent.sendNextFrameMs.max).toBeLessThan(100)
      expect.soft(metrics.concurrent.typingNextFrameMs.p95).toBeLessThan(100)
      expect.soft(metrics.concurrent.focusNextFrameMs.p95).toBeLessThan(100)
      expect.soft(metrics.concurrent.rendererNextFrameMs.p95).toBeLessThan(200)
      // The injector shares the renderer's event loop, so its late timers inflate raw gaps; guard staleness instead.
      expect.soft(metrics.concurrent.injectionToDisplayMs.max).toBeLessThan(300)
      // A main-process backlog held sends for 2.3 s behind full-history state publication. The
      // round trip still grows with stored history, so this bound catches the queue, not that cost.
      expect.soft(metrics.concurrent.sendAcknowledgedMs.max).toBeLessThan(1_500)
      expect.soft(rendered.every(pane => pane.messageCount <= 81)).toBe(true)
    }
  } finally { await closeSotto(launched) }
})
