import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readHistoryFile, type HistoryFileReader } from '../../../src/main/agents/usageHistory/files'
import type { UsageHistorySink } from '../../../src/main/agents/usageHistory/sink'
import type { UsageHistoryCursor } from '../../../src/shared/usageDashboard'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

/** A reader that keeps every wanted line it is shown, so the test can compare them with what was written. */
function recordingReader(seen: string[]): HistoryFileReader<null> {
  return {
    needles: [Buffer.from('"want"')],
    start: () => null,
    line: text => { seen.push(text) },
    settle: () => undefined,
    save: () => undefined,
  }
}

function memorySink(): UsageHistorySink & { cursors: Map<string, UsageHistoryCursor> } {
  const cursors = new Map<string, UsageHistoryCursor>()
  return {
    cursors,
    tokens: () => undefined,
    prompts: () => undefined,
    cursor: key => cursors.get(key),
    setCursors: entries => { for (const entry of entries) cursors.set(entry.key, entry.cursor) },
  }
}

describe('readHistoryFile', () => {
  it('reads lines that run past its read buffer whole, and leaves the lines after them intact', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sotto-history-files-')); folders.push(folder)
    const path = join(folder, 'session.jsonl')
    // Lines of many lengths, two of them longer than the 1 MiB read buffer, so every line break lands somewhere new.
    const lines: string[] = []
    for (let index = 0; index < 400; index++) {
      const fill = index === 37 ? 'a'.repeat(2_600_000) : index === 211 ? 'b'.repeat(1_048_576) : String(index % 10).repeat((index * 7919) % 20_000)
      lines.push(index % 3 === 0 ? `{"skip":${index},"pad":"${fill}"}` : `{"want":${index},"pad":"${fill}"}`)
    }
    writeFileSync(path, lines.join('\n') + '\n{"want":"unfinished"')
    const seen: string[] = []
    const sink = memorySink()
    const file = { path, relativePath: 'session.jsonl' }

    expect(await readHistoryFile('claude', file, recordingReader(seen), sink, new AbortController().signal)).toBe(true)

    expect(seen).toEqual(lines.filter(line => line.includes('"want"')))
    const complete = Buffer.byteLength(lines.join('\n') + '\n')
    expect([...sink.cursors.values()].at(-1)?.offset).toBe(complete)

    // The unfinished line waits for the next pass, which reads only what was added after the cursor.
    appendFileSync(path, ',"pad":"z"}\n{"want":"next"}\n')
    seen.length = 0
    expect(await readHistoryFile('claude', file, recordingReader(seen), sink, new AbortController().signal)).toBe(true)
    expect(seen).toEqual(['{"want":"unfinished","pad":"z"}', '{"want":"next"}'])
  })

  it('reads a file smaller than its read buffer and stops at a pass that was stopped', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sotto-history-files-')); folders.push(folder)
    const path = join(folder, 'small.jsonl')
    writeFileSync(path, '{"want":1}\r\n{"want":2}\n')
    const seen: string[] = []
    expect(await readHistoryFile('claude', { path, relativePath: 'small.jsonl' }, recordingReader(seen), memorySink(), new AbortController().signal)).toBe(true)
    expect(seen).toEqual(['{"want":1}', '{"want":2}'])

    const stopped = new AbortController(); stopped.abort()
    const none: string[] = []
    expect(await readHistoryFile('claude', { path, relativePath: 'small.jsonl' }, recordingReader(none), memorySink(), stopped.signal)).toBe(false)
  })
})
