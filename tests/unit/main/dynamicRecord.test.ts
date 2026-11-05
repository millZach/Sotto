// ADR-0191 decision 9: its record counts an overseer's pieces per model, in numbers and model names alone, on Usage
// history's terms, and Clear its record empties it so nothing from before counts again.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DYNAMIC_RECORD_PIECES_MAX, DynamicRecord, dynamicRecordTokens } from '../../../src/main/agents/dynamicRecord'

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function fixture(threadTokens?: () => ReadonlyMap<string, number>) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-dynamic-record-'))
  folders.push(directory)
  const record = new DynamicRecord(directory, threadTokens)
  await record.load()
  return { directory, record }
}
const saved = async (directory: string): Promise<unknown> => JSON.parse(await readFile(join(directory, 'dynamic-record.json'), 'utf8'))
const sol = { provider: 'codex', model: 'native:codex:model:gpt-6.1-sol', name: 'GPT-6.1 Sol' } as const
const opus = { provider: 'claude', model: 'native:claude:model:opus', name: 'Opus 5.5' } as const

describe('its record', () => {
  it('counts a piece once, finished once, and the tokens its thread used since it was last counted', async () => {
    const { record } = await fixture()
    record.started({ thread: 'worker-1', ...sol })
    record.started({ thread: 'worker-1', ...sol })
    expect(record.watches('worker-1')).toBe(true)
    expect(record.watches('someone-else')).toBe(false)
    record.ended('worker-1', false, 1_000)
    record.ended('worker-1', true, 5_000)
    // A later brief to the same worker: answered again, more tokens.
    record.ended('worker-1', true, 8_000)
    record.ended('worker-1', true, 7_000)
    expect(record.line(sol.model)).toEqual({ ...sol, pieces: 1, finished: 1, moved: 0, tokens: 8_000 })
  })

  it('counts a piece moved once, only when it went to another model, and lists the most-used model first', async () => {
    const { record } = await fixture()
    record.started({ thread: 'worker-1', ...opus })
    record.started({ thread: 'worker-2', ...sol })
    record.started({ thread: 'worker-3', ...sol })
    record.moved('worker-3', sol.model)
    record.moved('worker-2', opus.model); record.moved('worker-2', opus.model); record.moved('never-started', opus.model)
    expect(record.read().models.map(row => [row.name, row.pieces, row.moved])).toEqual([['GPT-6.1 Sol', 2, 1], ['Opus 5.5', 1, 0]])
  })

  it('keeps counts and model names alone across a restart, and clears them so earlier pieces never count again', async () => {
    const { directory, record } = await fixture()
    record.started({ thread: 'worker-1', ...sol })
    record.ended('worker-1', true, 2_000)
    await vi.waitFor(async () => expect(await saved(directory)).toEqual({ version: 1, models: [{ ...sol, pieces: 1, finished: 1, moved: 0, tokens: 2_000 }],
      pieces: [{ thread: 'worker-1', model: sol.model, finished: true, tokens: 2_000 }] }))
    const again = new DynamicRecord(directory)
    await again.load()
    expect(again.read().models).toHaveLength(1)
    await again.clear()
    expect(again.read()).toEqual({ models: [] })
    again.ended('worker-1', true, 9_000)
    again.moved('worker-1', opus.model)
    expect(again.read()).toEqual({ models: [] })
    const cleared = new DynamicRecord(directory)
    await cleared.load()
    expect(cleared.read()).toEqual({ models: [] })
  })

  it('loses only a damaged line or piece, with the pieces of a lost line, and watches only the newest pieces', async () => {
    const { directory } = await fixture()
    await writeFile(join(directory, 'dynamic-record.json'), JSON.stringify({ version: 1, models: [{ ...sol, pieces: 2, finished: 1, moved: 0, tokens: 10 }, { ...opus, pieces: -1 }],
      pieces: [{ thread: 'worker-1', model: sol.model, tokens: 4 }, { thread: 7 }, { thread: 'worker-2', model: opus.model, tokens: 0 }] }))
    const record = new DynamicRecord(directory)
    await record.load()
    expect(record.read().models).toEqual([{ ...sol, pieces: 2, finished: 1, moved: 0, tokens: 10 }])
    expect(record.watches('worker-1')).toBe(true)
    // Its line was damaged, so its ending cannot count against a line made again from nothing.
    expect(record.watches('worker-2')).toBe(false)
    for (let index = 0; index <= DYNAMIC_RECORD_PIECES_MAX; index++) record.started({ thread: `piece-${index}`, ...opus })
    expect(record.watches('worker-1')).toBe(false)
    expect(record.watches(`piece-${DYNAMIC_RECORD_PIECES_MAX}`)).toBe(true)
    expect(record.line(opus.model)?.pieces).toBe(DYNAMIC_RECORD_PIECES_MAX + 1)
  })

  it('tops up a watched piece\'s tokens from its thread when the record is read, for usage that arrived after its outcome', async () => {
    const threads = new Map<string, number>()
    const { record } = await fixture(() => threads)
    record.started({ thread: 'worker-1', ...sol })
    record.ended('worker-1', true, 1_000)
    threads.set('worker-1', 1_500)
    expect(record.read().models[0]).toMatchObject({ finished: 1, tokens: 1_500 })
    // A thread that reports less, or is gone, takes nothing back.
    threads.set('worker-1', 900)
    expect(record.read().models[0]!.tokens).toBe(1_500)
    threads.clear()
    expect(record.read().models[0]!.tokens).toBe(1_500)
  })

  it('counts a thread\'s input, cached input included, and its output', () => {
    expect(dynamicRecordTokens({ input: 300, cached: 250, output: 20 })).toBe(320)
    expect(dynamicRecordTokens(undefined)).toBe(0)
  })
})
