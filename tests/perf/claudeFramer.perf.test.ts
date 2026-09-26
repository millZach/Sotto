// @vitest-environment node
/**
 * Synthetic framing cost of `ClaudeProtocol`: one native user replay frame carrying a base64 image,
 * handed to the stdout listener in 64 KiB pieces, the size a Node pipe read delivers. It times the
 * framer alone (byte counting, newline search, joining, one `JSON.parse`), not a Claude send.
 * It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/claudeFramer.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeProtocol, type ClaudeFrame } from '../../src/main/agents/claudeProtocol'
import { median, PERF_BENCH } from '../fixtures/perfBench'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const CHUNK = 64 * 1024
const ITERATIONS = 5

function replayFrame(imageBytes: number): string {
  const data = Buffer.alloc(imageBytes, 7).toString('base64')
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: 'What is in this picture?' }] } })}\n`
}

function framer(): { feed: (chunk: string) => void; frames: ClaudeFrame[] } {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) })
  vi.mocked(spawn).mockReturnValueOnce(child as never)
  const frames: ClaudeFrame[] = []
  new ClaudeProtocol('claude', [], '.', {}, 5000, frame => { frames.push(frame) }, () => undefined)
  const listener = child.stdout.listeners('data')[0] as (chunk: string) => void
  return { feed: listener, frames }
}

describe.skipIf(!PERF_BENCH)('Claude frame parser cost', () => {
  for (const mebibytes of [1, 10, 20]) {
    it(`frames a ${mebibytes} MiB image replay split into 64 KiB chunks`, () => {
      const line = replayFrame(mebibytes * 1024 * 1024)
      const chunks: string[] = []
      for (let offset = 0; offset < line.length; offset += CHUNK) chunks.push(line.slice(offset, offset + CHUNK))
      const samples: number[] = []
      for (let run = 0; run < ITERATIONS; run++) {
        const { feed, frames } = framer()
        const started = performance.now()
        for (const chunk of chunks) feed(chunk)
        samples.push(performance.now() - started)
        expect(frames).toHaveLength(1)
      }
      console.log(`claude framer: ${mebibytes} MiB image, ${(line.length / 1024 / 1024).toFixed(1)} MiB line, ${chunks.length} chunks, median ${median(samples).toFixed(1)} ms of ${ITERATIONS}`)
    }, 120_000)
  }
})
