// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { HOST_EVENT_PAGE_SIZE } from '../../src/shared/hostProtocol'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { WatcherLaunchProfiles } from '../../src/main/agents/watcherLaunchProfiles'
import type { WatcherProfileTools, AgentHost } from '../../src/main/agents/host'
import type { AgentThread } from '../../src/shared/agents'
import { emptyWatcherRecord } from '../../src/shared/watcher'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { museFixture } from '../fixtures/museFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function savedWatcher(watcherEnabled = false) {
  let f = await workspaceFixture()
  const root = f.root
  cleanups.push(() => f.remove())
  const snapshot = await f.host.connect('codex')
  const project = snapshot.projects.find(project => project.providerId === 'codex')!
  const model = snapshot.models.find(model => model.providerId === 'codex')!
  const ids: string[] = [randomUUID(), randomUUID()]
  for (const id of ids) await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id,
    projectId: project.id, modelId: model.id, title: 'Any title', workingCopy: 'shared' })
  await f.stop()
  const file = join(root, 'workspace.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  const threads = saved.snapshot.threads as AgentThread[]
  threads.find(thread => thread.id === ids[0])!.kind = 'watcher'
  threads.find(thread => thread.id === ids[1])!.kind = 'watcher-history'
  await writeFile(file, JSON.stringify(saved))
  const record = emptyWatcherRecord()
  const identity = { target: { hostId: saved.snapshot.hostId as string, threadId: ids[0]! },
    projectId: project.id, provider: 'codex' as const, createdAt: new Date().toISOString(), creationOperationId: randomUUID() }
  record.current = identity
  record.history = [{ ...identity, target: { ...identity.target, threadId: ids[1]! } }]
  await writeFile(join(root, 'agents.json'), JSON.stringify({ watcher: record }))
  f = await workspaceFixture(root, { watcherEnabled })
  cleanups.push(() => f.stop())
  return { ...f, record, ids, saved, file, model, project }
}

it('stable omits special kinds from every snapshot and observation and refuses native start, sends and local edits', async () => {
  const f = await savedWatcher()
  const observed = vi.spyOn(f.native, 'observeThreads')
  const start = vi.spyOn(f.native, 'startThreadSession')
  const execute = vi.spyOn(f.native, 'execute')
  const refresh = vi.spyOn(f.native, 'refreshThread')
  const activity = vi.fn()
  const unsubscribe = f.host.subscribeActivitySnapshots(activity)
  cleanups.push(async () => unsubscribe())
  await f.host.connect('codex')
  expect(f.host.workspaceSnapshot().threads.every(thread => thread.kind === 'project')).toBe(true)
  expect(f.host.watcherThreadIds()).toEqual(f.ids)
  expect((await f.host.snapshot()).threads.some(thread => f.ids.includes(thread.id))).toBe(false)
  for (const threadId of f.ids) {
    f.host.observeThreads([threadId])
    await expect(f.host.startThreadSession(threadId)).rejects.toThrow('Sotto Owl')
    await expect(f.host.refreshThread(threadId)).rejects.toThrow('Sotto Owl')
    await expect(f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Synthetic refused turn' })).rejects.toThrow('Sotto Owl')
    await expect(f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId })).rejects.toThrow('Sotto Owl')
    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId, reasoningEffort: 'high' })).rejects.toThrow('Sotto Owl')
    await expect(f.host.setWorkspaceSettled('thread', threadId, true)).rejects.toThrow('Sotto Owl')
    await expect(f.host.configureThreadWorkingCopy(threadId, { workingCopy: 'independent' })).rejects.toThrow('Sotto Owl')
    expect(f.host.threadMessages(threadId)).toEqual([])
    expect(f.host.messageIdentities(threadId)).toEqual([])
    expect(await f.host.writeShortText(threadId, { instruction: 'Synthetic', material: 'Synthetic' })).toBeNull()
    expect(f.host.admitsVisuals(threadId)).toBe(false)
    expect(f.host.admitsBabysitting(threadId)).toBe(false)
    expect(f.host.babysitThread(threadId)).toBeNull()
    expect(f.host.rollbackCapability(threadId).supported).toBe(false)
    expect(f.host.threadPullRequests(threadId)).toEqual({ branch: undefined, linked: [] })
    const babysitChange = vi.fn(records => records)
    await f.host.changeBabysitting(threadId, babysitChange)
    await f.host.recordBabysitEnded(threadId, 'https://github.com/example/synthetic/pull/1', 'switched-off')
    expect(babysitChange).not.toHaveBeenCalled()
  }
  expect(observed.mock.calls.every(([ids]) => ids.every(id => !f.ids.includes(id)))).toBe(true)
  expect(start).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  expect(activity.mock.calls.every(([snapshot]) => snapshot.threads.every((thread: AgentThread) => !f.ids.includes(thread.id)))).toBe(true)
  await f.host.privacyChanged()
  await f.stop()
  const saved = JSON.parse(await readFile(f.file, 'utf8'))
  expect(saved.snapshot.threads.filter((thread: AgentThread) => f.ids.includes(thread.id))).toEqual(
    f.saved.snapshot.threads.filter((thread: AgentThread) => f.ids.includes(thread.id)))
})

it('stable never attaches sotto_threads or grants any current, creation or history identity a profile', async () => {
  const f = await savedWatcher()
  const tools: WatcherProfileTools = { name: 'sotto_threads', definitions: [{ name: 'list_threads', description: 'Synthetic', inputSchema: {} }],
    mcpServer: vi.fn(async () => ({ name: 'sotto_threads', type: 'http' as const, url: 'http://127.0.0.1:1234/mcp', headers: [] })), revoke: vi.fn() }
  const identityOnly = randomUUID()
  f.record.creation = { phase: 'intent', identity: { ...f.record.current!, target: { ...f.record.current!.target, threadId: identityOnly } }, replaces: f.record.current!.target }
  await writeFile(join(f.root, 'agents.json'), JSON.stringify({ watcher: f.record }))
  const source = new WatcherLaunchProfiles(f.root, () => f.record.current!.target.hostId,
    id => f.saved.snapshot.threads.find((thread: AgentThread) => thread.id === id))
  source.useTools(tools)
  for (const id of [...f.ids, identityOnly]) await expect(source.profileFor(id)).rejects.toThrow('Sotto Owl')
  await expect(source.assertCreationBinding(identityOnly, f.project.id, 'codex')).rejects.toThrow('Sotto Owl')
  expect(await source.profileFor('ordinary')).toBeUndefined()
  expect(tools.mcpServer).not.toHaveBeenCalled()
  expect(tools.revoke).not.toHaveBeenCalled()
  const provider: FakeProviderHost & Pick<AgentHost, 'useThreadTools'> = Object.assign(new FakeProviderHost(), { useThreadTools: vi.fn() })
  const host = new WorkspaceHost(provider, f.root)
  cleanups.push(() => host.close())
  host.useThreadTools([tools, { ...tools, name: 'sotto_visual' }])
  expect(provider.useThreadTools).toHaveBeenCalledWith([expect.objectContaining({ name: 'sotto_visual' })])
})

it.each([false, true])('keeps ordinary project creation and first sends with Watcher enabled=%s', async watcherEnabled => {
  const f = await workspaceFixture(undefined, { watcherEnabled })
  cleanups.push(() => f.remove())
  cleanups.push(() => f.stop())
  const snapshot = await f.host.connect('codex')
  const project = snapshot.projects.find(project => project.providerId === 'codex')!
  const model = snapshot.models.find(model => model.providerId === 'codex')!
  const threadId = randomUUID()
  expect((await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: project.id,
    modelId: model.id, title: 'Ordinary thread', workingCopy: 'shared' })).accepted).toBe(true)
  expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Synthetic ordinary turn' })).accepted).toBe(true)
  expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === threadId)).toMatchObject({ kind: 'project', status: 'running' })
})

const factories = { claude: claudeFixture, codex: codexFixture, grok: grokFixture, devin: devinFixture, muse: () => museFixture() }
it.each(['claude', 'codex', 'grok', 'devin', 'muse'] as const)('refuses disabled Watcher at the %s adapter boundary before launch', async provider => {
  const f = await factories[provider]()
  cleanups.push(f.cleanup)
  const hostId = randomUUID(), threadId = randomUUID()
  const record = emptyWatcherRecord()
  record.current = { target: { hostId, threadId }, provider: provider === 'devin' ? 'codex' : provider, projectId: f.projectId, creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
  await writeFile(join(f.root, 'agents.json'), JSON.stringify({ watcher: record }))
  f.host.useLaunchProfiles!(new WatcherLaunchProfiles(f.root, () => hostId, id => ({ id, hostId, kind: 'watcher',
    providerId: provider, projectId: f.projectId, title: 'Synthetic', modelId: f.modelId, status: 'idle', messages: [], requests: [] })))
  await expect(f.host.startThreadSession!(threadId, { modelId: f.modelId, workingDirectory: f.root })).rejects.toThrow('Sotto Owl')
})


it.each([true, false])('keeps a restored Watcher selection, drafts, deliveries, outbox and wake-ups whole (identity present: %s)', async identityPresent => {
  const host = new FakeProviderHost()
  const fixture = await agentControlFixture({ host, credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: true } })
  cleanups.push(fixture.dispose)
  await fixture.control.start()
  fixture.control.dispose()
  await fixture.control.closed()
  const file = join(fixture.directory, 'agents.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  const threadId = randomUUID(), hostId = randomUUID(), draftId = randomUUID(), at = new Date().toISOString()
  const record = emptyWatcherRecord()
  record.current = { target: { hostId, threadId }, projectId: 'project', provider: 'codex', creationOperationId: randomUUID(), createdAt: at }
  saved.watcher = identityPresent ? record : emptyWatcherRecord()
  const attachment = { id: randomUUID(), name: 'Synthetic kept.png', mimeType: 'image/png', sizeBytes: 8, digest: 'a'.repeat(64) }
  Object.assign(saved, { activeThreadId: threadId, activeProjectId: 'project', draft: 'Synthetic retained draft',
    draftThreadId: threadId, draftRequestId: null, draftAttachments: [attachment], manualDraftId: draftId, composing: true,
    threadDrafts: [{ threadId, draftId, text: 'Synthetic retained draft', attachments: [attachment], requestId: null, updatedAt: at }],
    deliveries: [{ threadId, draftId, status: 'submitting', createdAt: at, updatedAt: at }],
    outbox: [{ id: randomUUID(), threadId, type: 'send', messageId: randomUUID() }] })
  await writeFile(file, JSON.stringify(saved))
  const followupFile = join(fixture.directory, 'followups.json')
  const queue = { items: ['queued', 'dispatching'].map(status => ({ id: randomUUID(), threadId, draftId: randomUUID(), status,
    text: 'Synthetic retained wake-up', attachments: [attachment], createdAt: at, updatedAt: at, wakeUp: true })), receipts: [] }
  await writeFile(followupFile, JSON.stringify(queue))
  Object.assign(host.state.threads[0]!, { id: threadId, kind: 'watcher' })
  Object.assign(host, { watcherThreadIds: () => [threadId] })
  const observed = vi.spyOn(host, 'observeThreads'), commands = vi.spyOn(host, 'execute')
  const control = fixture.create({ watcherEnabled: false })
  await control.start()
  expect(JSON.parse(await readFile(file, 'utf8')).draftThreadId).toBe(threadId)
  host.emit()
  expect(control.shell().host.threads.map(thread => thread.id)).toEqual(['session-docs'])
  expect(control.get().activeThreadId).toBeNull()
  expect(control.get().draft).toBe('')
  expect(control.get().threadDrafts).toEqual([])
  expect(control.get().followups).toEqual([])
  expect(observed.mock.calls.flatMap(([ids]) => ids)).not.toContain(threadId)
  expect(commands.mock.calls.every(([command]) => !('threadId' in command) || command.threadId !== threadId)).toBe(true)
  expect((await control.commandShell({ type: 'manual-send', threadId, text: 'Synthetic refused turn' })).error).toContain('Sotto Owl')
  expect((await control.commandShell({ type: 'compose', text: 'Synthetic refused replacement' })).error).toContain('Sotto Owl')
  expect((await control.commandShell({ type: 'cancel-draft' })).error).toContain('Sotto Owl')
  expect((await control.commandShell({ type: 'send' })).error).toContain('Sotto Owl')
  await expect(control.withdrawWakeUp(threadId, undefined, { tool: false })).rejects.toThrow('Sotto Owl')
  await control.privacyChanged()
  control.dispose()
  await control.closed()
  const after = JSON.parse(await readFile(file, 'utf8'))
  for (const key of ['watcher', 'activeThreadId', 'activeProjectId', 'draft', 'draftThreadId', 'draftRequestId', 'draftAttachments',
    'manualDraftId', 'composing', 'threadDrafts', 'deliveries', 'outbox']) expect(after[key]).toEqual(saved[key])
  expect(JSON.parse(await readFile(followupFile, 'utf8'))).toEqual(queue)
})

it.each([false, true])('fills ordinary catch-up pages across hidden Watcher history (enabled: %s)', async watcherEnabled => {
  const f = await savedWatcher(watcherEnabled)
  await f.host.connect('codex')
  const threadId = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.project.id,
    modelId: f.model.id, title: 'Ordinary catch-up', workingCopy: 'shared' })
  const store = new ThreadStore(join(f.root, 'threads.sqlite'))
  store.open()
  cleanups.push(async () => store.close())
  const afterSeq = store.latestSeq()
  const event = { kind: 'answer-given' as const, at: new Date().toISOString(), requestId: 'synthetic-request', attribution: { clientId: 'synthetic-desktop', transport: 'ipc' as const } }
  for (const id of f.ids) store.appendMany(id, Array.from({ length: HOST_EVENT_PAGE_SIZE + 1 }, () => event))
  store.appendMany(threadId, Array.from({ length: HOST_EVENT_PAGE_SIZE + 2 }, () => event))
  const expected = store.eventsAfter(afterSeq).filter(row => watcherEnabled || row.threadId === threadId)
  let cursor = afterSeq
  const received = []
  for (;;) {
    // Socket catch-up asks for one extra visible record to compute hasMore.
    const all = f.host.eventsAfter(cursor, undefined, HOST_EVENT_PAGE_SIZE + 1)
    const page = all.slice(0, HOST_EVENT_PAGE_SIZE)
    received.push(...page)
    if (all.length <= page.length) break
    expect(page.length).toBe(HOST_EVENT_PAGE_SIZE)
    expect(page.at(-1)!.seq).toBeGreaterThan(cursor)
    cursor = page.at(-1)!.seq
  }
  expect(received).toEqual(expected)
  expect(f.host.eventsAfter(afterSeq, threadId, 1)).toEqual(store.eventsAfter(afterSeq, threadId, 1))
  expect(f.host.eventsAfter(afterSeq, f.ids[0], 1)).toHaveLength(watcherEnabled ? 1 : 0)
  expect(f.host.eventsAfter(afterSeq, undefined, 0)).toEqual([])
  expect(store.eventsAfter(afterSeq)).toHaveLength(3 * HOST_EVENT_PAGE_SIZE + 4)
})
