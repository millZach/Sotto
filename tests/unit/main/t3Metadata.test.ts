// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { T3CodeHost } from '../../../src/main/agents/t3'
import { agentHostSnapshotSchema } from '../../../src/shared/agents'

const OLD = '2026-09-09T10:00:00.000Z'
const NEW = '2026-09-10T11:00:00.000Z'
const base = {
  id: 'thread', projectId: 'project', title: 'Thread', modelSelection: { instanceId: 'codex', model: 'model' },
  runtimeMode: 'approval-required', interactionMode: 'default', latestTurn: null, session: null,
}
const hosts: T3CodeHost[] = []
afterEach(() => { for (const host of hosts.splice(0)) host.disconnect(); vi.restoreAllMocks(); vi.useRealTimers() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function navigationFixture(delayedId: string, detailFields: Record<string, unknown> = {}) {
  vi.useFakeTimers()
  const host = new T3CodeHost(); hosts.push(host)
  const started = deferred<void>()
  const delayed = deferred<Record<string, unknown>>()
  const message = { id: 'old-message', role: 'assistant', text: 'Old detail', createdAt: OLD }
  const oldDetail = { ...base, updatedAt: OLD, settledAt: null, settledOverride: 'active', messages: [message], ...detailFields }
  let shell = { ...base, updatedAt: OLD } as Record<string, unknown>
  const other = { ...base, id: 'other' }
  const transport = host as unknown as { request(path: string): Promise<unknown>; rpc(tag: string, payload: unknown): Promise<unknown> }
  const request = vi.spyOn(transport, 'request').mockImplementation(async path => {
    if (path === '/api/orchestration/shell') return { snapshotSequence: 1, projects: [], threads: [shell, other] }
    if (path === `/api/orchestration/threads/${delayedId}?turnLimit=5`) {
      started.resolve()
      return { thread: await delayed.promise }
    }
    if (path === '/api/orchestration/threads/thread?turnLimit=1' || path === '/api/orchestration/threads/thread?turnLimit=5') return { thread: oldDetail }
    if (path === '/api/orchestration/threads/other?turnLimit=5') return { thread: other }
    throw new Error(`Unexpected read: ${path}`)
  })
  vi.spyOn(transport, 'rpc').mockResolvedValue({ providers: [] })
  host['connected'] = true
  return { host, started, delayed, oldDetail, other, message, request,
    updateShell: (fields: Record<string, unknown>) => { shell = { ...base, ...fields } },
  }
}

function fixture(shellFields: Record<string, unknown>, detailFields?: Record<string, unknown>) {
  const host = new T3CodeHost(); hosts.push(host)
  let shell = { ...base, ...shellFields }
  let detail = { ...base, ...detailFields }
  const transport = host as unknown as { request(path: string): Promise<unknown>; rpc(tag: string, payload: unknown): Promise<unknown> }
  vi.spyOn(transport, 'request').mockImplementation(async path => {
    if (path === '/api/orchestration/shell') return { snapshotSequence: 1, projects: [], threads: [shell] }
    if (path.startsWith('/api/orchestration/threads/')) return { thread: detail }
    throw new Error(`Unexpected read: ${path}`)
  })
  vi.spyOn(transport, 'rpc').mockResolvedValue({ providers: [] })
  // Exercise public discovery and observed-detail reads with only transport replaced.
  host['connected'] = true
  if (detailFields !== undefined) host.observeThreads(['thread'])
  return {
    host,
    read: async () => agentHostSnapshotSchema.parse(await host.snapshot()).threads[0]!,
    update: (nextShell: Record<string, unknown>, nextDetail: Record<string, unknown>) => {
      shell = { ...base, ...nextShell }; detail = { ...base, ...nextDetail }
    },
  }
}

describe('T3 thread activity and lifecycle metadata', () => {
  it('retains display history after navigation during a delayed read while newer settled shell metadata stays visible', async () => {
    const f = navigationFixture('thread')
    f.host.observeThreads(['thread'])
    const pending = f.host.snapshot()
    await f.started.promise
    f.host.observeThreads(['other'])
    f.delayed.resolve(f.oldDetail)
    const navigated = agentHostSnapshotSchema.parse(await pending).threads[0]!

    const settled = { updatedAt: NEW, settledAt: NEW, settledOverride: 'settled', archivedAt: null }
    f.updateShell(settled)
    const refreshed = agentHostSnapshotSchema.parse(await f.host.snapshot())
    expect(refreshed.threads[0]).toMatchObject({ ...settled, messages: [f.message] })
    expect(navigated.messages).toEqual([f.message])
    expect(f.request.mock.calls.filter(([path]) => path === '/api/orchestration/threads/thread?turnLimit=5')).toHaveLength(1)

    f.host.observeThreads(['thread'])
    expect(agentHostSnapshotSchema.parse(await f.host.snapshot()).threads[0])
      .toMatchObject({ ...settled, messages: [f.message] })
  })

  it.each([
    {
      name: 'newer settled shell', detail: {},
      shell: { updatedAt: NEW, settledAt: NEW, settledOverride: 'settled', archivedAt: NEW },
      expected: { updatedAt: NEW, settledAt: NEW, settledOverride: 'settled', archivedAt: NEW },
    },
    {
      name: 'explicit null clearing in newer shell',
      detail: { settledAt: OLD, settledOverride: 'settled', archivedAt: OLD },
      shell: { updatedAt: NEW, settledAt: null, settledOverride: null, archivedAt: null },
      expected: { updatedAt: NEW, settledAt: null, settledOverride: null, archivedAt: null },
    },
    {
      name: 'newer detail',
      detail: { updatedAt: NEW, settledAt: null, settledOverride: 'active', archivedAt: null },
      shell: { updatedAt: OLD, settledAt: OLD, settledOverride: 'settled', archivedAt: OLD },
      expected: { updatedAt: NEW, settledAt: null, settledOverride: 'active', archivedAt: null },
    },
    {
      name: 'detail wins timestamp ties',
      detail: { archivedAt: null },
      shell: { updatedAt: OLD, settledAt: OLD, settledOverride: 'settled', archivedAt: OLD },
      expected: { updatedAt: OLD, settledAt: null, settledOverride: 'active', archivedAt: null },
    },
    {
      name: 'newer shell omits lifecycle metadata',
      detail: { settledAt: OLD, settledOverride: 'settled', archivedAt: OLD },
      shell: { updatedAt: NEW },
      expected: { updatedAt: NEW, settledAt: OLD, settledOverride: 'settled', archivedAt: OLD },
    },
  ])('merges retained guarded-send detail against the fresh shell before normalization: $name', async ({ detail, shell, expected }) => {
    const f = navigationFixture('other', detail)
    await f.host.snapshot()
    f.updateShell(shell)
    f.host.observeThreads(['other'])
    const pending = f.host.snapshot()
    await f.started.promise

    // The guard retains A's detail while the snapshot is still reading B. A was
    // not observed when that snapshot chose which threads to hydrate.
    const changed = vi.fn()
    f.host.subscribe(changed)
    await expect(f.host.execute({ type: 'send', commandId: 'command', messageId: 'message', threadId: 'thread',
      text: 'Synthetic never dispatched', expectedLastUserMessageId: 'previous' })).rejects.toThrow('The thread changed')
    expect(changed).toHaveBeenCalled()
    f.delayed.resolve(f.other)
    expect(agentHostSnapshotSchema.parse(await pending).threads[0])
      .toMatchObject({ ...expected, messages: [f.message] })
    expect(f.request.mock.calls.some(([path]) => path === '/api/orchestration/dispatch')).toBe(false)
  })

  it('carries shell metadata through both adapter and shared snapshot parsing', async () => {
    const metadata = { updatedAt: OLD, settledAt: OLD, settledOverride: 'settled', archivedAt: NEW }
    expect(await fixture(metadata).read()).toMatchObject(metadata)
  })

  it('accepts unknown activity without inventing a timestamp', async () => {
    const thread = await fixture({}).read()
    expect(thread).not.toHaveProperty('updatedAt')
    expect(thread.messages).toEqual([])
  })

  it('keeps shell metadata when selected detail omits it, while hydrating messages', async () => {
    const metadata = { updatedAt: NEW, settledAt: NEW, settledOverride: 'settled', archivedAt: null }
    const message = { id: 'message', role: 'assistant', text: 'Completed earlier', createdAt: OLD }
    expect(await fixture(metadata, { updatedAt: OLD, messages: [message] }).read())
      .toMatchObject({ ...metadata, messages: [message] })
  })

  it('retains metadata supplied only by detail', async () => {
    const metadata = { settledAt: OLD, settledOverride: 'settled', archivedAt: OLD }
    expect(await fixture({ updatedAt: OLD }, { updatedAt: OLD, ...metadata }).read()).toMatchObject(metadata)
  })

  it('honors newer detail and explicit null reopening, then newer shell over stale detail', async () => {
    const closed = { updatedAt: OLD, settledAt: OLD, settledOverride: 'settled', archivedAt: OLD }
    const reopened = { updatedAt: NEW, settledAt: null, settledOverride: 'active', archivedAt: null }
    const f = fixture(closed, reopened)
    expect(await f.read()).toMatchObject(reopened)
    f.update(reopened, closed)
    expect(await f.read()).toMatchObject(reopened)
  })

  it.each([true, false])('retains lifecycle metadata when a guarded send publishes refreshed detail after a takeover (observed: %s)', async observed => {
    const metadata = { updatedAt: NEW, settledAt: NEW, settledOverride: 'settled', archivedAt: null }
    const f = fixture(metadata, observed ? { updatedAt: OLD, messages: [] } : undefined)
    await f.read()
    const changed = vi.fn()
    f.host.subscribe(changed)
    await expect(f.host.execute({ type: 'send', commandId: 'command', messageId: 'message', threadId: 'thread',
      text: 'Synthetic never dispatched', expectedLastUserMessageId: 'previous' })).rejects.toThrow('The thread changed')
    expect(changed).toHaveBeenCalledOnce()
    expect(agentHostSnapshotSchema.parse(changed.mock.calls[0]![0]).threads[0]).toMatchObject(metadata)
  })
})
