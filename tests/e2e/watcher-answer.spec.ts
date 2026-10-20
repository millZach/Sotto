import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { AgentHostCommand, AgentHostResult } from '../../src/main/agents/host'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import type { RemoteHostE2EConnection } from '../../src/main/e2e/remoteHost'
import { parseHostEntityKey } from '../../src/shared/clientIdentity'
import type { AgentRequest } from '../../src/shared/agents'
import type { WatcherRoomState } from '../../src/shared/watcherRoom'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { holdOwlSky } from './support/sottoOwl'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Answering a watched thread's request in Watcher's conversation (ADR-0073, October 19, 2026), end to end on the built
 * app against main's own Watcher over the fake Codex app server: nothing is seeded. A watched thread asks, main's own
 * wake-up tells Watcher, the workspace records the request with that wake-up, the room places the thread's card under
 * Watcher's reply, and the user answers there. Once on this computer, and once for a thread on a paired host reached
 * through the real headless host, socket and desktop router (the unpackaged harness bypasses SSH only). Run after
 * `npm run build`. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/watcher-answer.
 */
const evidence = evidenceDirectory('artifacts/watcher-answer')
const WATCHER_REPLY = 'Watcher here.'

const watcherPane = (page: Page): Locator => page.getByRole('region', { name: 'Watcher', exact: true })

async function mainRoom(page: Page): Promise<WatcherRoomState> {
  const read = await page.evaluate(async () => window.sotto!.watcher!.get())
  if (read.status !== 'ok') throw new Error(read.message)
  return read.state
}

/** The window, settled and with the night held still, into the note's evidence folder. */
async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await launched.page.mouse.move(0, 0)
  await launched.page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
  await holdOwlSky(launched.page)
  await captureWindow(launched.app, join(evidence, name))
}

/** Starts Watcher from its room's first entry and waits for its first reply. */
async function startWatcher(page: Page): Promise<void> {
  await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
  await expect(page.locator('.watcher-dock')).toBeVisible()
  await page.getByRole('textbox', { name: 'Watcher message' }).click()
  await page.keyboard.type('Keep an eye on my threads and bring me their questions.')
  await page.getByRole('button', { name: 'Start Watcher and send' }).click()
  await expect(watcherPane(page).locator('[data-role="assistant"]')).toContainText(WATCHER_REPLY)
}

/** The card follows the reply in which Watcher told the user about it, in the order the eye reads the pane. */
async function followsReply(card: Locator, reply: Locator): Promise<boolean> {
  const replyHandle = await reply.elementHandle()
  return card.evaluate((element, before) => before !== null && (before.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, replyHandle)
}

/**
 * Sotto Owl over the fake Codex app server, with nothing seeded, so the room reads main's own Watcher. Before launch,
 * `prepare` may add to the profile (a paired host's record); after it, `connected` may join that host.
 */
async function withMainWatcher(prefix: string, run: (launched: LaunchedSotto, root: string) => Promise<void>,
  hooks: { prepare?: (profile: string) => Promise<void>; connected?: (launched: LaunchedSotto) => Promise<void>
    /** After the app closes and before the profile goes, so nothing still holds a file in it. */
    closed?: () => Promise<void> } = {}): Promise<void> {
  const profile = (await ownedE2EProfile({ prefix })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'worker']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: WATCHER_REPLY }))
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  try {
    await hooks.prepare?.(profile)
    await onReleaseTrack('owl', async () => {
      const launched = await launchSotto('success', profile)
      try {
        const { page } = launched
        await page.evaluate(async () => {
          await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
          const agents = window.sotto!.agents!
          await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
          await agents.command({ type: 'connect', provider: 'codex' })
        })
        await page.reload()
        await hooks.connected?.(launched)
        await openThreads(page)
        await resizeContentWindow(launched, 1280, 800)
        await run(launched, root)
      } finally { await closeSotto(launched) }
    })
  } finally {
    if (previous.root === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = previous.root
    if (previous.executable === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = previous.executable
    await hooks.closed?.()
    await removeOwnedE2EProfile(profile)
  }
}

/** A provider on the paired host that keeps every answer it was given, so the journey can see whose answer arrived. */
class ForgeProvider extends E2EAgentHost {
  readonly answers: Extract<AgentHostCommand, { type: 'answer' }>[] = []
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type === 'answer') this.answers.push(structuredClone(command))
    return super.execute(command)
  }
}

const FORGE_QUESTION: AgentRequest = { id: 'forge-route', kind: 'question', text: 'Forge build question', options: [], questions: [
  { id: 'route', question: 'Which route should this build use?', multiSelect: false, allowFreeText: true,
    options: [{ id: 'coast', label: 'Coast' }, { id: 'hills', label: 'Hills' }] },
] }

test.describe('answering in Watcher’s conversation, against main’s own Watcher', () => {
  test.describe.configure({ mode: 'serial', timeout: 4 * 60_000 })

  test('a watched thread on this computer asks, and the user answers on its card under Watcher’s reply', async () => {
    await withMainWatcher('sotto-e2e-watcher-answer-', async (launched, root) => {
      const { page } = launched
      await startWatcher(page)
      // A thread on Codex in its own project, given to Watcher by a standing watch.
      const worker = await page.evaluate(async path => {
        const agents = window.sotto!.agents!
        const opened = await agents.command({ type: 'create-project', title: 'Badge work', path, useExisting: true, provider: 'codex' })
        const room = await window.sotto!.watcher!.get()
        if (opened.error || !opened.activeProjectId || room.status !== 'ok' || !room.state.currentOptions) throw new Error('Could not create the worker project.')
        const created = await agents.command({ type: 'create-thread', projectId: opened.activeProjectId, modelId: room.state.currentOptions.modelId,
          title: 'Badge worker', workingCopy: 'shared', runtimeMode: 'approval-required' })
        if (created.error || !created.activeThreadId) throw new Error('Could not create the worker.')
        return created.activeThreadId
      }, join(root, 'worker'))
      const target = { hostId: (await mainRoom(page)).current!.target.hostId, threadId: parseHostEntityKey(worker)?.id ?? worker }
      expect(await page.evaluate(async target => window.sotto!.watcher!.watchThread!({ target }), target)).toMatchObject({ status: 'ok' })

      // The worker's turn asks a question and waits on it. Watcher's own turn, which the news wakes, only replies.
      await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ question: 'Which colour should the badge be?' }))
      await page.evaluate(async threadId => {
        const sent = await window.sotto!.agents!.command({ type: 'send', draft: { threadId, text: 'Pick the badge colour.' } })
        if (sent.error) throw new Error(sent.error)
      }, worker)
      await expect.poll(async () => (await mainRoom(page)).watchedThreads.find(row => row.target.threadId === target.threadId)?.waitsOn.length ?? 0).toBe(1)
      // The worker names itself from its first exchange, as any thread does, so it is found by what it is called now.
      const title = await page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)!.title, worker)
      const told = 'The worker asks which colour the badge should be. Only you can answer it.'
      await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: told }))

      // Main's wake-up carried the request; the room places its card under the reply that told of it.
      const pane = watcherPane(page)
      const reply = pane.locator('[data-role="assistant"]', { hasText: told })
      await expect(reply).toBeVisible({ timeout: 60_000 })
      const card = pane.getByRole('region', { name: `Question from ${title}` })
      await expect(card).toBeVisible()
      await expect(card).toContainText('This computer')
      expect(await followsReply(card, reply)).toBe(true)
      const room = await mainRoom(page)
      expect(room.asks).toEqual([expect.objectContaining({ target, kind: 'question' })])
      // Main placed it from its record of the wake-up, which held only news and so is shown nowhere: the card goes
      // under the reply that wake-up's turn gave, by that reply's own message ID.
      const ask = room.asks![0]!
      expect(ask.messageId).toBe(await reply.getAttribute('data-message-id'))
      expect(ask.wakeUpMessageId).not.toBe(ask.messageId)
      await expect(pane.locator(`[data-message-id="${ask.wakeUpMessageId}"]`)).toHaveCount(0)

      // The same request in the worker's own pane, opened beside Watcher.
      await card.getByRole('button', { name: `Open ${title} beside Watcher` }).click()
      const beside = page.locator('#watcher-beside-pane')
      await expect(beside.getByText('Which colour should the badge be?')).toBeVisible()
      await card.scrollIntoViewIfNeeded()
      expect(await pageBoundProblems(page)).toEqual([])
      await capture(launched, 'answer-main-card-dark-1280x800.png')

      // The user's own answer, from the card in Watcher's conversation, goes to the worker's request.
      await card.getByRole('radio', { name: /^Blue/ }).click()
      await card.getByRole('button', { name: 'Send answer', exact: true }).click()
      await expect(card).toHaveCount(0)
      await expect(pane.locator('.watcher-ask-receipt__words')).toHaveText(`You answered ${title.replace(/\.+$/u, '')}: Blue.`)
      // Answered here, gone there too.
      await expect(beside.getByText('Which colour should the badge be?')).toHaveCount(0)
      await expect.poll(async () => (await mainRoom(page)).watchedThreads.find(row => row.target.threadId === target.threadId)?.waitsOn.length ?? -1).toBe(0)
      const frames = (await readFile(join(root, 'codex', 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as
        { method?: string; result?: { answers?: Record<string, { answers: string[] }> } })
      expect(frames.filter(frame => frame.method === undefined && frame.result?.answers).map(frame => frame.result!.answers))
        .toEqual([{ choice: { answers: ['Blue'] } }])
      expect(await pageBoundProblems(page)).toEqual([])
      await capture(launched, 'answer-main-line-dark-1280x800.png')
    })
  })

  test('a watched thread on a paired host asks, and the answer from Watcher’s conversation reaches that host', async () => {
    let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
    let forge: ForgeProvider | undefined
    let connection: RemoteHostE2EConnection | undefined
    let forgeThreadId = ''
    await withMainWatcher('sotto-e2e-watcher-answer-forge-', async launched => {
        const { page } = launched
        await startWatcher(page)
        const target = { hostId: connection!.hostId, threadId: forgeThreadId }
        // The router has joined Forge's threads before Watcher is given one of them.
        await expect.poll(async () => page.evaluate(async title => (await window.sotto!.agents!.get()).host.threads.some(thread => thread.title === title), 'Forge route worker')).toBe(true)
        const watched = await page.evaluate(async target => window.sotto!.watcher!.watchThread!({ target }), target)
        expect(watched, JSON.stringify(watched.status === 'refused' ? watched : null)).toMatchObject({ status: 'ok' })

        // The thread on Forge asks; Watcher's turn on this computer only replies.
        const told = 'Forge route worker asks which route the build should use. Only you can answer it.'
        await writeFile(join(process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT!, 'codex', 'script.json'), JSON.stringify({ reply: told }))
        // The provider's own thread behind the host's: the stand-in names it `workshop`.
        forge!.event({ type: 'question', threadId: 'workshop', text: FORGE_QUESTION.text, request: FORGE_QUESTION, status: 'running' })

        const pane = watcherPane(page)
        const reply = pane.locator('[data-role="assistant"]', { hasText: told })
        await expect(reply).toBeVisible({ timeout: 60_000 })
        const card = pane.getByRole('region', { name: 'Question from Forge route worker' })
        await expect(card).toBeVisible()
        await expect(card.locator('.watcher-ask__machine')).toHaveAttribute('data-kind', 'remote')
        await expect(card.locator('.watcher-ask__machine')).toHaveText('Forge')
        expect(await followsReply(card, reply)).toBe(true)
        expect((await mainRoom(page)).asks).toEqual([expect.objectContaining({ target, requestCardId: FORGE_QUESTION.id, kind: 'question' })])
        await card.scrollIntoViewIfNeeded()
        expect(await pageBoundProblems(page)).toEqual([])
        await capture(launched, 'answer-forge-card-dark-1280x800.png')

        await card.getByRole('radio', { name: 'Coast', exact: true }).click()
        await card.getByRole('button', { name: 'Send answer', exact: true }).click()
        await expect(card).toHaveCount(0)
        await expect(pane.locator('.watcher-ask-receipt__words')).toHaveText('You answered Forge route worker: Coast.')
        // The answer reached the provider of the thread on Forge, for its own request, as the user's.
        await expect.poll(() => forge!.answers.map(answer => [answer.threadId, answer.requestId])).toEqual([['workshop', FORGE_QUESTION.id]])
        expect(forge!.answers[0]!.questionAnswers).toEqual({ route: expect.objectContaining({ optionIds: ['coast'] }) })
        await capture(launched, 'answer-forge-line-dark-1280x800.png')
      }, {
        async prepare(profile) {
          const providers = { codex: new ForgeProvider(), claude: new ForgeProvider(), grok: new ForgeProvider(), devin: new ForgeProvider(), muse: new ForgeProvider(), opencode: new ForgeProvider() }
          await Promise.all(Object.entries(providers).map(([id, provider]) => provider.initializeWorkingFolders(join(profile, 'working-folders', id))))
          forge = providers.codex
          host = await startHeadlessHost({ dataDirectory: join(profile, 'remote-host'), port: 0, providers })
          const url = `http://127.0.0.1:${host.descriptor!.port}`
          const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
          // The host lets Watcher read and direct its threads only for a desktop it knows, as a launched host does.
          await writeFile(join(profile, 'remote-host', 'desktop-clients.json'), JSON.stringify([paired.clientId]))
          await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: randomUUID(), name: 'Forge', target: 'forge', identityFile: '',
            installPath: '/opt/sotto', dataDirectory: '/data/sotto', enabled: false, hostId: paired.hostId, clientId: paired.clientId }]))
          const descriptor = JSON.parse(await readFile(join(profile, 'remote-host', 'host-listener.json'), 'utf8')) as { adminToken: string }
          const grant = await fetch(`${url}/v1/admin/allow-answers`, { method: 'POST',
            headers: { Authorization: `Bearer ${descriptor.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: paired.clientId }) })
          expect(grant.status).toBe(200)
          connection = { url, token: paired.token, hostId: paired.hostId }
          const setup = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false })
          try {
            await setup.connect()
            await setup.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
            await setup.command({ type: 'connect', provider: 'codex' })
            forgeThreadId = setup.shell().host.threads.find(thread => thread.title === 'Workshop' && thread.providerId === 'codex')!.id
            await setup.command({ type: 'rename-thread', threadId: forgeThreadId, title: 'Forge route worker' })
          } finally { await setup.close() }
        },
        async connected(launched) {
          await launched.app.evaluate(async (_, connection) => {
            if (!globalThis.sottoRemoteHostE2E) throw new Error('The unpackaged remote host harness is unavailable.')
            await globalThis.sottoRemoteHostE2E.connect(connection)
          }, connection!)
        },
        async closed() { await host?.close() },
      })
  })
})
