// @vitest-environment node
/**
 * What one repeat shell push costs a paired phone with and without `model-catalog-revision` (issue #699). The
 * host lists 753 synthetic models, the size of the owner's installed catalog when the issue was filed. It reads
 * only byte counts and durations, so no thread content is reported. It asserts no time, so it runs only under
 * `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/socketCatalogRevision.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * Two raw peers share one session on one listener, as the iPhone speaks the wire: one accepts the feature and
 * one does not, which is every phone before it. Each publish goes to both. The sizes are of the frames as they
 * arrive. Beside them, the listener's own new work per publish for an accepting peer, which is comparing the
 * catalog it was handed against the one its revision names, and the work it no longer does, which is
 * serializing that catalog into the frame.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { startSocketServer } from '../../src/host/socketServer'
import { ModelCatalogRevisions } from '../../src/main/agents/agentStateBroadcast'
import type { HostService } from '../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { hostCatalogKey } from '../../src/shared/agents'
import { syntheticModelCatalog } from '../fixtures/modelCatalog'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { rawPeer } from '../fixtures/rawHostPeer'

const MODELS = 753
const REPEATS = 20
const ITERATIONS = 40

describe.skipIf(!PERF_BENCH)("socket shell with and without the model catalog (timing benchmark; requires SOTTO_PERF_BENCH=1)", () => {
  let root = ''
  let close: (() => Promise<void>) | undefined
  afterAll(async () => { await close?.(); if (root) await rm(root, { recursive: true, force: true }) })

  it('reports the bytes of one repeat shell push to a phone that names the catalog by revision and to one that does not', async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-perf-socket-catalog-'))
    const host = await startHeadlessHost({ dataDirectory: root, port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
    const models = syntheticModelCatalog(MODELS)
    let publish = (): void => undefined
    // A fresh copy on every read, as the coordinator's shell is rebuilt on every publish.
    const service: HostService = {
      shell: () => { const state = host.service.shell(); return { ...state, host: { ...state.host, models: structuredClone(models) } } },
      state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
      command: (command, identity) => host.service.command(command, identity), events: () => [],
      subscribe: listener => { publish = () => listener(service.shell()); return () => undefined },
    }
    const server = await startSocketServer({ service, pairing: host.pairing })
    close = async () => { await server.close(); await host.close() }
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'iPhone')
    const session = host.pairing.signSession(paired.clientId)
    const named = await rawPeer(server.descriptor.port, session), whole = await rawPeer(server.descriptor.port, session)
    try {
      await named.call('hello', { op: 'hello', accepts: ['detail-delta', 'client-liveness', 'model-catalog-revision'] })
      await whole.call('hello', { op: 'hello', accepts: ['detail-delta', 'client-liveness'] })
      const bytes = (message: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(message))
      const shells = (peer: typeof named) => peer.messages.filter(message => message.event === 'shell')
      for (let index = 0; index < REPEATS; index++) {
        const before = shells(named).length
        publish()
        await expect.poll(() => shells(named).length > before && shells(whole).length > before).toBe(true)
      }
      const namedShells = shells(named), wholeShells = shells(whole)
      expect(namedShells.every(message => !('models' in (message.state as { host: object }).host))).toBe(true)
      const catalogBytes = Buffer.byteLength(JSON.stringify(models))

      const revisions = new ModelCatalogRevisions(), key = hostCatalogKey(host.service.shell().hostId)
      revisions.revisionFor(key, structuredClone(models))
      const time = (work: () => unknown): number => {
        for (let index = 0; index < 5; index++) work()
        const samples: number[] = []
        for (let index = 0; index < ITERATIONS; index++) { const started = performance.now(); work(); samples.push(performance.now() - started) }
        return round(median(samples), 3)
      }
      const copies = Array.from({ length: ITERATIONS + 5 }, () => structuredClone(models))
      let copy = 0
      const wholeState = wholeShells.at(-1)!.state, namedState = namedShells.at(-1)!.state
      const report = {
        models: MODELS, repeats: REPEATS, catalogBytes,
        repeatShellBytes: { whole: median(wholeShells.map(bytes)), named: median(namedShells.map(bytes)) },
        ms: {
          compareCatalog: time(() => revisions.revisionFor(key, copies[copy++ % copies.length]!)),
          serializeWhole: time(() => JSON.stringify({ v: 1, event: 'shell', state: wholeState })),
          serializeNamed: time(() => JSON.stringify({ v: 1, event: 'shell', state: namedState })),
        },
      }
      console.info(`socket catalog revision: ${JSON.stringify(report)}`)
    } finally { named.frames.close(); whole.frames.close() }
  }, 120_000)
})
