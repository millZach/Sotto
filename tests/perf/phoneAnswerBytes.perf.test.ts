// @vitest-environment node
/**
 * What one answer from an iPhone is sent back, from the listener itself, over the real socket. A command's reply is the
 * same shell whichever command it was, so `select-project` stands in for the answer. The bytes a phone waits for are counted, not timed: on one socket a message waits behind every byte before it, so seconds are these
 * bytes over whatever the link gives at that moment. Thread records are synthetic, padded to the laptop's average of
 * 2,147 bytes, and the fixture has no Watcher page, so this understates a real computer's shell; the notes give those
 * (docs/perf/2026-11-02-iphone-answer-bytes.md, docs/perf/2026-11-02-iphone-command-reply-threads.md). The figures print
 * only under `SOTTO_PERF_BENCH=1`; the guard below them always runs:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/phoneAnswerBytes.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SocketFrames } from '../../src/host/socketFrames'
import type { AgentHostSnapshot, AgentThread } from '../../src/shared/agents'
import { PERF_BENCH } from '../fixtures/perfBench'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const raws: SocketFrames[] = []
afterEach(() => { for (const frames of raws.splice(0)) frames.close() })

const OPEN = 7, SETTLED = 625, RECORD_BYTES = 2_147
/** What an iPhone accepts that changes what a shell costs (`IncomingFrame.swift`). */
const OLD_HOST: string[] = ['provider-opencode', 'provider-cursor', 'changed-thread-records', 'model-catalog-revision']
const CUT = [...OLD_HOST, 'reply-thread-records', 'provider-mode-lists', 'settled-threads-on-request', 'usable-models']
const CHANGED_ANSWERS = [...CUT, 'command-changed-thread-records']

async function laptopThreads(): Promise<string> {
  await expect.poll(() => fixture.host.service.shell().host.threads.length).toBeGreaterThan(0)
  const native = fixture.native as unknown as { state: AgentHostSnapshot; emit(): void }
  const base = native.state.threads[0]!
  const size = Buffer.byteLength(JSON.stringify(base))
  const title = 'x'.repeat(Math.max(1, RECORD_BYTES - size))
  const settledAt = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const made: AgentThread[] = Array.from({ length: OPEN + SETTLED }, (_, index) => ({ ...base, id: `bench-${index}`, title,
    ...index < OPEN ? {} : { settledAt } }))
  native.state.threads = made
  native.emit()
  await expect.poll(() => fixture.host.service.shell().host.threads.filter(thread => thread.id.startsWith('bench-') || thread.title === title).length).toBeGreaterThanOrEqual(OPEN + SETTLED)
  return base.projectId
}

async function phone(accepts: string[]) {
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
  const raw = await rawPeer(fixture.host.descriptor!.port, fixture.host.pairing.signSession(paired.clientId))
  raws.push(raw.frames)
  const bytes = async (id: string, operation: Record<string, unknown>): Promise<number> =>
    Buffer.byteLength(JSON.stringify(await raw.call(id, operation)))
  await bytes('hello', { op: 'hello', accepts })
  return bytes
}
/** Tells the fixture's host that the first `count` listed threads changed, as `count` threads working at once would. */
function changeThreads(count: number): void {
  const native = fixture.native as unknown as { state: AgentHostSnapshot; emit(): void }
  native.state.threads = native.state.threads.map((thread, index) => index < count ? { ...thread, title: thread.title.slice(0, -8) + String(Date.now() % 1e8).padStart(8, '0') } : thread)
  native.emit()
}

describe.skipIf(!PERF_BENCH)('what one answer from an iPhone is sent back', () => {
  it.each([['a host without the connect cuts', OLD_HOST], ['a host with them', CUT], ['a host with them and changed records in answers', CHANGED_ANSWERS]] as const)('on %s', async (name, accepts) => {
    const projectId = await laptopThreads()
    const bytes = await phone([...accepts])
    const reply = await bytes('answer', { op: 'command', command: { type: 'select-project', projectId } })
    const read = await bytes('read', { op: 'shell' })
    const receipt = await bytes('receipt', { op: 'receipt', commandId: 'answer' })
    const before = reply + read + receipt, after = reply + receipt
    console.log(`${name}: reply ${Math.round(reply / 1024)} KB, shell read ${Math.round(read / 1024)} KB, receipt ${receipt} bytes. `
      + `Before ${Math.round(before / 1024)} KB, after ${Math.round(after / 1024)} KB.`)
    expect(after).toBeLessThan(before * 0.6)
  })
})

describe('a command\'s answer to an iPhone', () => {
  it('costs next to nothing beside a whole shell when every thread is listed and none changed', async () => {
    // Without `settled-threads-on-request` the 632 records listed are what an answer used to repeat: 1,559 KB.
    const projectId = await laptopThreads()
    const bytes = await phone(CHANGED_ANSWERS.filter(feature => feature !== 'settled-threads-on-request'))
    const answer = await bytes('answer', { op: 'command', command: { type: 'select-project', projectId } })
    const read = await bytes('read', { op: 'shell' })
    expect(read).toBeGreaterThan((OPEN + SETTLED) * RECORD_BYTES)
    expect(answer).toBeLessThan(read * 0.02)
  })
  it('grows only by the records that changed', async () => {
    const projectId = await laptopThreads()
    const quiet = await (await phone(CHANGED_ANSWERS))('quiet', { op: 'command', command: { type: 'select-project', projectId } })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
    const raw = await rawPeer(fixture.host.descriptor!.port, fixture.host.pairing.signSession(paired.clientId))
    raws.push(raw.frames)
    await raw.call('hello', { op: 'hello', accepts: CHANGED_ANSWERS })
    changeThreads(2)
    const answered = await raw.call('changed', { op: 'command', command: { type: 'select-project', projectId } })
    const { threadRecords } = (answered as { result: { threadRecords: { changed: AgentThread[] } } }).result
    expect(threadRecords.changed.length).toBeLessThanOrEqual(2)
    // A push can go first and leave the answer less to carry, so what is compared is the rest of the answer.
    expect(Buffer.byteLength(JSON.stringify(answered)) - Buffer.byteLength(JSON.stringify(threadRecords.changed))).toBeLessThan(quiet + 1024)
  })
})
