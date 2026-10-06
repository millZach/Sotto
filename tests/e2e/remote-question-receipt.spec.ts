import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { AgentHostCommand, AgentHostResult } from '../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { RemoteHostE2EConnection } from '../../src/main/e2e/remoteHost'
import type { AgentRequest, ProviderId } from '../../src/shared/agents'
import type { RequestDraft } from '../../src/shared/requestDrafts'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// Real paired headless host -> socket -> desktop router -> IPC -> question panel. The main-only,
// unpackaged harness bypasses SSH launch, never the remote protocol or answer/draft handling.
class AnswerProvider extends E2EAgentHost {
  readonly answers: Extract<AgentHostCommand, { type: 'answer' }>[] = []
  constructor(private readonly uncertainAnswer = false, private readonly answerCompletion?: Promise<boolean>) { super() }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type === 'answer') this.answers.push(structuredClone(command))
    const result = await super.execute(command)
    // The request disappearing is deliberately insufficient evidence of acceptance.
    return command.type === 'answer' && this.uncertainAnswer
      ? { accepted: false, uncertain: true, ...(this.answerCompletion ? { answerCompletion: this.answerCompletion } : {}) }
      : result
  }
}

const legacy: AgentRequest = { id: 'remote-choice', kind: 'question', text: 'Which route should Forge use?',
  options: [{ id: 'native:coast', label: 'Coast' }, { id: 'native:hills', label: 'Hills' }] }
const structured: AgentRequest = { id: 'remote-form', kind: 'question', text: 'Forge build question', options: [], questions: [
  { id: 'route', question: 'Which route should this build use?', multiSelect: false, allowFreeText: true,
    options: [{ id: 'coast', label: 'Coast' }, { id: 'hills', label: 'Hills' }] },
] }
const drafts = async (profile: string): Promise<RequestDraft[]> => JSON.parse(await readFile(join(profile, 'request-drafts.json'), 'utf8')).drafts

async function fixture(provider: ProviderId, uncertain = false, answerCompletion?: Promise<boolean>) {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-remote-question-'))
  let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
  let setup: SocketHostService | undefined
  let launched: LaunchedSotto | undefined
  try {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true,
      localHostEnabled: false, reducedMotion: 'on', historyEnabled: false }))
    const providers = { codex: new AnswerProvider(uncertain, answerCompletion), claude: new AnswerProvider(uncertain, answerCompletion), grok: new AnswerProvider(uncertain, answerCompletion), devin: new AnswerProvider() }
    const native = providers[provider]
    host = await startHeadlessHost({ dataDirectory: join(profile, 'remote-host'), port: 0,
      providers, reasoner: e2eAgentReasoner })
    const url = `http://127.0.0.1:${host.descriptor!.port}`
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
    const descriptor = JSON.parse(await readFile(join(profile, 'remote-host', 'host-listener.json'), 'utf8')) as { adminToken: string }
    const grant = await fetch(`${url}/v1/admin/allow-answers`, { method: 'POST', headers: {
      Authorization: `Bearer ${descriptor.adminToken}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ clientId: paired.clientId }) })
    expect(grant.status).toBe(200)
    const connection: RemoteHostE2EConnection = { url, token: paired.token, hostId: paired.hostId }
    setup = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false })
    await setup.connect()
    await setup.command({ type: 'configure', patch: { provider, enabledProviders: [provider] } })
    await setup.command({ type: 'connect', provider })
    const nativeThreadId = setup.shell().host.threads.find(thread => thread.title === 'Workshop' && thread.providerId === provider)!.id
    await setup.command({ type: 'rename-thread', threadId: nativeThreadId, title: 'Forge question fixture' })
    await setup.close()
    launched = await launchSotto('success', profile)
    const errors: string[] = []
    launched.page.on('pageerror', error => errors.push(error.message))
    await launched.app.evaluate(async (_, connection) => {
      if (!globalThis.sottoRemoteHostE2E) throw new Error('The unpackaged remote host harness is unavailable.')
      await globalThis.sottoRemoteHostE2E.connect(connection)
    }, connection)
    await openThreads(launched.page)
    await launched.page.getByRole('button', { name: 'Forge question fixture', exact: true }).click()
    const threadId = await launched.page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.title === 'Forge question fixture')!.id)
    const ownedHost = host
    const ownedApp = launched
    return { native, host: ownedHost, launched: ownedApp, profile, threadId, errors, connection,
      async close() {
        await closeSotto(ownedApp)
        await ownedHost.close()
        await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (launched) await closeSotto(launched)
    await setup?.close()
    await host?.close()
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
    throw error
  }
}

async function capture(launched: LaunchedSotto, name: string, subject?: Locator): Promise<void> {
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await launched.app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width, size.height)
    }, { width, height })
    await expect.poll(() => launched.page.evaluate(([width, height]) => innerWidth === width && Math.abs(innerHeight - height) <= 2, [width, height] as const)).toBe(true)
    for (const appearance of ['dark', 'light'] as const) {
      await launched.page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
      await subject?.scrollIntoViewIfNeeded()
      expect(await launched.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      if (subject) expect(await subject.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await launched.page.screenshot({ path: test.info().outputPath(`${name}-${width}-${appearance}.png`), animations: 'disabled' })
    }
  }
}

for (const provider of ['codex', 'claude', 'grok'] as const) test(`${provider}: Forge accepts choice and structured answers once and the laptop retires their saved holds`, async () => {
  test.setTimeout(120_000)
  const f = await fixture(provider)
  try {
    const { page } = f.launched
    for (const request of [legacy, structured]) {
      f.native.event({ type: 'question', threadId: 'workshop', text: request.text, request })
      const card = page.locator('.thread-questions .agent-request').filter({ hasText: request.questions?.[0]?.question ?? request.text })
      await expect(card).toBeVisible()
      await card.getByRole('radio', { name: 'Coast', exact: true }).click()
      await expect(card).toHaveAttribute('data-save', 'saved')
      await expect.poll(async () => (await drafts(f.profile)).map(draft => draft.target.requestId)).toEqual([request.id])
      expect(f.native.answers).toHaveLength(request === legacy ? 0 : 1)
      if (provider === 'codex') await capture(f.launched, request === legacy ? 'choice-saved' : 'form-saved', card)
      await card.getByRole('button', { name: 'Send answer', exact: true }).click()
      await expect.poll(() => f.native.answers.length).toBe(request === legacy ? 1 : 2)
      await expect(card).toHaveCount(0)
      await expect(page.getByRole('region', { name: /^(?:Saved|Unconfirmed) answer$/u })).toHaveCount(0)
      await expect.poll(() => drafts(f.profile)).toEqual([])
      expect(f.host.service.shell().host.threads.flatMap(thread => thread.requests)).toEqual([])
      expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).error)).toBeNull()
      if (provider === 'codex') await capture(f.launched, request === legacy ? 'choice-accepted' : 'form-accepted')
    }
    expect(f.native.answers.map(command => ({ requestId: command.requestId, answer: command.answer, questionAnswers: command.questionAnswers }))).toEqual([
      { requestId: legacy.id, answer: 'native:coast', questionAnswers: undefined },
      { requestId: structured.id, answer: '', questionAnswers: { route: { optionIds: ['coast'] } } },
    ])
    expect(f.errors).toEqual([])
  } finally { await f.close() }
})

test('a late exact receipt after remote reconnect removes the mounted unconfirmed card without replay or another host update', async () => {
  test.setTimeout(120_000)
  const f = await fixture('codex')
  const originalRecovery = f.host.service.requestAnswerRecovery.bind(f.host.service)
  try {
    const { page } = f.launched
    // The provider accepts, but the first receipt read has no native acceptance evidence.
    f.host.service.requestAnswerRecovery = () => ({ completed: [], uncertainRequestIds: [] })
    f.native.event({ type: 'question', threadId: 'workshop', text: structured.text, request: structured })
    const live = page.locator('.thread-questions .agent-request').filter({ hasText: structured.questions![0]!.question })
    await live.getByRole('radio', { name: 'Coast', exact: true }).click()
    await expect(live).toHaveAttribute('data-save', 'saved')
    await live.getByRole('button', { name: 'Send answer', exact: true }).click()
    const retained = page.getByRole('region', { name: 'Unconfirmed answer', exact: true })
    await expect(retained).toBeVisible()
    await expect.poll(() => f.native.answers.length).toBe(1)
    await expect.poll(async () => (await drafts(f.profile)).map(draft => draft.held)).toEqual([true])
    f.host.service.requestAnswerRecovery = originalRecovery
    await f.launched.app.evaluate(async (_, connection) => {
      await globalThis.sottoRemoteHostE2E!.disconnect(connection.hostId)
      await globalThis.sottoRemoteHostE2E!.connect({ ...connection, holdReceipts: true })
    }, f.connection)
    await page.getByRole('button', { name: 'Forge question fixture', exact: true }).click()
    await expect(retained).toBeVisible()
    await expect.poll(() => f.launched.app.evaluate((_, id) => globalThis.sottoRemoteHostE2E!.receiptReads(id), f.connection.hostId)).toBeGreaterThan(0)
    await page.screenshot({ path: test.info().outputPath('late-receipt-mounted.png'), animations: 'disabled' })
    // Release only the receipt. No selection, provider event, reload or user check may hide a stale card.
    await f.launched.app.evaluate((_, id) => globalThis.sottoRemoteHostE2E!.releaseReceipts(id), f.connection.hostId)
    await expect.poll(() => drafts(f.profile)).toEqual([])
    expect(f.native.answers).toHaveLength(1)
    await page.screenshot({ path: test.info().outputPath('late-receipt-disk-retired.png'), animations: 'disabled' })
    await expect(retained, 'The exact answer receipt retired disk storage, but the mounted laptop card stayed unconfirmed.').toHaveCount(0)
    expect(f.native.answers).toHaveLength(1)
    expect(f.errors).toEqual([])
  } finally { f.host.service.requestAnswerRecovery = originalRecovery; await f.close() }
})

for (const accepted of [true, false]) test(`a native answer settling after the idle laptop cached uncertainty clears its card only with acceptance ${accepted}`, async () => {
  test.setTimeout(120_000)
  let finishNative: (accepted: boolean) => void = () => undefined
  const completion = new Promise<boolean>(resolve => { finishNative = resolve })
  const f = await fixture('claude', true, completion)
  try {
    const { page } = f.launched
    f.native.event({ type: 'question', threadId: 'workshop', text: structured.text, request: structured })
    const live = page.locator('.thread-questions .agent-request').filter({ hasText: structured.questions![0]!.question })
    await live.getByRole('radio', { name: 'Coast', exact: true }).click()
    await expect(live).toHaveAttribute('data-save', 'saved')
    await live.getByRole('button', { name: 'Send answer', exact: true }).click()
    const retained = page.getByRole('region', { name: 'Unconfirmed answer', exact: true })
    await expect(retained).toBeVisible()
    await expect.poll(() => page.evaluate(async threadId => {
      const state = await window.sotto!.agents!.get()
      return { busy: state.busyThreadIds?.includes(threadId) ?? false,
        requests: state.host.threads.find(thread => thread.id === threadId)?.requests.length }
    }, f.threadId)).toEqual({ busy: false, requests: 0 })
    // A negative read has finished before the late native callback. No read is held open across it.
    await expect.poll(() => f.launched.app.evaluate((_, id) => globalThis.sottoRemoteHostE2E!.completedIdleReceiptReads(id), f.connection.hostId)).toBeGreaterThan(0)
    await expect.poll(async () => (await drafts(f.profile)).map(draft => draft.held)).toEqual([true])
    expect(f.native.answers).toHaveLength(1)
    finishNative(accepted)
    if (accepted) {
      // Native completion alone must clear the already-mounted card, without reconnect or another action.
      await expect.poll(() => drafts(f.profile)).toEqual([])
      await expect(retained).toHaveCount(0)
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).error)).toBeNull()
      await expect(page.getByRole('alert')).toHaveCount(0)
      await page.screenshot({ path: test.info().outputPath('native-late-receipt-cleared.png'), animations: 'disabled' })
    } else {
      await completion
      await expect(retained).toContainText('Coast')
      await page.reload()
      await openThreads(page)
      await page.getByRole('button', { name: 'Forge question fixture', exact: true }).click()
      await expect(retained).toContainText('Coast')
      expect((await drafts(f.profile)).map(draft => draft.held)).toEqual([true])
    }
    expect(f.native.answers).toHaveLength(1)
    expect(f.errors).toEqual([])
  } finally { finishNative(false); await f.close() }
})

test('Forge leaves a genuinely uncertain answer held on the laptop even after its question disappears, without replay', async () => {
  test.setTimeout(120_000)
  const f = await fixture('codex', true)
  try {
    const { page } = f.launched
    f.native.event({ type: 'question', threadId: 'workshop', text: structured.text, request: structured })
    const card = page.locator('.thread-questions .agent-request').filter({ hasText: structured.questions![0]!.question })
    await card.getByRole('radio', { name: 'Coast', exact: true }).click()
    await expect(card).toHaveAttribute('data-save', 'saved')
    await card.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect.poll(() => f.native.answers.length).toBe(1)
    await expect.poll(async () => (await drafts(f.profile)).map(draft => ({ held: draft.held, choice: draft.selections.route?.optionIds }))).toEqual([{ held: true, choice: ['coast'] }])
    await expect.poll(async () => await page.locator('.agent-request[data-phase="unconfirmed"]').count() + await page.getByRole('region', { name: 'Unconfirmed answer', exact: true }).count()).toBeGreaterThan(0)
    const retained = page.locator('.agent-request[data-phase="unconfirmed"], .request-recovery[data-held="true"]').filter({ hasText: structured.questions![0]!.question }).first()
    await expect(retained).toContainText('Coast')
    const send = retained.getByRole('button', { name: 'Send answer', exact: true })
    if (await send.count()) await expect(send).toBeDisabled()
    await capture(f.launched, 'form-unconfirmed', retained)
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Forge question fixture', exact: true }).click()
    await expect.poll(async () => (await drafts(f.profile)).map(draft => draft.held)).toEqual([true])
    expect(f.native.answers).toHaveLength(1)
    expect(f.errors).toEqual([])
  } finally { await f.close() }
})
