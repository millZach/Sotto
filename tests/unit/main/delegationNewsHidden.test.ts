// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentDelivery, AgentHostSnapshot, AgentThread } from '../../../src/shared/agents'
import type { DelegationNews } from '../../../src/shared/delegation'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

/**
 * A delegation's news in the thread that delegated (ADR-0081, October 19, 2026): handed to its agent as its next turn,
 * privately. No queue panel, transcript, row or phone shows it, and only that thread's own running turn holds it: never
 * a machine Stop, the user's paused queue, or a set-aside prompt. A ready prompt of the user's still goes first.
 */
const roots: string[] = []; const controls: AgentControl[] = []
afterEach(async () => {
  for (const c of controls.splice(0)) { c.dispose(); await c.privacyChanged() }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-delegation-hidden-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
})
/** A provider that echoes each send, and marks a wake-up as the workspace does from its own record of the send. */
class Host implements AgentHost {
  state!: AgentHostSnapshot
  listeners = new Set<(s: AgentHostSnapshot) => void>()
  attempts: AgentHostCommand[] = []
  /** The next send fails surely, or comes back unconfirmed. */
  failNext = false; uncertainNext = false
  /** A thread read before a send never answers while set, as when Sotto stops mid-read. */
  stallReads = false
  /** The thread's preparation before the native writer, held while set. */
  preparation: Promise<void> | undefined
  async connect() { this.state ??= await new E2EAgentHost().connect(); this.state.connected = true; return this.snapshot() }
  async snapshot() { return structuredClone(this.state) }
  refreshThread(): Promise<AgentHostSnapshot> { return this.stallReads ? new Promise(() => undefined) : this.snapshot() }
  preparing = 0
  async executeFromWatcher(c: AgentHostCommand, guard: () => void): Promise<AgentHostResult> {
    this.preparing++
    await this.preparation
    guard()
    return await this.execute(c)
  }
  subscribe(fn: (s: AgentHostSnapshot) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  disconnect() { this.state.connected = false }
  observeThreads() { /* Every thread is in the snapshot. */ }
  update(id: string, patch: Partial<AgentThread>) { Object.assign(this.state.threads.find(t => t.id === id)!, patch); this.emit() }
  emit() { for (const fn of this.listeners) fn(structuredClone(this.state)) }
  async execute(c: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(c)
    if (c.type === 'send' && this.failNext) { this.failNext = false; throw new Error('Synthetic provider refusal.') }
    if (c.type === 'send' && this.uncertainNext) { this.uncertainNext = false; return { accepted: false, uncertain: true } }
    if (c.type === 'send') {
      const thread = this.state.threads.find(t => t.id === c.threadId)!
      if (c.wakeUp) thread.wakeUpMessageIds = [...thread.wakeUpMessageIds ?? [], c.messageId]
      if (c.hiddenWakeUp) thread.hiddenWakeUpMessageIds = [...thread.hiddenWakeUpMessageIds ?? [], c.messageId]
      thread.messages.push({ id: c.messageId, commandId: c.commandId, role: 'user', text: c.text, createdAt: new Date().toISOString(),
        ...(c.wakeUp ? { wakeUp: true as const } : {}), ...(c.hiddenWakeUp ? { hiddenWakeUp: true as const } : {}) })
      thread.status = 'running'; thread.lastTurn = { id: c.commandId, status: 'running' }; this.emit()
    }
    return { accepted: true }
  }
}
/** A coordinator over `root`, as Sotto starts one: it reads what the last one saved, its queue among it. */
async function boot(root: string, host: Host, credentials: Awaited<ReturnType<typeof testCredentials>>, running = true) {
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner }); controls.push(control)
  await control.start(); await control.command({ type: 'connect' })
  if (running) host.update('workshop', { status: 'running', lastTurn: { id: 'turn', status: 'running' } })
  let fenced = false
  control.useWatcher({ userCommand: () => undefined, beforeDispatch: command => command, observe: () => undefined,
    guardOperation: () => undefined, preserveUserQueue: () => fenced })
  // Delegation words the news as it goes, from its own record: here, a line that says so.
  control.useDelegation({ userCommand: () => undefined, observe: () => undefined, observedThreadIds: () => [], messageIdFor: () => undefined,
    guardFor: () => undefined, newsText: (_threadId, news) => `Synthetic news as sent: ${news.flatMap(part => part.items.map(item => item.outcome)).join(', ')}` })
  return { root, host, credentials, control, fence: (on: boolean) => { fenced = on } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-delegation-hidden-')); roots.push(root)
  return await boot(root, new Host(), await testCredentials(root, { mode: 'unavailable' }))
}
const delegation = (): DelegationNews => ({ source: 'delegation', items: [{ delegationId: randomUUID(), threadId: 'delegated', outcome: 'answered' }] })
const pullRequest = (number: number): BabysitNews => ({ pullRequest: { url: `https://github.com/o/r/pull/${number}`, number, title: `Pull ${number}` },
  startedBy: 'agent', head: 'head-1', changes: [{ kind: 'checks-failed', checks: [{ name: `build-${number}`, status: 'failure', url: null }] }], ended: null })
const end = (host: Host, status: 'completed' | 'interrupted' = 'completed') => host.update('workshop', { status: 'idle', lastTurn: { id: randomUUID(), status } })
const sends = (host: Host) => host.attempts.filter((c): c is Extract<AgentHostCommand, { type: 'send' }> => c.type === 'send')
type Stored = { items: readonly { id: string; threadId: string; wakeUp?: true; status: string; text: string; messageId?: string }[] }
const stored = (control: AgentControl) => (control as unknown as { followupStore: { peek(): Stored } }).followupStore.peek().items
const queueUser = async (control: AgentControl, text: string) => {
  expect((await control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text })).error ?? null).toBeNull()
}

it('hands an idle thread its delegation news as its next turn, shown in no queue, transcript, row or phone', async () => {
  const f = await fixture()
  end(f.host)
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  await expect.poll(() => sends(f.host).length).toBe(1)
  const sent = sends(f.host)[0]!
  // The agent reads it, worded from delegation's record as it goes, as a wake-up the host records as one no one is shown.
  expect(sent).toMatchObject({ text: 'Synthetic news as sent: answered', wakeUp: true, hiddenWakeUp: true })
  await expect.poll(() => stored(f.control)).toEqual([])
  // The queue panel and the phone read the shell's queue; the transcript and the phone read the thread's detail.
  expect(f.control.shell().followups).toEqual([])
  expect(f.control.threadDetail('workshop')!.messages.some(message => message.id === sent.messageId)).toBe(false)
  expect(f.control.shell().host.threads.find(thread => thread.id === 'workshop')!.summary?.lastUser?.id).not.toBe(sent.messageId)
})

it('waits only while the thread\'s own turn runs, and goes as soon as it ends', async () => {
  const f = await fixture()
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  // Waiting, it is in no queue panel either.
  expect(stored(f.control)).toHaveLength(1)
  expect(f.control.shell().followups).toEqual([])
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(sends(f.host)).toHaveLength(0)
  end(f.host)
  await expect.poll(() => sends(f.host).length).toBe(1)
  expect(sends(f.host)[0]!.hiddenWakeUp).toBe(true)
})

it('goes past a machine Stop\'s fence, pausing the user\'s held prompts first so they wait for the user\'s Resume', async () => {
  const f = await fixture()
  await queueUser(f.control, 'Synthetic queued prompt')
  // Watcher's Stop all on a thread Watcher started stops its turn, so it does not finish; the fence holds the user's prompt.
  f.fence(true)
  end(f.host, 'interrupted')
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  await f.control.deliverWakeUp('workshop', pullRequest(1), { tool: false })
  await expect.poll(() => sends(f.host).length).toBe(1)
  expect(sends(f.host)[0]).toMatchObject({ hiddenWakeUp: true })
  // The news turn completes like any other, so the user's prompt was paused for their review before it went.
  await expect.poll(() => stored(f.control).map(item => [item.wakeUp ? 'wake-up' : item.text, item.status])).toEqual([['Synthetic queued prompt', 'paused'], ['wake-up', 'queued']])
  expect(f.control.shell().followups?.find(item => !item.wakeUp)?.error).toBe('Watcher stopped this thread. Review the queue and resume it when ready.')
  // The news turn ends and the Stop's hold lifts: the prompt still waits, and so does the news behind it.
  end(f.host)
  f.fence(false)
  f.host.emit()
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(sends(f.host)).toHaveLength(1)
  // Resume is the user's review: their prompt goes, then the pull request's news.
  expect((await f.control.command({ type: 'resume-followups', threadId: 'workshop' })).error ?? null).toBeNull()
  await expect.poll(() => sends(f.host).length).toBe(2)
  expect(sends(f.host)[1]!.text).toBe('Synthetic queued prompt')
})

it('goes past the user\'s paused prompt at the head of the queue, which stays paused and in place', async () => {
  const f = await fixture()
  await queueUser(f.control, 'Synthetic first prompt')
  await queueUser(f.control, 'Synthetic second prompt')
  // The user's Stop pauses their queue for review.
  await f.control.command({ type: 'interrupt', threadId: 'workshop' })
  end(f.host, 'interrupted')
  await expect.poll(() => stored(f.control).map(item => item.status)).toEqual(['paused', 'paused'])
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  await expect.poll(() => sends(f.host).length).toBe(1)
  expect(sends(f.host)[0]!.hiddenWakeUp).toBe(true)
  await expect.poll(() => stored(f.control).map(item => [item.text, item.status])).toEqual([['Synthetic first prompt', 'paused'], ['Synthetic second prompt', 'paused']])
  expect(f.control.shell().followups?.map(item => item.text)).toEqual(['Synthetic first prompt', 'Synthetic second prompt'])
})

it('lets a ready prompt of the user\'s go first, and goes on the next free turn', async () => {
  const f = await fixture()
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  await queueUser(f.control, 'Synthetic user prompt')
  end(f.host)
  await expect.poll(() => sends(f.host).length).toBe(1)
  expect(sends(f.host)[0]!.text).toBe('Synthetic user prompt')
  end(f.host)
  await expect.poll(() => sends(f.host).length).toBe(2)
  expect(sends(f.host)[1]!.hiddenWakeUp).toBe(true)
})

it('is not held by a set-aside prompt, which still holds other news', async () => {
  const f = await fixture()
  end(f.host)
  // The user set aside an unconfirmed prompt and has not yet had a fresh one confirmed: automatic updates wait.
  const at = new Date().toISOString()
  const setAside: AgentDelivery = { threadId: 'workshop', draftId: randomUUID(), status: 'uncertain', setAside: true, createdAt: at, updatedAt: at }
  const state = (f.control as unknown as { state: { deliveries?: AgentDelivery[] } }).state
  state.deliveries = [...state.deliveries ?? [], setAside]
  await f.control.deliverWakeUp('workshop', pullRequest(1), { tool: false })
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  await expect.poll(() => sends(f.host).length).toBe(1)
  expect(sends(f.host)[0]!.hiddenWakeUp).toBe(true)
  // The pull request's wake-up still waits for the set-aside prompt to be settled.
  expect(f.control.shell().followups?.map(item => item.wakeUp)).toEqual([true])
})

it('never folds into a visible wake-up, and is set apart from one an earlier build folded it into', async () => {
  const f = await fixture()
  await f.control.deliverWakeUp('workshop', pullRequest(1), { tool: false })
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  // One hidden wake-up holds both delegations' news; the pull request's is its own, and the only one shown.
  expect(stored(f.control)).toHaveLength(2)
  expect(f.control.shell().followups).toHaveLength(1)
  end(f.host)
  await expect.poll(() => sends(f.host).length).toBe(1)
  expect(sends(f.host)[0]!.text).toContain('Check build-1 failed')
  end(f.host)
  await expect.poll(() => sends(f.host).length).toBe(2)
  expect(sends(f.host)[1]!.text).toBe('Synthetic news as sent: answered, answered')
})

it('waits for the user\'s prompt a crash left unresolved between the queue\'s claim and its send, across a real restart', async () => {
  const f = await fixture()
  end(f.host)
  // The queue claims the user's prompt and saves it as dispatching; the read before its send never answers, so the send
  // never saves its outbox entry. Sotto stops there.
  f.host.stallReads = true
  await queueUser(f.control, 'Synthetic prompt')
  await expect.poll(() => stored(f.control).map(item => item.status)).toEqual(['dispatching'])
  const messageId = stored(f.control)[0]!.messageId!
  f.control.dispose()
  // A new coordinator starts over the same folder: the prompt comes back unresolved, and nothing in the outbox says so.
  const host = new Host(); host.state = structuredClone(f.host.state)
  const g = await boot(f.root, host, f.credentials, false)
  expect(stored(g.control).map(item => [item.text, item.status])).toEqual([['Synthetic prompt', 'uncertain']])
  await g.control.deliverWakeUp('workshop', delegation(), { tool: false })
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(sends(host)).toHaveLength(0)
  // The provider shows the prompt landed and its turn ended: the prompt is settled, and the news goes after it.
  host.state.threads.find(thread => thread.id === 'workshop')!.messages.push({ id: messageId, role: 'user', text: 'Synthetic prompt', createdAt: new Date().toISOString() })
  end(host)
  await expect.poll(() => sends(host).length).toBe(1)
  expect(sends(host)[0]!.hiddenWakeUp).toBe(true)
})

it('tries a send that surely did not go again ten seconds later, and only then', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    const f = await fixture()
    f.host.failNext = true
    end(f.host)
    await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
    await vi.waitFor(() => expect(sends(f.host)).toHaveLength(1))
    await vi.waitFor(() => expect(stored(f.control).map(item => item.status)).toEqual(['failed']))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(sends(f.host)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_500)
    await vi.waitFor(() => expect(sends(f.host)).toHaveLength(2))
    expect(sends(f.host)[1]!.hiddenWakeUp).toBe(true)
    await vi.waitFor(() => expect(stored(f.control)).toEqual([]))
  } finally { vi.useRealTimers() }
})

it('never sends again news whose send may have gone', async () => {
  const f = await fixture()
  f.host.uncertainNext = true
  end(f.host)
  await f.control.deliverWakeUp('workshop', delegation(), { tool: false })
  await expect.poll(() => sends(f.host).length).toBe(1)
  await expect.poll(() => stored(f.control).map(item => item.status)).toEqual(['uncertain'])
  // The thread moves on and is read again many times: the news is never sent again.
  for (let pass = 0; pass < 5; pass++) { end(f.host); await f.control.command({ type: 'refresh' }) }
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(sends(f.host)).toHaveLength(1)
  expect(f.control.shell().followups).toEqual([])
})
