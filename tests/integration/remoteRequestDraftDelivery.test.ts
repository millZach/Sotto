// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService, HostConnectionError } from '../../src/main/agents/socketHostService'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import type { ThreadReadPurpose } from '../../src/main/agents/host'
import { RequestDraftService, requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { type AgentRequest, type ProviderId } from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { HostOperation, HostReceipt } from '../../src/shared/hostProtocol'
import { requestDraftQuestions, type RequestDraftOwner } from '../../src/shared/requestDrafts'

const question: AgentRequest = { id: 'question-one', kind: 'question', text: 'Synthetic question', options: [], questions: [
  { id: 'q', question: 'Which option?', options: [{ id: 'a', label: 'Option A' }], multiSelect: false, allowFreeText: true },
] }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(provider: ProviderId, onPushError?: (message: string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-remote-answer-'))
  cleanups.push(async () => { if (dirname(root) === tmpdir() && root.includes('sotto-remote-answer-')) await rm(root, { recursive: true, force: true }) })
  const providers = { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }
  const native = providers[provider]
  const startHost = () => startHeadlessHost({ dataDirectory: join(root, 'host'), port: 0,
    providers, reasoner: e2eAgentReasoner })
  const host = await startHost()
  cleanups.push(() => host.close())
  const url = 'http://127.0.0.1:' + host.descriptor!.port
  const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
  const descriptor = JSON.parse(await readFile(join(root, 'host', 'host-listener.json'), 'utf8')) as { adminToken: string }
  const permission = await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: {
    Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ clientId: paired.clientId }) })
  expect(permission.status).toBe(200)
  const client = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, ...(onPushError ? { onPushError } : {}) })
  cleanups.push(() => client.close())
  await client.connect()
  await client.command({ type: 'configure', patch: { provider, enabledProviders: [provider] } })
  await client.command({ type: 'connect', provider })
  const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop' && thread.providerId === provider)!.id
  let drafts: RequestDraftService
  const router = new DesktopHostRouter(emptyDesktopState, {
    bindRequestDraftDecision: (target, id, answers) => drafts.bindDecision(target, id, answers),
  })
  cleanups.push(async () => { router.dispose() })
  router.add({ hostId: paired.hostId, kind: 'remote', name: 'Forge', service: client,
    detail: id => client.readThreadDetail(id), preview: request => client.attachmentPreview(request),
    refreshRequestAnswer: (id, target) => client.refreshRequestAnswer(id, target) })
  const owner: RequestDraftOwner = { kind: 'thread', ownerId: hostEntityKey(paired.hostId, threadId), providerId: provider }
  const desktop = join(root, 'desktop'); await mkdir(desktop)
  const createDrafts = () => new RequestDraftService(desktop, input => router.requestDraftState(input),
    async (target, decisionId) => { await router.refreshRequestDraft(target, decisionId) })
  drafts = createDrafts()
  await drafts.start()
  native.event({ type: 'question', threadId: 'workshop', text: '', request: question })
  await expect.poll(() => router.shell().host.threads.find(thread => thread.id === owner.ownerId)?.requests.some(request => request.id === question.id)).toBe(true)
  const target = { ...owner, requestId: question.id, questions: requestDraftQuestions(question) }
  await drafts.save({ target, revision: 1, held: true, selections: { q: { optionIds: ['a'], other: false, text: '' } } })
  const restartDrafts = async () => { drafts = createDrafts(); await drafts.start(); return drafts }
  return { native, host, client, router, drafts, owner, target, threadId, restartDrafts, startHost, paired, desktop }
}

it.each(['codex', 'claude', 'grok'] as const)('acknowledges a %s answer accepted on Forge and retires its laptop hold', async provider => {
  const f = await fixture(provider)
  const original = f.native.execute.bind(f.native)
  const execute = vi.spyOn(f.native, 'execute').mockImplementation(async command => {
    if (command.type === 'answer') expect(await f.drafts.get(f.target)).toMatchObject({ held: true, decisionId: expect.any(String) })
    return original(command)
  })
  const result = await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  expect(result.error).toBeNull()
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
  expect(f.host.service.shell().host.threads.find(thread => thread.id === f.threadId)?.requests).toEqual([])
  await f.drafts.reconcile()
  expect(await f.drafts.list(f.owner), 'The provider accepted this answer, but Sotto still shows its retained answer as unconfirmed.').toEqual([])
})

it('keeps a remote answer unconfirmed when its question disappears without positive native acceptance', async () => {
  const f = await fixture('codex')
  const original = f.native.execute.bind(f.native)
  const execute = vi.spyOn(f.native, 'execute').mockImplementation(async command => {
    const result = await original(command)
    return command.type === 'answer' ? { accepted: false, uncertain: true } : result
  })
  await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  expect(f.host.service.shell().host.threads.find(thread => thread.id === f.threadId)?.requests.filter(request => request.id === question.id && !request.delivery)).toEqual([])
  await f.router.reconcileRequestDrafts(f.drafts)
  expect(await f.drafts.list(f.owner)).toEqual([expect.objectContaining({ held: true, decisionId: expect.any(String) })])
  expect(f.router.requestDraftState(f.owner)?.completed).toEqual([])
  const recovered = await f.restartDrafts()
  await f.router.reconcileRequestDrafts(recovered)
  expect(await recovered.list(f.owner)).toHaveLength(1)
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
})

it('keeps a refused remote answer available without recording acceptance', async () => {
  const f = await fixture('claude')
  const execute = vi.spyOn(f.native, 'execute').mockResolvedValueOnce({ accepted: false })
  const result = await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  expect(result.error).not.toBeNull()
  await f.router.reconcileRequestDrafts(f.drafts)
  expect(await f.drafts.list(f.owner)).toHaveLength(1)
  expect(f.router.requestDraftState(f.owner)?.completed).toEqual([])
  expect(f.host.service.shell().host.threads.find(thread => thread.id === f.threadId)?.requests).toContainEqual(expect.objectContaining({ id: question.id }))
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
})

it.each(['check', 'reconnect'] as const)('recovers an accepted remote answer after both host and laptop restart through %s without sending it again', async recovery => {
  const f = await fixture('grok')
  const execute = vi.spyOn(f.native, 'execute')
  await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  const held = (await f.drafts.list(f.owner))[0]!
  expect(held).toMatchObject({ held: true, decisionId: expect.any(String) })
  await f.client.close()
  f.router.dispose()
  await f.host.close()
  const host = await f.startHost()
  cleanups.push(() => host.close())
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + host.descriptor!.port, token: f.paired.token, expectedHostId: f.paired.hostId })
  cleanups.push(() => client.close())
  await client.connect()
  const router = new DesktopHostRouter(emptyDesktopState)
  cleanups.push(async () => { router.dispose() })
  router.add({ hostId: f.paired.hostId, kind: 'remote', name: 'Forge', service: client,
    detail: id => client.readThreadDetail(id), preview: request => client.attachmentPreview(request),
    refreshRequestAnswer: (id, target) => client.refreshRequestAnswer(id, target) })
  const recovered = new RequestDraftService(f.desktop, input => router.requestDraftState(input),
    async (target, decisionId) => { await router.refreshRequestDraft(target, decisionId) })
  await recovered.start()
  if (recovery === 'check') await expect(recovered.check(f.target)).resolves.toEqual({ status: 'accepted',
    decisionId: held.decisionId, revision: held.revision })
  else await router.reconcileRequestDrafts(recovered)
  expect(await recovered.list(f.owner)).toEqual([])
  expect(router.requestDraftState(f.owner)?.completed).toContainEqual({ requestId: question.id,
    questionsDigest: requestQuestionsDigest(f.target.questions), decisionId: held.decisionId })
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
})

it('checks a previously unknown receipt again when its uncertain question disappears, without replaying the answer', async () => {
  const f = await fixture('codex')
  const execute = vi.spyOn(f.native, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
  const receipt = vi.spyOn(f.client, 'receipt').mockResolvedValue({ status: 'unknown' })
  await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  await f.router.reconcileRequestDrafts(f.drafts)
  const held = (await f.drafts.list(f.owner))[0]!
  expect(held).toMatchObject({ held: true, decisionId: expect.any(String) })
  const attempts = receipt.mock.calls.length
  await f.router.reconcileRequestDrafts(f.drafts)
  expect(receipt).toHaveBeenCalledTimes(attempts)
  receipt.mockResolvedValue({ status: 'completed', acceptedAnswer: { threadId: f.threadId, providerId: 'codex',
    requestId: question.id, questionsDigest: requestQuestionsDigest(f.target.questions), decisionId: held.decisionId! } })
  f.native.event({ type: 'history', threadId: 'workshop', text: '', messages: [] })
  await expect.poll(() => f.router.shell().host.threads.find(thread => thread.id === f.owner.ownerId)?.requests.length).toBe(0)
  await f.router.reconcileRequestDrafts(f.drafts)
  expect(await f.drafts.list(f.owner)).toEqual([])
  expect(receipt.mock.calls.length).toBeGreaterThan(attempts)
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
})

it('reuses the same accepted remote answer receipt when a command is retried with its original identity', async () => {
  const f = await fixture('codex')
  const execute = vi.spyOn(f.native, 'execute')
  const command = { type: 'answer' as const, requestId: question.id, answer: '', questionAnswers: { q: { optionIds: ['a'] } } }
  await f.router.command({ ...command, threadId: f.owner.ownerId }, desktopWindowClient('Synthetic user'))
  const held = (await f.drafts.list(f.owner))[0]!
  expect(held.decisionId).toEqual(expect.any(String))
  await expect(f.client.command({ ...command, threadId: f.threadId }, undefined, held.decisionId)).resolves.toMatchObject({ error: null })
  expect(await f.client.receipt(held.decisionId!)).toMatchObject({ status: 'completed' })
  await expect(f.client.command({ ...command, threadId: f.threadId, questionAnswers: { q: { optionIds: [], text: 'Changed choice' } } }, undefined, held.decisionId)).rejects.toMatchObject({ code: 'invalid_request' })
  await f.drafts.reconcile()
  expect(await f.drafts.list(f.owner)).toEqual([])
  expect(execute.mock.calls.filter(([value]) => value.type === 'answer')).toHaveLength(1)
})

it('acknowledges a positively accepted answer even if the following detail refresh fails', async () => {
  const f = await fixture('codex')
  const execute = vi.spyOn(f.native, 'execute')
  vi.spyOn(f.client, 'readThreadDetail').mockRejectedValueOnce(new Error('Synthetic detail refresh failed'))
  const result = await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  expect(result.error).toBeNull()
  await f.drafts.reconcile()
  expect(await f.drafts.list(f.owner)).toEqual([])
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
})

it('acknowledges a positively accepted answer even if the host then fails to reread its provider', async () => {
  const f = await fixture('codex')
  const snapshot = vi.spyOn(f.native, 'snapshot')
  const original = f.native.execute.bind(f.native)
  const execute = vi.spyOn(f.native, 'execute').mockImplementation(async command => {
    const result = await original(command)
    if (command.type === 'answer') snapshot.mockRejectedValueOnce(new Error('Synthetic native refresh failed'))
    return result
  })
  const result = await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  expect(result.error).toBeNull()
  await f.drafts.reconcile()
  expect(await f.drafts.list(f.owner)).toEqual([])
  expect(snapshot).toHaveBeenCalled()
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
})

it.each(['accepted', 'unknown'] as const)('checks a saved answer when its receipt is %s and the fresh native Check fails', async outcome => {
  const f = await fixture('codex')
  const execute = vi.spyOn(f.native, 'execute')
  const receipt = vi.spyOn(f.client, 'receipt').mockResolvedValueOnce({ status: 'unknown' })
  await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  const held = await f.drafts.get(f.target)
  expect(held).toMatchObject({ held: true })
  if (outcome === 'unknown') receipt.mockResolvedValueOnce({ status: 'unknown' })
  const check = vi.spyOn(f.client, 'checkRequestAnswer').mockRejectedValueOnce(new Error('Synthetic native Check failure'))
  if (outcome === 'accepted') {
    await expect(f.drafts.check(f.target)).resolves.toEqual({ status: 'accepted', decisionId: held!.decisionId, revision: held!.revision })
    expect(await f.drafts.list(f.owner)).toEqual([])
  } else {
    await expect(f.drafts.check(f.target)).rejects.toThrow('Synthetic native Check failure')
    expect(await f.drafts.list(f.owner)).toHaveLength(1)
  }
  expect(check).toHaveBeenCalledTimes(outcome === 'accepted' ? 0 : 1)
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
})

it.each(['unknown', 'uncertain'] as const)('keeps a held answer and reports a detail refresh failure when acceptance is %s', async outcome => {
  const onPushError = vi.fn()
  const f = await fixture('codex', onPushError)
  const saved = await f.drafts.get(f.target)
  const execute = vi.spyOn(f.native, 'execute')
  if (outcome === 'unknown') vi.spyOn(f.client, 'receipt').mockResolvedValueOnce({ status: 'unknown' })
  else execute.mockResolvedValueOnce({ accepted: false, uncertain: true, error: 'Synthetic answer unconfirmed' })
  const detail = vi.spyOn(f.client, 'readThreadDetail').mockRejectedValueOnce(new Error('Synthetic detail refresh failed'))
  const result = await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  // An acknowledged command keeps its own outcome; the host row reports a failed display refresh.
  expect(result.error).toBe(outcome === 'unknown' ? null : 'Synthetic answer unconfirmed')
  expect(detail).toHaveBeenCalledWith(f.threadId)
  expect(onPushError).toHaveBeenCalledExactlyOnceWith('The host confirmed the command, but its latest details could not be read. Nothing was lost. Refresh or reconnect to see them.')
  await f.drafts.reconcile()
  expect(await f.drafts.list(f.owner)).toEqual([{ ...saved, held: true, decisionId: expect.any(String) }])
  expect(f.router.requestDraftState(f.owner)?.completed).toEqual([])
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
})

it.each([true, false])('rechecks a pending receipt after its command finishes with native acceptance %s when the question was already absent and its direct acknowledgement was lost', async accepted => {
  const { native, client, router, drafts, owner } = await fixture('claude')

  const { promise: nativeEntered, resolve: enteredNative } = deferred<void>()

  const { promise: nativeRelease, resolve: releaseNative } = deferred<void>()

  const executeOriginal = native.execute.bind(native)
  const execute = vi.spyOn(native, 'execute').mockImplementation(async command => {
    const result = await executeOriginal(command)
    if (command.type === 'answer') { enteredNative(); await nativeRelease }
    return accepted ? result : { accepted: false, uncertain: true }
  })
  // Lose this caller's acknowledgement while the real socket request and its host task continue.
  // No clock or request deadline is shortened, and no answer is sent a second time.
  const transport = client as unknown as { call(operation: HostOperation, id?: string): Promise<unknown> }
  const callOriginal = transport.call.bind(client)
  let wireResponse: Promise<unknown> = Promise.resolve()
  vi.spyOn(transport, 'call').mockImplementation(async (operation, id) => {
    if (operation.op !== 'command' || operation.command.type !== 'answer') return callOriginal(operation, id)
    wireResponse = callOriginal(operation, id)
    await nativeEntered
    throw new HostConnectionError('Synthetic direct acknowledgement lost', 'disconnected', id)
  })
  const statuses: HostReceipt['status'][] = []
  const receiptOriginal = client.receipt.bind(client)
  const receipt = vi.spyOn(client, 'receipt').mockImplementation(async (...args) => {
    const result = await receiptOriginal(...args); statuses.push(result.status); return result
  })
  try {
    await expect(router.command({ type: 'answer', threadId: owner.ownerId, requestId: question.id,
      answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))).rejects.toThrow('Synthetic direct acknowledgement lost')
    await expect.poll(() => router.shell().host.threads.find(thread => thread.id === owner.ownerId)?.requests.length).toBe(0)
    await expect.poll(() => router.shell().busyThreadIds?.includes(owner.ownerId)).toBe(true)
    await router.reconcileRequestDrafts(drafts)
    expect(statuses).toEqual(['pending'])
    expect(await drafts.list(owner)).toHaveLength(1)
    await router.reconcileRequestDrafts(drafts)
    expect(receipt).toHaveBeenCalledTimes(1)
    releaseNative()
    await wireResponse
    await expect.poll(() => router.shell().busyThreadIds?.includes(owner.ownerId) ?? false).toBe(false)
    expect(router.shell().host.threads.find(thread => thread.id === owner.ownerId)?.requests).toEqual([])
    await router.reconcileRequestDrafts(drafts)
    expect(await drafts.list(owner), 'The settled command must clear its hold only with positive native acceptance.').toHaveLength(accepted ? 0 : 1)
    // Exact pushed acceptance settles the positive branch without another read. A settled
    // negative command still invalidates its pending memo through the busy-state transition.
    expect(statuses).toEqual(accepted ? ['pending'] : ['pending', 'completed'])
    await router.reconcileRequestDrafts(drafts)
    expect(receipt).toHaveBeenCalledTimes(accepted ? 1 : 2)
    expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
  } finally { releaseNative(); await wireResponse }
})

it.each([true, false])('settles a late native answer completion %s after a negative receipt with an absent question and idle command', async accepted => {
  const f = await fixture('claude')

  const { promise: answerCompletion, resolve: settle } = deferred<boolean>()

  const original = f.native.execute.bind(f.native)
  const execute = vi.spyOn(f.native, 'execute').mockImplementation(async command => {
    const result = await original(command)
    return command.type === 'answer' ? { accepted: false, uncertain: true, answerCompletion } : result
  })
  const receipt = vi.spyOn(f.client, 'receipt')
  await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  await expect.poll(() => f.router.shell().busyThreadIds?.includes(f.owner.ownerId) ?? false).toBe(false)
  await expect.poll(() => f.router.shell().host.threads.find(thread => thread.id === f.owner.ownerId)?.requests).toEqual([])
  await f.router.reconcileRequestDrafts(f.drafts)
  const held = (await f.drafts.list(f.owner))[0]!
  expect(held).toMatchObject({ held: true, decisionId: expect.any(String) })
  expect(f.router.requestDraftState(f.owner)?.completed).toEqual([])
  const reads = receipt.mock.calls.length
  // Unrelated and repeated publications must leave the cached negative read alone.
  f.native.event({ type: 'stream', threadId: 'docs', messageId: 'unrelated-stream', text: 'Synthetic unrelated output' })
  await f.router.reconcileRequestDrafts(f.drafts)
  await f.router.reconcileRequestDrafts(f.drafts)
  expect(receipt).toHaveBeenCalledTimes(reads)
  const off = f.router.subscribe(() => { void f.router.reconcileRequestDrafts(f.drafts) })
  try {
    settle(accepted)
    if (accepted) {
      await expect.poll(() => f.host.service.requestAnswerRecovery(f.threadId, 'claude').completed.length).toBe(1)
      await expect.poll(async () => (await f.drafts.list(f.owner)).length).toBe(0)
      expect(receipt).toHaveBeenCalledTimes(reads)
    } else {
      await answerCompletion
      await f.router.reconcileRequestDrafts(f.drafts)
      expect(await f.drafts.list(f.owner)).toEqual([held])
      expect(f.router.requestDraftState(f.owner)?.completed).toEqual([])
      expect(receipt).toHaveBeenCalledTimes(reads)
    }
    await f.router.reconcileRequestDrafts(f.drafts)
    expect(receipt).toHaveBeenCalledTimes(reads)
    expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
  } finally { off(); settle(false) }
})

it.each([false, true])('confirms its pending remote write when it completes during Check (read fails %s)', async fails => {
  const f = await fixture('claude')

  const { promise: answerCompletion, resolve: settle } = deferred<boolean>()

  const original = f.native.execute.bind(f.native)
  const execute = vi.spyOn(f.native, 'execute').mockImplementation(async command => {
    const result = await original(command)
    if (command.type !== 'answer') return result
    f.native.event({ type: 'question', threadId: 'workshop', text: '', request: { ...question, delivery: 'uncertain' } })
    return { accepted: false, uncertain: true, answerCompletion }
  })
  await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  const held = (await f.drafts.list(f.owner))[0]!
  await expect.poll(() => f.router.requestDraftState(f.owner)?.requests.find(item => item.id === question.id)?.delivery).toBe('uncertain')
  expect(f.router.requestDraftState(f.owner)?.completed).toEqual([])
  const refresh = vi.fn(async (threadId: string, purpose?: ThreadReadPurpose) => {
    expect(threadId).toBe('workshop')
    expect(purpose).toMatchObject({ retryUncertainAnswers: true, retryUncertainAnswerId: question.id })
    f.native.event({ type: 'history', threadId: 'workshop', text: '', messages: [] })
    settle(true)
    await expect.poll(() => f.router.requestDraftState(f.owner)?.completed?.some(item => item.decisionId === held.decisionId)).toBe(true)
    // The receipt arrives before coalesced state frames. This case requires the original native question to close too.
    await expect.poll(() => f.router.requestDraftState(f.owner)?.requests.some(item => item.id === question.id)).toBe(false)
    await f.drafts.reconcile()
    if (fails) throw new Error('Synthetic native Check failure after acceptance')
    return f.native.snapshot()
  })
  Object.assign(f.native, { refreshThread: refresh })
  const receipt = vi.spyOn(f.client, 'refreshRequestAnswer')
  try {
    await expect(f.drafts.check(f.target)).resolves.toEqual({ status: 'accepted', decisionId: held.decisionId, revision: held.revision })
    expect(await f.drafts.list(f.owner)).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(receipt).toHaveBeenCalledWith(held.decisionId, { threadId: f.threadId, providerId: 'claude',
      requestId: question.id, questionsDigest: requestQuestionsDigest(f.target.questions) })
    expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
  } finally { settle(false) }
})

it('restores accepted remote status while its original native card remains, without receipt reads or replay', async () => {
  const f = await fixture('claude')
  const execute = vi.spyOn(f.native, 'execute')
  await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  const held = await f.drafts.get(f.target)
  expect(held).toMatchObject({ held: true, decisionId: expect.any(String) })
  f.native.event({ type: 'question', threadId: 'workshop', text: '', request: question })
  await expect.poll(() => f.router.requestDraftState(f.owner)?.requests.find(item => item.id === question.id)).toMatchObject({ id: question.id })
  expect(f.router.requestDraftState(f.owner)?.requests.find(item => item.id === question.id)?.delivery).toBeUndefined()
  await f.router.reconcileRequestDrafts(f.drafts)
  const accepted = { status: 'accepted', decisionId: held!.decisionId, revision: held!.revision }
  const receipt = vi.spyOn(f.client, 'refreshRequestAnswer'), detail = vi.spyOn(f.client, 'readThreadDetail')
  const restarted = await f.restartDrafts()
  expect(await restarted.status(f.target)).toEqual(accepted)
  expect(await restarted.check(f.target)).toEqual(accepted)
  expect(receipt).not.toHaveBeenCalled(); expect(detail).not.toHaveBeenCalled()
  await f.client.close()
  const refresh = vi.fn(async () => { throw new Error('Disconnected host must not be read') })
  const offline = new RequestDraftService(f.desktop, () => undefined, refresh)
  await offline.start()
  expect(await offline.status(f.target)).toEqual(accepted)
  expect(await offline.check(f.target)).toEqual(accepted)
  expect(refresh).not.toHaveBeenCalled()
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
  const saved = JSON.parse(await readFile(join(f.desktop, 'request-drafts.json'), 'utf8'))
  expect(saved.version).toBe(2)
  expect(saved.drafts).toEqual([])
  expect(saved.retirements).toEqual([{ owner: f.owner, requestId: f.target.requestId,
    questionsDigest: requestQuestionsDigest(f.target.questions), decisionId: held!.decisionId, revision: held!.revision }])
})

it.each(['claude', 'grok'] as const)('freshly checks a retired same-ID %s re-offer over the paired socket without replaying its old answer', async provider => {
  const f = await fixture(provider)
  const execute = vi.spyOn(f.native, 'execute')
  await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  const held = await f.drafts.get(f.target)
  await f.router.reconcileRequestDrafts(f.drafts)
  expect(await f.drafts.status(f.target)).toEqual({ status: 'accepted', decisionId: held!.decisionId, revision: 1 })
  f.native.event({ type: 'question', threadId: 'workshop', text: '', request: { ...question, delivery: 'uncertain' } })
  await expect.poll(() => f.router.requestDraftState(f.owner)?.requests.find(item => item.id === question.id)?.delivery).toBe('uncertain')
  const restarted = await f.restartDrafts()
  expect(await restarted.status(f.target)).toEqual({ status: 'unconfirmed', revision: 1 })
  const refresh = vi.fn(async (threadId: string, purpose?: ThreadReadPurpose) => {
    expect(threadId).toBe('workshop')
    expect(purpose).toMatchObject({ retryUncertainAnswers: true, retryUncertainAnswerId: question.id })
    const snapshot = await f.native.snapshot()
    snapshot.threads.find(thread => thread.id === threadId)!.requests = [{ ...question, answerRetryReady: true }]
    return snapshot
  })
  Object.assign(f.native, { refreshThread: refresh })
  const historicalReceipt = vi.spyOn(f.client, 'refreshRequestAnswer')
  const blank = { target: f.target, revision: 2, selections: {}, held: false }
  expect(await restarted.check(f.target)).toEqual({ status: 'editable', draft: blank })
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(historicalReceipt).not.toHaveBeenCalled()
  expect(await restarted.status(f.target)).toEqual({ status: 'draft', draft: blank })
  await expect(restarted.save({ ...held!, held: false })).rejects.toThrow('already accepted')
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
  const persisted = JSON.parse(await readFile(join(f.desktop, 'request-drafts.json'), 'utf8'))
  expect(persisted.drafts).toEqual([blank])
  expect(persisted.retirements).toEqual([{ owner: f.owner, requestId: f.target.requestId,
    questionsDigest: requestQuestionsDigest(f.target.questions), decisionId: held!.decisionId, revision: 1 }])
})

it.each(['claude', 'grok'] as const)('keeps a native %s re-offer retry-ready across Check publication and a second recovered offer', async provider => {
  const f = await fixture(provider)
  const execute = vi.spyOn(f.native, 'execute')
  await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
    answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
  await f.router.reconcileRequestDrafts(f.drafts)
  const refresh = vi.fn(async (threadId: string, purpose?: ThreadReadPurpose) => {
    if (!purpose?.retryUncertainAnswers) return f.native.snapshot()
    expect(purpose).toMatchObject({ retryUncertainAnswers: true, retryUncertainAnswerId: question.id })
    const thread = (await f.native.snapshot()).threads.find(item => item.id === threadId)!
    f.native.event({ type: 'history', threadId, text: '', messages: thread.messages })
    for (const request of thread.requests) {
      const next = structuredClone(request)
      delete next.delivery; next.answerRetryReady = true
      f.native.event({ type: 'question', threadId, text: next.text, request: next })
    }
    return f.native.snapshot()
  })
  Object.assign(f.native, { refreshThread: refresh })
  for (let offer = 0; offer < 2; offer++) {
    f.native.event({ type: 'question', threadId: 'workshop', text: '', request: { ...question, delivery: 'uncertain' } })
    await expect.poll(() => f.router.requestDraftState(f.owner)?.requests.find(item => item.id === question.id)?.delivery).toBe('uncertain')
    const currentDrafts = offer ? await f.restartDrafts() : f.drafts
    const checked = await currentDrafts.check(f.target)
    expect(checked).toMatchObject({ status: 'editable', draft: { held: false, selections: {} } })
    const requests = () => f.router.requestDraftState(f.owner)?.requests.filter(item => item.id === question.id)
    expect(requests()).toEqual([expect.objectContaining({ answerRetryReady: true })])
    expect(requests()?.[0]?.delivery).toBeUndefined()
    // Follow-up shell/observation reads traverse the actual paired stack and must not
    // restore an uncertain provider snapshot after the draft has become editable.
    await f.client.observe([f.threadId])
    await f.client.readShell()
    expect(requests()).toEqual([expect.objectContaining({ answerRetryReady: true })])
    expect(requests()?.[0]?.delivery).toBeUndefined()
    if (checked.status !== 'editable' || !checked.draft) throw new Error('The checked re-offer has no fresh draft.')
    const draft = checked.draft
    await currentDrafts.save({ ...draft, revision: draft.revision + 1, held: true, selections: { q: { optionIds: ['a'], other: false, text: '' } } })
    await f.router.command({ type: 'answer', threadId: f.owner.ownerId, requestId: question.id,
      answer: '', questionAnswers: { q: { optionIds: ['a'] } } }, desktopWindowClient('Synthetic user'))
    await f.router.reconcileRequestDrafts(currentDrafts)
    expect(await currentDrafts.list(f.owner)).toEqual([])
  }
  expect(refresh.mock.calls.filter(([, purpose]) => purpose?.retryUncertainAnswers)).toHaveLength(2)
  expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(3)
})
