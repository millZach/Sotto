// @vitest-environment node
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { RequestDraftService, requestQuestionsDigest, type RequestDraftOwnerState } from '../../../src/main/agents/requestDrafts'
import type { RequestDraft, RequestDraftTarget } from '../../../src/shared/requestDrafts'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { RequestAnswerRecovery } from '../../../src/main/agents/hostService'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE_A = '22222222-2222-4222-8222-222222222222'
const REMOTE_B = '33333333-3333-4333-8333-333333333333'
const questions = [{ id: 'question', question: 'Where?', multiSelect: false, allowFreeText: true, options: [] }]
const answers = { question: { optionIds: [], text: 'Saved answer' } }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function host(hostId: string, kind: 'local' | 'remote') {
  const state = emptyDesktopState(hostId)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.threads = [{ id: 'thread', projectId: 'project', title: 'Task', modelId: '', status: 'idle', messages: [],
    requests: [{ id: 'request', kind: 'question', text: 'Question', options: [], questions }] }]
  const recovery: RequestAnswerRecovery = { uncertainRequestIds: [], completed: [] }
  const command = vi.fn(async () => state)
  const read = vi.fn(async () => {})
  const connection: DesktopHostConnection = { hostId, name: hostId, kind,
    service: { shell: () => state, subscribe: () => () => {}, command, requestAnswerRecovery: () => recovery },
    detail: async () => null, preview: () => null, refreshRequestAnswer: read }
  return { state, recovery, command, read, connection }
}
function target(hostId: string): RequestDraftTarget {
  return { kind: 'thread', ownerId: hostEntityKey(hostId, 'thread'), providerId: 'codex', requestId: 'request', questions }
}
async function hold(drafts: RequestDraftService, owner: RequestDraftTarget, decisionId: string) {
  await drafts.save({ target: owner, revision: 1, held: true,
    selections: { question: { optionIds: [], other: false, text: 'Saved answer' } } })
  await drafts.bindDecision(owner, decisionId, answers)
}
function accept(recovery: RequestAnswerRecovery, decisionId: string) {
  recovery.completed = [...recovery.completed, { requestId: 'request', decisionId, questionsDigest: requestQuestionsDigest(questions) }]
}

describe('independent answer receipt recovery', () => {
  it('retires known local and personal acceptance while a remote receipt is pending', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const local = host(LOCAL, 'local'), remote = host(REMOTE_A, 'remote')
    router.add(local.connection); router.add(remote.connection)
    const personal: RequestDraftTarget = { ...target(LOCAL), kind: 'personal', ownerId: 'chat' }
    let personalState: RequestDraftOwnerState = { connected: true, ready: true,
      requests: local.state.host.threads[0]!.requests, completed: [] }
    const drafts = new RequestDraftService(tmpdir(), owner => owner.kind === 'personal' ? personalState : router.requestDraftState(owner), async () => {}, { write: async () => {} })
    await hold(drafts, target(REMOTE_A), 'remote'); await hold(drafts, target(LOCAL), 'local'); await hold(drafts, personal, 'personal')
    accept(local.recovery, 'local')
    personalState = { ...personalState, completed: [{ requestId: 'request', decisionId: 'personal', questionsDigest: requestQuestionsDigest(questions) }] }
    const started = deferred(), gate = deferred()
    remote.read.mockImplementation(async () => { started.resolve(); await gate.promise })
    const running = router.reconcileRequestDrafts(drafts)
    try {
      await started.promise
      expect(await drafts.get(target(LOCAL))).toBeNull()
      expect(await drafts.get(personal)).toBeNull()
      expect((await drafts.get(target(REMOTE_A)))?.held).toBe(true)
      expect(local.command).not.toHaveBeenCalled(); expect(remote.command).not.toHaveBeenCalled()
    } finally { gate.resolve(); await running; router.dispose() }
  })

  it('recovers another remote independently and deduplicates repeated unchanged recovery', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const a = host(REMOTE_A, 'remote'), b = host(REMOTE_B, 'remote')
    router.add(a.connection); router.add(b.connection)
    const drafts = new RequestDraftService(tmpdir(), owner => router.requestDraftState(owner), async () => {}, { write: async () => {} })
    await hold(drafts, target(REMOTE_A), 'a'); await hold(drafts, target(REMOTE_B), 'b')
    const started = deferred(), gate = deferred()
    a.read.mockImplementation(async () => { started.resolve(); await gate.promise })
    b.read.mockImplementation(async () => { accept(b.recovery, 'b') })
    const runs = [router.reconcileRequestDrafts(drafts)]
    try {
      await started.promise
      runs.push(router.reconcileRequestDrafts(drafts))
      await expect.poll(async () => await drafts.get(target(REMOTE_B))).toBeNull()
      expect(a.read).toHaveBeenCalledOnce(); expect(b.read).toHaveBeenCalledOnce()
      expect((await drafts.get(target(REMOTE_A)))?.held).toBe(true)
      expect(a.command).not.toHaveBeenCalled(); expect(b.command).not.toHaveBeenCalled()
    } finally { gate.resolve(); await Promise.all(runs); router.dispose() }
  })

  it('budgets sixteen reads per second per connection and retains unchanged negative results', async () => {
    vi.useFakeTimers()
    const router = new DesktopHostRouter(emptyDesktopState)
    const a = host(REMOTE_A, 'remote'), b = host(REMOTE_B, 'remote')
    router.add(a.connection); router.add(b.connection)
    const held: RequestDraft[] = [REMOTE_A, REMOTE_B].flatMap(hostId => Array.from({ length: 17 }, (_, index) => ({
      target: { ...target(hostId), requestId: `request-${index}` }, revision: 1, held: true,
      decisionId: `${hostId}-${index}`, selections: {} })))
    const drafts = { heldThreadAnswers: async () => held, reconcile: vi.fn(async () => {}) }
    let running: Promise<void> | undefined
    try {
      running = router.reconcileRequestDrafts(drafts)
      await vi.advanceTimersByTimeAsync(0)
      expect(a.read).toHaveBeenCalledTimes(16); expect(b.read).toHaveBeenCalledTimes(16)
      await vi.advanceTimersByTimeAsync(999)
      expect(a.read).toHaveBeenCalledTimes(16); expect(b.read).toHaveBeenCalledTimes(16)
      await vi.advanceTimersByTimeAsync(1)
      await running
      expect(a.read).toHaveBeenCalledTimes(17); expect(b.read).toHaveBeenCalledTimes(17)
      await router.reconcileRequestDrafts(drafts)
      expect(a.read).toHaveBeenCalledTimes(17); expect(b.read).toHaveBeenCalledTimes(17)
      expect(a.command).not.toHaveBeenCalled(); expect(b.command).not.toHaveBeenCalled()
    } finally { await vi.runAllTimersAsync(); await running; router.dispose(); vi.useRealTimers() }
  })

  it('bounds queued reads at 512 without evicting pending deduplication entries', async () => {
    vi.useFakeTimers()
    const router = new DesktopHostRouter(emptyDesktopState), remote = host(REMOTE_A, 'remote')
    router.add(remote.connection)
    const held: RequestDraft[] = Array.from({ length: 513 }, (_, index) => ({
      target: { ...target(REMOTE_A), requestId: `request-${index}` }, revision: 1, held: true,
      decisionId: `decision-${index}`, selections: {} }))
    const drafts = { heldThreadAnswers: async () => held, reconcile: async () => {} }
    const gate = deferred()
    remote.read.mockImplementationOnce(async () => { await gate.promise })
    const runs = [router.reconcileRequestDrafts(drafts)]
    try {
      await vi.advanceTimersByTimeAsync(0)
      runs.push(router.reconcileRequestDrafts(drafts))
      await vi.advanceTimersByTimeAsync(0)
      expect(remote.read).toHaveBeenCalledOnce()
      gate.resolve()
      await vi.runAllTimersAsync()
      await Promise.all(runs)
      expect(remote.read).toHaveBeenCalledTimes(512)
      // Once a completed negative memo can be evicted, the previously capped draft progresses.
      runs.push(router.reconcileRequestDrafts(drafts))
      await vi.runAllTimersAsync()
      await Promise.all(runs)
      expect(remote.read).toHaveBeenCalledTimes(513)
      expect(remote.command).not.toHaveBeenCalled()
    } finally { gate.resolve(); await vi.runAllTimersAsync(); await Promise.all(runs); router.dispose(); vi.useRealTimers() }
  })

})
