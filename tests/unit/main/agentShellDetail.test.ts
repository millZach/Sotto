// @vitest-environment node
/**
 * The split between the shell every window gets and the history only a looked-at thread gets.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATE_PUBLISH_INTERVAL_MS, AgentControl, coalesceAgentThreadDetailPublishes, type PublishScheduler } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { applyAgentThreadDetailDelta, isAgentThreadDetailDelta } from '../../../src/shared/agentThreadDetail'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentState, AgentThreadDetail, AgentThreadDetailDelta, AgentThreadDetailUpdate } from '../../../src/shared/agents'

/** The whole detail an update must be for the assertion that follows to mean anything. */
function whole(update: AgentThreadDetailUpdate | undefined): AgentThreadDetail {
  if (update === undefined || isAgentThreadDetailDelta(update)) throw new Error('Expected a whole thread detail')
  return update
}
function delta(update: AgentThreadDetailUpdate | undefined): AgentThreadDetailDelta {
  if (update === undefined || !isAgentThreadDetailDelta(update)) throw new Error('Expected a thread detail delta')
  return update
}

const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  vi.useRealTimers()
  for (const control of controls) control.dispose()
  controls.clear()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-shell-detail-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(schedule: PublishScheduler = immediatePublishScheduler) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-shell-detail-')); roots.push(root)
  const host = new E2EAgentHost()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  const control = new AgentControl({ schedule, directory: root, host, credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
  controls.add(control)
  await control.start(); await control.command({ type: 'connect' })
  host.event({ type: 'manual', threadId: 'workshop', text: 'Pick the palette' })
  host.event({ type: 'ready', threadId: 'workshop', text: 'Indigo it is.' })
  host.event({ type: 'ready', threadId: 'docs', text: 'The guide is drafted.' })
  await control.command({ type: 'refresh' })
  return { root, host, control }
}

describe('the published shell', () => {
  it('carries every thread with the facts a row reads and none of its history', async () => {
    const f = await fixture()
    const shell = f.control.shell()
    expect(shell.host.threads.map(thread => thread.id)).toEqual(f.control.get().host.threads.map(thread => thread.id))
    for (const thread of shell.host.threads) expect(thread.messages).toEqual([])
    const workshop = shell.host.threads.find(thread => thread.id === 'workshop')!
    expect(workshop.summary).toMatchObject({ messageCount: 2 })
    expect(workshop.summary!.lastUser!.text).toBe('Pick the palette')
    expect(workshop.summary!.lastAssistant!.text).toBe('Indigo it is.')
    expect(workshop.summary!.lastMessageAt).toBe(f.control.get().host.threads.find(thread => thread.id === 'workshop')!.messages.at(-1)!.createdAt)
    // The rest of the state is untouched.
    expect(shell.configuration).toEqual(f.control.get().configuration)
    expect(shell.queue).toEqual(f.control.get().queue)
  })

  it('is what listeners are broadcast, so no thread history crosses the state channel', async () => {
    const f = await fixture()
    const published: AgentState[] = []
    f.control.subscribe(state => published.push(state))
    f.host.event({ type: 'ready', threadId: 'docs', text: 'One more paragraph.' })
    await f.control.command({ type: 'refresh' })
    expect(published.length).toBeGreaterThan(0)
    for (const state of published) for (const thread of state.host.threads) expect(thread.messages).toEqual([])
    expect(published.at(-1)!.host.threads.find(thread => thread.id === 'docs')!.summary!.lastAssistant!.text).toBe('One more paragraph.')
  })

  it('says whether the user is keeping local history, so the window knows what it may cache', async () => {
    const f = await fixture()
    expect(f.control.shell().historyEnabled).toBe(true)
  })
})

describe('per-thread detail', () => {
  it('is pushed only for the threads the window says it is looking at', async () => {
    const f = await fixture()
    const details: AgentThreadDetailUpdate[] = []
    f.control.subscribeThreadDetail(item => details.push(item))
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    expect(details.map(item => item.threadId)).toEqual(['workshop'])
    expect(whole(details[0]).messages.map(message => message.text)).toEqual(['Pick the palette', 'Indigo it is.'])
    details.length = 0
    // A thread nobody is looking at never has its history copied, however much it streams.
    f.host.event({ type: 'ready', threadId: 'docs', text: 'Another paragraph.' })
    await f.control.command({ type: 'refresh' })
    expect(details.map(item => item.threadId)).not.toContain('docs')
  })

  it('is sent again only when that thread\'s messages actually change', async () => {
    const f = await fixture()
    const details: AgentThreadDetailUpdate[] = []
    f.control.subscribeThreadDetail(item => details.push(item))
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop', 'docs'] })
    expect(details.map(item => item.threadId)).toEqual(['workshop', 'docs'])
    details.length = 0
    await f.control.command({ type: 'refresh' })
    expect(details).toEqual([])
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'Indigo with white text.' })
    await f.control.command({ type: 'refresh' })
    expect(details.map(item => item.threadId)).toEqual(['workshop'])
    // The window already holds the previous revision, so the new message arrives on its own.
    const update = delta(details[0])
    expect(update.messageDeltas).toHaveLength(1)
    expect(update.messageDeltas[0]).toMatchObject({ message: { text: 'Indigo with white text.' } })
    expect(update.revision).toBeGreaterThan(update.baseRevision)
  })

  it('reaches a thread with work in flight even when no pane is open on it', async () => {
    const f = await fixture()
    const details: AgentThreadDetailUpdate[] = []
    f.control.subscribeThreadDetail(item => details.push(item))
    await f.control.command({ type: 'manual-send', threadId: 'docs', draftId: crypto.randomUUID(), text: 'Add an index' })
    expect(details.map(item => item.threadId)).toContain('docs')
  })

  it('answers a request for one thread the window opened without being pushed it', async () => {
    const f = await fixture()
    const detail = f.control.threadDetail('workshop')
    expect(detail!.threadId).toBe('workshop')
    expect(detail!.messages.map(message => message.text)).toEqual(['Pick the palette', 'Indigo it is.'])
    expect(f.control.threadDetail('no-such-thread')).toBeNull()
  })
})

const record = (id: string, patch: Partial<AgentActivity> = {}): AgentActivity =>
  ({ id, turnId: 'turn-1', sequence: 1, kind: 'command', status: 'running', title: 'npm test', ...patch })

describe('detail deltas while a thread streams', () => {
  it('sends the whole detail the first time, and the suffix a streaming message grew by after that', async () => {
    const f = await fixture()
    const details: AgentThreadDetailUpdate[] = []
    f.control.subscribeThreadDetail(item => details.push(item))
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    expect(whole(details[0]).messages).toHaveLength(2)
    details.length = 0
    f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'stream-1', text: 'Indigo' })
    await f.control.command({ type: 'refresh' })
    details.length = 0
    f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'stream-1', text: 'Indigo it is, with white text.' })
    await f.control.command({ type: 'refresh' })
    const update = delta(details[0])
    expect(update.messageDeltas).toEqual([{ id: 'stream-1', appendText: ' it is, with white text.' }])
    expect(update.activityDeltas).toEqual([])
  })

  it('sends the whole message when the change is not an append', async () => {
    const f = await fixture()
    const details: AgentThreadDetailUpdate[] = []
    f.control.subscribeThreadDetail(item => details.push(item))
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'stream-1', text: 'Indigo it is.' })
    await f.control.command({ type: 'refresh' })
    details.length = 0
    // A rewritten message shares no prefix with the one the window holds, so the message itself is sent.
    f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'stream-1', text: 'Actually, copper.' })
    await f.control.command({ type: 'refresh' })
    expect(delta(details[0]).messageDeltas).toEqual([{ message: expect.objectContaining({ id: 'stream-1', text: 'Actually, copper.' }) }])
  })

  it('diffs an activity record once however often it was updated inside one window', async () => {
    const clock = new TestClock()
    const f = await fixture(clock.schedule)
    const details: AgentThreadDetailUpdate[] = []
    f.control.subscribeThreadDetail(item => details.push(item))
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    expect(whole(details[0])).toBeDefined()
    // Activity arriving for the first time is a whole detail of its own; the window then holds one to diff.
    f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'stream-1', text: 'Working', activities: [record('build')] })
    clock.tick()
    details.length = 0
    // The coalescing window is open from the run above; every update below rides its trailing run.
    for (const output of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
      f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'stream-1', text: 'Working', activities: [record('build', { output })] })
    }
    expect(details).toEqual([])
    clock.tick()
    expect(details).toHaveLength(1)
    const update = delta(details[0])
    expect(update.activityDeltas).toEqual([{ record: expect.objectContaining({ id: 'build', output: 'abcde' }) }])
    expect(update.messageDeltas).toEqual([])
  })

  it('carries only the activity the host keeps beside the window, and the rest once the window widens', async () => {
    const f = await fixture()
    const details: AgentThreadDetailUpdate[] = []
    f.control.subscribeThreadDetail(item => details.push(item))
    // The host keeps back a turn above the loaded window; the pane is given it once its messages load.
    const above = new Set(['above'])
    Object.assign(f.host, { paneActivities: (_threadId: string, records: readonly AgentActivity[]) => records.filter(item => !above.has(item.id)) })
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'stream-1', text: 'Working',
      activities: [record('above', { turnId: 'turn-0', status: 'completed' }), record('build')] })
    await f.control.command({ type: 'refresh' })
    expect(details.flatMap(update => isAgentThreadDetailDelta(update) ? update.activityDeltas.flatMap(item => 'record' in item ? [item.record.id] : []) : (update.activities ?? []).map(item => item.id)))
      .not.toContain('above')
    expect(f.control.threadDetail('workshop')!.activities!.map(item => item.id)).toEqual(['build'])
    // Everything else in main still reads every record.
    expect(f.control.get().host.threads.find(thread => thread.id === 'workshop')!.activities!.map(item => item.id)).toEqual(['above', 'build'])

    details.length = 0
    above.clear()
    await f.control.command({ type: 'refresh' })
    // The record lands before one the window holds, so the window is sent the whole detail in order.
    expect(whole(details.at(-1)).activities!.map(item => item.id)).toEqual(['above', 'build'])
  })

  it('frees the snapshot of a thread that leaves the viewed set, so the next detail is a whole one', async () => {
    const f = await fixture()
    const details: AgentThreadDetailUpdate[] = []
    f.control.subscribeThreadDetail(item => details.push(item))
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    await f.control.command({ type: 'observe-threads', threadIds: [] })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'While nobody was looking.' })
    await f.control.command({ type: 'refresh' })
    details.length = 0
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    expect(whole(details[0]).messages.at(-1)!.text).toBe('While nobody was looking.')
  })

  it('answers a request with the whole detail and measures what follows from it', async () => {
    const f = await fixture()
    const details: AgentThreadDetailUpdate[] = []
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    f.control.subscribeThreadDetail(item => details.push(item))
    // A window that lost track asks for the whole detail; main's own base moves with the answer.
    const answer = f.control.threadDetail('workshop')!
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'And one more.' })
    await f.control.command({ type: 'refresh' })
    expect(delta(details.at(-1)).baseRevision).toBe(answer.revision)
  })

  it('sends a change still waiting to every listener before a whole read resets the base, so no one else has to read the thread again', async () => {
    const clock = new TestClock()
    const f = await fixture(clock.schedule)
    // A client that holds only what it was sent, the way the socket client and the window do.
    let held: AgentThreadDetail | null = null
    let misses = 0
    f.control.subscribeThreadDetail(update => {
      if (!isAgentThreadDetailDelta(update)) { held = update; return }
      const applied = held === null ? null : applyAgentThreadDetailDelta(held, update)
      if (applied === null) misses += 1
      else held = applied
    })
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    clock.tick()
    let text = ''
    for (const chunk of ['Indigo', ' it is', ', with', ' white', ' text.']) {
      text += chunk
      f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'stream-1', text })
      // Another client reads the whole thread while this change is still waiting in the window.
      f.control.threadDetail('workshop')
      clock.tick()
    }
    expect(misses).toBe(0)
    expect(held!.messages.at(-1)!.text).toBe('Indigo it is, with white text.')
    expect(held!.revision).toBe(f.control.threadDetail('workshop')!.revision)
  })
})

class TestClock {
  private readonly armed = new Set<{ run: () => void }>()
  intervals: number[] = []
  readonly schedule: PublishScheduler = (run, ms) => {
    this.intervals.push(ms)
    const entry = { run }
    this.armed.add(entry)
    return () => this.armed.delete(entry)
  }
  tick(): void { for (const entry of [...this.armed]) { this.armed.delete(entry); entry.run() } }
  get pending(): number { return this.armed.size }
}

describe('coalesced thread detail at the IPC boundary', () => {
  const detail = (threadId: string, revision: number): AgentThreadDetail =>
    ({ threadId, revision, messages: [{ id: String(revision), role: 'assistant', text: String(revision), createdAt: '2026-01-01T00:00:00.000Z' }] })
  it('sends the first revision of a burst at once and only the newest of the rest', () => {
    const sent: string[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentThreadDetailPublishes(item => sent.push(`${item.threadId}:${item.revision}`), { schedule: clock.schedule })
    for (let revision = 1; revision <= 20; revision += 1) publisher.publish(detail('workshop', revision))
    expect(sent).toEqual(['workshop:1'])
    clock.tick()
    expect(sent).toEqual(['workshop:1', 'workshop:20'])
    expect(clock.intervals.every(ms => ms === AGENT_STATE_PUBLISH_INTERVAL_MS)).toBe(true)
  })
  it('keeps one lane per thread, so a busy thread never holds another one back', () => {
    const sent: string[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentThreadDetailPublishes(item => sent.push(`${item.threadId}:${item.revision}`), { schedule: clock.schedule })
    publisher.publish(detail('workshop', 1))
    publisher.publish(detail('workshop', 2))
    publisher.publish(detail('docs', 1))
    expect(sent).toEqual(['workshop:1', 'docs:1'])
    clock.tick()
    expect(sent).toEqual(['workshop:1', 'docs:1', 'workshop:2'])
  })
  const append = (baseRevision: number, revision: number, appendText: string, id = '1'): AgentThreadDetailDelta =>
    ({ threadId: 'workshop', baseRevision, revision, messageDeltas: [{ id, appendText }], activityDeltas: [] })
  it('folds the deltas waiting in a lane into one, so no chunk is dropped', () => {
    const sent: AgentThreadDetailUpdate[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentThreadDetailPublishes(item => sent.push(item), { schedule: clock.schedule })
    publisher.publish(detail('workshop', 1))
    publisher.publish(append(1, 2, ' one'))
    publisher.publish(append(2, 3, ' two'))
    publisher.publish(append(3, 4, ' three'))
    expect(sent).toHaveLength(1)
    clock.tick()
    // Three chunks of one message become one chunk, still measured from the revision already sent.
    expect(sent).toHaveLength(2)
    expect(delta(sent[1])).toMatchObject({ baseRevision: 1, revision: 4, messageDeltas: [{ id: '1', appendText: ' one two three' }] })
  })
  it('folds a delta into a whole detail that has not been sent yet', () => {
    const sent: AgentThreadDetailUpdate[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentThreadDetailPublishes(item => sent.push(item), { schedule: clock.schedule })
    publisher.publish(detail('workshop', 1))
    publisher.publish(detail('workshop', 2))
    publisher.publish(append(2, 3, ' more', '2'))
    clock.tick()
    expect(whole(sent[1])).toMatchObject({ revision: 3, messages: [{ id: '2', text: '2 more' }] })
  })
  it('keeps a delta whose base is not what is waiting, rather than dropping it', () => {
    const sent: AgentThreadDetailUpdate[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentThreadDetailPublishes(item => sent.push(item), { schedule: clock.schedule })
    publisher.publish(detail('workshop', 1))
    publisher.publish(append(5, 6, ' one'))
    publisher.publish(append(7, 8, ' two'))
    clock.tick()
    expect(sent.map(item => item.revision)).toEqual([1, 6, 8])
  })
  it('holds an update published while the lane is sending until that send has reached everyone', () => {
    const sent: string[] = []
    const clock = new TestClock()
    let publisher: ReturnType<typeof coalesceAgentThreadDetailPublishes> | undefined
    // The first listener's send publishes the next revision, the way a whole read inside a send does.
    publisher = coalesceAgentThreadDetailPublishes(item => {
      sent.push(`first:${item.revision}`)
      if (item.revision === 1) publisher!.publish(detail('workshop', 2))
      sent.push(`second:${item.revision}`)
    }, { schedule: clock.schedule })
    publisher.publish(detail('workshop', 1))
    expect(sent).toEqual(['first:1', 'second:1'])
    clock.tick()
    expect(sent).toEqual(['first:1', 'second:1', 'first:2', 'second:2'])
  })
  it('publishes nothing after dispose and leaves no lane armed', () => {
    const sent: string[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentThreadDetailPublishes(item => sent.push(`${item.threadId}:${item.revision}`), { schedule: clock.schedule })
    publisher.publish(detail('workshop', 1))
    publisher.publish(detail('workshop', 2))
    publisher.dispose()
    expect(clock.pending).toBe(0)
    publisher.publish(detail('workshop', 3))
    clock.tick()
    expect(sent).toEqual(['workshop:1'])
  })
  it('drops a lane once it goes quiet, so the next update opens a fresh one and sends at once', () => {
    const sent: string[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentThreadDetailPublishes(item => sent.push(`${item.threadId}:${item.revision}`), { schedule: clock.schedule })
    publisher.publish(detail('workshop', 1))
    publisher.publish(detail('workshop', 2))
    expect(sent).toEqual(['workshop:1'])
    clock.tick()
    expect(sent).toEqual(['workshop:1', 'workshop:2'])
    // The trailing run fires with nothing waiting and retires the lane.
    clock.tick()
    expect(sent).toEqual(['workshop:1', 'workshop:2'])
    publisher.publish(detail('workshop', 3))
    expect(sent).toEqual(['workshop:1', 'workshop:2', 'workshop:3'])
  })
  it('leaves no timer armed once a lane goes quiet or the publisher is disposed', () => {
    vi.useFakeTimers()
    const sent: number[] = []
    const publisher = coalesceAgentThreadDetailPublishes(item => sent.push(item.revision))
    publisher.publish(detail('workshop', 1))
    publisher.publish(detail('workshop', 2))
    vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS)
    expect(sent).toEqual([1, 2])
    vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS)
    expect(vi.getTimerCount()).toBe(0)
    publisher.publish(detail('docs', 1))
    publisher.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
