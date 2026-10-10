// @vitest-environment node
/**
 * What one draft save's reply costs to carry when the host lists 608 models (issue #323). The catalog is
 * synthetic (`tests/fixtures/modelCatalog.ts`) and the timers read nothing but durations and byte counts,
 * so no model or draft content is reported. It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1`
 * (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/commandReceipt.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * The draft save goes the way the desktop window sends it: the page's wrapped bridge, the preload's
 * bridge and its schema, the `AGENT_COMMAND` handler, the desktop host router and the local host service,
 * joined as `index.ts` joins them (`tests/fixtures/commandReceiptWindow.ts`), with the window already sent
 * the catalog once by the broadcast. Each stage is timed alone. `node:v8`'s `serialize` stands in for
 * Electron's structured clone, as it did for ADR-0028: its length is the reply's size on the wire and a
 * serialize and deserialize is the copy.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serialize } from 'node:v8'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { PublishScheduler } from '../../src/main/agents/control'
import { AGENT_COMMAND, type AgentCommand, type AgentCommandReceipt } from '../../src/shared/agents'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'D:/fixture' },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))
import { clone, commandReceiptWindow } from '../fixtures/commandReceiptWindow'

const WARMUP = 5
const ITERATIONS = 40

/** The broadcast is sent by hand below; holding the coordinator's own publish closed keeps it out of the timing. */
const neverPublish: PublishScheduler = () => () => undefined

async function time(work: () => unknown): Promise<number> {
  for (let index = 0; index < WARMUP; index++) await work()
  const samples: number[] = []
  for (let index = 0; index < ITERATIONS; index++) {
    const started = performance.now()
    await work()
    samples.push(performance.now() - started)
  }
  return round(median(samples), 3)
}

describe.skipIf(!PERF_BENCH)("command receipt size (timing benchmark; requires SOTTO_PERF_BENCH=1)", () => {
  let root = ''
  let dispose: (() => void) | undefined
  afterAll(async () => {
    dispose?.()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('reports what one draft save reply carries and costs with a 608-model catalog', async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-perf-command-receipt-'))
    // The window: the preload's own bridge over an IPC stand-in that copies each answer the way a clone
    // would, wrapped by the page the way `AgentContext` wraps it, and sent the catalog once by the broadcast.
    const window = await commandReceiptWindow(root, neverPublish)
    dispose = () => window.dispose()
    const { router, broadcaster, handle, preload, page } = window
    expect(router.shell().host.models.length).toBe(609)
    window.broadcast()
    expect(window.seen).toHaveLength(1)

    let typed = 0
    const draft = (): AgentCommand => ({ type: 'save-thread-draft', threadId: 'workshop', draftId: randomUUID(), text: `Draft ${typed++}` })

    const reply = await handle(AGENT_COMMAND, draft()) as AgentCommandReceipt
    const answered = await page.command(draft())
    expect(answered.host.models).toHaveLength(609)
    expect(answered.threadDraftPersistence?.some(entry => entry.threadId.endsWith('workshop'))).toBe(true)

    const report = {
      models: router.shell().host.models.length,
      catalogBytes: serialize(router.shell().host.models).length,
      replyBytes: serialize(reply).length,
      ms: {
        handler: await time(() => handle(AGENT_COMMAND, draft())),
        // The receipt's own encoding: a content comparison per catalog in main. A fresh shell each time,
        // built ahead, as each command's own reply is.
        receiptEncode: await (async () => {
          const shells = Array.from({ length: WARMUP + ITERATIONS }, () => router.shell())
          return time(() => broadcaster.encodeReceipt(shells.pop()!))
        })(),
        clone: await time(() => clone(reply)),
        preload: await (async () => {
          window.held = { reply: clone(reply) }
          try { return await time(() => preload.command(draft())) } finally { window.held = null }
        })(),
        windowRoundTrip: await time(() => page.command(draft())),
      },
    }
    console.info(`command receipt: ${JSON.stringify(report)}`)
  }, 120_000)
})
