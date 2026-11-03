// @vitest-environment node
/**
 * What one answer from an iPhone is sent back, from the listener itself, over the real socket. A command's reply is the
 * same shell whichever command it was, so `select-project` stands in for the answer. The bytes a phone waits for are counted, not timed: on one socket a message waits behind every byte before it, so seconds are these
 * bytes over whatever the link gives at that moment. Thread records are synthetic, padded to the laptop's average of
 * 2,147 bytes, and the fixture has no Watcher page, so this understates a real computer's shell; the note gives those
 * (docs/perf/2026-11-02-iphone-answer-bytes.md). It runs only under `SOTTO_PERF_BENCH=1`:
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

describe.skipIf(!PERF_BENCH)('what one answer from an iPhone is sent back', () => {
  it.each([['a host without the connect cuts', OLD_HOST], ['a host with them', CUT]] as const)('on %s', async (name, accepts) => {
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
