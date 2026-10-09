/**
 * Process memory with the native adapters holding long histories (issue #369). The built app runs the real
 * Claude and Codex adapters over the fake CLIs in `tests/fixtures/` (`SOTTO_E2E_NATIVE_FIXTURE_ROOT` in
 * `src/main/index.ts`), holds 1, 4 or 8 threads of 1,002 messages each, and records the working sets of main,
 * the window's renderer and the provider processes: with the window on Dictate, which shows no pane, then with the
 * Threads page showing one pane, then on Dictate again. It prints sizes and counts, never what a thread said. It asserts
 * no size, so it runs only when asked, after `npm run build`, like the timing benchmarks (`docs/ci.md`):
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx playwright test tests/e2e/native-process-memory.spec.ts
 *   sh:          SOTTO_PERF_BENCH=1 npx playwright test tests/e2e/native-process-memory.spec.ts
 *
 * The provider figures are the fake CLIs', which say what Sotto's traffic costs a Node process holding the
 * same history, not what Claude Code or Codex would hold. `docs/perf/2026-09-27-native-process-memory.md` has
 * the numbers and what they mean.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const run = promisify(execFile)
/** Filler turns after the first exchange: 500 prompts and 500 replies, so every thread holds 1,002 messages. */
const FILLER_TURNS = 500
const MESSAGES = 2 + FILLER_TURNS * 2
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
// Main keeps the pages it read histories into in its working set for a while after collections free them, sometimes
// for more than a minute, so each measurement waits and the settled no-pane figure is taken last.
const SETTLE_MS = 20_000
const SAMPLES = 5
const SAMPLE_GAP_MS = 500
const MiB = 1024 * 1024
const FAKES = { claude: 'fakeClaudeThread.mjs', codex: 'fakeCodexAppServer.mjs' } as const
type Provider = keyof typeof FAKES

interface OsProcess { pid: number; ppid: number; bytes: number; command: string }

/** Every process on the machine with its parent and working set (resident set on macOS). Command lines stay here. */
async function osProcesses(): Promise<OsProcess[]> {
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress'],
    { maxBuffer: 64 * MiB, windowsHide: true })
    return (JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number; WorkingSetSize: number; CommandLine: string | null }[])
      .map(item => ({ pid: item.ProcessId, ppid: item.ParentProcessId, bytes: Number(item.WorkingSetSize), command: item.CommandLine ?? '' }))
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], { maxBuffer: 64 * MiB })
  return stdout.split('\n').filter(line => line.trim()).map(line => {
    const [pid, ppid, rss, ...command] = line.trim().split(/\s+/u)
    return { pid: Number(pid), ppid: Number(ppid), bytes: Number(rss) * 1024, command: command.join(' ') }
  })
}

/**
 * Full collections in main and in the window's renderer, so what is measured is what is held. Three rounds a
 * few hundred milliseconds apart give V8 the chance to hand freed pages back, which one collection often does not.
 */
async function collect(launched: LaunchedSotto): Promise<void> {
  await launched.app.evaluate(async ({ BrowserWindow }) => {
    const v8 = process.getBuiltinModule('node:v8') as typeof import('node:v8')
    const vm = process.getBuiltinModule('node:vm') as typeof import('node:vm')
    v8.setFlagsFromString('--expose-gc')
    const gc = vm.runInNewContext('gc') as () => void
    const devtools = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.webContents.debugger
    devtools.attach('1.3')
    try {
      for (let round = 0; round < 3; round++) {
        gc()
        await devtools.sendCommand('HeapProfiler.collectGarbage')
        await new Promise(resolve => globalThis.setTimeout(resolve, 300))
      }
    } finally { devtools.detach() }
  })
}

async function sample(launched: LaunchedSotto, provider: Provider) {
  const electron = await launched.app.evaluate(async ({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    const devtools = window.webContents.debugger
    devtools.attach('1.3')
    const rendererHeap = await devtools.sendCommand('Runtime.getHeapUsage').finally(() => devtools.detach()) as { usedSize: number }
    return { mainPid: process.pid, rendererPid: window.webContents.getOSProcessId(), mainHeapUsed: process.memoryUsage().heapUsed,
      rendererHeapUsed: rendererHeap.usedSize,
      metrics: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, workingSetKiB: metric.memory.workingSetSize,
        privateKiB: metric.memory.privateBytes ?? 0 })) }
  })
  const all = await osProcesses()
  const children = new Map<number, OsProcess[]>()
  for (const item of all) children.set(item.ppid, [...children.get(item.ppid) ?? [], item])
  const descendants: OsProcess[] = []
  const queue = [electron.mainPid]
  while (queue.length) for (const child of children.get(queue.shift()!) ?? []) { descendants.push(child); queue.push(child.pid) }
  const electronPids = new Set(electron.metrics.map(metric => metric.pid))
  const providers = descendants.filter(item => item.command.includes(FAKES[provider]))
  const providerPids = new Set(providers.map(item => item.pid))
  // On Windows each console child of a window app gets its own console host; they are counted beside the providers.
  const consoles = descendants.filter(item => providerPids.has(item.ppid) && !providerPids.has(item.pid))
  const metric = (pid: number) => electron.metrics.find(item => item.pid === pid)!
  const ofType = (type: string) => electron.metrics.filter(metric => metric.type === type && metric.pid !== electron.rendererPid)
    .reduce((sum, metric) => sum + metric.workingSetKiB * 1024, 0)
  return {
    main: metric(electron.mainPid).workingSetKiB * 1024, mainPrivate: metric(electron.mainPid).privateKiB * 1024, mainHeap: electron.mainHeapUsed,
    renderer: metric(electron.rendererPid).workingSetKiB * 1024, rendererPrivate: metric(electron.rendererPid).privateKiB * 1024,
    rendererHeap: electron.rendererHeapUsed,
    otherRenderers: ofType('Tab'), otherRendererCount: electron.metrics.filter(metric => metric.type === 'Tab' && metric.pid !== electron.rendererPid).length,
    gpu: ofType('GPU'), utility: ofType('Utility'),
    providers: providers.reduce((sum, item) => sum + item.bytes, 0), providerCount: providers.length,
    consoles: consoles.reduce((sum, item) => sum + item.bytes, 0),
    otherChildren: descendants.filter(item => !electronPids.has(item.pid) && !providerPids.has(item.pid) && !consoles.includes(item))
      .reduce((sum, item) => sum + item.bytes, 0),
  }
}

/** The median of `SAMPLES` samples after a collection and a settle, in MiB. */
async function measure(launched: LaunchedSotto, provider: Provider) {
  await setTimeout(SETTLE_MS)
  await collect(launched)
  await setTimeout(1_000)
  const samples: Awaited<ReturnType<typeof sample>>[] = []
  for (let index = 0; index < SAMPLES; index++) {
    if (index) await setTimeout(SAMPLE_GAP_MS)
    samples.push(await sample(launched, provider))
  }
  const field = (key: keyof (typeof samples)[number]) => round(median(samples.map(item => item[key])) / MiB, 1)
  const providerCount = median(samples.map(item => item.providerCount))
  // Private bytes are Windows-only in Electron's metrics; elsewhere they read 0.
  const figures = { mainMiB: field('main'), mainPrivateMiB: field('mainPrivate'), mainHeapMiB: field('mainHeap'),
    rendererMiB: field('renderer'), rendererPrivateMiB: field('rendererPrivate'), rendererHeapMiB: field('rendererHeap'),
    gpuMiB: field('gpu'), utilityMiB: field('utility'), otherRenderersMiB: field('otherRenderers'),
    otherRendererCount: median(samples.map(item => item.otherRendererCount)),
    providersMiB: field('providers'), providerCount, consoleHostsMiB: field('consoles'), otherChildrenMiB: field('otherChildren') }
  return { ...figures, totalMiB: round(figures.mainMiB + figures.rendererMiB + figures.gpuMiB + figures.utilityMiB + figures.otherRenderersMiB
    + figures.providersMiB + figures.consoleHostsMiB + figures.otherChildrenMiB, 1) }
}

const userText = WORDS.repeat(2)
const replyText = WORDS.repeat(8)

/** Claude: every open CLI streams and records 500 filler exchanges, then finishes the turn the prompt started. */
async function seedClaude(root: string, count: number): Promise<void> {
  const alive = async () => (await readdir(root)).filter(name => /^alive-.+\.json$/u.test(name)).map(name => name.slice(6, -5))
  await expect.poll(async () => (await alive()).length, { timeout: 60_000 }).toBe(count)
  await Promise.all((await alive()).map(async session => {
    const control = join(root, `control-${session}.json`)
    const frames = Array.from({ length: FILLER_TURNS * 2 }, (_, index) => index % 2 === 0
      ? { type: 'user', uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { role: 'user', content: userText } }
      : { type: 'assistant', uuid: randomUUID(), session_id: session, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: replyText }] } })
    await writeFile(control, JSON.stringify({ id: randomUUID(), type: 'raw-burst', persist: true, frames }))
    await expect.poll(() => existsSync(control), { timeout: 60_000 }).toBe(false)
    await writeFile(control, JSON.stringify({ id: randomUUID(), type: 'complete', text: replyText }))
    await expect.poll(() => existsSync(control), { timeout: 60_000 }).toBe(false)
  }))
}

/**
 * Codex: one app server. Each thread's history gains 500 completed filler turns the way another Codex on the same
 * session would add them, in the shared history and not on this connection's stream. Main then reconnects and reads
 * every thread once, as it does when a pane first opens a thread after Sotto starts. Streaming them instead saves
 * Sotto's thread records once a frame, which no real turn does two thousand times in a row.
 */
async function seedCodex(page: Page, root: string, ids: readonly string[]): Promise<void> {
  type FakeState = { threads: Record<string, { turns: { status: string }[] }> }
  const state = async () => JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as FakeState
  const answered = (turns: { status: string }[]) => turns.length === 1 && turns[0]!.status === 'completed'
  await expect.poll(async () => Object.values((await state()).threads).filter(thread => answered(thread.turns)).length, { timeout: 60_000 }).toBe(ids.length)
  for (const threadId of Object.keys((await state()).threads)) {
    const id = randomUUID()
    await writeFile(join(root, 'control.json'), JSON.stringify({ id, threadId, type: 'native-turn', count: FILLER_TURNS, text: userText, reply: replyText }))
    await expect.poll(async () => (await readFile(join(root, 'actions.jsonl'), 'utf8').catch(() => '')).includes(id), { timeout: 60_000 }).toBe(true)
  }
  // Codex reads a thread's turns once, when Sotto holds none for it, so the history is read after a reconnect.
  await page.evaluate(async () => {
    for (const type of ['disconnect', 'connect'] as const) {
      const result = await window.sotto!.agents!.command({ type, provider: 'codex' })
      if (result.error) throw new Error(result.error)
    }
  })
  await observe(page, ids)
  await expect.poll(async () => (await held(page, ids)).messages, { timeout: 120_000 }).toEqual(ids.map(() => MESSAGES))
  await observe(page, [])
}

/** Says which threads the window is watching, as the Threads page does when its panes change. */
async function observe(page: Page, ids: readonly string[]): Promise<void> {
  await page.evaluate(async threadIds => {
    const result = await window.sotto!.agents!.command({ type: 'observe-threads', threadIds: [...threadIds] })
    if (result.error) throw new Error(result.error)
  }, ids)
}

/** Creates `count` threads in one project and sends each a prompt, so each is held by its open provider session. */
async function createThreads(page: Page, provider: Provider, project: string, count: number): Promise<string[]> {
  return page.evaluate(async ({ provider, project, count }) => {
    const agents = window.sotto!.agents!
    const created = await agents.command({ type: 'create-project', provider, title: 'Memory benchmark', path: project, useExisting: true })
    if (created.error) throw new Error(created.error)
    const projectId = created.host.projects.find(item => item.title === 'Memory benchmark')!.id
    const model = (await agents.get()).host.models.find(item => item.providerId === provider && item.ready)
    if (!model) throw new Error(`No ready ${provider} model.`)
    const ids: string[] = []
    for (let index = 0; index < count; index++) {
      const thread = await agents.command({ type: 'create-thread', projectId, title: `Held ${index + 1}`, titleSource: 'user', modelId: model.id, workingCopy: 'shared', managed: false })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
      const sent = await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Synthetic benchmark prompt.' })
      if (sent.error) throw new Error(sent.error)
      ids.push(thread.activeThreadId)
    }
    return ids
  }, { provider, project, count })
}

async function held(page: Page, ids: readonly string[]): Promise<{ messages: number[]; statuses: string[] }> {
  return page.evaluate(async ids => {
    const threads = (await window.sotto!.agents!.get()).host.threads
    const found = ids.map(id => threads.find(thread => thread.id === id))
    return { messages: found.map(thread => thread?.summary?.messageCount ?? -1), statuses: found.map(thread => thread?.status ?? 'missing') }
  }, ids)
}

for (const provider of ['claude', 'codex'] as const) {
  for (const count of [1, 4, 8]) {
    test(`${provider}: process memory with ${count} held thread(s) of ${MESSAGES} messages`, async () => {
      test.skip(!PERF_BENCH, 'A memory benchmark: run with SOTTO_PERF_BENCH=1 after npm run build.')
      test.setTimeout(300_000)
      const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-memory-'))
      const root = join(profile, 'native-fixture')
      const project = join(root, 'project')
      for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
      // Codex answers each prompt at once, so every thread is idle with one exchange before the filler.
      await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: replyText }))
      const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
      process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
      process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
      const mainEntry = resolve(process.env.SOTTO_E2E_MAIN_ENTRY ?? 'out/main/index.js')
      let launched: LaunchedSotto | undefined
      try {
        launched = await launchSotto('success', profile)
        const { page } = launched
        await page.evaluate(async provider => {
          await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
          const configured = await window.sotto!.agents!.command({ type: 'configure', patch: { provider, enabled: true, enabledProviders: [provider], } })
          if (configured.error) throw new Error(configured.error)
          const connected = await window.sotto!.agents!.command({ type: 'connect', provider })
          if (connected.error) throw new Error(connected.error)
        }, provider)
        await page.reload()
        await resizeWindow(launched, 1280, 800)
        // Dictate shows no thread pane; leaving Threads tells main that no thread is watched.
        await page.getByRole('tab', { name: 'Dictate', exact: true }).click()
        await expect(page.locator('section.thread-pane')).toHaveCount(0)
        const ids = await createThreads(page, provider, project, count)
        if (provider === 'claude') await seedClaude(join(root, 'claude'), count)
        else await seedCodex(page, join(root, 'codex'), ids)
        await expect.poll(() => held(page, ids), { timeout: 120_000 })
          .toEqual({ messages: ids.map(() => MESSAGES), statuses: ids.map(() => 'idle') })
        // Still carries what reading the histories left in the working sets; `noPane` below is the settled figure.
        const noPaneAfterSeeding = await measure(launched, provider)

        await openThreads(page)
        const row = page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Held 1', exact: true })
        await row.click({ timeout: 60_000 }).catch(async (error: unknown) => {
          await page.screenshot({ path: test.info().outputPath('sidebar.png') })
          throw error
        })
        const pane = page.locator('section.thread-pane:not([data-hidden])')
        await expect(pane).toHaveCount(1)
        await expect(pane).toHaveAttribute('data-thread-id', ids[0]!)
        await expect(pane.getByLabel('Thread transcript').locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30_000 })
        const onePane = await measure(launched, provider)

        await page.getByRole('tab', { name: 'Dictate', exact: true }).click()
        await expect(page.locator('section.thread-pane')).toHaveCount(0)
        const noPane = await measure(launched, provider)
        expect(await held(page, ids)).toEqual({ messages: ids.map(() => MESSAGES), statuses: ids.map(() => 'idle') })
        const violations = await Promise.all(['claude', 'codex'].map(folder => readFile(join(root, folder, 'violations.jsonl'), 'utf8').catch(() => '')))
        expect(violations.join('')).toBe('')

        const result = { provider, threads: count, messagesPerThread: MESSAGES, noPaneAfterSeeding, onePane, noPane }
        console.log(`native process memory: ${JSON.stringify(result)}`)
        await writeFile(test.info().outputPath('native-process-memory.json'), `${JSON.stringify({
          ...result, platform: process.platform, logicalCpus: cpus().length,
          mainEntry, mainSha256: createHash('sha256').update(await readFile(mainEntry)).digest('hex'),
        }, null, 2)}\n`, 'utf8')
      } finally {
        if (launched) await closeSotto(launched)
        for (const [key, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable]] as const) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value
        }
        await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
      }
    })
  }
}
