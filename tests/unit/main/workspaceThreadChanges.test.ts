// @vitest-environment node
/**
 * The workspace's side of thread changes (ADR-0016, #925, step 4). It takes in its inner host's thread changes and merges
 * only the threads they name, with the threads its own commands changed, and publishes thread changes of its own beside
 * its activity snapshots. These hold it to the host-level contract `hostThreadChanges.test.ts` holds the wrapper and the
 * provider switch to: a subscriber's thread map stays equal to the workspace's activity publication from the same publish
 * after every change, whatever changed it. They also hold the whole path to the old one: a workspace that takes every
 * publication in whole and works out every publication from every thread, as before, says byte for byte what the one
 * that takes in changes says, across a long run of mixed operations.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import type { AgentHost } from '../../../src/main/agents/host'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { ThreadChangesDrift, ThreadMap, type AgentHostChanges } from '../../../src/main/agents/threadChanges'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { StreamingAdapter } from '../../fixtures/streamingAdapter'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })

const AT = '2026-10-25T12:00:00.000Z'
const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: `Thread ${id}`, modelId: 'fake:model',
  status: 'idle', messages: [], requests: [], ...fields })
const record = (id: string, sequence: number, status: AgentActivity['status'] = 'completed'): AgentActivity =>
  ({ id, turnId: 'turn', sequence, kind: 'tool', status, title: 'Tool', output: `Output ${id}` })

function providerState(root: string, sessions: readonly string[]): AgentHostSnapshot {
  return { ...structuredClone(EMPTY_AGENT_HOST), name: 'Synthetic', version: '1', connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true, observe: true },
    projects: [{ id: 'project', title: 'Synthetic project', path: join(root, 'project') }],
    models: [{ id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: true }],
    threads: sessions.map(id => thread(id)) }
}

/** What a workspace's thread changes subscriber sees: its map, checked against the activity publication of the same publish. */
function watch(workspace: WorkspaceHost) {
  let latest: AgentHostSnapshot | undefined
  const offSnapshots = workspace.subscribeActivitySnapshots(snapshot => { latest = snapshot })
  const map = new ThreadMap({ wholeOf: () => latest!, verify: true })
  const received: AgentHostChanges[] = []
  const drift: string[] = []
  const subscription = workspace.subscribeActivityChanges(changes => {
    received.push(changes)
    try { if (map.apply(changes) === 'resync') subscription.resync() }
    catch (error) { drift.push(error instanceof Error ? error.message : String(error)) }
  })
  cleanup.push(() => {
    subscription(); offSnapshots()
    expect(drift, 'A thread map fed the workspace\'s thread changes came to differ from its activity publication.').toEqual([])
  })
  return { map, received, drift, latest: () => latest!, last: () => received.at(-1)!,
    /** The publications since `from`, every thread they upserted, and every thread they removed. */
    since(from: number) {
      const changes = received.slice(from)
      return { changes, upserted: [...new Set(changes.flatMap(item => item.upserts.map(each => each.id)))], removed: [...new Set(changes.flatMap(item => item.removals))] }
    } }
}

const quiet = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))

/** The adapter, the identity wrapper and the provider switch as main wires them, with one workspace or more over the switch. */
async function stack(sessions: readonly string[] = ['s1', 's2', 's3'], workspaces = 1) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-workspace-changes-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
  await mkdir(join(root, 'project'), { recursive: true })
  const registry = new ThreadRegistry(join(root, 'registry'))
  await registry.load()
  cleanup.push(async () => { await registry.flush().catch(() => undefined) })
  const adapter = new StreamingAdapter(providerState(root, sessions))
  const native = new ConfiguredProviderHost({ directory: join(root, 'switch'), provider: () => 'claude', enabledProviders: () => ['claude'], threadProvider: id => registry.byThread(id)?.provider,
    hosts: { claude: new SottoThreadHost('claude', adapter, registry), codex: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(),
      muse: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), opencode: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), cursor: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) } })
  const hosts: WorkspaceHost[] = []
  for (let index = 0; index < workspaces; index++) {
    const directory = join(root, `workspace-${index}`)
    await mkdir(directory, { recursive: true })
    // No worktree re-read lands mid-test: when one does is each workspace's own timing, which two workspaces need not share.
    const host = new WorkspaceHost(native, directory, () => true, 600_000)
    cleanup.push(async () => { host.disconnect(); await host.privacyChanged().catch(() => undefined); host.dispose() })
    await host.initialize()
    hosts.push(host)
  }
  const workspace = hosts[0]!
  const sotto = (session: string): string => registry.bySession('claude', session)!.threadId
  /** Changes a provider thread, marks it as the adapter's own paths do, and publishes it. */
  const change = async (session: string, edit: (thread: AgentThread) => void): Promise<void> => {
    edit(adapter.state.threads.find(item => item.id === session)!)
    adapter.mark(session)
    adapter.publish(false)
    await quiet()
  }
  return { root, registry, adapter, native, workspace, hosts, sotto, change }
}

describe('the workspace\'s thread changes', () => {
  it('takes in a provider\'s change to one thread, and publishes that thread alone', async () => {
    const { workspace, sotto, change } = await stack()
    const seen = watch(workspace)
    await workspace.connect()
    await change('s1', item => { item.status = 'running' })
    expect(seen.received[0]).toMatchObject({ sequence: 1, whole: true })
    const from = seen.received.length
    await change('s2', item => { item.status = 'running' })
    const { upserted, removed } = seen.since(from)
    expect(upserted).toEqual([sotto('s2')])
    expect(removed).toEqual([])
    expect(seen.map.get(sotto('s2'))!.status).toBe('running')
    // An unchanged thread is handed out as the same frozen record its last publication carried.
    expect(seen.latest().threads.find(item => item.id === sotto('s3'))).toBe(seen.map.get(sotto('s3')))
    expect(Object.isFrozen(seen.map.get(sotto('s2')))).toBe(true)
  })

  it('publishes a thread whose own workspace state changed, and only that thread', async () => {
    const { workspace, sotto, change } = await stack()
    const seen = watch(workspace)
    await workspace.connect()
    await change('s1', item => { item.status = 'idle' })
    let from = seen.received.length
    await workspace.renameThread(sotto('s3'), 'Renamed by hand')
    expect(seen.since(from).upserted).toEqual([sotto('s3')])
    expect(seen.map.get(sotto('s3'))!.title).toBe('Renamed by hand')
    // The provider's own title no longer reaches it: a later change to that thread keeps the name.
    from = seen.received.length
    await change('s3', item => { item.title = 'Provider title'; item.status = 'running' })
    expect(seen.since(from).upserted).toEqual([sotto('s3')])
    expect(seen.map.get(sotto('s3'))).toMatchObject({ title: 'Renamed by hand', status: 'running' })
    from = seen.received.length
    await workspace.setWorkspaceSettled('thread', sotto('s2'), true)
    expect(seen.since(from).upserted).toEqual([sotto('s2')])
    expect(seen.map.get(sotto('s2'))!.workspaceSettledAt).toEqual(expect.any(String))
    from = seen.received.length
    await workspace.setDelegatedBy(sotto('s1'), sotto('s3'))
    expect(seen.since(from).upserted).toEqual([sotto('s1')])
    expect(seen.map.get(sotto('s1'))!.delegatedBy).toBe(sotto('s3'))
  })

  it('keeps a thread its provider no longer publishes, without its live state, as every accept kept one', async () => {
    const { adapter, workspace, sotto, change } = await stack()
    const seen = watch(workspace)
    await workspace.connect()
    await change('s2', item => { item.providerSessionOpen = true })
    expect(seen.map.get(sotto('s2'))!.providerSessionOpen).toBe(true)
    const gone = sotto('s2')
    adapter.state.threads.splice(adapter.state.threads.findIndex(item => item.id === 's2'), 1)
    adapter.mark('s2')
    adapter.publish(false)
    await quiet()
    expect(seen.map.has(gone)).toBe(true)
    expect(seen.map.get(gone)!.providerSessionOpen).toBeUndefined()
    expect(workspace.workspaceSnapshot().threads.map(item => item.id)).toEqual([...seen.map.ids()])
  })

  it('removes a thread the workspace lets go, and brings it back when its provider still publishes it, as an accept did', async () => {
    const { workspace, sotto, change } = await stack()
    const seen = watch(workspace)
    await workspace.connect()
    await change('s1', item => { item.status = 'running' })
    const internals = workspace as unknown as { removeThread(id: string): void; publish(): void }
    let from = seen.received.length
    internals.removeThread(sotto('s2'))
    internals.publish()
    expect(seen.since(from).removed).toEqual([sotto('s2')])
    expect(seen.map.has(sotto('s2'))).toBe(false)
    // The next publication takes it in again, last, as a thread new to the workspace.
    from = seen.received.length
    await change('s1', item => { item.status = 'idle' })
    expect(seen.since(from).upserted.sort()).toEqual([sotto('s1'), sotto('s2')].sort())
    expect([...seen.map.ids()].at(-1)).toBe(sotto('s2'))
  })

  it('starts a subscriber with a whole publication, and answers a resync with one', async () => {
    const { workspace, change } = await stack()
    await workspace.connect()
    await change('s1', item => { item.status = 'running' })
    const seen = watch(workspace)
    await change('s2', item => { item.status = 'running' })
    expect(seen.received[0]).toMatchObject({ whole: true })
    expect(seen.map.size).toBe(3)
    const subscription = workspace.subscribeActivityChanges(changes => { late.push(changes) })
    const late: AgentHostChanges[] = []
    cleanup.push(() => { subscription() })
    await change('s3', item => { item.status = 'running' })
    expect(late[0]).toMatchObject({ whole: true })
    subscription.resync()
    await quiet()
    expect(late.at(-1)).toMatchObject({ whole: true, sequence: late.at(-2)!.sequence })
  })

  it('carries a disconnection as the rest, keeping every thread without its live state', async () => {
    const { workspace, sotto, change } = await stack()
    const seen = watch(workspace)
    await workspace.connect()
    await change('s1', item => { item.providerSessionOpen = true; item.status = 'running' })
    const from = seen.received.length
    workspace.disconnect('claude')
    await quiet()
    const { changes } = seen.since(from)
    expect(changes.some(item => item.rest?.providers?.find(provider => provider.id === 'claude')?.connection === 'disconnected')).toBe(true)
    expect(seen.map.size).toBe(3)
    expect(seen.map.get(sotto('s1'))!.providerSessionOpen).toBeUndefined()
    // Connected again, the provider's threads come back to life through the same map.
    await workspace.connect()
    await change('s1', item => { item.providerSessionOpen = true })
    expect(seen.map.get(sotto('s1'))!.providerSessionOpen).toBe(true)
  })

  it('publishes a thread a command creates and configures before its provider has it', async () => {
    const { workspace, change } = await stack()
    const seen = watch(workspace)
    await workspace.connect()
    await change('s1', item => { item.status = 'running' })
    let from = seen.received.length
    const modelId = workspace.workspaceSnapshot().models.find(model => model.ready)!.id
    const projectId = workspace.workspaceSnapshot().projects[0]!.id
    await workspace.execute({ type: 'create-thread', commandId: 'create-new', threadId: 'new-thread', projectId, title: 'New thread', modelId, workingCopy: 'shared' })
    expect(seen.since(from).upserted).toEqual(['new-thread'])
    expect([...seen.map.ids()].at(-1)).toBe('new-thread')
    expect(seen.map.get('new-thread')).toMatchObject({ nativeSessionStarted: false, title: 'New thread' })
    // The next accept takes the live state off it, as every accept took it off a thread its provider does not publish,
    // and from then on a change elsewhere leaves it alone.
    await change('s2', item => { item.status = 'running' })
    from = seen.received.length
    await change('s3', item => { item.status = 'running' })
    expect(seen.since(from).upserted).toEqual([expect.any(String)])
    expect(seen.since(from).upserted).not.toContain('new-thread')
    from = seen.received.length
    await workspace.renameThread('new-thread', 'Named draft')
    expect(seen.since(from).upserted).toEqual(['new-thread'])
  })

  it('publishes a thread whose activity is let go to the store, and again when a window brings it back', async () => {
    const { adapter, workspace, sotto, change } = await stack()
    const seen = watch(workspace)
    await workspace.connect()
    await change('s1', item => { item.activities = [record('a', 0), record('b', 1)] })
    expect(seen.map.get(sotto('s1'))!.activities?.map(item => item.id)).toEqual(['a', 'b'])
    // A window says it shows another thread: the first is let go after the save that puts its list in the store.
    let from = seen.received.length
    workspace.observeThreads([sotto('s2')])
    await workspace.flush()
    await quiet()
    expect(seen.since(from).upserted).toContain(sotto('s1'))
    expect(seen.map.get(sotto('s1'))!.activities).toBeUndefined()
    // Its provider publishing the same list again reads nothing back, and publishes nothing new for it.
    from = seen.received.length
    adapter.mark('s1'); adapter.publish(false); await quiet()
    expect(seen.map.get(sotto('s1'))!.activities).toBeUndefined()
    // A window looks at it again: its records come back from the store, and so does the publication.
    from = seen.received.length
    workspace.observeThreads([sotto('s1'), sotto('s2')])
    await quiet()
    expect(seen.since(from).upserted).toContain(sotto('s1'))
    expect(seen.map.get(sotto('s1'))!.activities?.map(item => item.id)).toEqual(['a', 'b'])
  })

  it('keeps a stored thread stored when its provider brings nothing new, and reads it back for a new record', async () => {
    const { adapter, workspace, sotto, change } = await stack()
    const seen = watch(workspace)
    await workspace.connect()
    await change('s1', item => { item.activities = [record('a', 0)] })
    workspace.observeThreads([sotto('s2')])
    await workspace.flush()
    await quiet()
    expect(seen.map.get(sotto('s1'))!.activities).toBeUndefined()
    const from = seen.received.length
    await change('s1', item => { item.activities = [...adapter.state.threads.find(each => each.id === 's1')!.activities!, record('c', 1)] })
    expect(seen.since(from).upserted).toContain(sotto('s1'))
    expect(seen.map.get(sotto('s1'))!.activities?.map(item => item.id)).toEqual(['a', 'c'])
  })

  it('checks its publication against one worked out from every thread when verifying, and finds a change nobody marked', async () => {
    vi.stubEnv('SOTTO_VERIFY_THREAD_CHANGES', '1')
    cleanup.push(() => { vi.unstubAllEnvs() })
    const { workspace, sotto, change } = await stack()
    const seen = watch(workspace)
    await workspace.connect()
    await change('s1', item => { item.status = 'running' })
    await workspace.renameThread(sotto('s2'), 'Marked')
    expect(seen.map.get(sotto('s2'))!.title).toBe('Marked')
    // Written into the state the way no workspace path may: without marking the thread.
    const internals = workspace as unknown as { state: { snapshot: AgentHostSnapshot }; publish(): void }
    internals.state.snapshot.threads.find(item => item.id === sotto('s3'))!.title = 'Not marked'
    expect(() => internals.publish()).toThrow(ThreadChangesDrift)
  })
})

describe('the workspace taking in changes and taking in everything', () => {
  /**
   * Two workspaces over one provider switch, which publishes the same changes to both: the first takes them in as changes,
   * the second as whole snapshots and works out every publication from every thread, as every workspace did before. After
   * each operation, what each says (its snapshot, its activity publication and its ordinary subscription's) is the same
   * byte for byte, but for the host ID each one keeps.
   */
  it('says the same as the whole path across a long run of mixed operations', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const sessions = ['s1', 's2', 's3', 's4', 's5', 's6']
    const { adapter, hosts: [changed, whole], sotto } = await stack(sessions, 2)
    ;(whole as unknown as { acceptsWhole: boolean }).acceptsWhole = true
    const publications = new Map<WorkspaceHost, AgentHostSnapshot>(), ordinary = new Map<WorkspaceHost, AgentHostSnapshot>()
    for (const host of [changed, whole]) {
      host.subscribeActivitySnapshots(snapshot => { publications.set(host, snapshot) })
      host.subscribe(snapshot => { ordinary.set(host, snapshot) })
    }
    const seen = watch(changed!)
    // Both paths run: the changes path takes most publications in as changes, the other takes every one in whole.
    const taken = vi.spyOn(changed as unknown as { acceptThreads(changes: AgentHostChanges): unknown }, 'acceptThreads')
    const takenWhole = vi.spyOn(whole as unknown as { acceptThreads(changes: AgentHostChanges): unknown }, 'acceptThreads')
    const both = async (work: (host: WorkspaceHost) => unknown): Promise<void> => { for (const host of [changed!, whole!]) await work(host); await quiet() }
    const text = (host: WorkspaceHost, value: unknown): string => {
      const hostId = host.workspaceSnapshot().hostId!
      return JSON.stringify(value).split(hostId).join('HOST')
    }
    let compared = 0
    const same = (step: string): void => {
      compared++
      expect(text(changed!, changed!.workspaceSnapshot()), `the workspace snapshot after ${step}`).toBe(text(whole!, whole!.workspaceSnapshot()))
      expect(text(changed!, publications.get(changed!)), `the activity publication after ${step}`).toBe(text(whole!, publications.get(whole!)))
      expect(text(changed!, ordinary.get(changed!)), `the ordinary publication after ${step}`).toBe(text(whole!, ordinary.get(whole!)))
    }
    const at = (session: string) => adapter.state.threads.find(item => item.id === session)!
    const publish = async (...marked: string[]): Promise<void> => { for (const session of marked) adapter.mark(session); adapter.publish(false); await quiet() }
    await both(host => host.connect())
    await publish('s1')
    same('connecting')
    // A seeded run of what providers and the user do, mixed.
    let seed = 925
    const next = (below: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % below }
    let made = 0
    for (let round = 0; round < 60; round++) {
      const session = sessions[next(sessions.length)]!
      const pick = next(14)
      if (pick === 0) { at(session).status = at(session).status === 'running' ? 'idle' : 'running'; await publish(session); same(`turning ${session} ${at(session).status}`) }
      else if (pick === 1) { adapter.log.add(session, { id: `m-${round}`, role: round % 2 ? 'assistant' : 'user', text: `Message ${round}`, createdAt: AT }); await publish(); same(`a message in ${session}`) }
      else if (pick === 2) { const list = at(session).activities ?? []; at(session).activities = [...list, record(`r-${round}`, list.length, round % 3 ? 'completed' : 'running')]; await publish(session); same(`a record in ${session}`) }
      else if (pick === 3) { at(session).title = `Provider ${round}`; await publish(session); same(`the provider renaming ${session}`) }
      else if (pick === 4) { await both(host => host.renameThread(sotto(session), `User ${round}`)); same(`the user renaming ${session}`) }
      else if (pick === 5) { const settled = round % 2 === 0; await both(host => host.setWorkspaceSettled('thread', sotto(session), settled)); same(`settling ${session}`) }
      else if (pick === 6) { at(session).providerSessionOpen = !at(session).providerSessionOpen; await publish(session); same(`opening ${session}'s session`) }
      else if (pick === 7) { const shown = sessions.filter(() => next(2) === 0).map(sotto); await both(host => host.observeThreads(shown)); same('a window showing other threads') }
      else if (pick === 8) { await both(host => host.flush()); same('a save') }
      else if (pick === 9 && adapter.state.threads.length > 3) {
        const gone = adapter.state.threads.find(item => item.id === session)
        if (gone) { adapter.state.threads.splice(adapter.state.threads.indexOf(gone), 1); await publish(session); same(`the provider dropping ${session}`) }
      } else if (pick === 10) {
        const id = `n${made++}`
        adapter.state.threads.push(thread(id))
        sessions.push(id)
        await publish(id)
        same(`the provider starting ${id}`)
      } else if (pick === 11) { at(session).requests = at(session).requests.length ? [] : [{ id: `q-${round}`, kind: 'question', text: 'Which?', options: [] } as unknown as AgentThread['requests'][number]]; await publish(session); same(`a question in ${session}`) }
      else if (pick === 12) { at(session).archivedAt = at(session).archivedAt ? undefined : AT; await publish(session); same(`archiving ${session}`) }
      else { await both(host => host.setDelegatedBy(sotto(session), sotto('s1')).catch(() => undefined)); same(`delegating ${session}`) }
    }
    expect(compared).toBeGreaterThan(40)
    expect(taken.mock.calls.length).toBeGreaterThan(20)
    expect(takenWhole).not.toHaveBeenCalled()
    expect(seen.received.length).toBeGreaterThan(40)
    expect(seen.drift).toEqual([])
  })

  it('says the same as the whole path for a host that publishes only snapshots, through the shim', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
    const root = await mkdtemp(join(tmpdir(), 'sotto-workspace-shim-'))
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
    const provider = new FakeProviderHost()
    const hosts: WorkspaceHost[] = []
    for (const name of ['changed', 'whole']) {
      const directory = join(root, name)
      await mkdir(directory, { recursive: true })
      const host = new WorkspaceHost(provider as AgentHost, directory)
      cleanup.push(async () => { host.dispose() })
      await host.initialize()
      hosts.push(host)
    }
    const [changed, whole] = hosts as [WorkspaceHost, WorkspaceHost]
    ;(whole as unknown as { acceptsWhole: boolean }).acceptsWhole = true
    const seen = watch(changed)
    const publications = new Map<WorkspaceHost, AgentHostSnapshot>()
    for (const host of hosts) host.subscribeActivitySnapshots(snapshot => { publications.set(host, snapshot) })
    const text = (host: WorkspaceHost, value: unknown): string => JSON.stringify(value).split(host.workspaceSnapshot().hostId!).join('HOST')
    const same = (step: string): void => {
      expect(text(changed, changed.workspaceSnapshot()), step).toBe(text(whole, whole.workspaceSnapshot()))
      expect(text(changed, publications.get(changed)), step).toBe(text(whole, publications.get(whole)))
    }
    for (const host of hosts) await host.connect()
    const emit = async (): Promise<void> => { provider.emit(); await quiet() }
    await emit(); same('connecting')
    provider.state.threads[0]!.status = 'running'; await emit(); same('a thread running')
    provider.state.threads[0]!.messages.push({ id: 'm1', role: 'user', text: 'Hello', createdAt: AT }); await emit(); same('a message')
    for (const host of hosts) await host.renameThread('session-docs', 'Docs by hand'); await quiet(); same('a rename')
    provider.state.threads.push(thread('session-new')); await emit(); same('a new thread')
    provider.state.threads.splice(1, 1); await emit(); same('a thread gone')
    provider.state.threads[0]!.status = 'idle'; await emit(); same('a thread idle')
    expect(seen.drift).toEqual([])
  })
})
