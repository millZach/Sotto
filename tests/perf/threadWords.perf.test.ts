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
import { agentThreadWordsSchema, THREAD_WORDS_MOST } from '../../src/shared/threadWords'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { expectWithinBudget } from '../fixtures/perfBudget'

/**
 * What Search threads' read of what was said costs the store worker at the owner's scale (November 19, 2026: 994 threads,
 * 75,897 messages, 30 MiB of their words on the laptop). A store of 1,000 threads of 76 messages, about 400 characters
 * each, every word random, is searched for a word nothing says, for one a few threads say, and for one every thread
 * says, which names a page of threads. It always checks the answer stays a page of quotes, which fits a host's frame; the
 * stopwatch is `SOTTO_PERF_ASSERT`'s, and `SOTTO_PERF_BENCH=1` prints the medians. On the owner's own store the same
 * read took 55 to 116 ms on the laptop and 5 to 12 ms on forge.
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/threadWords.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
const THREADS = 1_000
const MESSAGES = 76
const SAMPLES = 5
const at = (index: number): string => new Date(Date.UTC(2026, 10, 19, 9, 0, index)).toISOString()
const words = (size: number): string => randomBytes(Math.ceil(size * 0.75)).toString('base64').slice(0, size).replace(/[+/]/gu, ' ')

function thread(index: number): AgentMessage[] {
  return Array.from({ length: MESSAGES }, (_, position) => ({
    id: `m${position}`, role: position % 2 === 0 ? 'user' as const : 'assistant' as const,
    // Every thread says "everywhere" once; one in a hundred says "boiler purge".
    text: `${words(200)}${position === 7 ? ' everywhere ' : ' '}${position === 9 && index % 100 === 0 ? 'boiler purge ' : ''}${words(200)}`,
    createdAt: at(index * MESSAGES + position),
  }))
}

describe('Search threads’ read of what was said at the owner’s scale', () => {
  let root: string
  let store: ThreadStore
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-thread-words-bench-'))
    store = new ThreadStore(join(root, 'threads.sqlite'))
    store.open()
    for (let index = 0; index < THREADS; index++) store.replaceThreadMessages(`thread-${index}`, thread(index), 'epoch')
  }, 120_000)
  afterAll(async () => { store?.close(); if (root) await rm(root, { recursive: true, force: true }) })

  it.each([['nothing says', 'zz-nobody-said-this', 0], ['a few threads say', 'boiler purge', THREADS / 100], ['every thread says', 'everywhere', THREAD_WORDS_MOST]] as const)(
    'reads every message once for a word %s, within its budget', (_, query, threads) => {
      const times: number[] = []
      let answer = store.threadWords(query)
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const started = performance.now()
        answer = store.threadWords(query)
        times.push(performance.now() - started)
      }
      expect(answer.found).toHaveLength(threads)
      expect(agentThreadWordsSchema.parse(answer)).toEqual(answer)
      // A page of quotes, however much was said, fits one of a host's frames.
      expect(JSON.stringify(answer).length).toBeLessThan(HOST_MAX_FRAME_BYTES / 10)
      if (PERF_BENCH) console.log(`threadWords "${query}" over ${THREADS * MESSAGES} messages: median ${round(median(times))} ms, ${answer.found.length} threads`)
      expectWithinBudget(median(times), 400, `Searching ${THREADS * MESSAGES} messages for "${query}"`)
    })
})
