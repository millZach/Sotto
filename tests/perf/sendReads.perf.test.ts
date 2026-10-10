// @vitest-environment node
/**
 * What a send from the Threads page reads before the provider hears the prompt (#765), for Claude, Codex and Grok.
 * Each provider's real adapter runs under the whole host stack (`tests/fixtures/sendStack.ts`) against its fake
 * client from `tests/fixtures/`, a real child process, so the times include no model or network. A thread that
 * has had one exchange is on screen, and it is sent prompts one after another, each after the last one's turn
 * has finished. Each send counts the adapter's own `refreshThread` calls, the reads of the thread's history from
 * the provider before and after the prompt, the adapter's publishes, and the workspace's writes and publishes,
 * and times the send from the press to the coordinator's answer. `codexSendRead.perf.test.ts` is the same
 * question for one Codex thread as it grows. A Claude thread is also measured with 1,000 earlier exchanges in its
 * transcript, a 200-character prompt and a 1,200-character reply each, since every read Claude's adapter made
 * copied the messages it held. Counts and timers only: every prompt and reply is filler. It asserts
 * no time, so it runs only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/sendReads.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { claudeFixture } from '../fixtures/claudeFixture'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { nativeFixture, sendStack, type SendCost } from '../fixtures/sendStack'

const SENDS = 9

/** Append `exchanges` finished exchanges of filler to a fake Claude thread's transcript, as Claude Code writes them. */
async function longClaudeTranscript(f: Awaited<ReturnType<typeof claudeFixture>>, sessionId: string, exchanges: number): Promise<void> {
  const session = await f.realId(sessionId)
  const folder = join(f.root, 'home', 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'))
  await mkdir(folder, { recursive: true })
  const lines: string[] = []
  for (let index = 0; index < exchanges; index++) {
    const timestamp = new Date(Date.now() - (exchanges - index) * 60_000).toISOString()
    lines.push(JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp, message: { role: 'user', content: 'u'.repeat(200) } }),
      JSON.stringify({ type: 'assistant', uuid: randomUUID(), sessionId: session, timestamp, message: { id: `seeded-${index}`, role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(1200) }] } }))
  }
  await appendFile(join(folder, `${session}.jsonl`), lines.join('\n') + '\n')
  await f.adapter.pollSessionLogs()
}

describe.skipIf(!PERF_BENCH)("reads around a send from the Threads page (timing benchmark; requires SOTTO_PERF_BENCH=1)", () => {
  it.each([['claude', 0], ['claude', 1000], ['codex', 0], ['grok', 0]] as const)('%s after %i earlier exchanges', async (provider, earlier) => {
    const native = await nativeFixture(provider)
    const stack = await sendStack(provider, native, earlier ? sessionId => longClaudeTranscript(native as Awaited<ReturnType<typeof claudeFixture>>, sessionId, earlier) : undefined)
    try {
      const sends: SendCost[] = []
      for (let index = 0; index < SENDS; index++) {
        const cost = await stack.send()
        expect(cost.error).toBeNull()
        sends.push(cost)
      }
      const middle = (pick: (cost: SendCost) => number) => median(sends.map(pick))
      console.info(`send reads: ${JSON.stringify({ provider, earlierExchanges: earlier, sends: SENDS, sendMedianMs: round(middle(cost => cost.elapsedMs)),
        sendMinMs: round(Math.min(...sends.map(cost => cost.elapsedMs))), sendMaxMs: round(Math.max(...sends.map(cost => cost.elapsedMs))),
        adapterReads: middle(cost => cost.reads.length), readPurposes: sends.at(-1)!.reads,
        historyBeforePrompt: middle(cost => cost.history.before), historyAfterPrompt: middle(cost => cost.history.after),
        adapterPublishes: middle(cost => cost.emits), workspaceWrites: middle(cost => cost.workspaceWrites), workspacePublishes: middle(cost => cost.workspacePublishes) })}`)
    } finally { await stack.cleanup() }
  }, 180_000)
})
