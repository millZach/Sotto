/** Child-process workload for usageLedgerReport.perf.test.ts: one long thread's usage reports, synthetic usage only. */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeUsage } from '../../src/main/agents/nativeUsage'

const [seed, reportsText, provider = 'claude', turnsText = '0'] = process.argv.slice(2)
if (!seed || !reportsText || (provider !== 'claude' && provider !== 'codex')) throw new Error('Expected a seeded usage folder, how many reports to time and claude or codex')
const report = (id: string, output: number) => ({ type: 'assistant', timestamp: '2026-10-31T12:00:00.000Z',
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1_000, output_tokens: output, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 } } })
const root = await mkdtemp(join(tmpdir(), 'sotto-usage-report-'))
try {
  // The thread's ledger as an earlier run wrote it: both versions read the same per-thread file.
  await cp(seed, root, { recursive: true })
  const usage = new NativeUsage(root, provider); await usage.load(); await usage.flushed()
  const reports = Number(reportsText), turns = Number(turnsText)
  const codexReport = (turn: number) => ({ turnId: `turn-${turn}`,
    tokenUsage: { total: { inputTokens: turn * 100, outputTokens: turn * 10, cachedInputTokens: 0 }, last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 } } })
  // Claude: a reply streaming on the thread, its newest request reporting a growing output on each frame. Codex: a
  // thread read again from its rollout, its newest turns' reports replayed, each one already counted.
  if (provider === 'claude') usage.claude('thread', { type: 'stream_event', event: { type: 'message_start', message: report('msg_streaming', 1).message } })
  const cpuBefore = process.cpuUsage(), started = performance.now()
  for (let frame = 1; frame <= reports; frame++) {
    if (provider === 'claude') usage.claude('thread', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 100 + frame } } })
    else usage.codex('thread', 'gpt-5.4', codexReport(turns - reports + frame))
  }
  const elapsed = performance.now() - started, cpu = process.cpuUsage(cpuBefore)
  console.log(JSON.stringify({ reports, msPerReport: elapsed / reports, cpuMsPerReport: (cpu.user + cpu.system) / 1000 / reports, total: usage.get('thread')?.total?.output }))
  await usage.flushed()
} finally { await rm(root, { recursive: true, force: true }) }
