// @vitest-environment node
/**
 * What one streamed Grok chunk costs the adapter, for a thread holding 10, 500 and 2,000 messages (#771). It drives
 * the adapter's own update handler with a reply already started, then times 200 more chunks of 20 characters.
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/grokChunkAppend.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it } from 'vitest'
import { GrokAcpHost } from '../../src/main/agents/grok'
import type { AgentMessage } from '../../src/shared/agents'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

interface GrokInternals {
  aliases: Record<string, unknown>
  histories: Map<string, unknown>
  record(id: string, status: 'running'): void
  frame(frame: { method: string; params: unknown }, rpc: unknown): Promise<void>
  usage: { flushed(): Promise<void> }
  disconnect(): void
}

const roots: string[] = []
afterAll(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-grok-chunks-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe.skipIf(!PERF_BENCH)("a streamed Grok chunk (timing benchmark; requires SOTTO_PERF_BENCH=1)", () => {
  it('reports the cost of one chunk against the messages the thread holds', async () => {
    const results: Record<string, unknown> = {}
    for (const held of [10, 500, 2_000]) {
      const root = await mkdtemp(join(tmpdir(), 'sotto-grok-chunks-')); roots.push(root)
      const internals = new GrokAcpHost(root, { executable: process.execPath }) as unknown as GrokInternals
      const sessionId = randomUUID()
      internals.aliases.thread = { grokSessionId: sessionId, projectId: 'project', cwd: root, title: 'Thread', modelId: 'grok-test', settingsConfirmed: true,
        createdAt: '2026-10-06T00:00:00.000Z', origins: [], answeredRequestIds: [] }
      const messages: AgentMessage[] = Array.from({ length: held }, (_, index) => ({ id: `m-${index}`, role: index % 2 === 0 ? 'user' : 'assistant',
        text: 'x'.repeat(400), createdAt: new Date(Date.parse('2026-10-06T00:00:00.000Z') + index * 1000).toISOString() }))
      messages.push({ id: 'prompt', role: 'user', text: 'The prompt', createdAt: '2026-10-07T00:00:00.000Z' })
      internals.histories.set('thread', { offset: 0, total: messages.length, messages, activities: [], events: new Set(), statusEvents: new Set(), status: 'running' })
      internals.record('thread', 'running')
      const chunk = (text: string) => internals.frame({ method: 'session/update', params: { sessionId, _meta: { promptId: 'turn', streamStartMs: 1 },
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }, undefined)
      await chunk('Start')
      const samples: number[] = []
      for (let index = 0; index < 200; index++) {
        const started = performance.now()
        await chunk(` chunk ${String(index).padStart(12, '0')}`)
        samples.push(performance.now() - started)
      }
      results[`${held} held`] = { medianMs: round(median(samples), 3), totalMs: round(samples.reduce((sum, value) => sum + value, 0), 1) }
      internals.disconnect(); await internals.usage.flushed()
    }
    console.log(`grok chunk append: ${JSON.stringify(results)}`)
    expect(Object.keys(results)).toHaveLength(3)
  }, 120_000)
})
