import { agentState } from './support/agentAccess'
import { ownedE2EProfile } from './support/e2eProfile'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import type { ThreadUsage } from '../../src/shared/threadUsage'
import { storedClaudeOrigins } from '../fixtures/claudeOrigins'
import { nativeUsageBoundary } from '../fixtures/nativeUsageBoundary'
import { firstSottoWindow, openThreads } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const artifacts = evidenceDirectory('artifacts/review-389/electron')

const NATIVE_MODEL = 'claude-sonnet-4-6'
const PUBLIC_MODEL = 'native:claude:model:claude-sonnet-4-6'
const persistenceWait = { timeout: 30_000 }

test('native Claude usage survives replay and a graceful quit with its latest archive write held', async () => {
  test.setTimeout(120_000)
  const root = await realpath((await ownedE2EProfile({ prefix: 'sotto-e2e-usage-' })).directory)
  const profile = join(root, 'profile'), project = join(root, 'project'), client = join(root, 'client'), home = join(root, 'home')
  let app: ElectronApplication | undefined
  let page: Page
  let closing: Promise<void> | undefined
  const capture = async (name: string) => {
    // Capture the actual foreground window without changing renderer styles or graphics mode.
    // The resulting bitmap still needs visual inspection; DOM visibility is not pixel evidence.
    await page.bringToFront()
    await app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().endsWith('/index.html'))!
      window.show(); window.focus()
    })
    await expect.poll(() => page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus()), persistenceWait).toBe(true)
    await page.screenshot({ path: join(artifacts, name), animations: 'disabled' })
  }
  const events = async () => (await readFile(join(root, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { event: string })
  const writes = async () => (await events()).filter(row => row.event === 'usage-write').length
  const archive = async () => JSON.parse(await readFile(join(profile, 'claude-usage.json'), 'utf8')) as Record<string, { view: ThreadUsage; entries: Record<string, unknown> }>
  const bridgeUsage = (id: string) => page.evaluate(async threadId => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === threadId)?.usage, id)
  const archiveUsage = async () => {
    const ledgers = Object.values(await archive())
    expect(ledgers).toHaveLength(1)
    return ledgers[0]!.view
  }
  const bridgeSnapshot = async (id: string) => nativeUsageBoundary(await bridgeUsage(id), PUBLIC_MODEL)
  const archiveSnapshot = async () => nativeUsageBoundary(await archiveUsage(), NATIVE_MODEL)
  const action = async (nativeId: string, value: Record<string, unknown>) => {
    const path = join(client, `control-${nativeId}.json`)
    await expect.poll(() => readFile(path).then(() => false, () => true)).toBe(true)
    await writeFile(path, JSON.stringify({ id: randomUUID(), ...value }))
  }
  const launch = async () => {
    const inherited = new Set(['systemroot', 'windir', 'comspec', 'temp', 'tmp', 'lang', 'lc_all', 'display', 'xauthority', 'wayland_display', 'xdg_runtime_dir'])
    app = await electron.launch({ args: [resolve('tests/fixtures/nativeUsageElectronMain.cjs')], env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && inherited.has(key.toLowerCase()))),
      HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
      SOTTO_USAGE_FIXTURE_ROOT: root, SOTTO_USAGE_FIXTURE_NODE: process.execPath,
    } })
    page = await firstSottoWindow(app)
    await page.waitForFunction(() => !!window.sotto?.agents)
    // Preload exists before main finishes admitting the loaded renderer as an IPC sender.
    // Retry a read, never configuration or a native turn, until that boundary is ready.
    await expect(async () => expect(await agentState(page)).toHaveProperty('host')).toPass(persistenceWait)
    expect(await page.evaluate(() => typeof window.sottoE2E)).toBe('undefined')
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(1280, 800))
    await page.evaluate(async () => {
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: {
        provider: 'claude', enabledProviders: ['claude'], enabled: true, speak: false, reasoning: 'none', followupLimit: 0,
      } })
      if (configured.error) throw new Error(configured.error)
      const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
      if (connected.error) throw new Error(connected.error)
    })
  }
  const result = (session: string, elapsed: number) => ({ type: 'result', subtype: 'success', session_id: session, is_error: false,
    duration_ms: elapsed, result: 'Synthetic usage reply', modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200_000 } } })
  const usageFrame = (session: string, index: number, output: number) => ({ type: 'assistant', uuid: `fixture-uuid-${index}`, session_id: session,
    timestamp: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(), message: { id: `usage-message-${index}`, role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: `Synthetic usage reply ${index}` }],
      usage: { input_tokens: 1000, output_tokens: output, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    } })
  try {
    for (const path of [profile, project, client, join(home, '.local', 'bin'), join(home, 'appdata'), join(home, 'localappdata')]) await mkdir(path, { recursive: true })
    const placeholder = join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
    await writeFile(placeholder, 'Scripted Claude placeholder; never executed.\n'); await chmod(placeholder, 0o700)
    await writeFile(join(client, 'models.json'), JSON.stringify([{ value: 'claude-sonnet-4-6', displayName: 'Synthetic Claude', supportsEffort: true, supportedEffortLevels: ['low'] }]))
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true, historyEnabled: true, threadTitles: false, appearance: 'dark', reducedMotion: 'on' }))
    await mkdir(artifacts, { recursive: true })
    await launch()
    const id = await page!.evaluate(async path => {
      const agents = window.sotto!.agents!
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Synthetic usage project', path, useExisting: true })
      if (created.error) throw new Error(created.error)
      const state = await agents.get()
      const project = state.host.projects.find(value => value.title === 'Synthetic usage project')!
      const model = state.host.models.find(value => value.providerId === 'claude' && value.ready)!
      const thread = await agents.command({ type: 'create-thread', projectId: project.id, title: 'Native usage verification', titleSource: 'user', modelId: model.id,
        workingCopy: 'shared', runtimeMode: 'approval-required', managed: false })
      if (thread.error) throw new Error(thread.error)
      const id = thread.activeThreadId!
      await agents.command({ type: 'select-thread', threadId: id })
      await agents.command({ type: 'observe-threads', threadIds: [id] })
      return id
    }, project)
    await openThreads(page!)
    const composer = () => page.getByRole('textbox', { name: 'Prompt', exact: true })
    await expect(composer()).toBeEditable()
    await composer().fill('Exercise the synthetic usage ledger.')
    await page!.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page!.getByLabel('Thread transcript')).toContainText('Exercise the synthetic usage ledger.')
    // The workspace echoes the prompt before creating the native session. Wait for its durable
    // alias and the scripted client's receipt of this prompt, not just the optimistic transcript.
    let nativeId = ''
    await expect(async () => {
      const aliases = JSON.parse(await readFile(join(profile, 'claude-threads.json'), 'utf8')) as Record<string, {
        sessionId: string; cwd: string; modelId: string; origins: { uuid: string }[]
      }>
      expect(Object.values(aliases)).toHaveLength(1)
      const [aliasId, alias] = Object.entries(aliases)[0]!
      expect(alias.sessionId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu)
      expect(alias.cwd).toBe(project)
      expect(alias.modelId).toBe(NATIVE_MODEL)
      // A new origin is a line of the origin journal until the thread store is next written whole (#767).
      const origins = await storedClaudeOrigins(profile, aliasId)
      expect(origins).toHaveLength(1)
      expect(origins[0]!.uuid).toEqual(expect.any(String))
      const requests = (await readFile(join(client, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(requests).toContainEqual(expect.objectContaining({ method: 'user', params: expect.objectContaining({
        frame: expect.objectContaining({ type: 'user', session_id: alias.sessionId, uuid: origins[0]!.uuid }),
      }) }))
      nativeId = alias.sessionId
    }).toPass(persistenceWait)
    const visibleHistory = async (stage: 'initial' | 'restored' | 'replayed') => {
      const transcript = page.getByLabel('Thread transcript')
      try {
        await expect(transcript.getByText('Exercise the synthetic usage ledger.', { exact: true })).toBeVisible(persistenceWait)
        await expect(transcript.getByText('Synthetic usage reply 1', { exact: true })).toBeVisible(persistenceWait)
        await expect(transcript.getByText('Exercise the synthetic usage ledger.', { exact: true })).toBeInViewport(persistenceWait)
        await expect(transcript.getByText('Synthetic usage reply 1', { exact: true })).toBeInViewport(persistenceWait)
        await expect(transcript).toHaveAttribute('aria-busy', 'false', persistenceWait)
      } catch (error) {
        // This fixture owns every profile and message. Capture the failed boundaries before cleanup;
        // reading detail happens only after failure so it cannot repair the journey being asserted.
        await Promise.allSettled([
          capture(`native-history-${stage}-failure.png`),
          page.evaluate(async threadId => {
            const dom = document.querySelector('[aria-label="Thread transcript"]')?.outerHTML
            const agents = window.sotto!.agents!
            const thread = (await agents.get()).host.threads.find(value => value.id === threadId)
            const detail = await agents.threadDetail!(threadId)
            return { dom, thread, detail }
          }, id).then(evidence => writeFile(join(artifacts, `native-history-${stage}-failure.json`), JSON.stringify(evidence, null, 2))),
          readFile(join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/gu, '-'), `${nativeId}.jsonl`), 'utf8')
            .then(transcript => writeFile(join(artifacts, `native-history-${stage}-transcript.jsonl`), transcript)),
        ])
        throw error
      }
    }
    // Every accounting observation below crosses stdout from the scripted CLI into the real adapter.
    const first = usageFrame(nativeId, 0, 100), second = usageFrame(nativeId, 1, 200)
    await action(nativeId, { type: 'raw', persist: true, frame: first })
    await action(nativeId, { type: 'raw', persist: true, frame: second })
    await action(nativeId, { type: 'raw', frame: result(nativeId, 111) })
    await expect.poll(() => bridgeUsage(id)).toMatchObject({ total: { input: 6000, output: 300, cached: 4000 }, elapsedMs: 111 })
    const before = (await bridgeUsage(id))!
    const beforeSnapshot = nativeUsageBoundary(before, PUBLIC_MODEL)
    expect(before.estimatedUsd).toBeCloseTo(0.0117, 8)
    // A bridge update can precede even the archive's first creation. Retry reads and assertions
    // together, retaining the full accounting comparison and the final error if it never settles.
    await expect(async () => expect(await archiveSnapshot()).toEqual(beforeSnapshot)).toPass(persistenceWait)
    const beforeWrites = await writes()
    // The final result is a receipt for the batch: its changed duration must reach the bridge and disk.
    await action(nativeId, { type: 'raw-burst', frames: [...Array.from({ length: 100 }, () => first), result(nativeId, 222)] })
    await expect.poll(() => bridgeUsage(id)).toMatchObject({ total: before.total, estimatedUsd: before.estimatedUsd, elapsedMs: 222 })
    await expect(async () => expect(await archiveSnapshot()).toEqual({ ...beforeSnapshot, elapsedMs: 222 })).toPass(persistenceWait)
    await expect.poll(writes).toBe(beforeWrites + 1)
    const afterReplay = (await bridgeUsage(id))!
    expect(nativeUsageBoundary(afterReplay, PUBLIC_MODEL)).toEqual({ ...beforeSnapshot, elapsedMs: 222 })
    await expect(page!.getByLabel('Thread transcript')).toContainText('Synthetic usage reply 1')
    await expect(composer()).toBeEditable()
    await composer().fill('An unsent draft stays editable after replay.')
    await expect(composer()).toHaveValue('An unsent draft stays editable after replay.')
    await composer().fill('')
    await visibleHistory('initial')
    await capture('native-usage-after-replay.png')
    await writeFile(join(root, 'hold-usage-write'), '')
    await action(nativeId, { type: 'raw', persist: true, frame: usageFrame(nativeId, 1, 250) })
    await expect.poll(() => bridgeUsage(id)).toMatchObject({ total: { output: 350 }, latest: { output: 250 } })
    const latest = (await bridgeUsage(id))!
    const latestSnapshot = nativeUsageBoundary(latest, PUBLIC_MODEL)
    expect(latest.estimatedUsd).toBeCloseTo(0.01245, 8)
    expect(latest.persistenceError).toBeUndefined()
    await expect.poll(() => readFile(join(root, 'usage-write-waiting')).then(() => true, () => false)).toBe(true)
    expect(Object.values(await archive())[0]!.view.total!.output).toBe(300)
    const quitEvents = (await events()).filter(row => row.event === 'quit-requested').length
    const processHandle = app!.process()
    closing = app!.close()
    await expect.poll(async () => (await events()).filter(row => row.event === 'quit-requested').length).toBeGreaterThan(quitEvents)
    expect(processHandle.exitCode).toBeNull()
    expect(Object.values(await archive())[0]!.view.total!.output).toBe(300)
    await rm(join(root, 'hold-usage-write'))
    await closing; closing = undefined; app = undefined
    const drained = await archiveUsage()
    expect(nativeUsageBoundary(drained, NATIVE_MODEL)).toEqual(latestSnapshot)
    await launch()
    await page!.evaluate(async threadId => {
      await window.sotto!.agents!.command({ type: 'select-thread', threadId })
      await window.sotto!.agents!.command({ type: 'observe-threads', threadIds: [threadId] })
    }, id)
    await expect(async () => expect(await bridgeSnapshot(id)).toEqual(latestSnapshot)).toPass(persistenceWait)
    const restored = (await bridgeUsage(id))!
    await openThreads(page!)
    // Usage restores independently of messages. Prove history before replay can supply any text.
    await visibleHistory('restored')
    // A second replay goes through the restarted native process, using the persisted request identity.
    const restartWrites = await writes()
    await action(nativeId, { type: 'raw-burst', frames: [...Array.from({ length: 100 }, () => first), result(nativeId, 333)] })
    await expect.poll(() => bridgeUsage(id)).toMatchObject({ total: latest.total, estimatedUsd: latest.estimatedUsd, elapsedMs: 333 })
    await expect(async () => expect(await archiveSnapshot()).toEqual({ ...latestSnapshot, elapsedMs: 333 })).toPass(persistenceWait)
    await expect.poll(writes).toBe(restartWrites + 1)
    expect(await bridgeSnapshot(id)).toEqual({ ...latestSnapshot, elapsedMs: 333 })
    await openThreads(page!)
    await expect(page!.getByRole('heading', { name: 'Native usage verification', exact: true })).toBeVisible()
    await expect(composer()).toBeEditable()
    await composer().fill('Still usable after restart.')
    await expect(composer()).toHaveValue('Still usable after restart.')
    await expect(page!.getByRole('button', { name: 'Send prompt', exact: true })).toBeEnabled()
    await visibleHistory('replayed')
    const renderedHistory = await page!.getByLabel('Thread transcript').evaluate(element => ({
      text: element.textContent, busy: element.getAttribute('aria-busy'),
      scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      messages: [...element.querySelectorAll('.thread-message')].map(message => ({
        text: message.textContent, rect: message.getBoundingClientRect().toJSON(),
        visibility: getComputedStyle(message).visibility, opacity: getComputedStyle(message).opacity,
      })),
    }))
    await capture('native-usage-after-restart.png')
    expect(await readFile(join(client, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
    expect((await events()).some(row => row.event === 'scripted-claude-launch')).toBe(true)
    await writeFile(join(artifacts, 'native-usage-evidence.json'), JSON.stringify({ syntheticOnly: true, provider: 'claude', before,
      afterReplay, afterDrain: drained, afterRestart: restored, afterRestartReplay: await bridgeUsage(id),
      replayWrites: 1, shutdownHeldUntilRelease: true, productTestBridgeAbsent: true,
      restoredHistoryVisibleBeforeReplay: true, restoredHistoryVisibleAfterReplay: true, renderedHistory }, null, 2))
  } finally {
    await rm(join(root, 'hold-usage-write'), { force: true })
    if (closing) await closing
    else if (app) await app.close()
    // No production profile or external checkout can satisfy this ownership guard.
    await rm(requireOwnedE2EProfile(await realpath(root)), { recursive: true, force: true })
  }
})
