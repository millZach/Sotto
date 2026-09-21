// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import type { AgentHostCommand, ThreadHistorySource } from '../../../src/main/agents/host'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = []
const controls: AgentControl[] = []
const registries: ThreadRegistry[] = []
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-threads-'))
  roots.push(root)
  return root
}
function adapter(root: string, inner = new FakeProviderHost()) {
  const registry = new ThreadRegistry(root)
  registries.push(registry)
  return { root, inner, registry, host: new SottoThreadHost('fake', inner, registry) }
}
async function fixture() { return adapter(await directory()) }

async function startControl(root: string, host: SottoThreadHost): Promise<AgentControl> {
  const credentials = new AgentCredentials(join(root, 'vault'), {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  })
  await credentials.load()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread.' }),
      decide: async () => ({ decision: 'human', text: 'Review this.' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
      action: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }) },
  })
  controls.push(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  return control
}

afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  vi.restoreAllMocks()
  for (const registry of registries.splice(0)) await registry.flush()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-threads-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('Sotto thread interface', () => {
  it('translates indexed task classification lookups to Sotto thread IDs and preserves the history epoch', async () => {
    let received: ThreadHistorySource | undefined
    const inner = Object.assign(new FakeProviderHost(), { useThreadHistory: (source: ThreadHistorySource) => { received = source } })
    const f = adapter(await directory(), inner)
    const snapshot = await f.host.connect()
    const expected = { id: 'claude-task-old', turnId: 'turn', sequence: 0, kind: 'subagent' as const, status: 'completed' as const, title: 'Subagent', taskUpdatesExcluded: true }
    const activity = vi.fn(() => expected)
    f.host.useThreadHistory({ messageIdentities: () => [], activity })
    expect(received?.activity?.(inner.state.threads[0]!.id, expected.id, 'epoch')).toEqual(expected)
    expect(activity).toHaveBeenCalledExactlyOnceWith(snapshot.threads[0]!.id, expected.id, 'epoch')
    expect(received?.activity?.('unknown-session', expected.id, 'epoch')).toBeUndefined()
    expect(activity).toHaveBeenCalledTimes(1)
  })
  it('exposes UUIDs and persists provider/session/project bindings before returning a snapshot', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    expect(f.inner.connectCalls).toBe(1)
    expect(snapshot).toEqual({ ...f.inner.state, threads: f.inner.state.threads.map((thread, index) => ({
      ...thread, id: snapshot.threads[index]!.id,
    })) })
    for (const [index, thread] of snapshot.threads.entries()) {
      expect(thread.id).toMatch(uuid)
      expect(thread.id).not.toBe(f.inner.state.threads[index]!.id)
      expect(f.registry.byThread(thread.id)).toEqual({ threadId: thread.id, provider: 'fake',
        sessionId: f.inner.state.threads[index]!.id, projectId: thread.projectId, createdAt: expect.any(String) })
      expect(new Date(f.registry.byThread(thread.id)!.createdAt).toISOString()).toBe(f.registry.byThread(thread.id)!.createdAt)
    }
    expect(JSON.parse(await readFile(join(f.root, 'threads.json'), 'utf8'))).toEqual({ bindings: f.registry.all() })
    expect(JSON.stringify(snapshot)).not.toContain('session-')
    f.host.disconnect()
    expect(f.inner.state.connected).toBe(false)
  })

  it('keeps IDs stable across snapshots and synchronous subscriber events, including discovered sessions', async () => {
    const f = await fixture()
    const first = await f.host.connect()
    const events: AgentHostSnapshot[] = []
    const unsubscribe = f.host.subscribe(snapshot => events.push(snapshot))
    f.inner.emit()
    expect(events[0]).toEqual(first)
    expect(await f.host.snapshot()).toEqual(first)
    f.inner.state.threads.push({ ...f.inner.state.threads[0]!, id: 'session-new', title: 'New' })
    f.inner.emit()
    const discovered = events.at(-1)!.threads.at(-1)!
    expect(discovered.id).toMatch(uuid)
    expect(f.registry.bySession('fake', 'session-new')?.threadId).toBe(discovered.id)
    expect((await f.host.snapshot()).threads.at(-1)).toEqual(discovered)
    expect(await readFile(join(f.root, 'threads.json'), 'utf8')).toContain(discovered.id)
    unsubscribe()
    f.inner.emit()
    expect(events).toHaveLength(2)
  })

  it('translates send, answer and interrupt without changing other command fields', async () => {
    const f = await fixture()
    const threadId = (await f.host.connect()).threads[0]!.id
    const commands: AgentHostCommand[] = [
      { type: 'send', threadId, commandId: 'send-command', messageId: 'message', text: 'Hello', expectedLastUserMessageId: null },
      { type: 'answer', threadId, commandId: 'answer-command', requestId: 'request', answer: 'Yes', approved: true },
      { type: 'interrupt', threadId, commandId: 'interrupt-command' },
    ]
    for (const command of commands) expect(await f.host.execute(command)).toEqual({ accepted: true })
    expect(f.inner.commands).toEqual(commands.map(command => ({ ...command, threadId: 'session-workshop' })))
    const project: AgentHostCommand = { type: 'create-project', commandId: 'project-command', projectId: 'new-project', title: 'New', path: 'C:/new' }
    await f.host.execute(project)
    expect(f.inner.commands.at(-1)).toEqual(project)
  })

  it('durably reserves a separate provider session before creation and reuses it on retry', async () => {
    const f = await fixture()
    await f.host.connect()
    const command: AgentHostCommand = { type: 'create-thread', threadId: randomUUID(), commandId: 'create-command',
      projectId: 'project', title: 'Created', modelId: 'fake:model' }
    const execute = f.inner.execute.bind(f.inner)
    vi.spyOn(f.inner, 'execute').mockImplementation(async translated => {
      expect(JSON.parse(await readFile(join(f.root, 'threads.json'), 'utf8')).bindings).toContainEqual(f.registry.byThread(command.threadId))
      return execute(translated)
    })
    await f.host.execute(command)
    const binding = f.registry.byThread(command.threadId)!
    expect(binding.sessionId).toMatch(uuid)
    expect(binding.sessionId).not.toBe(command.threadId)
    expect(f.inner.commands[0]).toEqual({ ...command, threadId: binding.sessionId })
    expect((await f.host.snapshot()).threads.at(-1)?.id).toBe(command.threadId)
    await f.host.execute(command)
    expect(f.inner.commands[1]).toEqual(f.inner.commands[0])
  })

  it('forwards observed session IDs and skips unknown Sotto IDs', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    f.host.observeThreads([snapshot.threads[0]!.id, 'unknown'])
    expect(f.inner.observed).toEqual(['session-workshop'])
  })

  it.each(['send', 'answer', 'interrupt'] as const)('rejects an unknown Sotto ID for %s', async type => {
    const f = await fixture()
    await f.host.connect()
    await expect(f.host.execute({ type, threadId: 'session-workshop', commandId: 'command',
      messageId: 'message', requestId: 'request', text: 'Hello', answer: 'Yes' })).rejects.toThrow(
      'This thread is not known to Sotto. Refresh and select it again.')
    expect(f.inner.commands).toEqual([])
  })

  it('restores identical IDs and observations with a new registry and host after restart', async () => {
    const f = await fixture()
    const first = await f.host.connect()
    f.host.disconnect()
    const restarted = adapter(f.root, new FakeProviderHost(f.inner.state))
    restarted.host.observeThreads([first.threads[0]!.id])
    expect(await restarted.host.connect()).toEqual(first)
    expect(restarted.inner.observed).toEqual(['session-workshop'])
    expect(restarted.registry.all()).toEqual(f.registry.all())
  })

  it('retains real control assignments and queue entries as Sotto IDs across restart', async () => {
    const f = await fixture()
    const control = await startControl(f.root, f.host)
    const threadId = control.get().host.threads[0]!.id
    expect((await control.command({ type: 'assign', threadId })).error).toBeNull()
    f.inner.state.threads[0]!.requests.push({ id: 'permission', kind: 'permission', text: 'Allow?', options: [] })
    f.inner.emit()
    const before = await control.command({ type: 'refresh' })
    expect(before.queue).toEqual([expect.objectContaining({ threadId, requestId: 'permission' })])
    control.dispose()
    const restarted = adapter(f.root, new FakeProviderHost(f.inner.state))
    const next = await startControl(f.root, restarted.host)
    const state = await next.command({ type: 'refresh' })
    expect(state.error).toBeNull()
    expect(state.assignments[0]?.threadId).toBe(threadId)
    expect(state.host.threads.find(thread => thread.id === state.assignments[0]?.threadId)?.title).toBe('Workshop')
    expect(state.queue).toEqual(before.queue)
    expect(JSON.stringify(state)).not.toContain('session-workshop')
    expect(await readFile(join(f.root, 'agents.json'), 'utf8')).not.toContain('session-workshop')
    expect(await readFile(join(f.root, 'threads.json'), 'utf8')).toContain('session-workshop')
  })

  it('reconciles an uncertain creation against its Sotto ID after a control and host restart', async () => {
    const f = await fixture()
    const control = await startControl(f.root, f.host)
    let pending: AgentHostCommand | undefined
    const execute = vi.spyOn(f.inner, 'execute').mockImplementation(async command => {
      pending = command
      return { accepted: false, uncertain: true }
    })
    const uncertain = await control.command({ type: 'create-thread', projectId: 'project', title: 'Delayed', modelId: 'fake:model' })
    expect(uncertain.error).toContain('did not confirm')
    const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))
    expect(saved.outbox).toHaveLength(1)
    const threadId = saved.outbox[0].threadId as string
    expect(threadId).toMatch(uuid)
    expect(saved.outbox[0].entityId).toBe(threadId)
    const sessionId = f.registry.byThread(threadId)!.sessionId
    expect(pending).toMatchObject({ threadId: sessionId })
    expect(JSON.stringify(saved)).not.toContain(sessionId)
    control.dispose()
    execute.mockRestore()
    await f.inner.execute(pending!)
    const restarted = adapter(f.root, new FakeProviderHost(f.inner.state))
    const next = await startControl(f.root, restarted.host)
    expect(next.get().host.threads.find(thread => thread.id === threadId)?.title).toBe('Delayed')
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
    expect(restarted.inner.commands).toEqual([])
  })
})

describe('ThreadRegistry durability', () => {
  it('loads idempotently, separates providers, updates projects and coalesces writes', async () => {
    const f = await fixture()
    await Promise.all([f.registry.load(), f.registry.load()])
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write')
    const first = f.registry.bind('fake', 'same-session', 'project')
    const second = f.registry.bind('other', 'same-session', 'project')
    expect(first.threadId).not.toBe(second.threadId)
    expect(f.registry.bind('fake', 'same-session', 'moved')).toEqual({ ...first, projectId: 'moved' })
    await f.registry.flush()
    expect(write).toHaveBeenCalledTimes(1)
    await f.registry.load()
    expect(f.registry.all()).toHaveLength(2)
    const restarted = adapter(f.root)
    await restarted.registry.load()
    expect(restarted.registry.byThread(first.threadId)?.projectId).toBe('moved')
  })

  it.each(['{broken', '{"bindings":[{"threadId":42}]}'])('recovers a corrupt registry: %s', async contents => {
    const f = await fixture()
    await writeFile(join(f.root, 'threads.json'), contents)
    await f.registry.load()
    expect(f.registry.all()).toEqual([])
    const backup = (await readdir(f.root)).find(name => name.startsWith('threads.json.corrupt-'))!
    expect(await readFile(join(f.root, backup), 'utf8')).toBe(contents)
    f.registry.bind('fake', 'session-workshop', 'project')
    await f.registry.flush()
    expect(JSON.parse(await readFile(join(f.root, 'threads.json'), 'utf8')).bindings).toHaveLength(1)
  })

  it('does not dispatch creation when its binding cannot be saved and preserves the ID for a retry', async () => {
    const f = await fixture()
    await f.host.connect()
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('Disk unavailable'))
    const command: AgentHostCommand = { type: 'create-thread', threadId: randomUUID(), commandId: 'create',
      projectId: 'project', title: 'Created', modelId: 'fake:model' }
    await expect(f.host.execute(command)).rejects.toThrow('Disk unavailable')
    expect(f.inner.commands).toEqual([])
    const reserved = f.registry.byThread(command.threadId)
    await f.host.execute(command)
    expect(f.registry.byThread(command.threadId)).toEqual(reserved)
    expect(JSON.parse(await readFile(join(f.root, 'threads.json'), 'utf8')).bindings).toContainEqual(reserved)
  })

  it('flushes discoveries made while a previous disk write is still in progress', async () => {
    const f = await fixture()
    await f.registry.load()
    let started!: () => void
    const writing = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementationOnce(async function (this: AtomicJsonStore<unknown>, value) {
      started()
      await gate
      return original.call(this, value)
    })
    const first = f.registry.bind('fake', 'first-session', 'project')
    const flushed = f.registry.flush()
    await writing
    const second = f.registry.bind('fake', 'second-session', 'project')
    release()
    await flushed
    expect(JSON.parse(await readFile(join(f.root, 'threads.json'), 'utf8')).bindings).toEqual([first, second])
  })
})

describe('upgrade and event ordering', () => {
  it('never adopts coincident provider IDs from a coordinator save without a registry', async () => {
    const root = await directory()
    await writeFile(join(root, 'agents.json'), JSON.stringify({ assignments: [{ threadId: 'session-workshop' }], activeThreadId: 'session-workshop' }))
    const f = adapter(root)
    const snapshot = await f.host.connect()
    expect(snapshot.threads[0]!.id).toMatch(uuid)
    expect(snapshot.threads[0]!.id).not.toBe('session-workshop')
    expect(f.registry.byThread('session-workshop')).toBeUndefined()
    await expect(f.host.execute({ type: 'send', commandId: 'old-send', threadId: 'session-workshop', messageId: 'old-message', text: 'Must not send' })).rejects.toThrow('not known')
    expect(f.inner.commands).toEqual([])
  })

  it('mints UUIDs on a fresh install even though no registry file exists yet', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    expect(snapshot.threads.map(thread => thread.id)).toEqual([expect.stringMatching(uuid), expect.stringMatching(uuid)])
  })

  it('drops provider events that arrive before the registry has loaded', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'threads.json'), JSON.stringify({ bindings: [
      { threadId: 'durable-workshop', provider: 'fake', sessionId: 'session-workshop', projectId: 'project', createdAt: new Date().toISOString() },
    ] }))
    const events: AgentHostSnapshot[] = []
    f.host.subscribe(snapshot => events.push(snapshot))
    f.inner.emit()
    expect(events).toEqual([])
    expect(f.registry.all()).toEqual([])
    const snapshot = await f.host.connect()
    expect(snapshot.threads[0]?.id).toBe('durable-workshop')
    f.inner.emit()
    expect(events[0]?.threads[0]?.id).toBe('durable-workshop')
  })

  it('keeps the first of duplicate rows instead of treating the registry as corrupt', async () => {
    const f = await fixture()
    const createdAt = new Date().toISOString()
    await writeFile(join(f.root, 'threads.json'), JSON.stringify({ bindings: [
      { threadId: 'first', provider: 'fake', sessionId: 'session-workshop', projectId: 'project', createdAt },
      { threadId: 'second', provider: 'fake', sessionId: 'session-workshop', projectId: 'project', createdAt },
      { threadId: 'first', provider: 'fake', sessionId: 'session-docs', projectId: 'project', createdAt },
    ] }))
    const snapshot = await f.host.connect()
    expect(snapshot.threads[0]?.id).toBe('first')
    expect(snapshot.threads[1]?.id).toMatch(uuid)
    expect((await readdir(f.root)).some(name => name.includes('corrupt'))).toBe(false)
  })
})
