// @vitest-environment node
/**
 * The phone listener's note of what each phone is sent (`phone-send-diagnostics.jsonl`, #2755), over the real listener and
 * the fixture host: by message kind, by thread, by the shell parts sent whole and by the record fields that changed.
 */
import { afterEach, expect, it } from 'vitest'
import { phoneSends, type PhoneSendsLine } from '../../src/host/phoneSends'
import { startSocketServer } from '../../src/host/socketServer'
import type { AgentState } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** What the iPhone's hello accepts that this needs: thread deltas, changed thread records and kept parts. */
const PHONE_ACCEPTS = ['detail-delta', 'client-liveness', 'activity-summaries', 'model-catalog-revision', 'changed-thread-records', 'reply-thread-records', 'kept-parts']

it('notes each kind, thread, whole part and changed field a phone is sent, and nothing it says', async () => {
  const lines: PhoneSendsLine[] = []
  const sends = phoneSends(line => lines.push(line))
  const listener = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing, admin: false, phoneSends: sends })
  cleanups.push(() => listener.close())
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Synthetic phone')
  const peer = await rawPeer(listener.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
  cleanups.push(() => peer.frames.close())
  await peer.call('hello', { op: 'hello', afterSeq: Number.MAX_SAFE_INTEGER, accepts: PHONE_ACCEPTS })
  fixture.native.event({ type: 'stream', threadId: 'workshop', messageId: 'workshop-reply', text: 'Synthetic words nobody logs', status: 'running' })
  const shown = (): AgentState['host']['threads'][number] | undefined => fixture.host.service.shell().host.threads.find(thread => thread.title === 'Workshop' && thread.status === 'running')
  await expect.poll(() => shown() !== undefined).toBe(true)
  const workshop = shown()!
  await peer.call('observe', { op: 'observe', threadIds: [workshop.id] })
  fixture.native.event({ type: 'stream', threadId: 'workshop', messageId: 'workshop-reply', text: 'Synthetic words nobody logs, and more', status: 'running' })
  await expect.poll(() => peer.messages.some(message => message.event === 'detail-delta' || message.event === 'detail')).toBe(true)
  fixture.native.event({ type: 'stream', threadId: 'workshop', messageId: 'workshop-reply', text: 'Synthetic words nobody logs, done', status: 'idle' })
  await expect.poll(() => fixture.host.service.shell().host.threads.find(thread => thread.id === workshop.id)?.status).toBe('idle')
  await new Promise(resolve => setTimeout(resolve, 200))
  sends.flush()

  const kinds = Object.assign({}, ...lines.map(line => line.kinds)) as PhoneSendsLine['kinds']
  expect(kinds.shell?.frames).toBeGreaterThan(0)
  expect(kinds.answer?.frames).toBeGreaterThan(0)
  expect(Object.keys(kinds).some(kind => kind === 'detail' || kind === 'detail-delta')).toBe(true)
  expect(lines.some(line => line.threads[workshop.id] !== undefined)).toBe(true)
  expect(lines.some(line => (line.fields.status ?? 0) > 0)).toBe(true)
  // Sizes and names only: no title and no word of the thread.
  expect(JSON.stringify(lines)).not.toContain('Synthetic words nobody logs')
  expect(JSON.stringify(lines)).not.toContain('Workshop')
})

it('notes nothing a desktop is sent', async () => {
  const lines: PhoneSendsLine[] = []
  const sends = phoneSends(line => lines.push(line))
  const listener = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing, port: 0, phoneSends: sends })
  cleanups.push(() => listener.close())
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Synthetic desktop')
  const peer = await rawPeer(listener.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
  cleanups.push(() => peer.frames.close())
  await peer.call('hello', { op: 'hello', afterSeq: Number.MAX_SAFE_INTEGER, accepts: PHONE_ACCEPTS })
  fixture.native.event({ type: 'stream', threadId: 'workshop', messageId: 'workshop-reply', text: 'Synthetic reply', status: 'running' })
  await expect.poll(() => peer.messages.filter(message => message.event === 'shell').length).toBeGreaterThan(0)
  sends.flush()
  expect(lines).toEqual([])
})
