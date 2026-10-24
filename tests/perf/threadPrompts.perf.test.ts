// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ThreadStore } from '../../src/main/agents/threadStore'
import type { AgentMessage } from '../../src/shared/agents'
import { HOST_MAX_FRAME_BYTES } from '../../src/shared/hostProtocol'
import { agentThreadPromptsSchema, THREAD_PROMPT_REPLY_HEAD, THREAD_PROMPT_REPLY_TAIL, THREAD_PROMPT_TEXT, THREAD_PROMPTS_MOST } from '../../src/shared/threadPrompts'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { expectWithinBudget } from '../fixtures/perfBudget'

/**
 * What the message scrubber's read of a very long thread costs main (ADR-0109): `promptsBefore` over a thread of 2,500
 * turns, each a prompt, a working note and a reply of about 3 KB, read from just above the newest ten turns as a pane
 * opening on it asks. Every word is random. It always checks the answer stays the size of its prompts rather than of
 * their words, and that the largest answer fits a host's frame; the stopwatch is `SOTTO_PERF_ASSERT`'s, and
 * `SOTTO_PERF_BENCH=1` prints the medians.
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/threadPrompts.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
const TURNS = 2_500
const SAMPLES = 7
const at = (index: number): string => new Date(Date.UTC(2026, 9, 24, 9, 0, index)).toISOString()
const words = (size: number): string => randomBytes(Math.ceil(size * 0.75)).toString('base64').slice(0, size).replace(/[+/]/gu, ' ')

function history(): AgentMessage[] {
  return Array.from({ length: TURNS }, (_, turn) => [
    { id: `u${turn}`, role: 'user' as const, text: words(200 + (turn % 7) * 150), createdAt: at(turn * 3) },
    { id: `n${turn}`, role: 'assistant' as const, text: words(120), createdAt: at(turn * 3 + 1) },
    { id: `a${turn}`, role: 'assistant' as const, text: `${words(1_500)}\n\n${words(1_500)}?`, createdAt: at(turn * 3 + 2) },
  ]).flat()
}

describe('the message scrubber’s read of a very long thread', () => {
  let root: string
  let store: ThreadStore
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-thread-prompts-bench-'))
    store = new ThreadStore(join(root, 'threads.sqlite'))
    store.open()
    store.replaceThreadMessages('long', history(), 'epoch')
  }, 120_000)
  afterAll(async () => { store?.close(); if (root) await rm(root, { recursive: true, force: true }) })

  it('reads every prompt above the window at the size of its prompts, not their words, within its budget', () => {
    const before = `u${TURNS - 10}`
    const times: number[] = []
    let prompts = store.promptsBefore('long', before, new Set())
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const started = performance.now()
      prompts = store.promptsBefore('long', before, new Set())
      times.push(performance.now() - started)
    }
    expect(prompts).toHaveLength(TURNS - 10)
    const answer = JSON.stringify({ prompts })
    expect(agentThreadPromptsSchema.parse({ prompts }).prompts).toHaveLength(TURNS - 10)
    // Never more than a prompt's own share, however long what was said and what came back.
    const most = THREAD_PROMPT_TEXT + THREAD_PROMPT_REPLY_HEAD + THREAD_PROMPT_REPLY_TAIL + 200
    expect(answer.length / prompts.length).toBeLessThan(most)
    // The largest answer a host can give still fits one of its frames, however long every message and reply is.
    expect(THREAD_PROMPTS_MOST * most * 1.5).toBeLessThan(HOST_MAX_FRAME_BYTES)
    if (PERF_BENCH) console.log(`promptsBefore over ${TURNS} turns: median ${round(median(times))} ms, ${round(answer.length / 1024)} KB answer`)
    expectWithinBudget(median(times), 250, `Reading ${TURNS} turns' prompts`)
  })
})
