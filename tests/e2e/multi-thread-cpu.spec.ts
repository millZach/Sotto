import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { expect, test, type Page } from '@playwright/test'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

/** Candidate or fixed-build Electron diagnostic. The phase3 provider is synthetic and uses its
 * legacy snapshot contract; this does not establish a native-adapter CPU improvement. */
const IDS = ['visual-gate', 'footer-links', 'weekly-note', 'grok-previews', 'release-notes',
  'wav-stall', 'thread-routing', 'benchmark'] as const
const PANES = [
  ['visual-gate', 'Visual gate flake'], ['footer-links', 'Footer links'],
  ['weekly-note', 'Weekly note'], ['grok-previews', 'Grok voice previews'],
] as const
const STREAM_THREAD = 'footer-links'
const PERMISSION_THREAD = 'visual-gate'
const RECORDS = 500
const OUTPUT_BYTES = 4096
const STREAM_UPDATES = 18
const SAMPLE_MS = 1_100

function pane(page: Page, id: string) { return page.locator(`section.thread-pane[data-thread-id="${id}"]`) }

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(800, 540)
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(size =>
    Math.abs(innerWidth - size.width) <= 2 && Math.abs(innerHeight - size.height) <= 2,
  { width, height })).toBe(true)
}

async function seed(page: Page): Promise<void> {
  // The bridge builds synthetic strings in the renderer, so protocol bodies and screenshots
  // contain no account data. Each thread reaches the real workspace and event store.
  await page.evaluate(async ({ ids, records, outputBytes }) => {
    for (const threadId of ids) {
      const messages = [
        { id: `cpu-${threadId}-prompt`, role: 'user' as const, text: 'Inspect synthetic work.',
          createdAt: '2026-09-23T12:00:00.000Z' },
        { id: `cpu-${threadId}-reply`, role: 'assistant' as const, text: 'Synthetic work is in progress.',
          createdAt: '2026-09-23T12:00:01.000Z' },
      ]
      const activities = Array.from({ length: records }, (_, sequence) => ({
        id: `cpu-${threadId}-${sequence}`, turnId: `cpu-${threadId}-turn`, sequence,
        afterMessageId: messages[0]!.id, kind: 'command' as const, title: 'Synthetic command',
        status: 'completed' as const, output: 'x'.repeat(outputBytes),
        completedAt: '2026-09-23T12:00:02.000Z',
      }))
      await window.sottoE2E!.agentEvent!({ type: 'history', threadId, text: '',
        messages, activities, status: 'running' })
    }
    await window.sottoE2E!.agentEvent!({ type: 'permission', threadId: 'visual-gate',
      text: 'Run the synthetic verification command?', status: 'running', request: {
        id: 'cpu-permission', kind: 'permission', text: 'Run the synthetic verification command?', options: [],
        permissionChoices: [
          { id: 'once', label: 'Allow once', kind: 'allow-once' },
          { id: 'deny', label: 'Deny', kind: 'deny' },
        ],
      } })
  }, { ids: IDS, records: RECORDS, outputBytes: OUTPUT_BYTES })
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.sotto!.agents!.get())
    return IDS.filter(id => state.host.threads.find(thread => thread.id === hostEntityKey(state.hostId, id))
      ?.summary?.activityCount === RECORDS).length
  }).toBe(IDS.length)
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.sotto!.agents!.get())
    return state.host.threads.find(thread => thread.id === hostEntityKey(state.hostId, PERMISSION_THREAD))
      ?.requests.map(request => request.id)
  }).toContain('cpu-permission')
}

async function beginCpu(launched: LaunchedSotto, phase: string) {
  return launched.app.evaluate(({ app, BrowserWindow }, phase) => {
    const getMain = () => (process as unknown as { getCPUUsage: () => {
      percentCPUUsage: number; cumulativeCPUUsage?: number } }).getCPUUsage()
    const mainWindow = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    return { phase, rendererPid: mainWindow.webContents.getOSProcessId(),
      startedAt: globalThis.performance.now(), firstMain: getMain(), first: app.getAppMetrics() }
  }, phase)
}

async function endCpu(launched: LaunchedSotto, start: Awaited<ReturnType<typeof beginCpu>>) {
  return launched.app.evaluate(({ app, BrowserWindow }, start) => {
    const getMain = () => (process as unknown as { getCPUUsage: () => {
      percentCPUUsage: number; cumulativeCPUUsage?: number } }).getCPUUsage()
    const mainWindow = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    const durationMs = globalThis.performance.now() - start.startedAt
    const lastMain = getMain()
    const last = app.getAppMetrics()
    if (last.filter(metric => metric.pid === start.rendererPid).length !== 1) {
      throw new Error('Primary renderer is missing from Electron process metrics.')
    }
    const before = new Map(start.first.map(metric => [metric.pid, metric]))
    return { phase: start.phase, durationMs, focused: mainWindow.isFocused(), minimized: mainWindow.isMinimized(),
      visible: mainWindow.isVisible(), rendererPid: start.rendererPid,
      mainGetCPUUsage: { percentCPUUsage: lastMain.percentCPUUsage,
        cumulativeSecondsDelta: start.firstMain.cumulativeCPUUsage === undefined || lastMain.cumulativeCPUUsage === undefined
          ? null : lastMain.cumulativeCPUUsage - start.firstMain.cumulativeCPUUsage },
      processes: last.map(metric => ({ pid: metric.pid, type: metric.type, name: metric.name ?? null,
        primaryRenderer: metric.pid === start.rendererPid, percentCPUUsage: metric.cpu.percentCPUUsage,
        cumulativeSecondsDelta: metric.cpu.cumulativeCPUUsage === undefined
          || before.get(metric.pid)?.cpu.cumulativeCPUUsage === undefined ? null
          : metric.cpu.cumulativeCPUUsage - before.get(metric.pid)!.cpu.cumulativeCPUUsage!,
        workingSetSize: metric.memory.workingSetSize })) }
  }, start)
}

test('synthetic thread histories keep streaming and permission available across window states', async () => {
  test.setTimeout(180_000)
  const testInfo = test.info()
  const mainEntry = resolve(process.env.SOTTO_E2E_MAIN_ENTRY ?? 'out/main/index.js')
  const mainSha256 = createHash('sha256').update(await readFile(mainEntry)).digest('hex')
  const launchStarted = performance.now()
  const launched = await launchSotto('phase3-workspace')
  const launchMs = performance.now() - launchStarted
  const { page } = launched
  const cpu: unknown[] = []
  const interactions: Record<string, unknown> = {}
  let streamedText = 'Synthetic streaming reply.'
  let focusHelperId: number | undefined
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    const hostId = (await page.evaluate(() => window.sotto!.agents!.get())).hostId
    const key = (id: string): string => hostEntityKey(hostId, id)
    await resize(launched, 1600, 1000)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: PANES[0][1], exact: true }).click()
    for (const [, title] of PANES.slice(1)) {
      await sidebar.getByRole('button', { name: title, exact: true }).hover()
      await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click()
    }
    await expect(page.locator('section.thread-pane:not([data-hidden])')).toHaveCount(PANES.length)
    await seed(page)
    const permission = pane(page, key(PERMISSION_THREAD)).locator('.agent-request[data-kind="permission"]')
    await expect(permission.getByRole('button', { name: 'Deny' })).toBeEnabled()
    await expect(pane(page, key(STREAM_THREAD)).getByLabel('Thread transcript')).toContainText('Synthetic work is in progress.')

    const prompt = pane(page, key(STREAM_THREAD)).getByRole('textbox', { name: 'Prompt', exact: true })
    let started = performance.now()
    await prompt.click()
    await expect(pane(page, key(STREAM_THREAD))).toHaveAttribute('data-focused')
    interactions.focusMs = performance.now() - started
    started = performance.now()
    await prompt.fill('Synthetic CPU verification prompt.')
    await expect(prompt).toHaveValue('Synthetic CPU verification prompt.')
    interactions.typeMs = performance.now() - started
    started = performance.now()
    await prompt.press('Enter')
    await expect(prompt).toHaveValue('')
    interactions.sendAcknowledgedMs = performance.now() - started

    async function emitStream(phase: string) {
      const injectionMs: number[] = []
      const startedAt = performance.now()
      for (let index = 0; index < STREAM_UPDATES; index++) {
        const delay = startedAt + index * 50 - performance.now()
        if (delay > 0) await setTimeout(delay)
        streamedText += ` ${phase}/${index}`
        const at = performance.now()
        await page.evaluate(async ({ threadId, text }) => window.sottoE2E!.agentEvent!({ type: 'stream',
          threadId, messageId: 'cpu-stream', text, status: 'running' }), { threadId: STREAM_THREAD, text: streamedText })
        injectionMs.push(performance.now() - at)
      }
      return { updates: STREAM_UPDATES, elapsedMs: performance.now() - startedAt,
        injectionMs, finalMarker: `${phase}/${STREAM_UPDATES - 1}` }
    }

    for (const phase of ['visible', 'unfocused', 'minimized'] as const) {
      if (phase === 'unfocused') {
        focusHelperId = await launched.app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
          const helper = new BrowserWindow({ width: 160, height: 100, show: true, skipTaskbar: true })
          window.setFocusable(false)
          helper.focus()
          return helper.id
        })
        await expect.poll(() => launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
          .find(item => item.webContents.getURL().endsWith('/index.html'))!.isFocused())).toBe(false)
      }
      if (phase === 'minimized') {
        await launched.app.evaluate(({ BrowserWindow }, helperId) => {
          const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
          BrowserWindow.fromId(helperId)?.close()
          window.setFocusable(true)
          window.minimize()
        }, focusHelperId!)
        focusHelperId = undefined
        await expect.poll(() => launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
          .find(item => item.webContents.getURL().endsWith('/index.html'))!.isMinimized())).toBe(true)
      }
      const startedCpu = await beginCpu(launched, phase)
      const startedPhase = performance.now()
      const streamed = await emitStream(phase)
      const remaining = SAMPLE_MS - (performance.now() - startedPhase)
      if (remaining > 0) await setTimeout(remaining)
      const measured = await endCpu(launched, startedCpu)
      expect(measured.processes.filter(metric => metric.primaryRenderer)).toHaveLength(1)
      cpu.push(measured)
      interactions[`${phase}Stream`] = streamed
      if (phase !== 'minimized') await expect(pane(page, key(STREAM_THREAD)).getByLabel('Thread transcript'))
        .toContainText(streamed.finalMarker)
    }

    await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
      window.restore(); window.focus()
    })
    await expect.poll(() => launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(item => item.webContents.getURL().endsWith('/index.html'))!.isMinimized())).toBe(false)
    const displayStarted = performance.now()
    await expect(pane(page, key(STREAM_THREAD)).getByLabel('Thread transcript')).toContainText(`minimized/${STREAM_UPDATES - 1}`)
    interactions.restoreToLatestTextMs = performance.now() - displayStarted
    await expect(permission.getByRole('button', { name: 'Deny' })).toBeEnabled()

    await page.screenshot({ path: testInfo.outputPath('cpu-1600x1000-dark.png'), animations: 'disabled' })
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await resize(launched, 1280, 800)
    await page.screenshot({ path: testInfo.outputPath('cpu-1280x800-light.png'), animations: 'disabled' })
    await page.evaluate(() => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await resize(launched, 820, 560)
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await sidebar.getByRole('button', { name: PANES[0][1], exact: true }).click()
    await expect(permission.getByRole('button', { name: 'Deny' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('cpu-820x560-reduced-motion.png'), animations: 'disabled' })
    await expect(permission.getByRole('button', { name: 'Deny' })).toBeEnabled()
    await permission.getByRole('button', { name: 'Deny' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.sotto!.agents!.get())).host.threads
      .find(thread => thread.id === key(PERMISSION_THREAD))?.requests.map(request => request.id)).not.toContain('cpu-permission')

  } finally {
    if (focusHelperId !== undefined) await launched.app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.fromId(id)?.close()
      BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))?.setFocusable(true)
    }, focusHelperId).catch(() => undefined)
    await writeFile(testInfo.outputPath('cpu-measurements.json'), `${JSON.stringify({
      scope: 'Synthetic phase3 provider through real coordinator, workspace, IPC and Electron; legacy provider snapshots do not exercise native-adapter immutable publication.',
      mainEntry, mainSha256, launchMs, logicalCpus: cpus().length, retainedActivitiesPerThread: RECORDS,
      retainedThreads: IDS.length, commandOutputBytes: OUTPUT_BYTES, observedPanes: PANES.length,
      sampleTargetMs: SAMPLE_MS, cpu, interactions,
    }, null, 2)}\n`, 'utf8')
    await closeSotto(launched)
  }
})
