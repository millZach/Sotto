// @vitest-environment node
/**
 * What reading Codex's rollouts costs main at a restart, against how many threads are saved (#992). Each saved thread
 * has a rollout of about 2 MB: turns of a question, tool output and an answer, as Codex writes them. The adapter is
 * connected over the fake app-server once and every rollout read to its end, as a run leaves them; then five threads
 * gain a turn typed in Codex outside Sotto and Sotto starts again. Over that second run it reports the connect's time,
 * the rollout bytes main read from the connect until the reads settle and the CPU that took, the rollouts each idle
 * tick reads, and opening five untouched threads and the five with outside work: each open's time and the bytes it read.
 * It prints JSON and asserts nothing, so it runs only under `SOTTO_PERF_BENCH=1`.
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/codexRolloutTail.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, open as openFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, expect, it } from 'vitest'
import { CodexSessionLogWatcher } from '../../src/main/agents/codexSessionLog'
import { codexFixture } from '../fixtures/codexFixture'
import { median, PERF_BENCH } from '../fixtures/perfBench'

const INTERVAL_MS = 100
const ROLLOUT_BYTES = 2_000_000
const OPENS = 5
const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

const line = (at: number, type: string, payload: unknown): string => `${JSON.stringify({ timestamp: new Date(Date.UTC(2026, 8, 10, 0, 0, at)).toISOString(), type, payload })}\n`
/** One turn as Codex writes it: its context, the question, two tool outputs, the answer and its completion. */
function turn(index: number, question = `Synthetic question ${index}`): string {
  const id = `turn-${index}`
  return line(index, 'turn_context', { turn_id: id }) + line(index, 'event_msg', { type: 'task_started', turn_id: id })
    + line(index, 'event_msg', { type: 'user_message', message: question })
    + line(index, 'response_item', { type: 'function_call_output', output: `Synthetic output ${index} `.repeat(150) })
    + line(index, 'response_item', { type: 'function_call_output', output: `Synthetic listing ${index} `.repeat(150) })
    + line(index, 'event_msg', { type: 'agent_message', message: `Synthetic answer ${index}` })
    + line(index, 'response_item', { type: 'message', role: 'assistant', id: `msg-${index}`, content: [{ type: 'output_text', text: `Synthetic answer ${index}` }] })
    + line(index, 'event_msg', { type: 'task_complete', turn_id: id })
}

/** Every byte main reads from a file, counted as each read returns. */
const bytes = { read: 0 }
async function countReads(): Promise<() => void> {
  const probe = await openFile(process.execPath, 'r')
  const handles = Object.getPrototypeOf(probe) as { read(...args: unknown[]): Promise<{ bytesRead: number }> }
  await probe.close()
  const native = handles.read
  handles.read = async function (this: unknown, ...args: unknown[]) { const result = await native.apply(this, args); bytes.read += result.bytesRead; return result }
  return () => { handles.read = native }
}

/** What every tail has read, from the watcher the adapter holds. */
const tails = (adapter: unknown): Map<string, { offset: number }> =>
  ((adapter as { watcher?: unknown }).watcher as unknown as { tails: Map<string, { offset: number }> } | undefined)?.tails ?? new Map()
const sumOffsets = (adapter: unknown): number => [...tails(adapter).values()].reduce((sum, tail) => sum + tail.offset, 0)

it.skipIf(!PERF_BENCH)('times Codex\'s rollout reads at a restart, and opening a thread, against the saved threads', async () => {
  const report: Record<string, unknown> = {}
  for (const threads of [46, 92]) {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-tail-')); roots.push(root)
    const folder = join(root, 'home', 'sessions', '2026', '09', '10')
    await mkdir(folder, { recursive: true })
    const aliases: Record<string, unknown> = {}, fake: Record<string, unknown> = {}, rollouts = new Map<string, string>()
    let turns = 0
    for (let index = 0; index < threads; index++) {
      const id = randomUUID(), codexThreadId = randomUUID()
      rollouts.set(id, join(folder, `rollout-2026-09-10-${codexThreadId}.jsonl`))
      aliases[id] = { codexThreadId, projectId: 'project', cwd: root, title: `Saved ${index}`, modelId: 'fixture-model', createdAt: new Date(Date.UTC(2026, 8, 10)).toISOString() }
      fake[codexThreadId] = { id: codexThreadId, cwd: root, model: 'fixture-model', createdAt: 1_789_000_000, status: { type: 'idle' }, turns: [], approvalPolicy: 'on-request', sandbox: 'workspace-write', reasoningEffort: 'low', serviceTier: 'default' }
      let text = line(0, 'session_meta', { id: codexThreadId })
      for (turns = 0; Buffer.byteLength(text) < ROLLOUT_BYTES; turns++) text += turn(turns)
      await writeFile(rollouts.get(id)!, text)
    }
    await writeFile(join(root, 'codex-threads.json'), JSON.stringify(aliases))
    await writeFile(join(root, 'codex-projects.json'), JSON.stringify([{ id: 'project', title: 'Project', path: root }]))
    await writeFile(join(root, 'state.json'), JSON.stringify({ threads: fake }))
    const total = [...rollouts.values()].length * ROLLOUT_BYTES
    const settled = async (adapter: unknown, bytes: number): Promise<void> => {
      for (const deadline = performance.now() + 300_000; sumOffsets(adapter) < bytes;) {
        if (performance.now() > deadline) throw new Error('The rollouts were never read to their end')
        await delay(20)
      }
    }
    // A run that read every rollout to its end, then quit.
    const first = await codexFixture(root, false, 2000, { pollIntervalMs: INTERVAL_MS })
    await first.host.connect()
    await settled(first.adapter, total)
    await delay(3 * INTERVAL_MS)
    first.adapter.disconnect(); await first.adapter.closed?.()
    // What the saved positions hold on disk, where the run saved them.
    const positions = join(root, 'codex-rollouts')
    const savedPositionBytes = (await Promise.all((await readdir(positions).catch(() => [] as string[])).map(async name => (await stat(join(positions, name))).size))).reduce((sum, size) => sum + size, 0)
    const ids = [...rollouts.keys()]
    const untouched = ids.slice(0, OPENS), outside = ids.slice(OPENS, 2 * OPENS)
    // While Sotto was closed, a turn typed in Codex outside it on five threads.
    for (const id of outside) await appendFile(rollouts.get(id)!, turn(turns, `Typed in Codex while away ${id}`))
    const sizes = new Map(await Promise.all(ids.map(async id => [id, (await stat(rollouts.get(id)!)).size] as const)))
    const second = await codexFixture(root, false, 2000, { pollIntervalMs: INTERVAL_MS })
    const uncount = await countReads()
    try {
      bytes.read = 0
      const cpu = process.cpuUsage(), started = performance.now()
      await second.host.connect()
      const connectMs = performance.now() - started
      // The reads a restart makes: until main has read nothing more for a second.
      let last = -1
      for (let quiet = 0; quiet < 10;) { await delay(INTERVAL_MS); quiet = bytes.read === last ? quiet + 1 : 0; last = bytes.read }
      const used = process.cpuUsage(cpu)
      const restart = { connectMs: Math.round(connectMs), bytesRead: bytes.read, cpuMs: Math.round((used.user + used.system) / 1000) }
      const reads = { calls: 0 }
      const nativePoll = CodexSessionLogWatcher.prototype.pollThread
      CodexSessionLogWatcher.prototype.pollThread = function (this: CodexSessionLogWatcher, ...args: Parameters<CodexSessionLogWatcher['pollThread']>) { reads.calls++; return nativePoll.apply(this, args) }
      const idleStarted = performance.now()
      await delay(2_000)
      CodexSessionLogWatcher.prototype.pollThread = nativePoll
      const idle = { rolloutsReadPerTick: Math.round(reads.calls / ((performance.now() - idleStarted) / INTERVAL_MS) * 10) / 10 }
      const open = async (group: readonly string[]) => {
        const samples: { ms: number; bytes: number }[] = []
        for (const id of group) {
          bytes.read = 0
          const at = performance.now()
          await (second.adapter as unknown as { open(id: string): Promise<void> }).open(id)
          samples.push({ ms: performance.now() - at, bytes: bytes.read })
          // Opened, its rollout has been read to its end.
          expect([...tails(second.adapter).entries()].find(([codexThreadId]) => rollouts.get(id)!.includes(codexThreadId))![1].offset).toBe(sizes.get(id))
        }
        return { openMs: Math.round(median(samples.map(sample => sample.ms)) * 10) / 10, bytesReadInOpen: Math.round(median(samples.map(sample => sample.bytes))) }
      }
      report[`${threads} threads`] = { savedRolloutBytes: total, savedPositionBytes, restart, idle, openUntouched: await open(untouched), openAfterOutsideWork: await open(outside) }
    } finally { uncount(); second.adapter.disconnect(); await second.adapter.closed?.() }
  }
  console.log(`CODEX-TAIL ${JSON.stringify(report)}`)
  expect(Object.keys(report)).toHaveLength(2)
}, 900_000)
