// @vitest-environment node
/**
 * The split between the shell every window gets and the history only a looked-at thread gets.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_STATE_PUBLISH_INTERVAL_MS, AgentControl, coalesceAgentThreadDetailPublishes, type PublishScheduler } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import type { AgentState, AgentThreadDetail } from '../../../src/shared/agents'

const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  for (const control of controls) control.dispose()
  controls.clear()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-shell-detail-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-shell-detail-')); roots.push(root)
  const host = new E2EAgentHost()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
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
    const details: AgentThreadDetail[] = []
    f.control.subscribeThreadDetail(item => details.push(item))
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop'] })
    expect(details.map(item => item.threadId)).toEqual(['workshop'])
    expect(details[0]!.messages.map(message => message.text)).toEqual(['Pick the palette', 'Indigo it is.'])
    details.length = 0
    // A thread nobody is looking at never has its history copied, however much it streams.
    f.host.event({ type: 'ready', threadId: 'docs', text: 'Another paragraph.' })
    await f.control.command({ type: 'refresh' })
    expect(details.map(item => item.threadId)).not.toContain('docs')
  })

  it('is sent again only when that thread\'s messages actually change', async () => {
    const f = await fixture()
    const details: AgentThreadDetail[] = []
    f.control.subscribeThreadDetail(item => details.push(item))
    await f.control.command({ type: 'observe-threads', threadIds: ['workshop', 'docs'] })
    expect(details.map(item => item.threadId)).toEqual(['workshop', 'docs'])
    details.length = 0
    await f.control.command({ type: 'refresh' })
    expect(details).toEqual([])
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'Indigo with white text.' })
    await f.control.command({ type: 'refresh' })
    expect(details.map(item => item.threadId)).toEqual(['workshop'])
    expect(details[0]!.messages.at(-1)!.text).toBe('Indigo with white text.')
    expect(details[0]!.revision).toBeGreaterThan(0)
  })

  it('reaches a thread with work in flight even when no pane is open on it', async () => {
    const f = await fixture()
    const details: AgentThreadDetail[] = []
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
})
