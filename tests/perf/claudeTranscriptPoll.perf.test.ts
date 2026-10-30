// @vitest-environment node
/**
 * What Claude's transcript poll costs main while nothing happens, and what opening a thread costs, against how many
 * threads are saved (#992). The adapter is connected over the fake CLI with `threads` saved threads of 40 entries each
 * and one on screen. Over an idle window it counts the transcripts each tick reads, the time inside those reads and the
 * process's CPU per tick. Then it opens five untouched threads, and five whose transcripts gained twenty entries typed
 * in Claude Code outside Sotto before the window, and times each open, the transcript read inside it, and the bytes it
 * read. It prints JSON and asserts nothing, so it runs only under `SOTTO_PERF_BENCH=1`.
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/claudeTranscriptPoll.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { ClaudeSessionLog } from '../../src/main/agents/claudeSessionLog'
import { claudeFixture } from '../fixtures/claudeFixture'
import { median, PERF_BENCH } from '../fixtures/perfBench'

const INTERVAL_MS = 100
const IDLE_MS = 3_000
const OPENS = 5

const entry = (sessionId: string, index: number, text: string): string => JSON.stringify({ type: index % 2 ? 'assistant' : 'user', sessionId, uuid: randomUUID(),
  timestamp: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(), message: { role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text }] } })
const transcript = (sessionId: string, from: number, count: number): string =>
  Array.from({ length: count }, (_, line) => entry(sessionId, from + line, `Synthetic line ${from + line} `.repeat(20))).join('\n') + '\n'

/** Every transcript read, how long each took on the machine's clock, and how far each log has read. */
const reads = { calls: 0, ms: 0 }
const nativePoll = ClaudeSessionLog.prototype.poll
ClaudeSessionLog.prototype.poll = async function (this: ClaudeSessionLog) {
  const started = performance.now()
  try { return await nativePoll.call(this) } finally { reads.calls++; reads.ms += performance.now() - started }
}
const offset = (log: ClaudeSessionLog | undefined): number => log?.cursor()?.offset ?? 0

it.skipIf(!PERF_BENCH)('times Claude\'s idle transcript poll and opening a thread, against the saved threads', async () => {
  const report: Record<string, unknown> = {}
  for (const threads of [132, 264]) {
    const root = await mkdtemp(join(tmpdir(), 'sotto-claude-poll-'))
    const folder = join(root, 'home', 'projects', root.replace(/[^a-zA-Z0-9]/gu, '-'))
    await mkdir(folder, { recursive: true })
    const aliases: Record<string, unknown> = {}
    const sessions = new Map<string, string>()
    for (let index = 0; index < threads; index++) {
      const id = randomUUID(), sessionId = randomUUID()
      sessions.set(id, sessionId)
      aliases[id] = { sessionId, projectId: 'project', cwd: root, title: `Saved ${index}`, modelId: 'fixture-model', createdAt: new Date(Date.UTC(2026, 9, 1)).toISOString(), origins: [], answeredRequestIds: [] }
      await writeFile(join(folder, `${sessionId}.jsonl`), transcript(sessionId, 0, 40))
    }
    await writeFile(join(root, 'claude-threads.json'), JSON.stringify(aliases))
    await writeFile(join(root, 'claude-projects.json'), JSON.stringify([{ id: 'project', title: 'Project', path: root }]))
    const f = await claudeFixture(root, 2000, undefined, { pollIntervalMs: INTERVAL_MS })
    try {
      await f.host.connect()
      const ids = [...sessions.keys()]
      const { logs, messageLog } = f.adapter as unknown as { logs: Map<string, ClaudeSessionLog>; messageLog: { summary(id: string): { messageCount: number } } }
      // One thread on screen, as a pane holds it.
      f.adapter.observeThreads([ids[0]!])
      await delay(1_000)
      const untouched = ids.slice(1, 1 + OPENS), outside = ids.slice(1 + OPENS, 1 + 2 * OPENS)
      // Work typed in Claude Code outside Sotto on threads nobody looks at, a while before they are opened.
      for (const id of outside) await appendFile(join(folder, `${sessions.get(id)}.jsonl`), transcript(sessions.get(id)!, 40, 20))
      reads.calls = 0; reads.ms = 0
      const cpu = process.cpuUsage(), started = performance.now()
      await delay(IDLE_MS)
      const used = process.cpuUsage(cpu), elapsed = performance.now() - started
      const ticks = elapsed / INTERVAL_MS
      const idle = { transcriptsReadPerTick: Math.round(reads.calls / ticks * 10) / 10, readMsPerTick: Math.round(reads.ms / ticks * 100) / 100,
        cpuMsPerTick: Math.round((used.user + used.system) / 1000 / ticks * 100) / 100 }
      const open = async (group: readonly string[]) => {
        const samples: { ms: number; readMs: number; bytes: number }[] = []
        for (const id of group) {
          const before = offset(logs.get(id))
          reads.calls = 0; reads.ms = 0
          const at = performance.now()
          await f.adapter.refreshThread(id)
          samples.push({ ms: performance.now() - at, readMs: reads.ms, bytes: offset(logs.get(id)) - before })
          // Nothing typed outside Sotto is lost: it is there once the thread is open.
          expect(messageLog.summary(id).messageCount).toBe(group === outside ? 60 : 40)
        }
        return { openMs: Math.round(median(samples.map(sample => sample.ms)) * 10) / 10, readMsInOpen: Math.round(median(samples.map(sample => sample.readMs)) * 100) / 100,
          bytesReadInOpen: Math.round(median(samples.map(sample => sample.bytes))) }
      }
      report[`${threads} threads`] = { idle, openUntouched: await open(untouched), openAfterOutsideWork: await open(outside) }
    } finally { await f.cleanup() }
  }
  console.log(`CLAUDE-POLL ${JSON.stringify(report)}`)
  expect(Object.keys(report)).toHaveLength(2)
}, 600_000)
