// @vitest-environment node
/**
 * The count guard for delegation's observation pass (ADR-0081, #1029), beside `watcherObserveCounts.test.ts`. Main runs
 * the pass on every snapshot it accepts, every streamed chunk included, so it may not grow with the number of delegated
 * threads or delegations: it reads the snapshot's thread list once and asks the coordinator for nothing else per thread
 * it does not need, whatever the size. The window's cards (#1029) add one batched word per pass that delegations changed,
 * however many delegating threads it names, and their read takes no snapshot at all.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DelegationService, type DelegationControlHooks, type DelegationCoordinator } from '../../../src/main/agents/delegation'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-delegation-counts-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Counts per pass for `size` delegated threads, each with one accepted brief whose turn has finished, and as many still
 * working, shared out among `parents` delegating threads.
 */
async function counts(size: number, parents = 1) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-delegation-counts-')); roots.push(root)
  const at = '2026-10-15T00:00:00.000Z'
  const parentIds = Array.from({ length: parents }, (_, index) => index ? `parent-${index}` : 'parent')
  const threads: AgentThread[] = parentIds.map(id => ({ id, projectId: 'project', providerId: 'claude', title: 'Parent', modelId: 'model', status: 'running', messages: [], requests: [] }))
  const delegations = [], links = []
  for (let index = 0; index < size * 2; index++) {
    const parent = parentIds[Math.floor(index / 2) % parents]!
    const threadId = `delegated-${index}`, messageId = randomUUID(), finished = index % 2 === 0
    threads.push({ id: threadId, projectId: 'project', providerId: 'codex', title: 'Delegated', modelId: 'model', delegatedBy: parent,
      status: finished ? 'idle' : 'running', lastUserMessageId: messageId, requests: [],
      lastTurn: { id: messageId, status: finished ? 'completed' : 'running' },
      messages: [{ id: messageId, role: 'user', text: 'Synthetic brief', createdAt: at },
        ...finished ? [{ id: randomUUID(), role: 'assistant' as const, text: 'Synthetic reply', createdAt: at }] : []] })
    delegations.push({ id: randomUUID(), delegatingThreadId: parent, delegatedThreadId: threadId, action: 'start', work: 'code-review', rootUserMessageId: 'root',
      inputDigest: 'a'.repeat(64), draftId: randomUUID(), messageId, expectedLastUserMessageId: null, deliveryState: 'accepted', outcome: 'working', told: 'working',
      charged: true, createdAt: at, updatedAt: at })
    links.push({ threadId, delegatingThreadId: parent, createdAt: at, seenHead: messageId })
  }
  await writeFile(join(root, 'delegations.json'), JSON.stringify({ version: 1, delegations, links, roots: [] }))
  const tally = { threadLists: 0, snapshots: 0, pendingWork: 0, wakeUps: 0, items: 0, changes: 0, changed: 0 }
  let measuring = false
  const base: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, threads }
  // The snapshot as main hands it to the pass, its thread list counted each time it is read.
  const snapshot = new Proxy(base, { get: (target, property, receiver) => {
    if (property === 'threads' && measuring) tally.threadLists++
    return Reflect.get(target, property, receiver) as unknown
  } })
  let hooks: DelegationControlHooks | undefined
  const control: DelegationCoordinator = {
    hostId: () => 'host', watcherSnapshot: () => { if (measuring) tally.snapshots++; return snapshot }, configuration: () => ({}),
    useDelegation: given => { hooks = given; return () => { hooks = undefined } },
    commandFromDelegation: async () => { throw new Error('This pass sends nothing.') },
    hasPendingThreadWork: () => { if (measuring) tally.pendingWork++; return false }, hasUserDraft: () => false,
    refreshDelegationObservation: () => undefined,
    deliverWakeUp: async (_threadId, news) => { if (measuring) { tally.wakeUps++; tally.items += news.items.length } },
  }
  const live = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined },
    historyEnabled: () => true })
  await live.recover()
  // Recovery tells each delegating thread once that what was open is now unknown; that news has gone before the measure.
  const quiet = live as unknown as { untold: Map<string, unknown>; telling: Set<string> }
  await vi.waitFor(() => expect(quiet.untold.size + quiet.telling.size).toBe(0))
  // The window listens for changed delegations, as main's IPC does while delegation is on.
  live.onViewsChanged(threadIds => { if (measuring) { tally.changes++; tally.changed += threadIds.length } })
  // Recovery leaves every brief from before a restart unknown; these are this run's, open for the pass to follow.
  ;(live as unknown as { records: unknown[] }).records = structuredClone(delegations)
  const measure = async (read: () => void) => {
    for (const name of Object.keys(tally) as (keyof typeof tally)[]) tally[name] = 0
    measuring = true
    // The news a pass finds goes once the pass is over, so the measure runs until it has gone.
    try { read(); await new Promise(resolve => setTimeout(resolve, 0)) } finally { measuring = false }
    return { ...tally }
  }
  const observe = await measure(() => hooks!.observe(snapshot))
  // The pass did reach the finished turns: each finished brief now reads answered.
  const answered = (live as unknown as { records: { outcome?: string }[] }).records.filter(record => record.outcome === 'answered').length
  expect(answered).toBe(size)
  const observed = await measure(() => { expect(hooks!.observedThreadIds()).toHaveLength(size) })
  // The window reading every delegating thread's cards reads its own record, never the snapshot.
  const views = await measure(() => { for (const parent of parentIds) expect(live.views(parent).made).toHaveLength(size * 2 / parents) })
  live.close()
  return { observe, observed, views }
}

it('reads the snapshot\'s threads once per pass and asks nothing per delegated thread, whatever the size', async () => {
  const small = await counts(2), large = await counts(24)
  // The pass reads the thread list once; the news it found goes as one wake-up to the delegating thread, which reads the
  // snapshot once more to see the thread is still there, however many delegations it names.
  expect({ ...large.observe, items: 0, changed: 0 }).toEqual({ ...small.observe, items: 0, changed: 0 })
  // The window hears once, naming the delegating thread and each delegated thread whose record moved: on this first pass
  // every one, answered or its turn first seen.
  expect(small.observe).toEqual({ threadLists: 2, snapshots: 1, pendingWork: 0, wakeUps: 1, items: 2, changes: 1, changed: 1 + 4 })
  expect(large.observe.changed).toBe(1 + 48)
  expect(large.observe.items).toBe(24)
  expect(small.observed).toEqual({ threadLists: 0, snapshots: 0, pendingWork: 0, wakeUps: 0, items: 0, changes: 0, changed: 0 })
}, 60_000)

it('tells the window once per pass however many delegating threads changed, and its read takes no snapshot', async () => {
  const few = await counts(4, 2), many = await counts(48, 24)
  // One word to the window per pass, naming each delegating thread whose cards moved and each delegated thread whose
  // brief did; the snapshot is read as often for 24 delegating threads as for 2. Each delegating thread hears its news
  // as its own wake-up, as before.
  expect(few.observe).toMatchObject({ threadLists: 2, snapshots: 1, pendingWork: 0, changes: 1, changed: 2 + 8, wakeUps: 2 })
  expect(many.observe).toMatchObject({ threadLists: 2, snapshots: 1, pendingWork: 0, changes: 1, changed: 24 + 96, wakeUps: 24 })
  for (const read of [few.views, many.views]) expect(read).toEqual({ threadLists: 0, snapshots: 0, pendingWork: 0, wakeUps: 0, items: 0, changes: 0, changed: 0 })
}, 60_000)
