// @vitest-environment node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'vitest'
import { NativeUsage } from '../../../src/main/agents/nativeUsage'

import { nativeUsageBenchTotals as totals } from '../../fixtures/nativeUsageBenchTotals'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each(['stream', 'turns'])('compares %s counters with their real JSON archive after restart', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-comparison-test-')); roots.push(root)
  const usage = new NativeUsage(root, 'claude'); await usage.load()
  const message = { id: 'synthetic-request', model: 'claude-sonnet-4-6', usage: {
    input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0,
  } }
  if (scenario === 'stream') {
    usage.claude('thread', { type: 'stream_event', event: { type: 'message_start', message } })
    usage.claude('thread', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 200 } } })
  } else usage.claude('thread', { type: 'assistant', message })
  await usage.flushed()
  const reopened = new NativeUsage(root, 'claude'); await reopened.load(); await reopened.flushed()
  // Node strict equality is also what the isolated benchmark child uses, unlike Vitest's toEqual.
  assert.deepEqual(totals(reopened.get('thread')), totals(usage.get('thread')))
  assert.equal(totals(reopened.get('thread')).total?.output, scenario === 'stream' ? 200 : 100)
  assert.equal(totals(reopened.get('thread')).estimatedUsd, scenario === 'stream' ? 0.0066 : 0.0051)
})
