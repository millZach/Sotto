// @vitest-environment node
/**
 * The phone wire probe (`scripts/perf-bench/phone-wire-probe.mjs`) against a host at forge's size, before and after phones
 * are compressed (#2394). Main is the host-sized fixture the transfer benchmark uses (`ownerScalePipeline` with `host`, as
 * `hostSocketScale` builds it), on the machine's own clock, with one thread working: its reply streams twenty chunks a
 * second and its token usage moves twice a second, as Claude's adapter reports it. It is served by a listener with the
 * administrative routes, which the probes pair through, and by two listeners shaped like a headless host's tailnet
 * listener with no desktop recorded, which the probes reach as phones: one that compresses for no phone, as every host did
 * before (and as one started with `SOTTO_HOST_COMPRESS_PHONES=0` does), and one that compresses for phones, as every phone
 * listener does now. Two probes run at once, one on each, both offering `permessage-deflate` bare as the iPhone's
 * URLSession does, so both see the same pushes. Each prints what it was sent: each message's size, the estimate of it
 * compressed, and the bytes it took on the wire. It asserts only that the probes ran and what each host answered, so it
 * runs only under `SOTTO_PERF_BENCH=1` (`docs/perf/2026-11-10-phone-compression.md`).
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/phoneWireProbe.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * `SOTTO_PROBE_SECONDS` sets how long each probe stays on the Threads list and on the opened thread (60 by default).
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { DEFLATE_RESPONSE } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { DESKTOP_WATCHER, grown } from '../fixtures/hostSocketScale'
import { ownerScalePipeline } from '../fixtures/ownerScalePipeline'

const BENCH = process.env.SOTTO_PERF_BENCH === '1'
const SECONDS = Number(process.env.SOTTO_PROBE_SECONDS ?? '60')
const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

type Report = Record<string, unknown> & { negotiated?: string | null; hello?: { bytes: number; wireBytes: number }; openThread?: { working?: boolean } }
/** Runs the probe on `data` and answers its report, which holds sizes, counts and field names only. */
function probe(data: string): Promise<Report> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/perf-bench/phone-wire-probe.mjs', '--data', data, '--offer-deflate', '--list-seconds', String(SECONDS), '--thread-seconds', String(SECONDS)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (part: Buffer) => { out += part.toString('utf8') })
    child.stderr.on('data', (part: Buffer) => { err += part.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`The probe exited ${code}: ${err.slice(0, 400)}`)); return }
      try { resolve(JSON.parse(out) as Report) } catch { reject(new Error('The probe printed something that is not JSON')) }
    })
  })
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

it.skipIf(!BENCH)('measures what a phone is sent by a host at forge\'s size, before and after phones are compressed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-phone-probe-')); roots.push(root)
  const main = join(root, 'main')
  // Paired before main is built, so main's Watcher record holds the desktop's work under its pairing, as forge's does.
  const pairing = new PairedClients(main)
  await pairing.load()
  const desktop = await pairing.redeem(pairing.issuePairingCode().code, 'Desktop')
  const p = await ownerScalePipeline(main, { threads: 1, history: 1 }, 3, 'owl', { host: { desktop: { clientId: desktop.clientId, master: DESKTOP_WATCHER } } })
  let streaming: ReturnType<typeof setInterval> | undefined
  const listeners: Awaited<ReturnType<typeof startSocketServer>>[] = []
  const reports: Record<string, Report> = {}
  try {
    // A host that has run a few seconds, as forge's had: a provider turned on but not connected at start is reconnected
    // 5 s later, and its models join the catalog before any phone connects.
    await wait(6_000)
    const service = new LocalHostService({ control: p.control, events: p.workspace, ...(p.watcher ? { watcher: p.watcher } : {}) })
    const admin = await startSocketServer({ service, pairing, port: 0 }); listeners.push(admin)
    const phones = async (compressPhones: boolean) => {
      const listener = await startSocketServer({ service, pairing, port: 0, admin: false, observationKey: compressPhones ? 'phones-after' : 'phones-before', compressPhones,
        tailnet: { phonesAdmitted: () => true, desktops: { has: () => false, refresh: async () => undefined } } })
      listeners.push(listener)
      // The probe's own view of a host: the descriptor with the administrative port and token, and the tailnet listener's port.
      const data = join(root, compressPhones ? 'after' : 'before')
      await mkdir(data, { recursive: true })
      await writeFile(join(data, 'host-listener.json'), JSON.stringify({ ...admin.descriptor, adminToken: admin.adminToken }))
      await writeFile(join(data, 'phone-access.json'), JSON.stringify({ port: listener.descriptor.port }))
      return data
    }
    const before = await phones(false), after = await phones(true)

    // One thread working, so the probes open it and are pushed what a phone is pushed while a reply streams.
    const session = p.streamSessions[0]!
    const thread = p.adapter.state.threads.find(item => item.id === session)!
    p.adapter.log.add(session, { id: 'prompt', role: 'user', text: 'Synthetic prompt', createdAt: new Date().toISOString() }); thread.status = 'running'; p.adapter.mark(session)
    p.adapter.log.add(session, { id: 'reply', role: 'assistant', text: 'First', createdAt: new Date().toISOString() })
    p.adapter.publish(true)
    let chunk = 0
    streaming = setInterval(() => {
      p.adapter.log.appendText(session, 'reply', ` word${chunk} and some more text`)
      if (++chunk % 10 === 0) { thread.usage = grown(thread.usage); p.adapter.mark(session) }
      p.adapter.publish(true)
    }, 50)
    await wait(1_000)

    const [beforeReport, afterReport] = await Promise.all([probe(before), probe(after)])
    reports.before = beforeReport; reports.after = afterReport
  } finally {
    clearInterval(streaming)
    for (const listener of listeners) await listener.close()
    await p.stop()
  }
  console.log(`PHONE-WIRE-PROBE ${JSON.stringify({ counts: p.counts, seconds: SECONDS, ...reports }, null, 1)}`)
  expect(reports.before?.negotiated).toBeNull()
  expect(reports.after?.negotiated).toBe(DEFLATE_RESPONSE)
  expect(reports.before?.openThread?.working).toBe(true)
  expect(reports.after?.openThread?.working).toBe(true)
}, 900_000)
