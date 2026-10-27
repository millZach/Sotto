import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { hostEntityKey, parseHostEntityKey } from '../../src/shared/clientIdentity'
import { WATCHER_WAKE_UP_PROMPT } from '../../src/main/agents/watcherNews'
import { WATCHER_STAND_IN_KEY } from '../../src/renderer/src/e2e/watcherStandIn'
import { watcherToolSchemas, type WatcherToolName, type WatcherToolOutput } from '../../src/shared/watcher'
import type { WatcherRoomState } from '../../src/shared/watcherRoom'
import { evidenceDirectory } from '../fixtures/evidence'
import { parseProviderRecords, writeProviderAction } from '../fixtures/providerRecords'
import { pageBoundProblems } from './support/designCapture'
import { ownedE2EProfile } from './support/e2eProfile'
import { fillPrompt } from './support/prompt'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow, closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

const evidence = evidenceDirectory('artifacts/watcher-recovery')
const switchTab = (page: Page, name: 'Watcher' | 'Threads') => page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name, exact: true })
const pane = (page: Page) => page.getByRole('region', { name: 'Watcher', exact: true })
/** Opens a thread beside Watcher from All threads, the room's list of every thread. */
async function openBeside(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: /^All threads, \d+\. Show the list$/ }).click()
  await page.getByRole('dialog', { name: 'All threads' }).getByRole('button', { name: `Open ${title} beside Watcher` }).click()
}

async function mainRoom(page: Page): Promise<WatcherRoomState> {
  const read = await page.evaluate(() => window.sotto!.watcher!.get())
  if (read.status !== 'ok') throw new Error(read.message)
  return read.state
}

interface CodexRecord {
  method?: string
  params?: { threadId?: string; input?: { type: string; text?: string }[];
    config?: { mcp_servers?: Record<string, { url: string; http_headers: Record<string, string> }> } }
}

/** Only this owned fake provider's records are read. Its temporary endpoint credentials never leave this closure. */
async function mainTools(codex: string, watcherText: string) {
  // The user bubble and prepared request precede dispatch. Wait for this provider turn and its saved native session.
  await expect.poll(async () => {
    const records = parseProviderRecords<CodexRecord>(await readFile(join(codex, 'requests.jsonl'), 'utf8').catch(() => ''))
    const nativeId = records.find(frame => frame.method === 'turn/start' && frame.params?.input?.some(item => item.text === watcherText))?.params?.threadId
    if (!nativeId) return false
    const state = JSON.parse(await readFile(join(codex, 'state.json'), 'utf8')) as { threads: Record<string, unknown> }
    return Object.keys(state.threads).length === 1 && Object.hasOwn(state.threads, nativeId)
  }).toBe(true)
  const records = parseProviderRecords<CodexRecord>(await readFile(join(codex, 'requests.jsonl'), 'utf8'))
  const watcherNative = records.find(frame => frame.method === 'turn/start' && frame.params?.input?.some(item => item.text === watcherText))?.params?.threadId
  const configured = records.filter(frame => frame.method === 'thread/start' && frame.params?.config?.mcp_servers?.sotto_threads)
  // The endpoint is captured before any worker exists: exactly one native session, the UI-created Watcher.
  const state = JSON.parse(await readFile(join(codex, 'state.json'), 'utf8')) as { threads: Record<string, unknown> }
  expect(watcherNative).toBeTruthy()
  expect(Object.keys(state.threads)).toEqual([watcherNative])
  expect(configured.length).toBe(1)
  const server = configured[0]!.params!.config!.mcp_servers!.sotto_threads!
  const address = new URL(server.url)
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.pathname !== '/mcp') throw new Error('The owned fixture did not supply a loopback tool server.')
  return {
    watcherNative: watcherNative!,
    call: async <N extends WatcherToolName>(name: N, args: unknown): Promise<WatcherToolOutput<N>> => {
      const response = await fetch(server.url, { method: 'POST', headers: { ...server.http_headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) })
      if (!response.ok) throw new Error('The owned Watcher tool call could not be read.')
      const frame = await response.json() as { result?: { structuredContent?: unknown } }
      return watcherToolSchemas[name].output.parse(frame.result?.structuredContent) as WatcherToolOutput<N>
    },
  }
}

async function complete(codex: string, nativeId: string, text: string): Promise<void> {
  const id = await writeProviderAction(join(codex, 'control.json'), { type: 'complete', text }, { threadId: nativeId })
  await expect.poll(async () => parseProviderRecords<{ id: string }>(await readFile(join(codex, 'actions.jsonl'), 'utf8').catch(() => '')).some(action => action.id === id)).toBe(true)
}

/** Finish only this fake Watcher's hidden news turns; a user's next request stays running for its tool call. */
function drainWatcherNews(codex: string, nativeId: string) {
  const completed = new Set<string>()
  return async (): Promise<string[]> => {
    const state = JSON.parse(await readFile(join(codex, 'state.json'), 'utf8')) as {
      threads: Record<string, { turns: { id: string; status: string; items: {
        type: string; content?: { type: string; text?: string }[]
      }[] }[] }>
    }
    const turn = state.threads[nativeId]!.turns.at(-1)
    if (turn?.status !== 'inProgress') return []
    const inputs = turn.items.filter(item => item.type === 'userMessage').flatMap(item => item.content ?? [])
    const texts = inputs.filter(item => item.type === 'text').map(item => item.text ?? '')
    if (inputs.length !== 1 || texts[0] !== WATCHER_WAKE_UP_PROMPT) return texts
    // This fixture creates three worker finishes and a takeover. More than eight wakes is a regression, not a drain.
    expect(completed.size).toBeLessThan(8)
    expect(completed.has(turn.id)).toBe(false)
    completed.add(turn.id)
    await complete(codex, nativeId, 'I have read this recovery worker update.')
    return []
  }
}

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await launched.page.mouse.move(0, 0)
  await launched.page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
  expect(await pageBoundProblems(launched.page)).toEqual([])
  await captureWindow(launched.app, join(evidence, name))
}

/** Real Electron main, native Codex adapter and authenticated tools; only the Codex child is scripted. No room seed. */
test('a fresh Watcher request resumes a watched worker after the user takes over, while the old request stays fenced', async () => {
  test.setTimeout(180_000)
  const profile = await ownedE2EProfile({ prefix: 'sotto-e2e-watcher-recovery-' })
  const root = join(profile.directory, 'native-fixture'), codex = join(root, 'codex'), workerPath = join(root, 'worker')
  const names = ['SOTTO_E2E_NATIVE_FIXTURE_ROOT', 'SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE'] as const
  const previous = new Map(names.map(name => [name, process.env[name]]))
  let launched: LaunchedSotto | undefined
  try {
    for (const folder of [codex, join(root, 'claude'), workerPath]) await mkdir(folder, { recursive: true })
    await writeFile(join(codex, 'script.json'), '{}')
    process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
    process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile.directory)
      const { page } = launched
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const project = await page.evaluate(async path => {
        await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on', threadTitles: false })
        const agents = window.sotto!.agents!
        const configured = await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
        if (configured.error) throw new Error(configured.error)
        const connected = await agents.command({ type: 'connect', provider: 'codex' })
        if (connected.error) throw new Error(connected.error)
        const created = await agents.command({ type: 'create-project', provider: 'codex', title: 'Recovery project', path, useExisting: true })
        if (created.error || !created.activeProjectId) throw new Error('Could not create the owned recovery project.')
        return created.activeProjectId
      }, workerPath)
      await page.reload(); await openThreads(page); await resizeContentWindow(launched, 1280, 800)
      await switchTab(page, 'Watcher').click()
      await expect(page.getByRole('heading', { name: 'Start Watcher', exact: true })).toBeVisible()
      expect((await mainRoom(page)).current).toBeNull()
      expect(await page.evaluate(key => localStorage.getItem(key), WATCHER_STAND_IN_KEY)).toBeNull()
      const first = 'Keep the recovery worker moving until its checks pass.'
      await fillPrompt(page.getByRole('textbox', { name: 'Watcher message' }), first)
      await page.getByRole('button', { name: 'Start Watcher and send' }).click()
      await expect(pane(page).locator('[data-role="user"] .rich-message')).toHaveText(first)
      await expect.poll(async () => (await mainRoom(page)).requests.length).toBe(1)
      const requestA = (await mainRoom(page)).requests[0]!.id
      const tools = await mainTools(codex, first)
      const drainNews = drainWatcherNews(codex, tools.watcherNative)
      const room = await mainRoom(page), hostId = room.current!.target.hostId
      const modelId = room.currentOptions!.modelId
      // The tool starts A's worker through main; the resulting standing watch is main's own durable assignment.
      const start = await tools.call('start_thread', { requestId: requestA, retryKey: randomUUID(), project: { hostId, projectId: parseHostEntityKey(project)?.id ?? project },
        modelId, title: 'Recovery worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Run the first recovery check.' })
      expect(start).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
      if (start.status !== 'ok') throw new Error('Main did not admit the recovery worker.')
      const target = start.target, workerId = hostEntityKey(target.hostId, target.threadId)
      const row = async () => (await mainRoom(page)).watchedThreads.find(item => item.target.threadId === target.threadId)!
      const participationA = async () => (await mainRoom(page)).requests.find(item => item.id === requestA)!.participants.find(item => item.target.threadId === target.threadId)!
      await expect.poll(async () => (await row()).watched).toBe(true)
      const records = parseProviderRecords<CodexRecord>(await readFile(join(codex, 'requests.jsonl'), 'utf8'))
      const workerNative = records.find(frame => frame.method === 'turn/start' && frame.params?.input?.some(item => item.text === 'Run the first recovery check.'))!.params!.threadId!
      await complete(codex, workerNative, 'The first check is ready for your instruction.')
      await expect.poll(async () => (await row()).status).toBe('idle')
      await openBeside(page, 'Recovery worker')
      const worker = page.getByRole('region', { name: 'Recovery worker', exact: true })
      await expect(worker.getByRole('button', { name: 'Watch Recovery worker', exact: true })).toHaveAttribute('aria-pressed', 'true')
      const direct = 'Use my revised check before continuing.'
      await fillPrompt(worker.getByRole('textbox', { name: 'Prompt', exact: true }), direct)
      await worker.getByRole('textbox', { name: 'Prompt', exact: true }).press('Enter')
      await expect(worker.locator('[data-role="user"] .rich-message')).toContainText([direct])
      await expect.poll(async () => (await participationA()).state).toBe('taken-over')
      await expect.poll(async () => (await row()).paused).toBe(true)
      const fenced = await participationA()
      expect(await tools.call('send_to_thread', { requestId: requestA, retryKey: randomUUID(), target, delivery: 'queue', text: 'This old request must stay fenced.' }))
        .toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
      // Takeover and the optimistic bubble precede native dispatch. Complete only the direct user's actual turn.
      await expect.poll(async () => {
        const state = JSON.parse(await readFile(join(codex, 'state.json'), 'utf8')) as {
          threads: Record<string, { turns: { status: string; items: { type: string; content?: { type: string; text?: string }[] }[] }[] }>
        }
        const turn = state.threads[workerNative]!.turns.at(-1)
        if (turn?.status !== 'inProgress') return []
        return turn.items.filter(item => item.type === 'userMessage').flatMap(item => item.content ?? [])
      }).toEqual([{ type: 'text', text: direct }])
      await capture(launched, 'during-user-turn.png')
      await complete(codex, workerNative, 'Your revised check is complete.')
      await expect.poll(async () => (await row()).paused).toBe(false)
      await complete(codex, tools.watcherNative, 'I will continue after your revised check.')
      await expect.poll(async () => {
        await drainNews()
        return (await mainRoom(page)).currentOptions?.status
      }).toBe('idle')
      const fresh = 'Continue watching the recovery worker with my revised check.'
      await fillPrompt(pane(page).getByRole('textbox', { name: 'Watcher message' }), fresh)
      await pane(page).getByRole('textbox', { name: 'Watcher message' }).press('Enter')
      // News can start between the idle projection and Enter. Drain only its exact hidden prompt until B starts.
      await expect.poll(drainNews).toEqual([fresh])
      await expect.poll(async () => (await mainRoom(page)).requests.filter(item => !item.standingWatchId).length).toBe(2)
      const requestB = (await mainRoom(page)).requests.findLast(item => !item.standingWatchId)!.id
      expect(requestB).not.toBe(requestA)
      const continuation = 'Run the next check using the revised instruction.'
      expect(await tools.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target, delivery: 'now', text: continuation }))
        .toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
      expect(await participationA()).toEqual(fenced)
      expect(await tools.call('send_to_thread', { requestId: requestA, retryKey: randomUUID(), target, delivery: 'queue', text: 'The old request is still fenced after recovery.' }))
        .toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
      await expect(worker.locator('[data-role="user"] .rich-message')).toContainText([continuation])
      await complete(codex, workerNative, 'The next check passed. The recovery worker can continue.')
      await expect(worker.locator('[data-role="assistant"]')).toContainText(['The next check passed.'])
      await page.reload(); await switchTab(page, 'Watcher').click()
      await expect(pane(page).locator('[data-role="user"] .rich-message')).toContainText([fresh])
      expect(await participationA()).toEqual(fenced)
      expect(await row()).toMatchObject({ watched: true, paused: false })
      await openBeside(page, 'Recovery worker')
      await expect(page.getByRole('region', { name: 'Recovery worker', exact: true }).locator('[data-role="assistant"]')).toContainText(['The next check passed.'])
      expect((await page.evaluate(id => window.sotto!.agents!.threadDetail!(id), workerId))?.messages.some(message => message.role === 'user' && message.text === continuation)).toBe(true)
      await capture(launched, 'recovered-after-reload.png')
      expect(errors).toEqual([])
    })
  } finally {
    try {
      if (launched) await closeSotto(launched)
    } finally {
      for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value
      await profile.dispose()
    }
  }
})
