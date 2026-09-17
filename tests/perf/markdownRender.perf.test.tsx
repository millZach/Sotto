import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageContent, splitStreamingMarkdown } from '../../src/renderer/src/agents/MessageContent'

afterEach(cleanup)

/**
 * A realistic long assistant reply: headings, prose with inline code, a bulleted and a numbered
 * list, three fenced code blocks and a table. About 6 KB, the size of an answer that explains a
 * change and shows the code.
 */
export function longReply(): string {
  const parts: string[] = ['## What I changed', '']
  parts.push('The loader in `src/app/loader.ts` read the manifest twice, so the second read won and the retry path ran again. I split the read from the parse and kept the parse pure.', '')
  parts.push('- `loadManifest` now returns the raw text only', '- `parseManifest` is pure and testable', '- the retry path asks the clock, not `Date.now()`', '')
  parts.push('```ts')
  for (let index = 0; index < 22; index += 1) parts.push(`export function step${index}(input: string): string { return input.trim().padEnd(${index + 4}, '.') }`)
  parts.push('```', '')
  parts.push('- the helpers are pure, so they need no fixtures', '- `step0` is the only one the loader calls', '- the rest are used by the retry path', '')
  parts.push('### Why the second read won', '')
  parts.push('Each call opened its own handle, and the later handle finished first on Windows, so the earlier bytes overwrote the newer ones in the cache. The fix keeps one handle per load and hands the bytes to the parser.', '')
  parts.push('1. read the file once', '2. parse the bytes', '3. cache the parsed value under the file digest', '')
  parts.push('```py')
  for (let index = 0; index < 20; index += 1) parts.push(`def handler_${index}(payload):\n    return {"index": ${index}, "payload": payload}`)
  parts.push('```', '')
  parts.push('### Files touched', '')
  parts.push('| File | Change | Lines |', '| --- | --- | --- |')
  for (let index = 0; index < 16; index += 1) parts.push(`| src/app/module${index}.ts | rewrote the ${index % 2 === 0 ? 'reader' : 'parser'} | ${12 + index * 3} |`)
  parts.push('')
  parts.push('The table above lists every file, and `npm run typecheck` is clean. The remaining risk is the cache key, which still hashes the path rather than the contents.', '')
  parts.push('```sh')
  for (let index = 0; index < 12; index += 1) parts.push(`npm run test -- --filter module${index}`)
  parts.push('```', '')
  parts.push('That leaves the retry path, which I will fix next.')
  return parts.join('\n')
}

interface Timing { readonly median: number; readonly total: number }

function summarise(durations: readonly number[]): Timing {
  const sorted = [...durations].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
  return { median, total: durations.reduce((sum, value) => sum + value, 0) }
}

/** Feeds the reply in `chunks` appends, timing each render the way a provider update would cost. */
function feed(text: string, chunks: number, streaming: boolean): Timing {
  const step = Math.ceil(text.length / chunks)
  const view = render(<MessageContent text="" streaming={streaming} />)
  const durations: number[] = []
  for (let index = 1; index <= chunks; index += 1) {
    const prefix = text.slice(0, Math.min(text.length, index * step))
    const started = performance.now()
    view.rerender(<MessageContent text={prefix} streaming={streaming} />)
    durations.push(performance.now() - started)
  }
  cleanup()
  return summarise(durations)
}

/**
 * The characters Markdown is parsed over across the whole stream. A memoised block is parsed the
 * first time its text appears and never again, so this counts what the machine timings measure
 * without the machine's noise.
 */
function parsedCharacters(text: string, chunks: number, streaming: boolean): number {
  const step = Math.ceil(text.length / chunks)
  const parsed = new Set<string>()
  let total = 0
  for (let index = 1; index <= chunks; index += 1) {
    const prefix = text.slice(0, Math.min(text.length, index * step))
    for (const source of streaming ? splitStreamingMarkdown(prefix) : [prefix]) {
      if (parsed.has(source)) continue
      parsed.add(source)
      total += source.length
    }
  }
  return total
}

const CHUNKS = 40

describe('rendering a reply as it streams', () => {
  it('costs less per chunk than re-parsing the whole message', () => {
    const text = longReply()
    // A warm run first: the first parse pays for module init and lowlight registration.
    feed(text, 4, true)
    feed(text, 4, false)
    const whole = feed(text, CHUNKS, false)
    const incremental = feed(text, CHUNKS, true)
    const report = {
      bytes: text.length,
      chunks: CHUNKS,
      wholeMedianMs: Number(whole.median.toFixed(2)),
      wholeTotalMs: Number(whole.total.toFixed(1)),
      incrementalMedianMs: Number(incremental.median.toFixed(2)),
      incrementalTotalMs: Number(incremental.total.toFixed(1)),
      speedup: Number((whole.total / incremental.total).toFixed(2)),
      wholeParsedChars: parsedCharacters(text, CHUNKS, false),
      incrementalParsedChars: parsedCharacters(text, CHUNKS, true),
    }
    console.log(`markdown streaming render: ${JSON.stringify(report)}`)
    expect(text.length).toBeGreaterThan(5_000)
    // Loose so a slow machine cannot fail the suite; the logged numbers carry the detail.
    expect(incremental.total).toBeLessThan(whole.total)
    expect(report.incrementalParsedChars).toBeLessThan(report.wholeParsedChars / 3)
  })
})
