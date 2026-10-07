import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { AgentHostCommand, AgentHostResult, ThreadReadPurpose } from '../../src/main/agents/host'
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
  private readonly pendingAnswerIds = new Set<string>()
  checkReads = 0
  constructor(private readonly uncertainAnswer = false, private readonly answerCompletion?: Promise<boolean>, private readonly keepQuestion = false) { super() }
  async refreshThread(threadId: string, purpose?: ThreadReadPurpose) {
    if (purpose?.retryUncertainAnswers) {
      this.checkReads++
      const thread = (await this.snapshot()).threads.find(item => item.id === threadId)!
      // Model the provider's explicit recovery read. Ordinary snapshot reads never release a re-ask.
      this.event({ type: 'history', threadId, text: '', messages: thread.messages })
      for (const request of thread.requests) {
        const next = structuredClone(request)
        if (next.delivery === 'uncertain' && !this.pendingAnswerIds.has(next.id)
          && (!purpose.retryUncertainAnswerId || purpose.retryUncertainAnswerId === next.id)) {
          delete next.delivery; next.answerRetryReady = true
        }
        this.event({ type: 'question', threadId, text: next.text, request: next })
      }
    }
    return this.snapshot()
  }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type === 'answer') this.answers.push(structuredClone(command))
    const retainedRequest = command.type === 'answer' && this.keepQuestion
      ? (await this.snapshot()).threads.find(thread => thread.id === command.threadId)?.requests.find(request => request.id === command.requestId) : undefined
    const result = await super.execute(command)
    if (command.type === 'answer' && retainedRequest) {
      // A pending native write remains uncertain even during an explicit recovery read.
      // Once it completes, retain only the ordinary stale snapshot, without re-ask flags.
      if (this.uncertainAnswer) this.pendingAnswerIds.add(command.requestId)
      this.event({ type: 'question', threadId: command.threadId, text: retainedRequest.text,
        request: this.uncertainAnswer ? { ...retainedRequest, delivery: 'uncertain' } : retainedRequest })
      void this.answerCompletion?.then(accepted => {
        if (!accepted) return
        this.pendingAnswerIds.delete(command.requestId)
        this.event({ type: 'history', threadId: command.threadId, text: '', messages: [] })
        this.event({ type: 'question', threadId: command.threadId, text: retainedRequest.text, request: retainedRequest })
      })
    }
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

async function fixture(provider: ProviderId, uncertain = false, answerCompletion?: Promise<boolean>, keepQuestion = false) {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-remote-question-'))
  let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
  let setup: SocketHostService | undefined
  let launched: LaunchedSotto | undefined
  try {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true,
      localHostEnabled: false, reducedMotion: 'on', historyEnabled: false }))
    const providers = { codex: new AnswerProvider(uncertain, answerCompletion, keepQuestion), claude: new AnswerProvider(uncertain, answerCompletion, keepQuestion), grok: new AnswerProvider(uncertain, answerCompletion, keepQuestion), devin: new AnswerProvider() }
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

test('acceptance recovered by a receipt reply after reconnect clears the existing banner without another shell read', async () => {
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
    await expect(page.getByRole('alert')).toBeVisible()
    await expect.poll(() => f.launched.app.evaluate((_, id) => globalThis.sottoRemoteHostE2E!.completedIdleReceiptReads(id), f.connection.hostId)).toBeGreaterThan(0)
    // Keep the selected thread and its command notice, as the production reconnect path does.
    await f.launched.app.evaluate((_, id) => globalThis.sottoRemoteHostE2E!.disconnect(id, true), f.connection.hostId)
    finishNative(true)
    const remoteThread = f.host.service.shell().host.threads.find(thread => thread.title === 'Forge question fixture')!
    await expect.poll(() => f.host.service.requestAnswerRecovery(remoteThread.id, 'claude').completed.length).toBe(1)
    await f.launched.app.evaluate((_, connection) => globalThis.sottoRemoteHostE2E!.connect({ ...connection, holdReceipts: true }), f.connection)
    await expect.poll(() => f.launched.app.evaluate((_, id) => globalThis.sottoRemoteHostE2E!.receiptReads(id), f.connection.hostId)).toBeGreaterThan(0)
    await expect(retained).toBeVisible()
    await expect(page.getByRole('alert')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('receipt-reply-awaiting-proof.png'), animations: 'disabled' })
    // Acceptance happened offline. Only this reply can reveal it; never poll agents.get(),
    // change selection or cause another shell read to clear the notice on the test's behalf.
    await f.launched.app.evaluate((_, id) => globalThis.sottoRemoteHostE2E!.releaseReceipts(id), f.connection.hostId)
    await expect.poll(() => drafts(f.profile)).toEqual([])
    await expect(retained).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('receipt-reply-draft-retired.png'), animations: 'disabled' })
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('receipt-reply-confirmed.png'), animations: 'disabled' })
    expect(f.native.answers).toHaveLength(1)
    expect(f.errors).toEqual([])
  } finally { finishNative(false); await f.close() }
})

test('background acceptance marks a still-visible native question sent without a Check or another read', async () => {
  test.setTimeout(120_000)
  let finishNative: (accepted: boolean) => void = () => undefined
  const completion = new Promise<boolean>(resolve => { finishNative = resolve })
  const f = await fixture('claude', true, completion, true)
  try {
    const { page } = f.launched
    f.native.event({ type: 'question', threadId: 'workshop', text: structured.text, request: structured })
    const card = page.locator('.thread-questions .agent-request').filter({ hasText: structured.questions![0]!.question })
    await card.getByRole('radio', { name: 'Coast', exact: true }).click()
    await expect(card).toHaveAttribute('data-save', 'saved')
    await card.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect(card).toHaveAttribute('data-phase', 'unconfirmed')
    await expect.poll(() => f.launched.app.evaluate((_, id) => globalThis.sottoRemoteHostE2E!.completedReceiptReads(id), f.connection.hostId)).toBeGreaterThan(0)
    finishNative(true)
    await expect.poll(() => drafts(f.profile)).toEqual([])
    await expect(card).toHaveAttribute('data-phase', 'sent')
    await expect(card.getByText('Answer sent.', { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Check again', exact: true })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Send answer', exact: true })).toBeDisabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('background-accepted-sent.png'), animations: 'disabled' })
    // The ordinary native snapshot is still stale. A new renderer must recover the accepted
    // revision from metadata after its answer text has already been removed.
    await page.reload()
    await openThreads(page)
    await expect(card).toHaveAttribute('data-phase', 'sent')
    await expect(card.getByText('Answer sent.', { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Send answer', exact: true })).toBeDisabled()
    await expect(card.getByRole('button', { name: 'Check again', exact: true })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(await drafts(f.profile)).toEqual([])
    expect(f.native.answers).toHaveLength(1)
    expect(f.errors).toEqual([])
  } finally { finishNative(false); await f.close() }
})

for (const provider of ['claude', 'grok'] as const) test(`${provider}: a provider re-ask requires Check and a fresh explicit answer, including after renderer reload`, async () => {
  test.setTimeout(120_000)
  const f = await fixture(provider)
  try {
    const { page } = f.launched
    const card = page.locator('.thread-questions .agent-request').filter({ hasText: structured.questions![0]!.question })
    f.native.event({ type: 'question', threadId: 'workshop', text: structured.text, request: structured })
    await card.getByRole('radio', { name: 'Coast', exact: true }).click()
    await expect(card).toHaveAttribute('data-save', 'saved')
    await card.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect.poll(() => drafts(f.profile)).toEqual([])
    expect(f.native.answers).toHaveLength(1)
    for (const [index, reload] of [false, true].entries()) {
      const floor = JSON.parse(await readFile(join(f.profile, 'request-drafts.json'), 'utf8')).retirements[0].revision as number
      f.native.event({ type: 'question', threadId: 'workshop', text: structured.text, request: { ...structured, delivery: 'uncertain' } })
      await expect(card).toBeVisible()
      if (reload) { await page.reload(); await openThreads(page) }
      await expect(card).toHaveAttribute('data-phase', 'unconfirmed')
      await expect(card.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()
      await expect(card.getByText('Answer sent.', { exact: true })).toHaveCount(0)
      await expect(card.getByRole('button', { name: 'Send answer', exact: true })).toBeDisabled()
      expect(f.native.checkReads).toBe(index)
      expect(f.native.answers).toHaveLength(index + 1)
      if (index === 0) await page.screenshot({ path: test.info().outputPath('reasked-awaiting-check.png'), animations: 'disabled' })
      await card.getByRole('button', { name: 'Check again', exact: true }).click()
      await expect(card).toHaveAttribute('data-phase', 'idle')
      await expect(card.getByRole('button', { name: 'Check again', exact: true })).toHaveCount(0)
      await expect(card.getByRole('radio', { name: 'Coast', exact: true })).not.toBeChecked()
      await expect(card.getByRole('radio', { name: 'Hills', exact: true })).not.toBeChecked()
      await expect.poll(async () => (await drafts(f.profile)).map(draft => ({ held: draft.held, newer: draft.revision > floor, selections: draft.selections })))
        .toEqual([{ held: false, newer: true, selections: {} }])
      expect(f.native.checkReads).toBe(index + 1)
      expect(f.native.answers).toHaveLength(index + 1)
      if (index === 0) await page.screenshot({ path: test.info().outputPath('reasked-checked-blank.png'), animations: 'disabled' })
      await card.getByRole('radio', { name: 'Hills', exact: true }).click()
      await expect(card).toHaveAttribute('data-save', 'saved')
      await card.getByRole('button', { name: 'Send answer', exact: true }).click()
      await expect(card).toHaveCount(0)
      await expect.poll(() => drafts(f.profile)).toEqual([])
      expect(f.native.answers).toHaveLength(index + 2)
      expect(f.native.answers.at(-1)?.questionAnswers).toEqual({ route: { optionIds: ['hills'] } })
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    expect(f.errors).toEqual([])
  } finally { await f.close() }
})

test('Check confirming an accepted answer keeps its visible card sent and never recreates a saved draft', async () => {
  test.setTimeout(120_000)
  let finishNative: (accepted: boolean) => void = () => undefined
  const completion = new Promise<boolean>(resolve => { finishNative = resolve })
  const f = await fixture('claude', true, completion, true)
  const originalRecovery = f.host.service.requestAnswerRecovery.bind(f.host.service)
  const originalCheck = f.host.service.checkRequestAnswer.bind(f.host.service)
  const originalRead = f.native.refreshThread.bind(f.native)
  const checks: Parameters<typeof originalCheck>[0][] = []
  let proofReleases = 0, completedChecks = 0, allowProof = false
  let activeCheck: Parameters<typeof originalCheck>[0] | undefined
  try {
    const { page } = f.launched
    f.host.service.requestAnswerRecovery = (...args) => ({ ...originalRecovery(...args), completed: [] })
    f.host.service.checkRequestAnswer = async (...args) => {
      checks.push(structuredClone(args[0]))
      const explicit = allowProof
      if (explicit) activeCheck = args[0]
      try {
        await originalCheck(...args)
        completedChecks++
      } finally { if (explicit) activeCheck = undefined }
    }
    f.native.refreshThread = async (threadId, purpose) => {
      if (purpose?.retryUncertainAnswers && activeCheck) {
        expect(checks).toHaveLength(2)
        expect(completedChecks).toBe(1)
        expect(activeCheck.providerId).toBe('claude')
        expect(activeCheck.requestId).toBe(structured.id)
        expect(threadId).toBe('workshop')
        expect(purpose.retryUncertainAnswerId).toBe(activeCheck.requestId)
        proofReleases++
        // Keep background receipts masked until the user's exact Check reaches its native read.
        f.host.service.requestAnswerRecovery = originalRecovery
      }
      return originalRead(threadId, purpose)
    }
    f.native.event({ type: 'question', threadId: 'workshop', text: structured.text, request: structured })
    const card = page.locator('.thread-questions .agent-request').filter({ hasText: structured.questions![0]!.question })
    await card.getByRole('radio', { name: 'Coast', exact: true }).click()
    await expect(card).toHaveAttribute('data-save', 'saved')
    await card.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect(card).toHaveAttribute('data-phase', 'unconfirmed')
    await expect.poll(() => f.launched.app.evaluate((_, id) => globalThis.sottoRemoteHostE2E!.completedReceiptReads(id), f.connection.hostId)).toBeGreaterThan(0)
    // The uncertain Send performs its automatic Check first; it must not disclose the later proof.
    await expect.poll(() => completedChecks).toBe(1)
    expect(f.native.checkReads).toBe(1)
    const remoteThread = f.host.service.shell().host.threads.find(thread => thread.title === 'Forge question fixture')!
    let acceptancePublished = false
    const stop = f.host.service.subscribe(() => { acceptancePublished ||= originalRecovery(remoteThread.id, 'claude').completed.length === 1 })
    try {
      finishNative(true)
      await expect.poll(() => acceptancePublished).toBe(true)
    } finally { stop() }
    // A queued ordinary publication must not learn the masked proof before the explicit Check.
    ;(f.native as unknown as { emit(): void }).emit()
    await expect.poll(async () => (await drafts(f.profile)).map(draft => draft.held)).toEqual([true])
    await expect(card).toHaveAttribute('data-phase', 'unconfirmed')
    await expect(card.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()
    expect(checks).toHaveLength(1)
    expect(proofReleases).toBe(0)
    expect(f.native.checkReads).toBe(1)
    const proof = originalRecovery(remoteThread.id, 'claude').completed[0]!
    allowProof = true
    await card.getByRole('button', { name: 'Check again', exact: true }).click()
    // Only the user's exact native Check releases proof. Observe UI and disk, never agents.get().
    await expect(card).toHaveAttribute('data-phase', 'sent').catch(async error => {
      await test.info().attach('check-diagnostics', { body: JSON.stringify({
        drafts: (await drafts(f.profile)).map(draft => ({ revision: draft.revision, held: draft.held, decisionId: draft.decisionId })),
        alerts: await page.getByRole('alert').allTextContents(), errors: f.errors,
        proof: originalRecovery(remoteThread.id, 'claude').completed,
      }), contentType: 'application/json' })
      throw error
    })
    await expect(card.getByText('Answer sent.', { exact: true })).toBeVisible()
    expect(checks).toEqual(Array(2).fill({ threadId: remoteThread.id, providerId: 'claude', requestId: structured.id, questionsDigest: proof.questionsDigest }))
    expect(completedChecks).toBe(2)
    expect(proofReleases).toBe(1)
    expect(f.native.checkReads).toBe(2)
    await expect(card.getByRole('button', { name: 'Send answer', exact: true })).toBeDisabled()
    await expect(card.getByRole('button', { name: 'Check again', exact: true })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect.poll(() => drafts(f.profile)).toEqual([])
    await page.screenshot({ path: test.info().outputPath('check-accepted-sent.png'), animations: 'disabled' })
    f.native.event({ type: 'history', threadId: 'workshop', text: '', messages: [] })
    await expect(card).toHaveCount(0)
    await expect(page.getByRole('region', { name: /^(?:Saved|Unconfirmed) answer$/u })).toHaveCount(0)
    expect(await drafts(f.profile)).toEqual([])
    expect(f.native.answers).toHaveLength(1)
    expect(f.errors).toEqual([])
  } finally {
    f.host.service.requestAnswerRecovery = originalRecovery
    f.host.service.checkRequestAnswer = originalCheck
    f.native.refreshThread = originalRead
    finishNative(false); await f.close()
  }
})

test('Check again refreshes the exact saved remote answer through desktop wiring and unlocks an unsent hold without submitting it', async () => {
  test.setTimeout(120_000)
  const f = await fixture('codex')
  try {
    const { page } = f.launched
    f.native.event({ type: 'question', threadId: 'workshop', text: structured.text, request: structured })
    const card = page.locator('.thread-questions .agent-request').filter({ hasText: structured.questions![0]!.question })
    await card.getByRole('radio', { name: 'Coast', exact: true }).click()
    await expect(card).toHaveAttribute('data-save', 'saved')
    const saved = (await drafts(f.profile))[0]!
    // Model restarting after the sending hold was saved but before an answer was dispatched.
    await page.evaluate(async draft => window.sotto!.requestDrafts!.save({ ...draft, revision: draft.revision + 1, held: true }), saved)
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Forge question fixture', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Check again', exact: true }).click()
    await expect.poll(async () => (await drafts(f.profile)).map(draft => draft.held)).toEqual([false])
    await expect(card.getByRole('radio', { name: 'Coast', exact: true })).toBeChecked()
    await expect(card.getByRole('button', { name: 'Send answer', exact: true })).toBeEnabled()
    await expect(card.getByRole('button', { name: 'Check again', exact: true })).toHaveCount(0)
    expect(f.native.answers).toHaveLength(0)
    await page.screenshot({ path: test.info().outputPath('remote-check-editable.png'), animations: 'disabled' })
    await card.getByRole('radio', { name: 'Hills', exact: true }).click()
    await expect(card).toHaveAttribute('data-save', 'saved')
    await card.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect.poll(() => drafts(f.profile)).toEqual([])
    await expect(card).toHaveCount(0)
    expect(f.native.answers.map(answer => answer.questionAnswers)).toEqual([{ route: { optionIds: ['hills'] } }])
    expect(f.errors).toEqual([])
  } finally { await f.close() }
})

test('a refused remote answer automatically checks its original attempt and lets the user edit and retry', async () => {
  test.setTimeout(120_000)
  const f = await fixture('codex')
  try {
    const { page } = f.launched
    f.native.event({ type: 'question', threadId: 'workshop', text: structured.text, request: structured })
    const card = page.locator('.thread-questions .agent-request').filter({ hasText: structured.questions![0]!.question })
    await card.getByRole('radio', { name: 'Coast', exact: true }).click()
    await expect(card).toHaveAttribute('data-save', 'saved')
    f.native.event({ type: 'reject', threadId: 'workshop', text: 'Synthetic answer refusal' })
    await card.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect.poll(() => f.native.answers.length).toBe(1)
    await expect.poll(async () => (await drafts(f.profile)).map(draft => ({ held: draft.held, decisionId: draft.decisionId }))).toEqual([{ held: false, decisionId: undefined }])
    await expect(card).toHaveAttribute('data-phase', 'failed')
    await expect(card.getByRole('radio', { name: 'Hills', exact: true })).toBeEnabled()
    await card.getByRole('radio', { name: 'Hills', exact: true }).click()
    await expect(card).toHaveAttribute('data-save', 'saved')
    await card.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect.poll(() => drafts(f.profile)).toEqual([])
    await expect(card).toHaveCount(0)
    expect(f.native.answers.map(answer => answer.questionAnswers)).toEqual([
      { route: { optionIds: ['coast'] } }, { route: { optionIds: ['hills'] } },
    ])
    expect(f.errors).toEqual([])
  } finally { await f.close() }
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
