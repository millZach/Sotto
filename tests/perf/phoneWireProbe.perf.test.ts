// @vitest-environment node
/**
 * The phone wire probe (`scripts/perf-bench/phone-wire-probe.mjs`) against a test listener, with the phone compression
 * switch off and on (#2394). Main at the owner's scale (`ownerScalePipeline.ts`, every payload generated) is served by a
 * listener with the administrative routes, which the probe pairs through, and a listener shaped like a headless host's
 * tailnet listener with no desktop recorded, which the probe reaches as a phone. The probe offers `permessage-deflate`
 * bare, as the iPhone's URLSession does, and prints what it was sent: each message's size, the estimate of it compressed,
 * and the bytes it took on the wire. It prints JSON and asserts only that the probe ran, so it runs only under
 * `SOTTO_PERF_BENCH=1` (`docs/perf/2026-11-10-phone-compression.md`).
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/phoneWireProbe.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * `SOTTO_PROBE_SECONDS` sets how long the probe stays on the Threads list and on the opened thread (5 by default).
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { ownerScalePipeline } from '../fixtures/ownerScalePipeline'

const BENCH = process.env.SOTTO_PERF_BENCH === '1'
const SECONDS = Number(process.env.SOTTO_PROBE_SECONDS ?? '5')
const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

/** Runs the probe on `data` and answers its report, which holds sizes, counts and field names only. */
function probe(data: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/perf-bench/phone-wire-probe.mjs', '--data', data, '--offer-deflate', '--list-seconds', String(SECONDS), '--thread-seconds', String(SECONDS)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (part: Buffer) => { out += part.toString('utf8') })
    child.stderr.on('data', (part: Buffer) => { err += part.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`The probe exited ${code}: ${err.slice(0, 400)}`)); return }
      try { resolve(JSON.parse(out) as Record<string, unknown>) } catch { reject(new Error('The probe printed something that is not JSON')) }
    })
  })
}

it.skipIf(!BENCH)('measures what a phone is sent over a test listener, with phone compression off and on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-phone-probe-')); roots.push(root)
  const p = await ownerScalePipeline(join(root, 'main'), { threads: 1, history: 1 }, 3, 'owl')
  const service = new LocalHostService({ control: p.control, events: p.workspace, ...(p.watcher ? { watcher: p.watcher } : {}) })
  const pairing = new PairedClients(join(root, 'main'))
  await pairing.load()
  const admin = await startSocketServer({ service, pairing, port: 0 })
  const reports: Record<string, Record<string, unknown>> = {}
  try {
    for (const compressPhones of [false, true]) {
      const phones = await startSocketServer({ service, pairing, port: 0, admin: false, observationKey: 'phones', ...(compressPhones ? { compressPhones } : {}),
        tailnet: { phonesAdmitted: () => true, desktops: { has: () => false, refresh: async () => undefined } } })
      try {
        // The probe's own view of a host: the descriptor with the administrative port and token, and the tailnet listener's port.
        const data = join(root, compressPhones ? 'on' : 'off')
        await mkdir(data, { recursive: true })
        await writeFile(join(data, 'host-listener.json'), JSON.stringify({ ...admin.descriptor, adminToken: admin.adminToken }))
        await writeFile(join(data, 'phone-access.json'), JSON.stringify({ port: phones.descriptor.port }))
        reports[compressPhones ? 'switchOn' : 'switchOff'] = await probe(data)
      } finally { await phones.close() }
    }
  } finally { await admin.close(); await p.stop() }
  console.log(`PHONE-WIRE-PROBE ${JSON.stringify({ counts: p.counts, seconds: SECONDS, ...reports }, null, 1)}`)
  expect(reports.switchOff?.negotiated).toBeNull()
  expect(reports.switchOn?.negotiated).toBe('permessage-deflate; server_no_context_takeover; client_no_context_takeover')
}, 600_000)
