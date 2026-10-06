/** Child-process workload for usageStreamWrites.perf.test.ts; a synthetic ledger and synthetic usage only. */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeUsage } from '../../src/main/agents/nativeUsage'
import { recordDurableWrites } from './durableWrites'

const [seed, framesText, gapText] = process.argv.slice(2)
if (!seed || !framesText || !gapText) throw new Error('Expected a seed ledger, a frame count and the gap between frames')
const root = await mkdtemp(join(tmpdir(), 'sotto-usage-stream-'))
try {
  await copyFile(seed, join(root, 'claude-usage.json'))
  const usage = new NativeUsage(root, 'claude'); await usage.load(); await usage.flushed()
  const recorder = recordDurableWrites()
  const message = { id: 'streamed', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } }
  const cpuBefore = process.cpuUsage()
  const started = performance.now()
  // A reply as Claude Code streams it: message_start, then the output count on each delta, then the turn's result.
  usage.claude('thread-0', { type: 'stream_event', event: { type: 'message_start', message } })
  const frames = Number(framesText)
  for (let i = 1; i <= frames; i++) {
    await delay(Number(gapText))
    usage.claude('thread-0', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: i * 10 } } })
  }
  usage.claudeResult('thread-0', { duration_ms: 1234 })
  const streamedMs = performance.now() - started
  await usage.flushed()
  const cpu = process.cpuUsage(cpuBefore)
  const writes = recorder.writes.filter(write => write.file === 'claude-usage.json')
  recorder.restore()
  console.log(JSON.stringify({ writes: writes.length, bytesWritten: writes.reduce((sum, write) => sum + write.bytes, 0),
    archiveBytes: writes.at(-1)?.bytes ?? 0, streamedMs, cpuMs: (cpu.user + cpu.system) / 1000, output: usage.get('thread-0')?.latest?.output }))
} finally { await rm(root, { recursive: true, force: true }) }
