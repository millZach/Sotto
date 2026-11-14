// @vitest-environment node
/**
 * What a phone's shell weighs on a host whose state holds what a busy host's does (#2392): the bytes of a hello, a
 * `shell` read and a push to a phone and to a desktop, over the real listener, with the parts around the threads in the
 * sizes forge's host sent on November 10, 2026 (`tests/fixtures/shellParts.ts`). Before the change the phone's and the
 * desktop's were the same size; the difference now is `PHONE_UNREAD_SHELL_PARTS`.
 *
 * It prints JSON and asserts nothing, so it runs only under `SOTTO_PERF_BENCH=1`
 * (`docs/perf/2026-11-10-phone-shell-parts.md`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/phoneShellParts.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { afterEach, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { PERF_BENCH } from '../fixtures/perfBench'
import { rawPeer } from '../fixtures/rawHostPeer'
import { hostSizedShellParts, withShellParts } from '../fixtures/shellParts'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** The iPhone's hello, without Watcher's page, which the fixture host does not run. */
const PHONE_ACCEPTS = ['detail-delta', 'client-liveness', 'activity-summaries', 'model-catalog-revision', 'provider-opencode', 'provider-cursor', 'provider-deepseek',
  'changed-thread-records', 'reply-thread-records', 'provider-mode-lists', 'settled-threads-on-request', 'usable-models', 'command-changed-thread-records', 'step-window']
const bytes = (message: unknown): number => Buffer.byteLength(JSON.stringify(message))

it.skipIf(!PERF_BENCH)('weighs a hello, a read and a push to a phone and to a desktop', async () => {
  const service = withShellParts(fixture.host.service, hostSizedShellParts())
  const report: Record<string, Record<string, number>> = {}
  for (const [name, options] of [['phone', { admin: false as const }], ['desktop', { port: 0 }]] as const) {
    const listener = await startSocketServer({ service, pairing: fixture.host.pairing, ...options })
    cleanups.push(() => listener.close())
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, `Synthetic ${name}`)
    const peer = await rawPeer(listener.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    cleanups.push(() => peer.frames.close())
    const hello = await peer.call('hello', { op: 'hello', afterSeq: Number.MAX_SAFE_INTEGER, accepts: PHONE_ACCEPTS })
    const read = await peer.call('read', { op: 'shell' })
    const before = peer.messages.length
    fixture.native.event({ type: 'stream', threadId: 'workshop', messageId: `workshop-reply-${name}`, text: 'Synthetic reply', status: 'running' })
    await expect.poll(() => peer.messages.slice(before).some(message => message.event === 'shell')).toBe(true)
    const push = peer.messages.slice(before).find(message => message.event === 'shell')!
    const state = (push as { state: Record<string, unknown> & { host: Record<string, unknown> } }).state
    const parts = Object.fromEntries([...Object.entries(state).filter(([key]) => key !== 'host').map(([key, value]) => [key, bytes(value)] as const),
      ...Object.entries(state.host).map(([key, value]) => [`host.${key}`, bytes(value)] as const)].filter(([, size]) => size > 1_000))
    report[name] = { helloBytes: bytes(hello), shellReadBytes: bytes(read), pushBytes: bytes(push), ...parts }
    fixture.native.event({ type: 'stream', threadId: 'workshop', messageId: `workshop-reply-${name}`, text: 'Synthetic reply', status: 'idle' })
  }
  console.log(`PHONE-SHELL-PARTS ${JSON.stringify(report, null, 1)}`)
})
