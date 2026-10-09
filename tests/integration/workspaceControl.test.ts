// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { createAgentControl } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceFixture } from '../fixtures/workspaceFixture'

import type { AgentState } from '../../src/shared/agents'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'
import { FollowupStore } from '../../src/main/agents/followups'
import { TurnRecorder } from '../../src/main/agents/turns'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(root?: string) {
  const f = await workspaceFixture(root)
  const credentials = await testCredentials(join(f.root, 'vault'), { mode: 'unavailable' })
  const opened: string[] = []
  const recorder = new TurnRecorder({ directory: f.root, resolveSession: id => f.registry.byThread(id) })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials, turns: recorder,
    openThreadFolder: async path => { opened.push(path) },
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
  })
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => { control.dispose(); await control.privacyChanged(); await f.stop() })()
  cleanup.push(async () => { await close(); await f.remove() })
  await control.start(); await control.command({ type: 'connect' })
  return { ...f, control, opened, recorder, close }
}
function thread(state: AgentState) { return state.host.threads.find(thread => thread.id === state.activeThreadId)! }

describe('workspace controller integration', () => {
  it('returns a worktree preview without saving or broadcasting it', async () => {
    const f = await fixture()
    const preview = { path: '/synthetic/worktree', branch: 'sotto/test', dirty: false, ignored: ['.env'], items: [{ path: '.env', bytes: 10, fileCount: 1 }], repositories: [], untracked: [] }
    const previewHost = vi.spyOn(f.host, 'previewThreadWorktreeReclaim').mockResolvedValue(preview)
    const publish = vi.fn(); const unsubscribe = f.control.subscribe(publish); publish.mockClear()
    try {
      const result = await f.control.command({ type: 'preview-reclaim-thread-worktree', threadId: f.control.get().host.threads[0]!.id })
      expect(result.worktreeReclaimPreview).toEqual(preview)
      expect(f.control.get().worktreeReclaimPreview).toBeUndefined()
      expect(f.control.shell().worktreeReclaimPreview).toBeUndefined()
      expect(publish).not.toHaveBeenCalled()
      expect(await readFile(join(f.root, 'agents.json'), 'utf8')).not.toContain('synthetic/worktree')
    } finally { previewHost.mockRestore(); unsubscribe() }
  })

  it('stops native work even when the follow-up pause cannot be saved', async () => {
    const f = await fixture()
    const threadId = f.control.get().host.threads.find(thread => thread.providerId === 'codex')!.id
    await f.control.command({ type: 'assign', threadId, instruction: 'Keep watching' })
    const pause = vi.spyOn(FollowupStore.prototype, 'pause').mockRejectedValueOnce(new Error('Synthetic pause write failure'))
    try {
      const result = await f.control.command({ type: 'interrupt', threadId })
      expect(f.adapters.codex.commands.filter(command => command.type === 'interrupt')).toHaveLength(1)
      expect(result.assignments.find(item => item.threadId === threadId)?.paused).toBe(true)
      expect((await f.recorder.recent(20)).find(turn => turn.commandType === 'interrupt')).toMatchObject({ outcome: 'completed' })
      expect(result.error).toBe('Stop was sent, but the queue pause could not be saved. Your queued messages are still saved. Check them before sending another message.')
    } finally { pause.mockRestore() }
  })

  it.each(['closed', 'unsupported'] as const)('leaves management and queued messages unchanged when Stop is refused: %s', async refusal => {
    const f = await fixture()
    const threadId = f.control.get().host.threads.find(thread => thread.providerId === 'codex')!.id
    await f.control.command({ type: 'assign', threadId, instruction: 'Keep watching' })
    const native = f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread(threadId)!.sessionId)!
    if (refusal === 'closed') native.archivedAt = new Date().toISOString()
    else f.adapters.codex.state.capabilities.interrupt = false
    f.adapters.codex.emit()
    await f.control.command({ type: 'refresh' })
    const before = f.control.get()
    const pause = vi.spyOn(FollowupStore.prototype, 'pause')
    try {
      const result = await f.control.command({ type: 'interrupt', threadId })
      expect(result.error).toBe(refusal === 'closed' ? 'This thread is settled or archived. There is no open work to stop.' : 'This connection cannot stop agent work.')
      expect(result.assignments).toEqual(before.assignments)
      expect(result.followups).toEqual(before.followups)
      expect(pause).not.toHaveBeenCalled()
      expect(f.adapters.codex.commands.filter(command => command.type === 'interrupt')).toEqual([])
    } finally { pause.mockRestore() }
  })

  it.each(['closed', 'unsupported'] as const)('restores management when Stop becomes unavailable during queue persistence: %s', async refusal => {
    const f = await fixture()
    const threadId = f.control.get().host.threads.find(thread => thread.providerId === 'codex')!.id
    await f.control.command({ type: 'assign', threadId, instruction: 'Keep watching' })
    const native = f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread(threadId)!.sessionId)!

    const { promise: gate, resolve: release } = deferred<void>()

    const pause = vi.spyOn(FollowupStore.prototype, 'pause').mockImplementationOnce(async () => { await gate })
    const stopping = f.control.command({ type: 'interrupt', threadId })
    try {
      await expect.poll(() => pause.mock.calls.length).toBe(1)
      if (refusal === 'closed') native.archivedAt = new Date().toISOString()
      else f.adapters.codex.state.capabilities.interrupt = false
      f.adapters.codex.emit()
      await f.control.command({ type: 'refresh' })
      release()
      const result = await stopping
      expect(result.error).toBe(refusal === 'closed' ? 'This thread is settled or archived. There is no open work to stop.' : 'This connection cannot stop agent work.')
      expect(result.assignments.find(item => item.threadId === threadId)?.paused).toBe(false)
      expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).assignments.find((item: { threadId: string }) => item.threadId === threadId).paused).toBe(false)
      expect(f.adapters.codex.commands.filter(command => command.type === 'interrupt')).toEqual([])
    } finally { release(); await stopping; pause.mockRestore() }
  })

  it('reports a failed Stop intent save without claiming cancellation reached the provider', async () => {
    const f = await fixture()
    const threadId = f.control.get().host.threads.find(thread => thread.providerId === 'codex')!.id
    const pause = vi.spyOn(FollowupStore.prototype, 'pause').mockRejectedValueOnce(new Error('Synthetic pause write failure'))
    const write = AtomicJsonStore.prototype.write
    const save = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (value && typeof value === 'object' && 'outbox' in value && Array.isArray(value.outbox)
        && value.outbox.some(item => item.type === 'interrupt')) return Promise.reject(new Error('Synthetic Stop intent failure'))
      return write.call(this, value)
    })
    try {
      const result = await f.control.command({ type: 'interrupt', threadId })
      expect(result.error).toBe('Synthetic Stop intent failure')
      expect(f.adapters.codex.commands.filter(command => command.type === 'interrupt')).toEqual([])
    } finally { pause.mockRestore(); save.mockRestore() }
  })

  it('retries Stop after an uncertain interrupt without replaying a prompt', async () => {
    const f = await fixture()
    const threadId = f.control.get().host.threads.find(thread => thread.providerId === 'codex')!.id
    const native = f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread(threadId)!.sessionId)!
    native.status = 'running'; native.lastTurn = { id: 'unconfirmed-turn', status: 'running' }
    f.adapters.codex.emit()
    await f.control.command({ type: 'refresh' })
    const original = f.adapters.codex.execute.bind(f.adapters.codex)
    const execute = vi.spyOn(f.adapters.codex, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
    try {
      expect((await f.control.command({ type: 'interrupt', threadId })).error).toBeTruthy()
      expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toContainEqual(expect.objectContaining({ type: 'interrupt', threadId }))
      execute.mockImplementation(original)
      expect((await f.control.command({ type: 'interrupt', threadId })).error).toBeNull()
      expect(execute.mock.calls.map(([command]) => command.type)).toEqual(['interrupt', 'interrupt'])
    } finally { execute.mockRestore() }
  })
  it('reopens an uncertain send through the real workspace and reconciles only its exact late receipt without replay', async () => {
    const first = await fixture()
    const threadId = first.control.get().host.threads.find(thread => thread.providerId === 'codex')!.id
    const nativeId = first.registry.byThread(threadId)!.sessionId
    const original = first.adapters.codex.execute.bind(first.adapters.codex)
    const execute = vi.spyOn(first.adapters.codex, 'execute').mockImplementation(async command => {
      if (command.type !== 'send') return original(command)
      return { accepted: false, uncertain: true }
    })
    const prompt = { type: 'manual-send' as const, threadId, draftId: randomUUID(), text: 'Keep this exact synthetic prompt' }
    const saved = async () => JSON.parse(await readFile(join(first.root, 'agents.json'), 'utf8'))
    try {
      expect((await first.control.command(prompt)).deliveries).toContainEqual(expect.objectContaining({ draftId: prompt.draftId, status: 'uncertain' }))
      const intent = (await saved()).outbox[0]
      expect(intent).toMatchObject({ threadId, draftId: prompt.draftId, messageId: expect.any(String), draftDigest: expect.any(String) })
      await first.close()

      // Replace the coordinator, workspace, registry and provider adapters. Only disk crosses this boundary.
      const reopened = await fixture(first.root)
      expect(reopened.registry.byThread(threadId)?.sessionId).toBe(nativeId)
      expect((await saved()).outbox).toEqual([intent])
      await reopened.control.command(prompt)
      expect(reopened.adapters.codex.commands.filter(command => command.type === 'send')).toEqual([])
      const native = reopened.adapters.codex.state.threads.find(thread => thread.id === nativeId)!
      native.messages.push({ id: 'unrelated-message', role: 'user', text: prompt.text, createdAt: new Date().toISOString() })
      reopened.adapters.codex.emit()
      await reopened.control.command({ type: 'refresh' })
      expect((await saved()).outbox).toEqual([intent])

      native.messages.push({ id: intent.messageId, commandId: intent.id, role: 'user', text: prompt.text, createdAt: new Date().toISOString() })
      reopened.adapters.codex.emit()
      await expect.poll(() => reopened.control.get().deliveredDrafts).toContainEqual({ threadId, draftId: prompt.draftId })
      await expect.poll(async () => (await saved()).outbox).toEqual([])
      await reopened.control.command(prompt)
      expect(reopened.adapters.codex.commands.filter(command => command.type === 'send')).toEqual([])
      expect(execute.mock.calls.filter(([command]) => command.type === 'send')).toHaveLength(1)
      await expect.poll(() => reopened.host.threadMessages(threadId).filter(message => message.id === intent.messageId)).toHaveLength(1)
    } finally { execute.mockRestore() }
  })

  it.each(['pending', 'uncertain'] as const)('stops native work while the original send is %s without replacing or replaying it', async delivery => {
    const f = await fixture()
    const threadId = f.control.get().host.threads.find(thread => thread.providerId === 'codex')!.id
    const native = f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread(threadId)!.sessionId)!
    const original = f.adapters.codex.execute.bind(f.adapters.codex)

    const { promise: held, resolve: release } = deferred<void>()

    const execute = vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
      if (command.type !== 'send') return original(command)
      native.status = 'running'; native.lastTurn = { id: 'unconfirmed-turn', status: 'running' }
      f.adapters.codex.emit()
      if (delivery === 'pending') await held
      return { accepted: false, uncertain: true }
    })
    const prompt = { type: 'manual-send' as const, threadId, draftId: randomUUID(), text: 'Start synthetic work' }
    const sending = f.control.command(prompt)
    let stopping: Promise<AgentState> | undefined
    try {
      await expect.poll(() => f.control.get().host.threads.find(thread => thread.id === threadId)?.status).toBe('running')
      if (delivery === 'uncertain') await sending
      const saved = () => readFile(join(f.root, 'agents.json'), 'utf8').then(text => JSON.parse(text))
      const intent = (await saved()).outbox.find((item: { type: string }) => item.type === 'send')
      expect(intent).toMatchObject({ threadId, draftId: prompt.draftId, messageId: expect.any(String), draftDigest: expect.any(String) })
      stopping = f.control.command({ type: 'interrupt', threadId })
      // The provider cannot finish the pending send until released below; Stop must cross both real layers first.
      await expect.poll(() => execute.mock.calls.filter(([command]) => command.type === 'interrupt').length).toBe(1)
      expect((await stopping).error).toBeNull()
      expect((await saved()).outbox).toEqual([intent])
      expect(f.control.get().host.threads.find(thread => thread.id === threadId)?.status).toBe('idle')
      release(); await sending
      expect(f.control.get().deliveries?.find(item => item.draftId === prompt.draftId)?.status).toBe('uncertain')
      await f.control.command(prompt)
      expect(execute.mock.calls.filter(([command]) => command.type === 'send')).toHaveLength(1)
      expect((await saved()).outbox).toEqual([intent])
      // Only an exact provider echo reconciles the original prompt; Stop alone is not a delivery receipt.
      native.messages.push({ id: intent.messageId, commandId: intent.id, role: 'user', text: prompt.text, createdAt: new Date().toISOString() })
      f.adapters.codex.emit()
      await expect.poll(() => f.control.get().deliveries?.find(item => item.draftId === prompt.draftId)?.status).toBe('accepted')
      await f.control.command(prompt)
      await expect.poll(async () => (await saved()).outbox).toEqual([])
      expect(execute.mock.calls.filter(([command]) => command.type === 'send')).toHaveLength(1)
    } finally { release(); await Promise.allSettled([sending, stopping]); execute.mockRestore() }
  })

  it('releases a rejected interrupt lane before a reconnect, another Stop and a fresh send', async () => {
    const f = await fixture()
    const threadId = f.control.get().host.threads.find(thread => thread.providerId === 'codex')!.id
    const execute = vi.spyOn(f.adapters.codex, 'execute').mockRejectedValueOnce(new Error('Synthetic Stop failure'))
    try {
      expect((await f.control.command({ type: 'interrupt', threadId })).error).toBe('Synthetic Stop failure')
      expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
      await f.control.command({ type: 'disconnect', provider: 'codex' })
      expect((await f.control.command({ type: 'connect', provider: 'codex' })).error).toBeNull()
      expect((await f.control.command({ type: 'interrupt', threadId })).error).toBeNull()
      expect((await f.control.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Fresh work after reconnect' })).error).toBeNull()
      expect(f.adapters.codex.commands.map(command => command.type)).toEqual(['interrupt', 'send'])
    } finally { execute.mockRestore() }
  })
  it('opens only the known thread’s validated working folder and rejects arbitrary targets', async () => {
    const f = await fixture()
    const initial = f.control.get()
    const created = await f.control.command({ type: 'create-thread', projectId: initial.host.projects[0]!.id,
      modelId: initial.host.models.find(model => model.providerId === 'codex')!.id, title: 'Shared', workingCopy: 'shared', managed: false })
    const id = created.activeThreadId!
    expect((await f.control.command({ type: 'open-thread-folder', threadId: id })).error).toBeNull()
    expect(f.opened).toEqual([created.host.threads.find(thread => thread.id === id)!.workingDirectory])
    expect((await f.control.command({ type: 'open-thread-folder', threadId: '../arbitrary' })).error).toContain('not known')
    expect(f.opened).toHaveLength(1)
    expect((await f.control.command({ type: 'refresh-thread-worktree', threadId: id })).error).toBeNull()
    expect(f.adapters.codex.commands).toHaveLength(0)
  })
  it('allows an explicit retry after definitive native creation rejection without changing its binding', async () => {
    const f = await fixture()
    const initial = f.control.get()
    const model = initial.host.models.find(model => model.providerId === 'codex')!
    const created = await f.control.command({ type: 'create-thread', projectId: initial.host.projects[0]!.id, modelId: model.id, title: 'Retry', managed: false })
    const id = created.activeThreadId!
    const execute = f.adapters.codex.execute.bind(f.adapters.codex)
    const spy = vi.spyOn(f.adapters.codex, 'execute').mockImplementationOnce(async () => ({ accepted: false }))
    const prompt = { type: 'manual-send' as const, threadId: id, text: 'Try this work' }
    expect((await f.control.command(prompt)).error).toContain('rejected thread creation')
    const binding = f.registry.byThread(id)
    spy.mockImplementation(execute)
    expect((await f.control.command(prompt)).error).toBeNull()
    expect(f.registry.byThread(id)).toEqual(binding)
    expect(f.adapters.codex.commands.map(command => command.type)).toEqual(['create-thread', 'send'])
  })
  it('does not recreate a selected existing folder that disappeared before registration', async () => {
    const f = await fixture()
    const path = join(f.root, 'selected-folder')
    await mkdir(path)
    await rm(path, { recursive: true })
    const before = f.control.get().host.projects
    const result = await f.control.command({ type: 'create-project', provider: 'codex', title: 'Selected folder', path, useExisting: true })
    expect(result.error).toBe('That folder no longer exists. Nothing was added. Choose another folder.')
    expect(result.host.projects).toEqual(before)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.adapters.codex.commands).toHaveLength(0)
  })
  it('makes a new folder, opens it when it is sent again as existing, and refuses a folder or file already there', async () => {
    const f = await fixture()
    const path = join(f.root, 'voice-lab')
    const made = await f.control.command({ type: 'create-project', provider: 'codex', title: 'voice-lab', path })
    expect(made.error).toBeNull()
    expect((await stat(path)).isDirectory()).toBe(true)
    const project = made.host.projects.find(item => item.path === path)!
    // Add project's retry after an unanswered first try sends the folder as existing, and finds the project it made.
    const retried = await f.control.command({ type: 'create-project', provider: 'codex', title: 'voice-lab', path, useExisting: true })
    expect(retried.error).toBeNull()
    expect(retried.activeProjectId).toBe(project.id)
    expect(retried.host.projects.filter(item => item.path === path)).toHaveLength(1)
    const before = retried.host.projects
    const other = join(f.root, 'not-a-project')
    await mkdir(other)
    const refused = await f.control.command({ type: 'create-project', provider: 'codex', title: 'not-a-project', path: other })
    expect(refused.error).toBe('That folder already exists. Nothing was added. Choose another folder, or add this one with Add project to use it as it is.')
    expect(refused.host.projects).toEqual(before)
    const file = join(f.root, 'notes')
    await writeFile(file, '')
    const onFile = await f.control.command({ type: 'create-project', provider: 'codex', title: 'notes', path: file, useExisting: true })
    expect(onFile.error).toBe('A file with that name is already there. Nothing was added. Choose another name.')
    expect(onFile.host.projects).toEqual(before)
  })
  it('opens existing projects without changing scope, creates multiple manual threads, and keeps coordinator settings independent', async () => {
    const f = await fixture()
    let state = await f.control.command({ type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'independent-coordinator' } })
    const project = state.host.projects.find(project => project.providerId === 'codex')!
    await mkdir(project.path, { recursive: true })
    state = await f.control.command({ type: 'create-project', provider: 'codex', title: 'Open folder', path: project.path, useExisting: true })
    expect(state.error).toBeNull()
    expect(state.activeProjectId).toBe(project.id)
    expect(state.host.projects).toHaveLength(3)
    expect(f.adapters.codex.commands).toHaveLength(0)
    const model = state.host.models.find(model => model.providerId === 'codex')!
    state = await f.control.command({ type: 'create-thread', projectId: project.id, modelId: model.id, title: 'First', managed: false })
    expect(state.error).toBeNull(); const first = thread(state)
    state = await f.control.command({ type: 'create-thread', projectId: project.id, modelId: model.id, title: 'Second', managed: false })
    expect(state.error).toBeNull(); const second = thread(state)
    expect(first.id).not.toBe(second.id)
    expect([first.projectId, second.projectId]).toEqual([project.id, project.id])
    expect(state.assignments).toEqual([])
    await f.control.command({ type: 'disconnect', provider: 'codex' })
    const claude = state.host.models.find(model => model.providerId === 'claude')!
    state = await f.control.command({ type: 'configure-thread', threadId: first.id, modelId: claude.id, reasoningEffort: 'high', runtimeMode: 'approval-required' })
    expect(state.error).toBeNull()
    expect(state.configuration).toMatchObject({ provider: 'codex', reasoning: 'openrouter', reasoningModel: 'independent-coordinator' })
    state = await f.control.command({ type: 'manual-send', threadId: first.id, text: 'Work on this project' })
    expect(state.error).toBeNull()
    expect(state.host.threads.find(thread => thread.id === first.id)).toMatchObject({ projectId: project.id, providerId: 'claude', nativeSessionStarted: true, status: 'running' })
    expect(state.assignments).toEqual([])
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
  })

  it('settles and restores offline while retaining working requests, attention, IDs and explicit management authority', async () => {
    const f = await fixture()
    const original = f.control.get().host.threads.find(thread => thread.providerId === 'codex')!
    await f.control.command({ type: 'assign', threadId: original.id, instruction: 'Keep watching' })
    const native = f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread(original.id)!.sessionId)!
    native.status = 'running'
    native.requests.push({ id: 'permission', kind: 'permission', text: 'Run the build?', options: [] })
    f.adapters.codex.emit()
    // Provider publishes are coalesced in the workspace host, so wait for this one to arrive.
    await expect.poll(() => f.control.get().queue.some(item => item.requestId === 'permission')).toBe(true)
    const before = f.control.get()
    const callCount = f.adapters.codex.commands.length
    let state = await f.control.command({ type: 'settle-thread', threadId: original.id })
    expect(state.error).toBeNull()
    state = await f.control.command({ type: 'settle-project', projectId: original.projectId })
    expect(state.error).toBeNull()
    expect(state.assignments).toEqual(before.assignments)
    expect(state.queue).toEqual(before.queue)
    expect(state.host.threads.find(thread => thread.id === original.id)).toMatchObject({ status: 'running', requests: native.requests, workspaceSettledAt: expect.any(String) })
    expect(f.adapters.codex.commands).toHaveLength(callCount)
    await f.control.command({ type: 'disconnect' })
    state = await f.control.command({ type: 'restore-project', projectId: original.projectId })
    expect(state.error).toBeNull()
    expect(state.host.projects.find(project => project.id === original.projectId)?.workspaceSettledAt).toBeNull()
    expect(state.host.threads.find(thread => thread.id === original.id)?.workspaceSettledAt).toEqual(expect.any(String))
    state = await f.control.command({ type: 'restore-thread', threadId: original.id })
    expect(state.error).toBeNull()
    expect(state.host.threads.find(thread => thread.id === original.id)?.workspaceSettledAt).toBeNull()
    expect(state.queue).toEqual(before.queue)
    expect(f.adapters.codex.commands).toHaveLength(callCount)
  })
})
