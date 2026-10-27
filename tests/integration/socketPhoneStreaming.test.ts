// @vitest-environment node
/**
 * What a phone is pushed while threads stream. Each thread row's summary carries the newest reply's opening words and a
 * count of its activity records, and both change with every word and every step. No phone reads either, but with them
 * every publish made the phone's shell new, so the October 18 repeat check never matched: a phone with threads working
 * was pushed its whole shell about twenty times a second, and the iPhone lagged while typing and scrolling (October 26).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { AgentState } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** What the iPhone's hello accepts (`WatcherWire.hello` in apps/ios). */
const PHONE_ACCEPTS = ['detail-delta', 'client-liveness', 'activity-summaries', 'model-catalog-revision', 'provider-opencode', 'provider-cursor', 'watcher-phone', 'watcher-phone-stop-all']
const THREADS = ['workshop', 'docs']
const STREAM_MS = 1_200

type ShellPush = { event: 'shell'; state: AgentState }
async function peerOn(port: number, name: string) {
  const pairing = fixture.host.pairing
  const paired = await pairing.redeem(pairing.issuePairingCode().code, name)
  const peer = await rawPeer(port, pairing.signSession(paired.clientId))
  cleanups.push(() => peer.frames.close())
  await peer.call('hello', { op: 'hello', afterSeq: Number.MAX_SAFE_INTEGER, accepts: PHONE_ACCEPTS })
  return { ...peer, shells: () => peer.messages.filter((message): message is ShellPush => message.event === 'shell') }
}
/** A listener as the desktop's own phone listener runs, over the fixture host's service. */
async function phone() {
  const listener = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing, admin: false })
  cleanups.push(() => listener.close())
  return peerOn(listener.descriptor.port, 'Synthetic phone')
}
const TITLES: Record<string, string> = { workshop: 'Workshop', docs: 'Docs' }
/** A thread's row, by the fixture provider's own ID: the host lists it under its Sotto thread ID, with the same title. */
const row = (state: AgentState, nativeId: string) => state.host.threads.find(thread => thread.title === TITLES[nativeId])!

const steps = (count: number) => Array.from({ length: count }, (_, index) => ({ id: 'step-' + index, turnId: 'turn', sequence: index, kind: 'command' as const,
  status: index === count - 1 ? 'running' as const : 'completed' as const, title: 'Run', command: 'ls', startedAt: new Date(0).toISOString() }))

/** Streams words and steps into both threads for `STREAM_MS`, as two working threads do. */
async function stream(): Promise<void> {
  let text = 'Synthetic reply', step = 0
  const began = Date.now()
  while (Date.now() - began < STREAM_MS) {
    text += ' word'; step++
    for (const threadId of THREADS) fixture.native.event({ type: 'stream', threadId, messageId: threadId + '-reply', text, status: 'running', activities: steps(Math.floor(step / 10) + 1) })
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('a phone while threads stream', () => {
  it('is pushed no shell for words and steps it does not read, and one when a thread finishes', async () => {
    const peer = await phone()
    for (const threadId of THREADS) fixture.native.event({ type: 'stream', threadId, messageId: threadId + '-reply', text: 'Synthetic reply', status: 'running', activities: steps(1) })
    await expect.poll(() => peer.shells().some(push => THREADS.every(id => row(push.state, id)?.status === 'running'))).toBe(true)
    // Let the window that carried the threads starting close before counting.
    await new Promise(resolve => setTimeout(resolve, 200))
    const before = peer.shells().length
    await stream()
    await new Promise(resolve => setTimeout(resolve, 200))
    // Before, this was about one shell every 50ms for the whole stream.
    expect(peer.shells().length - before).toBeLessThanOrEqual(1)
    // A thread's summary on a phone keeps what a phone reads, and leaves out the words and the count.
    const summary = row(peer.shells().at(-1)!.state, 'workshop').summary!
    expect(summary).not.toHaveProperty('lastAssistant')
    expect(summary).not.toHaveProperty('lastUser')
    expect(summary).not.toHaveProperty('activityCount')
    expect(summary.lastMessageAt).toEqual(expect.any(String))
    // What a phone does read still goes at once.
    fixture.native.event({ type: 'stream', threadId: 'workshop', messageId: 'workshop-reply', text: 'Synthetic reply, done', status: 'idle' })
    await expect.poll(() => row(peer.shells().at(-1)!.state, 'workshop')?.status).toBe('idle')
    expect(peer.frames.isClosed).toBe(false)
  })

  it('leaves a desktop\'s summaries whole', async () => {
    const desktop = await peerOn(fixture.host.descriptor!.port, 'Synthetic desktop')
    fixture.native.event({ type: 'stream', threadId: 'workshop', messageId: 'workshop-reply', text: 'Synthetic reply for the sidebar', status: 'running' })
    await expect.poll(() => desktop.shells().map(push => row(push.state, 'workshop')?.summary?.lastAssistant?.text).at(-1)).toBe('Synthetic reply for the sidebar')
  })
})
