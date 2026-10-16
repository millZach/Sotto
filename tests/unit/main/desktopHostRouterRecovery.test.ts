// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { DesktopHostRouter, REQUEST_DRAFT_PASS_INTERVAL_MS, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState, inactiveLocalHost } from '../../../src/main/hosts/inactiveLocalHost'
import { requestDraftOwnerState } from '../../../src/main/agents/requestDraftOwners'
import { RequestDraftService, requestQuestionsDigest } from '../../../src/main/agents/requestDrafts'
import { requestDraftProvider, type RequestDraft, type RequestDraftTarget } from '../../../src/shared/requestDrafts'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { RequestAnswerRecovery } from '../../../src/main/agents/hostService'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { deferred } from '../../fixtures/deferred'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { testCredentials } from '../../fixtures/testCredentials'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE_A = '22222222-2222-4222-8222-222222222222'
const REMOTE_B = '33333333-3333-4333-8333-333333333333'
const questions = [{ id: 'question', question: 'Where?', multiSelect: false, allowFreeText: true, options: [] }]
const answers = { question: { optionIds: [], text: 'Saved answer' } }

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
  it.each(['watcher', 'watcher-history'] as const)('keeps a remote %s held answer dormant without a native receipt read', async kind => {
    const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: false }), remote = host(REMOTE_A, 'remote')
    router.add(remote.connection)
    const drafts = new RequestDraftService(tmpdir(), owner => router.requestDraftState(owner), async () => {}, { write: async () => {} })
    await hold(drafts, target(REMOTE_A), 'retained-watcher-answer')
    const before = await drafts.heldThreadAnswers()
    remote.state.host.threads[0]!.kind = kind
    try {
      await router.reconcileRequestDrafts(drafts)
      expect(remote.read).not.toHaveBeenCalled()
      expect(remote.command).not.toHaveBeenCalled()
      expect(router.requestDraftState(target(REMOTE_A))).toBeUndefined()
      expect(await drafts.heldThreadAnswers()).toEqual(before)
    } finally { router.dispose() }
  })
  it('rechecks a queued receipt owner before reading a newly hidden Watcher', async () => {
    const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: false }), remote = host(REMOTE_A, 'remote')
    remote.state.host.threads.push({ ...remote.state.host.threads[0]!, id: 'second-thread' })
    router.add(remote.connection)
    const held: RequestDraft[] = ['thread', 'second-thread'].map((id, index) => ({
      target: { ...target(REMOTE_A), ownerId: hostEntityKey(REMOTE_A, id) }, revision: 1, held: true,
      decisionId: 'decision-' + index, selections: {} }))
    const before = structuredClone(held), drafts = { heldThreadAnswers: async () => held, reconcile: async () => {} }
    const started = deferred(), gate = deferred()
    remote.read.mockImplementationOnce(async () => { started.resolve(); await gate.promise })
    const running = router.reconcileRequestDrafts(drafts)
    try {
      await started.promise
      remote.state.host.threads[1]!.kind = 'watcher'
      gate.resolve()
      await running
      expect(remote.read).toHaveBeenCalledOnce()
      expect(held).toEqual(before)
    } finally { gate.resolve(); await running; router.dispose() }
  })
  it('retires known local acceptance for independent provider owners while a remote receipt is pending', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const local = host(LOCAL, 'local'), remote = host(REMOTE_A, 'remote')
    router.add(local.connection); router.add(remote.connection)
    local.state.host.threads.push({ ...local.state.host.threads[0]!, id: 'other-thread', providerId: 'grok' })
    const other: RequestDraftTarget = { ...target(LOCAL), ownerId: hostEntityKey(LOCAL, 'other-thread'), providerId: 'grok' }
    const otherRecovery: RequestAnswerRecovery = { uncertainRequestIds: [], completed: [] }
    local.connection.service.requestAnswerRecovery = threadId => threadId === 'other-thread' ? otherRecovery : local.recovery
    const drafts = new RequestDraftService(tmpdir(), owner => router.requestDraftState(owner), async () => {}, { write: async () => {} })
    await hold(drafts, target(REMOTE_A), 'remote'); await hold(drafts, target(LOCAL), 'local'); await hold(drafts, other, 'other-local')
    accept(local.recovery, 'local'); accept(otherRecovery, 'other-local')
    const started = deferred(), gate = deferred()
    remote.read.mockImplementation(async () => { started.resolve(); await gate.promise })
    const running = router.reconcileRequestDrafts(drafts)
    try {
      await started.promise
      expect(await drafts.get(target(LOCAL))).toBeNull()
      expect(await drafts.get(other)).toBeNull()
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

describe('answer recovery asked for by published states', () => {
  // A provider publishes dozens of times a second while it streams. One pass per published state queued
  // without bound behind the slower passes, and main spent minutes draining them after a reply.
  it('runs one pass for a burst and one more after its gap, and invents none in a quiet gap', async () => {
    vi.useFakeTimers()
    const router = new DesktopHostRouter(emptyDesktopState)
    router.add(host(REMOTE_A, 'remote').connection)
    const drafts = { heldThreadAnswers: vi.fn(async () => []), reconcile: vi.fn(async () => {}) }
    try {
      for (let index = 0; index < 100; index++) router.scheduleRequestDraftReconcile(drafts)
      await vi.advanceTimersByTimeAsync(0)
      expect(drafts.reconcile).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(REQUEST_DRAFT_PASS_INTERVAL_MS - 1)
      expect(drafts.reconcile).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(drafts.reconcile).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(REQUEST_DRAFT_PASS_INTERVAL_MS * 4)
      expect(drafts.reconcile).toHaveBeenCalledTimes(2)
      router.scheduleRequestDraftReconcile(drafts)
      await vi.advanceTimersByTimeAsync(0)
      expect(drafts.reconcile).toHaveBeenCalledTimes(3)
    } finally { router.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers() }
  })

  it('follows a pass slower than the interval at once, measuring the gap from its start', async () => {
    vi.useFakeTimers()
    const router = new DesktopHostRouter(emptyDesktopState)
    router.add(host(REMOTE_A, 'remote').connection)
    // A retirement write ahead of it on the draft service's lane holds the first pass up.
    const slow = deferred()
    const drafts = { heldThreadAnswers: vi.fn(async () => []), reconcile: vi.fn(async () => {}) }
    drafts.reconcile.mockImplementationOnce(async () => { await slow.promise })
    try {
      router.scheduleRequestDraftReconcile(drafts)
      await vi.advanceTimersByTimeAsync(100)
      router.scheduleRequestDraftReconcile(drafts)
      await vi.advanceTimersByTimeAsync(REQUEST_DRAFT_PASS_INTERVAL_MS + 100)
      expect(drafts.reconcile).toHaveBeenCalledOnce()
      slow.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(drafts.reconcile).toHaveBeenCalledTimes(2)
    } finally { slow.resolve(); router.dispose(); vi.useRealTimers() }
  })

  it('retires a known local acceptance on the next pass while an earlier pass\'s receipt read is still pending', async () => {
    vi.useFakeTimers()
    const router = new DesktopHostRouter(emptyDesktopState)
    const local = host(LOCAL, 'local'), remote = host(REMOTE_A, 'remote')
    router.add(local.connection); router.add(remote.connection)
    const drafts = new RequestDraftService(tmpdir(), owner => router.requestDraftState(owner), async () => {}, { write: async () => {} })
    const started = deferred(), gate = deferred()
    remote.read.mockImplementation(async () => { started.resolve(); await gate.promise })
    try {
      await hold(drafts, target(REMOTE_A), 'remote'); await hold(drafts, target(LOCAL), 'local')
      router.scheduleRequestDraftReconcile(drafts)
      await started.promise
      accept(local.recovery, 'local')
      router.scheduleRequestDraftReconcile(drafts)
      await vi.advanceTimersByTimeAsync(REQUEST_DRAFT_PASS_INTERVAL_MS)
      expect(await drafts.get(target(LOCAL))).toBeNull()
      expect((await drafts.get(target(REMOTE_A)))?.held).toBe(true)
      expect(remote.read).toHaveBeenCalledOnce()
    } finally { gate.resolve(); await vi.runAllTimersAsync(); router.dispose(); vi.useRealTimers() }
  })

  it('builds no host state for a pass with no held remote answer', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const remote = host(REMOTE_A, 'remote')
    const shell = vi.fn(() => remote.state)
    remote.connection.service.shell = shell
    router.add(remote.connection)
    shell.mockClear()
    try {
      await router.reconcileRequestDrafts({ heldThreadAnswers: async () => [], reconcile: async () => {} })
      expect(shell).not.toHaveBeenCalled()
    } finally { router.dispose() }
  })
})

describe('a held answer looking up its thread', () => {
  const roots: string[] = []
  const controls: AgentControl[] = []
  afterEach(async () => {
    for (const control of controls.splice(0)) control.dispose()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })
  async function remoteHeld(local: Parameters<typeof requestDraftOwnerState>[1], root: string) {
    const router = new DesktopHostRouter(emptyDesktopState)
    router.add(host(REMOTE_A, 'remote').connection)
    const drafts = new RequestDraftService(root, owner => requestDraftOwnerState(owner, local, router), async () => {}, { write: async () => {} })
    await hold(drafts, target(REMOTE_A), 'remote')
    return { router, drafts }
  }

  // `get()` copies every loaded thread's history. Read for the host ID on every published state, each copy
  // blocked main for 200 to 430 ms on a desktop with 195 threads, and clicks and typing lagged by seconds.
  it('reconciles an answer held on another host without copying this computer\'s histories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-draft-owner-'))
    roots.push(root)
    const control = createAgentControl({ directory: root, host: new E2EAgentHost(), credentials: await testCredentials(root, { mode: 'unavailable' }) })
    controls.push(control)
    await control.start()
    const { router, drafts } = await remoteHeld(control, root)
    const copies = vi.spyOn(control, 'get')
    try {
      await router.reconcileRequestDrafts(drafts)
      await drafts.reconcile()
      expect((await drafts.get(target(REMOTE_A)))?.held).toBe(true)
      expect(copies).not.toHaveBeenCalled()
    } finally { router.dispose() }
  })

  // The draft store asks for every owner it knows on every save of an answer being typed. Each answer copied the whole
  // shell once per owner, and main froze for most of a second at a time while the user typed in the answer box.
  it('saves a local answer as it is typed without copying the shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-draft-owner-local-'))
    roots.push(root)
    const provider = new FakeProviderHost()
    provider.state.threads = [{ id: 'thread', projectId: 'project', title: 'Task', modelId: 'fake:model', status: 'idle', messages: [],
      requests: [{ id: 'request', kind: 'question', text: 'Question', options: [], questions }] }]
    const control = createAgentControl({ directory: root, host: provider, credentials: await testCredentials(root, { mode: 'unavailable' }) })
    controls.push(control)
    await control.start(); await control.command({ type: 'connect' })
    const router = new DesktopHostRouter(emptyDesktopState)
    const owner = { ...target(control.hostId()!), providerId: requestDraftProvider(control.shell().host, control.shell().host.threads[0]!, control.configuration().provider) }
    const drafts = new RequestDraftService(root, item => requestDraftOwnerState(item, control, router), async () => {}, { write: async () => {} })
    const shellThread = control.shell().host.threads.find(item => item.id === 'thread')!
    const copies = vi.spyOn(control, 'shell')
    try {
      for (let revision = 1; revision <= 20; revision++) {
        await drafts.save({ target: owner, revision, held: false, selections: { question: { optionIds: [], other: true, text: 'Typed answer'.slice(0, revision) } } })
      }
      expect(copies).not.toHaveBeenCalled()
      const state = requestDraftOwnerState(owner, control, router)!
      expect(state).toMatchObject({ connected: true, ready: true, requests: shellThread.requests })
      // What it hands back is the caller's own copy.
      state.requests[0]!.text = 'Changed by the caller'
      expect(control.requestDraftView().host.threads[0]!.requests[0]!.text).toBe('Question')
    } finally { router.dispose() }
  })

  it('reconciles an answer held on another host while this computer\'s host is off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-draft-owner-off-'))
    roots.push(root)
    const { agentControl } = await inactiveLocalHost(root)
    const { router, drafts } = await remoteHeld(agentControl, root)
    try {
      await expect(router.reconcileRequestDrafts(drafts)).resolves.toBeUndefined()
      expect((await drafts.get(target(REMOTE_A)))?.held).toBe(true)
    } finally { router.dispose() }
  })
})
