// @vitest-environment node
/**
 * A phone that accepts `settled-threads-on-request` is sent only threads that are not settled, and reads settled ones
 * with `settled-threads` when the user opens the Settled shelf or searches (ADR-0028, November 1 part 2).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SocketFrames } from '../../src/host/socketFrames'
import type { AgentHostSnapshot, AgentThread } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const raws: SocketFrames[] = []
afterEach(() => { for (const frames of raws.splice(0)) frames.close() })

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()
interface Listed { host: { threads: AgentThread[] }; settledHeldBack?: number }

/** Three threads settled long ago, one two days ago, beside the provider's open ones. */
async function settledThreads(): Promise<void> {
  await expect.poll(() => fixture.host.service.shell().host.threads.length).toBeGreaterThan(1)
  const native = fixture.native as unknown as { state: AgentHostSnapshot; emit(): void }
  const base = native.state.threads[0]!
  native.state.threads = [...native.state.threads,
    { ...base, id: 'old-a', title: 'Billing reconcile', settledAt: ago(30) }, { ...base, id: 'old-b', title: 'Owl stars', settledAt: ago(20) },
    { ...base, id: 'old-c', title: 'Billing export', archivedAt: ago(40) }, { ...base, id: 'this-week', title: 'This week', settledAt: ago(2) }]
  native.emit()
  await expect.poll(() => fixture.host.service.shell().host.threads.some(thread => thread.title === 'This week')).toBe(true)
}

async function phone(accepts: string[]) {
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
  const raw = await rawPeer(fixture.host.descriptor!.port, fixture.host.pairing.signSession(paired.clientId))
  raws.push(raw.frames)
  const hello = await raw.call('hello', { op: 'hello', accepts }) as { result: { shell: Listed } }
  const titles = (listed: Listed) => listed.host.threads.map(thread => thread.title)
  return { ...raw, hello: hello.result.shell, titles }
}
const OLDER = ['Billing reconcile', 'Owl stars', 'Billing export']
/** Every provider the fixture runs, so a phone is sent each one's threads. */
const PROVIDERS = ['provider-opencode', 'provider-cursor']

describe('settled threads on request', () => {
  it('leaves every settled thread out of the list, however recently settled, and says how many it left out', async () => {
    await settledThreads()
    const whole = fixture.host.service.shell().host.threads.length
    const held = await phone([...PROVIDERS, 'settled-threads-on-request'])
    for (const title of [...OLDER, 'This week']) expect(held.titles(held.hello)).not.toContain(title)
    expect(held.hello.host.threads).toHaveLength(whole - 4)
    expect(held.hello.settledHeldBack).toBe(4)
    // A client that did not accept it is sent every thread, as before, and no count.
    const older = await phone(PROVIDERS)
    expect(older.hello.host.threads).toHaveLength(whole)
    expect(older.hello).not.toHaveProperty('settledHeldBack')
  })

  it('reads the threads it left out a page at a time, newest settled first, and finds them by a search', async () => {
    await settledThreads()
    const held = await phone([...PROVIDERS, 'settled-threads-on-request'])
    const first = await held.call('first', { op: 'settled-threads', limit: 2 }) as { result: { threads: AgentThread[]; next: string | null } }
    expect(first.result.threads.map(thread => thread.title)).toEqual(['This week', 'Owl stars'])
    const second = await held.call('second', { op: 'settled-threads', limit: 2, after: first.result.next }) as { result: { threads: AgentThread[]; next: string | null } }
    expect(second.result.threads.map(thread => thread.title)).toEqual(['Billing reconcile', 'Billing export'])
    expect(second.result.next).toBeNull()
    const found = await held.call('found', { op: 'settled-threads', query: 'billing' }) as { result: { threads: AgentThread[] } }
    expect(found.result.threads.map(thread => thread.title)).toEqual(['Billing reconcile', 'Billing export'])
  })

  it('lists a held-back thread while the phone has it open', async () => {
    await settledThreads()
    const held = await phone([...PROVIDERS, 'settled-threads-on-request'])
    const page = await held.call('page', { op: 'settled-threads' }) as { result: { threads: AgentThread[] } }
    const opened = page.result.threads.find(thread => thread.title === 'Owl stars')!
    await held.call('observe', { op: 'observe', threadIds: [opened.id] })
    await held.call('read', { op: 'shell' })
    const read = held.messages.find(message => message.id === 'read') as { result: Listed }
    expect(held.titles(read.result)).toContain('Owl stars')
    expect(read.result.settledHeldBack).toBe(3)
  })

  it('keeps a thread settled while the phone is connected in its list until it connects again', async () => {
    await settledThreads()
    const held = await phone([...PROVIDERS, 'settled-threads-on-request'])
    const native = fixture.native as unknown as { state: AgentHostSnapshot; emit(): void }
    const open = native.state.threads[0]!
    expect(held.titles(held.hello)).toContain(open.title)
    native.state.threads = native.state.threads.map(thread => thread.id === open.id ? { ...thread, title: 'Settled here', settledAt: new Date().toISOString() } : thread)
    native.emit()
    await expect.poll(() => fixture.host.service.shell().host.threads.find(thread => thread.title === 'Settled here')?.settledAt).toBeTruthy()
    // Still listed, so Undo puts it back at once; the next connect leaves it out.
    await held.call('read', { op: 'shell' })
    const read = held.messages.find(message => message.id === 'read') as { result: Listed }
    expect(held.titles(read.result)).toContain('Settled here')
    expect(read.result.settledHeldBack).toBe(4)
    const again = await phone([...PROVIDERS, 'settled-threads-on-request'])
    expect(again.titles(again.hello)).not.toContain('Settled here')
    expect(again.hello.settledHeldBack).toBe(5)
  })

  it('refuses the read to a client that did not accept the feature', async () => {
    await settledThreads()
    const older = await phone([])
    const answer = await older.call('refused', { op: 'settled-threads' }) as { ok: boolean; error?: { code: string } }
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('invalid_request')
  })
})
