// @vitest-environment node
/**
 * A phone that accepts `settled-threads-on-request` is sent only threads that are not settled, and reads settled ones
 * with `settled-threads` when the user opens the Settled shelf or searches (ADR-0028, November 1 part 2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SocketFrames } from '../../src/host/socketFrames'
import type { AgentHostSnapshot, AgentThread } from '../../src/shared/agents'
import { PROVIDER_HOST_FEATURES } from '../../src/shared/hostProtocol'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const raws: SocketFrames[] = []
afterEach(() => { vi.restoreAllMocks(); for (const frames of raws.splice(0)) frames.close() })

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
const PROVIDERS = Object.values(PROVIDER_HOST_FEATURES)

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

  it('finds a held-back thread by what was said in it, once the host reads its words', async () => {
    await settledThreads()
    const held = await phone([...PROVIDERS, 'settled-threads-on-request', 'thread-words'])
    const older = await phone([...PROVIDERS, 'settled-threads-on-request'])
    const page = await held.call('page', { op: 'settled-threads' }) as { result: { threads: AgentThread[] } }
    const stars = page.result.threads.find(thread => thread.title === 'Owl stars')!
    const words = vi.spyOn(fixture.host.service, 'threadWords').mockResolvedValue({ found: [{ threadId: stars.id, messageId: 'u0', role: 'user', quote: 'Make the invoice blink.', more: 0 }] })
    const found = await held.call('found', { op: 'settled-threads', query: 'invoice' }) as { result: { threads: AgentThread[] } }
    expect(found.result.threads.map(thread => thread.title)).toEqual(['Owl stars'])
    expect(words).toHaveBeenCalledExactlyOnceWith('invoice')
    // The phone's own read of the quotes, a moment later, is answered from the same read of the store.
    expect(await held.call('quotes', { op: 'thread-words', query: 'invoice' })).toMatchObject({ ok: true, result: { found: [{ threadId: stars.id }] } })
    expect(words).toHaveBeenCalledTimes(1)
    // A phone whose hello did not accept thread-words cannot quote such a thread, so its search finds only what titles say.
    const plain = await older.call('plain', { op: 'settled-threads', query: 'invoice' }) as { result: { threads: AgentThread[] } }
    expect(plain.result.threads).toEqual([])
    expect(words).toHaveBeenCalledTimes(1)
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

  it('holds back settled delegated threads from the live shell and leaves them out of settledHeldBack and settled-threads pages', async () => {
    await settledThreads()
    const native = fixture.native as unknown as { state: AgentHostSnapshot; emit(): void }
    const base = native.state.threads[0]!
    native.state.threads = [...native.state.threads,
      { ...base, id: 'delegated-settled', title: 'Billing delegated', settledAt: ago(1) }]
    native.emit()
    await expect.poll(() => fixture.host.service.shell().host.threads.some(thread => thread.title === 'Billing delegated')).toBe(true)
    const threads = fixture.host.service.shell().host.threads
    const parent = threads.find(thread => thread.title === base.title)!
    const child = threads.find(thread => thread.title === 'Billing delegated')!
    const host = fixture.host.service as unknown as { control: { dependencies: { host: { setDelegatedBy(threadId: string, delegatingThreadId: string): Promise<void> } } } }
    await host.control.dependencies.host.setDelegatedBy(child.id, parent.id)
    await expect.poll(() => fixture.host.service.shell().host.threads.find(thread => thread.id === child.id)?.delegatedBy).toBe(parent.id)
    const held = await phone([...PROVIDERS, 'settled-threads-on-request'])
    // Held back from the live shell, not counted in settledHeldBack, and omitted from settled-threads pages and search.
    expect(held.hello.host.threads.some(thread => thread.id === child.id)).toBe(false)
    expect(held.hello.settledHeldBack).toBe(4)
    const page = await held.call('page', { op: 'settled-threads' }) as { result: { threads: AgentThread[] } }
    expect(page.result.threads.some(thread => thread.id === child.id)).toBe(false)
    const found = await held.call('found', { op: 'settled-threads', query: 'billing' }) as { result: { threads: AgentThread[] } }
    expect(found.result.threads.map(thread => thread.title)).toEqual(['Billing reconcile', 'Billing export'])
  })

  it('refuses the read to a client that did not accept the feature', async () => {
    await settledThreads()
    const older = await phone([])
    const answer = await older.call('refused', { op: 'settled-threads' }) as { ok: boolean; error?: { code: string } }
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('invalid_request')
  })
})
