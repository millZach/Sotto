// @vitest-environment node
/**
 * What opening a thread on a remote host costs the link, before and after `permessage-deflate` and cut activity bodies
 * (ADR-0025, October 18 amendment). A thread's whole detail and a shell, both synthetic and built from a seeded generator so the uncompressed
 * byte counts are the same on every run, are sent through the listener's own framing with and without the extension,
 * and the bytes it wrote are counted. Compressed counts depend on the zlib Node carries, so they are asserted as
 * ratios. Timings, level 1 against level 6 and what the host's loop is held for, are reported only under
 * `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/remoteThreadOpenBytes.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * docs/perf/2026-10-18-remote-thread-open-bytes.md records the results and the field measurements beside them.
 */
import { Duplex } from 'node:stream'
import { constants as zlib, deflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DEFLATE_LEVEL, SocketFrames } from '../../src/host/socketFrames'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { CutBodies } from '../../src/shared/activityBodies'
import type { AgentThreadDetail } from '../../src/shared/agents'
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
const random = seeded(1018)
const between = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1))
// A vocabulary of a few hundred identifiers, the size of a codebase's, with hashes and numbers between them: command
// output and source compress about three to four times, as the host's real threads did.
const syllables = ['so', 'tto', 'host', 'th', 'read', 'de', 'tail', 'sock', 'et', 'ag', 'ent', 'pro', 'vi', 'der', 'sh', 'ell', 'mo', 'del', 'cat', 'log', 'ue', 'ry', 'ix', 'or']
const vocabulary = Array.from({ length: 400 }, () => Array.from({ length: between(1, 4) }, () => syllables[between(0, syllables.length - 1)]).join(''))
const token = (): string => {
  const roll = random()
  if (roll < 0.06) return Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0')
  if (roll < 0.14) return String(between(0, 99_999))
  if (roll < 0.2) return ['{', '}', '(', ')', '=>', '===', ';', ':', ','][between(0, 8)]!
  return vocabulary[between(0, vocabulary.length - 1)]!
}
const text = (length: number): string => {
  let value = ''
  while (value.length < length) value += token() + (random() < 0.08 ? '\n' : ' ')
  return value.slice(0, length)
}
const at = (index: number): string => new Date(Date.UTC(2026, 9, 18, 9, 0, 0) + index * 7_000).toISOString()

/** About 3.6 MB of history, near the size of the largest thread measured on the forge host, most of it command output. */
function longThread(): AgentThreadDetail {
  const activities: AgentActivity[] = []
  for (let index = 0; activities.length < 1040; index++) {
    const sequence = activities.length, timing = { startedAt: at(index), completedAt: at(index + 1), timingSource: 'provider' as const, durationMs: between(20, 90_000) }
    const base = { id: `activity-${sequence}`, turnId: `turn-${Math.floor(sequence / 40)}`, sequence, ...timing }
    if (random() < 0.75) {
      activities.push({ ...base, kind: 'command', status: 'completed', title: 'Ran ' + text(between(20, 60)), command: text(between(30, 200)),
        cwd: 'D:/synthetic/project/.worktrees/remote-thread', output: text(random() < 0.08 ? between(12_000, 30_000) : between(200, 4_000)), exitCode: 0 })
    } else activities.push({ ...base, kind: 'reasoning', status: 'completed', title: 'Thinking', text: text(between(300, 1_800)) })
  }
  const messages = Array.from({ length: 60 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, text: text(between(200, 3_000)), createdAt: at(index * 15) }))
  return { threadId: 'remote-thread', revision: 1, messages, activities }
}
/** A shell of about 130 KB: a host's thread list with its projects and model catalog, as the forge host sent one. */
function largeShell() {
  const threads = Array.from({ length: 300 }, (_, index) => ({ id: `thread-${index}`, provider: ['codex', 'claude', 'grok', 'devin'][index % 4],
    title: text(between(20, 70)), projectId: `project-${index % 9}`, status: index % 7 ? 'idle' : 'running', updatedAt: at(index), branch: 'sotto/' + text(10).replace(/\W/g, ''),
    preview: text(between(80, 200)), worktreePath: 'D:/synthetic/project/.worktrees/' + index }))
  const models = Array.from({ length: 80 }, (_, index) => ({ id: `model-${index}`, label: text(between(10, 30)), provider: ['codex', 'claude', 'grok', 'devin'][index % 4], efforts: ['low', 'medium', 'high'] }))
  return { v: 1, event: 'shell', state: { host: { hostId: 'forge', threads, models, projects: Array.from({ length: 9 }, (_, index) => ({ id: `project-${index}`, path: 'D:/synthetic/' + text(12) })) } },
    eventPage: { events: [], latestSeq: 4021, hasMore: false } }
}

/** The bytes the listener's framing writes for one message, with the extension or without it. */
async function written(message: string, deflate: boolean): Promise<number> {
  let total = 0
  const stream = new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) { total += chunk.length; callback() } })
  const frames = new SocketFrames(stream, false, () => undefined, { deflate })
  frames.sendText(message); await frames.drained(); frames.close()
  return total
}
const LINK_BYTES_PER_SECOND = 370_000
/** The synthetic thread cut: most of its outputs are under the limit and go whole, as about half the field thread's rows did. */
const CUT_DETAIL_BYTES = 2_047_190
const CUT_RECORDS = 411
const seconds = (bytes: number): number => round(bytes / LINK_BYTES_PER_SECOND, 2)

describe('remote thread open bytes', () => {
  const detail = JSON.stringify({ v: 1, event: 'detail', threadId: 'remote-thread', detail: longThread() })
  const shell = JSON.stringify(largeShell())

  it('sends a desktop that accepts activity bodies the long thread with its bodies cut', async () => {
    const thread = longThread()
    const cut = new CutBodies().detail(thread)
    const message = JSON.stringify({ v: 1, event: 'detail', threadId: 'remote-thread', detail: cut })
    const report = { cutDetailBytes: await written(message, false), cutDetailCompressedBytes: await written(message, true),
      records: cut.activities!.length, recordsCut: cut.activities!.filter(record => record.cut !== undefined).length }
    console.info(`remote thread open cut bytes: ${JSON.stringify({ ...report, cutDetailSeconds: seconds(report.cutDetailBytes), cutDetailCompressedSeconds: seconds(report.cutDetailCompressedBytes) })}`)
    // The cut frame is the generator's and the cut's alone, so its size is the same on every run.
    expect(report.cutDetailBytes).toBe(Buffer.byteLength(message) + 10)
    expect(Buffer.byteLength(message)).toBe(CUT_DETAIL_BYTES)
    expect(report.recordsCut).toBe(CUT_RECORDS)
    expect(report.records).toBe(1040)
    // Every cut record still reads whole in every field but its bodies.
    for (const [index, record] of cut.activities!.entries()) {
      const whole = thread.activities![index]!
      expect({ ...record, output: whole.output, text: whole.text, cut: undefined }).toEqual({ ...whole, cut: undefined })
    }
    expect(report.cutDetailCompressedBytes).toBeLessThan(report.cutDetailBytes / 2.5)
  })

  it('sends a desktop a long thread and a shell in a fraction of their bytes', async () => {
    const report = {
      detailBytes: await written(detail, false), detailCompressedBytes: await written(detail, true),
      shellBytes: await written(shell, false), shellCompressedBytes: await written(shell, true),
    }
    console.info(`remote thread open bytes: ${JSON.stringify({ ...report, detailSeconds: seconds(report.detailBytes), detailCompressedSeconds: seconds(report.detailCompressedBytes),
      shellSeconds: seconds(report.shellBytes), shellCompressedSeconds: seconds(report.shellCompressedBytes),
      detailRatio: round(report.detailBytes / report.detailCompressedBytes, 2), shellRatio: round(report.shellBytes / report.shellCompressedBytes, 2) })}`)
    // The uncompressed frames are the generator's alone: the JSON plus a ten-byte header.
    expect(report.detailBytes).toBe(Buffer.byteLength(detail) + 10)
    expect(report.shellBytes).toBe(Buffer.byteLength(shell) + 10)
    expect(Buffer.byteLength(detail)).toBe(3_609_588)
    expect(Buffer.byteLength(shell)).toBe(130_757)
    // The ratios the forge host's own data had at level 6: about 3.5 for a detail and 3.75 for a shell.
    expect(report.detailCompressedBytes).toBeLessThan(report.detailBytes / 2.5)
    expect(report.shellCompressedBytes).toBeLessThan(report.shellBytes / 2.5)
  })

  describe('timing benchmark; requires SOTTO_PERF_BENCH=1', () => {
    it.skipIf(!PERF_BENCH)('reports what compressing costs at level 1 and level 6, and how long the loop is held', async () => {
      const input = Buffer.from(detail), shellInput = Buffer.from(shell)
      const time = (work: () => unknown, rounds = 15): number => {
        for (let index = 0; index < 3; index++) work()
        const samples: number[] = []
        for (let index = 0; index < rounds; index++) { const started = performance.now(); work(); samples.push(performance.now() - started) }
        return round(median(samples), 2)
      }
      const levels = Object.fromEntries([1, 6].map(level => {
        const bytes = deflateRawSync(input, { level, finishFlush: zlib.Z_SYNC_FLUSH }).length
        return [`level${level}`, { detailBytes: bytes, detailSeconds: seconds(bytes), detailSyncMs: time(() => deflateRawSync(input, { level, finishFlush: zlib.Z_SYNC_FLUSH })),
          shellBytes: deflateRawSync(shellInput, { level, finishFlush: zlib.Z_SYNC_FLUSH }).length, shellSyncMs: time(() => deflateRawSync(shellInput, { level, finishFlush: zlib.Z_SYNC_FLUSH })) }]
      }))
      const asyncSamples: number[] = []
      for (let index = 0; index < 10; index++) {
        const started = performance.now()
        await new Promise(resolve => deflateRaw(input, { level: DEFLATE_LEVEL, finishFlush: zlib.Z_SYNC_FLUSH }, resolve))
        asyncSamples.push(performance.now() - started)
      }
      // What the loop is held for when the listener sends the detail: the send itself, the compression being off the loop.
      const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
      const frames = new SocketFrames(stream, false, () => undefined, { deflate: true })
      const held = time(() => { frames.sendText(detail) }, 5)
      await frames.drained(); frames.close()
      // What the desktop's loop spends on the detail it is sent: inflating it, and parsing the JSON that comes out.
      const packed = deflateRawSync(input, { level: DEFLATE_LEVEL, finishFlush: zlib.Z_SYNC_FLUSH })
      const inflateMs = time(() => inflateRawSync(packed, { finishFlush: zlib.Z_SYNC_FLUSH }))
      const parseMs = time(() => JSON.parse(detail) as unknown)
      // What cutting the thread's bodies costs the host the first time, with every record new to it.
      const source = longThread()
      const cutMs = time(() => new CutBodies().detail(source))
      console.info(`remote thread open timing: ${JSON.stringify({ ...levels, detailAsyncLevel6Ms: round(median(asyncSamples), 2), loopHeldPerDetailSendMs: held, detailInflateMs: inflateMs, detailParseMs: parseMs, cutDetailMs: cutMs })}`)
      expect(held).toBeGreaterThanOrEqual(0)
    })
  })
})
