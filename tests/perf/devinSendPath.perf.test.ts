// @vitest-environment node
/**
 * What a send to Devin costs before Devin hears the prompt, and how many observer processes a running turn starts
 * (#770). Against the fake ACP peer in `tests/fixtures/fakeDevinAgent.mjs` it sends five times to a warm thread the
 * way a send from the Threads page goes: the coordinator's read before the send (`beforeSend`), the checkpoint's
 * whole read of the thread, the send, and after acceptance the coordinator's reconciliation read. For each send it
 * reports the time from Send until the fake records `session/prompt`, the time until the send is accepted, the
 * processes started before the prompt and the observer reads (`session/load`) made through the reconciliation read. The fake starts streaming
 * the reply as soon as it has the prompt. It then leaves one streamed turn running for four seconds at the
 * production poll pace and counts the observer reads in that time.
 *
 * With `SOTTO_DEVIN_PIECES=1` it also times the pieces of a send against the installed Devin CLI without sending
 * any prompt: `plugins list` and `mcp list` one after the other and side by side, and an ACP process started,
 * initialized, asked for `_cognition.ai/config/read` and closed, which is most of what an observer read costs
 * besides replaying the session. It uses an owned profile in a temporary folder.
 *
 * Counters and timers only, and every text is synthetic. It asserts no time, so it runs only when asked:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/devinSendPath.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *   SOTTO_PERF_BENCH=1 SOTTO_DEVIN_PIECES=1 npx vitest run tests/perf/devinSendPath.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareDevinPolicy } from '../../src/main/agents/devinPolicy'
import { DevinRpc, devinEnvironment, findDevinExecutable } from '../../src/main/agents/devinRpc'
import { devinFixture } from '../fixtures/devinFixture'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const SENDS = 5
const prompts = (text: string): number => text.split('"method":"session/prompt"').length - 1

describe.skipIf(!PERF_BENCH)('Devin send path (#770)', () => {
  it('times warm sends from Send to session/prompt and counts what they start', async () => {
    const f = await devinFixture(undefined, 15_000, 60_000, {}, undefined, { acceptanceGraceMs: 1_500 })
    try {
      await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      const id = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Bench' })
      f.host.observeThreads([id])
      await f.script({ streamOnPrompt: 'Synthetic first words' })
      const log = join(f.root, 'requests.jsonl')
      const rows: { toPrompt: number; accepted: number; spawns: number; loads: number }[] = []
      for (let index = 0; index <= SENDS; index++) {
        const mark = (await f.driver.requests()).length
        const before = prompts(await readFile(log, 'utf8'))
        const started = performance.now()
        let toPrompt = Number.NaN
        let watching = true
        const watch = (async () => {
          while (watching) {
            if (prompts(await readFile(log, 'utf8')) > before) { toPrompt = performance.now() - started; return }
            await new Promise(resolve => setTimeout(resolve, 2))
          }
        })()
        await f.host.refreshThread(id, { beforeSend: true })
        await f.host.refreshThread(id)
        const result = await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: `Synthetic prompt ${index}` })
        const accepted = performance.now() - started
        await watch; watching = false
        // The coordinator's reconciliation read after an accepted prompt, outside the times above.
        await f.host.refreshThread(id)
        expect(result.accepted || result.uncertain).toBe(true)
        const records = (await f.driver.requests()).slice(mark)
        const prompt = records.findIndex(record => record.method === 'session/prompt')
        await f.driver.completeTurn(id, ' done')
        await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status, { timeout: 20_000 }).toBe('idle')
        // The first send is the thread's first prompt; the five after it are the warm ones measured.
        if (index === 0) continue
        rows.push({ toPrompt, accepted, spawns: records.slice(0, prompt).filter(record => record.method === 'fixture/spawn').length,
          loads: records.filter(record => record.method === 'session/load').length })
      }
      console.info('devin-send-path', {
        sendToPromptMs: round(median(rows.map(row => row.toPrompt))), acceptedMs: round(median(rows.map(row => row.accepted))),
        spawnsBeforePrompt: rows.map(row => row.spawns), observerReadsPerSend: rows.map(row => row.loads),
      })
    } finally { await f.cleanup() }
  }, 300_000)

  it('counts observer reads while a streamed turn runs at the production poll pace', async () => {
    const f = await devinFixture(undefined, 15_000, null, {}, undefined, { acceptanceGraceMs: 1_500 })
    try {
      await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      const id = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Bench' })
      f.host.observeThreads([id])
      await f.script({ streamOnPrompt: 'Synthetic first words' })
      const loads = async (): Promise<number> => (await f.driver.requests()).filter(record => record.method === 'session/load').length
      const before = await loads()
      await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: 'Synthetic long turn' })
      // A real wait on purpose: what is counted is what the poll timer does while the turn runs.
      await new Promise(resolve => setTimeout(resolve, 4_000))
      console.info('devin-running-turn', { observerReadsIn4s: (await loads()) - before })
      await f.driver.completeTurn(id, ' done')
    } finally { await f.cleanup() }
  }, 60_000)

  it.skipIf(process.env.SOTTO_DEVIN_PIECES !== '1')('times the pieces of a send against the installed Devin CLI, sending no prompt', async () => {
    const executable = await findDevinExecutable()
    if (!executable) throw new Error('Devin CLI was not found')
    const root = await mkdtemp(join(tmpdir(), 'sotto-devin-pieces-'))
    try {
      const profile = await prepareDevinPolicy(join(root, 'sotto'), 'nothing', root)
      const environment = devinEnvironment()
      const list = (...args: string[]): Promise<void> => new Promise((resolve, reject) => {
        execFile(executable, ['--config', profile.path, ...args], { cwd: root, env: environment, windowsHide: true, timeout: 30_000 }, error => error ? reject(new Error('list failed')) : resolve())
      })
      const timed = async (work: () => Promise<unknown>): Promise<number> => { const started = performance.now(); await work(); return performance.now() - started }
      const sequential: number[] = []; const parallel: number[] = []; const process: number[] = []
      for (let index = 0; index < SENDS; index++) {
        sequential.push(await timed(async () => { await list('plugins', 'list'); await list('mcp', 'list') }))
        parallel.push(await timed(() => Promise.all([list('plugins', 'list'), list('mcp', 'list')])))
        process.push(await timed(async () => {
          const rpc = new DevinRpc(executable, ['--config', profile.path, 'acp'], root, environment, 30_000, () => undefined, () => undefined)
          try {
            await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'sotto', version: '0.0.0' } })
            await rpc.request('_cognition.ai/config/read', {})
          } finally { rpc.close(); await rpc.closed }
        }))
      }
      console.info('devin-pieces', { listsOneAfterOtherMs: round(median(sequential)), listsSideBySideMs: round(median(parallel)), acpStartReadCloseMs: round(median(process)) })
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 300_000)
})
