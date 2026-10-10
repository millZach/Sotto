// @vitest-environment node
/**
 * What a paired phone is sent for one long thread with and without `activity-summaries` (issue #701). The thread is
 * synthetic, shaped like the owner's bug-audit thread (842 activities, about 3.5 MB, most of it command output), and
 * built from a seeded generator, so the byte counts are the same on every run. The counts are asserted in the default
 * run; the time the projection takes is reported only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/activitySummaries.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * Each frame is measured as the listener sends it: one JSON text frame, `{ v: 1, event, threadId, ... }`.
 */
import { describe, expect, it } from 'vitest'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentThreadDetail, AgentThreadDetailDelta } from '../../src/shared/agents'
import { deltaWithActivitySummaries, detailWithActivitySummaries } from '../../src/shared/hostProtocol'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

/** A seeded generator (mulberry32), so the thread is the same on every run and machine. */
function seeded(seed: number): () => number {
  return () => {
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}
const random = seeded(701)
const between = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1))
const words = ['src', 'main', 'agents', 'thread', 'detail', 'socket', 'host', 'test', 'build', 'activity', 'record', 'delta', 'phone', 'output']
const text = (length: number): string => {
  let value = ''
  while (value.length < length) value += words[between(0, words.length - 1)] + (random() < 0.1 ? '\n' : ' ')
  return value.slice(0, length)
}
const at = (index: number): string => new Date(Date.UTC(2026, 8, 30, 9, 0, 0) + index * 7_000).toISOString()

/** 842 records in the owner's proportions: mostly commands with their output, then reasoning, edits, tools and subagents. */
function ownersThread(): AgentThreadDetail {
  const activities: AgentActivity[] = []
  const push = (record: Omit<AgentActivity, 'id' | 'turnId' | 'sequence'>): void => {
    const sequence = activities.length
    activities.push({ id: `activity-${sequence}`, turnId: `turn-${Math.floor(sequence / 40)}`, sequence, ...record })
  }
  for (let index = 0; activities.length < 842; index++) {
    const roll = random()
    const timing = { startedAt: at(index), completedAt: at(index + 1), timingSource: 'provider' as const, durationMs: between(20, 90_000) }
    if (index % 40 === 0) push({ kind: 'turn', status: 'completed', title: 'Turn', ...timing })
    else if (roll < 0.72) {
      // Command output is most of the thread: usually a few kilobytes, sometimes a long test or build log.
      const output = random() < 0.08 ? between(12_000, 40_000) : between(200, 4_500)
      const failed = random() < 0.08
      push({ kind: 'command', status: failed ? 'failed' : 'completed', title: 'Ran ' + text(between(20, 60)), command: text(between(30, 280)),
        cwd: 'D:/synthetic/project/.worktrees/bug-audit', output: text(output), exitCode: failed ? 1 : 0, ...timing })
    } else if (roll < 0.85) push({ kind: 'reasoning', status: 'completed', title: 'Thinking', text: text(between(300, 1_800)), ...timing })
    else if (roll < 0.93) {
      push({ kind: 'file-change', status: 'completed', title: 'Edited files', ...timing,
        changes: Array.from({ length: between(1, 3) }, () => ({ path: 'src/' + text(between(10, 40)).replace(/\s/g, '/') + '.ts', kind: 'update', diff: text(between(300, 2_500)) })) })
    } else if (roll < 0.985) push({ kind: 'tool', status: 'completed', title: 'Read ' + text(between(10, 40)), text: text(between(100, 600)), output: text(between(200, 2_000)), ...timing })
    else {
      push({ kind: 'subagent', status: 'completed', title: 'Reviewers', ...timing,
        agents: Array.from({ length: between(1, 4) }, (_, agent) => ({ id: `agent-${index}-${agent}`, status: 'completed', prompt: text(400), message: text(between(500, 3_000)) })) })
    }
  }
  return { threadId: 'bug-audit', revision: 1, messages: [], activities }
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
const detailFrame = (detail: AgentThreadDetail) => ({ v: 1, event: 'detail', threadId: detail.threadId, detail })
const deltaFrame = (delta: AgentThreadDetailDelta) => ({ v: 1, event: 'detail-delta', threadId: delta.threadId, delta })

describe('activity summaries for a long thread (#701)', () => {
  const detail = ownersThread()
  const command = detail.activities!.find(record => record.kind === 'command' && (record.output?.length ?? 0) > 12_000)!
  /** One frame of a streaming command: its output grew by a chunk, and the delta carries the record as it now stands. */
  const delta: AgentThreadDetailDelta = { threadId: detail.threadId, baseRevision: 1, revision: 2, messageDeltas: [],
    activityDeltas: [{ record: { ...command, status: 'running', output: command.output + text(800) } }] }

  it('sends a phone the summary rows of an 842-record thread in a small part of the bytes', () => {
    const whole = bytes(detailFrame(detail)), summaries = bytes(detailFrame(detailWithActivitySummaries(detail)))
    const output = detail.activities!.reduce((total, record) => total + Buffer.byteLength(record.output ?? ''), 0)
    const wholeDelta = bytes(deltaFrame(delta)), summaryDelta = bytes(deltaFrame(deltaWithActivitySummaries(delta)))
    console.info(`activity summaries: ${JSON.stringify({ activities: detail.activities!.length, wholeDetailBytes: whole, outputBytes: output,
      summaryDetailBytes: summaries, detailSaving: round(1 - summaries / whole, 3), wholeDeltaBytes: wholeDelta, summaryDeltaBytes: summaryDelta })}`)
    expect(detail.activities).toHaveLength(842)
    // The shape the issue measured: about 3.5 MB, most of it command output.
    expect(whole).toBeGreaterThan(3_000_000)
    expect(output / whole).toBeGreaterThan(0.6)
    expect(summaries / whole).toBeLessThan(0.15)
    expect(summaryDelta / wholeDelta).toBeLessThan(0.1)
  })

  describe("timing benchmark; requires SOTTO_PERF_BENCH=1", () => {
    it.skipIf(!PERF_BENCH)('reports what making the summaries costs the host, once per update', () => {
      const time = (work: () => unknown): number => {
        for (let index = 0; index < 5; index++) work()
        const samples: number[] = []
        for (let index = 0; index < 40; index++) { const started = performance.now(); work(); samples.push(performance.now() - started) }
        return round(median(samples), 3)
      }
      const report = {
        summariseDetailMs: time(() => detailWithActivitySummaries(detail)),
        stringifyWholeDetailMs: time(() => JSON.stringify(detailFrame(detail))),
        stringifySummaryDetailMs: time(() => JSON.stringify(detailFrame(detailWithActivitySummaries(detail)))),
        summariseDeltaMs: time(() => deltaWithActivitySummaries(delta)),
      }
      console.info(`activity summaries timing: ${JSON.stringify(report)}`)
      expect(report.summariseDetailMs).toBeGreaterThanOrEqual(0)
    })
  })
})
