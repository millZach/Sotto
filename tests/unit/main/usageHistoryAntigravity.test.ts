// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { antigravityFolders } from '../../../src/main/agents/antigravityFolders'
import { nativeUsageKey } from '../../../src/main/agents/nativeUsage'
import { protobufFields, scanAntigravityHistory } from '../../../src/main/agents/usageHistory/antigravityHistory'
import { isUsageHistoryThreadId } from '../../../src/main/agents/usageHistory/sink'
import { usageTokenObservationSchema } from '../../../src/shared/usageDashboard'
import { memorySink } from '../../fixtures/usageHistory/sink'

// ---- A protobuf writer for the fixture: varints and length-delimited fields only, as `agy` writes them. ----
type Field = [number, number | string | Uint8Array]
const varint = (value: number): number[] => { const out: number[] = []; while (value >= 128) { out.push((value % 128) | 128); value = Math.floor(value / 128) } out.push(value); return out }
function message(...fields: Field[]): Uint8Array {
  const out: number[] = []
  for (const [number, value] of fields) {
    if (typeof value === 'number') { out.push(...varint(number * 8), ...varint(value)); continue }
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    out.push(...varint(number * 8 + 2), ...varint(bytes.length), ...bytes)
  }
  return Uint8Array.from(out)
}
const at = (minute: number): Uint8Array => message([1, Date.UTC(2026, 10, 20, 9, minute) / 1000], [2, 0])
const iso = (minute: number): string => new Date(Date.UTC(2026, 10, 20, 9, minute)).toISOString()
interface Usage { modelId?: number; uncached?: number; output?: number; write?: number; cached?: number; reasoning?: number; id?: string }
const usage = (u: Usage): Uint8Array => message(...([[1, u.modelId], [2, u.uncached], [3, u.output], [4, u.write], [5, u.cached], [9, u.reasoning], [11, u.id]] as Field[]).filter(([, v]) => v !== undefined))
/** A gen_metadata row: the generation's model, usage, instant and any retries. */
const generation = (options: { modelId?: number; name?: string; usage?: Usage; minute?: number; retries?: Usage[]; secret?: string }): Uint8Array => message([1, message(
  ...(options.modelId !== undefined ? [[3, options.modelId] as Field] : []), ...(options.name ? [[19, options.name] as Field] : []),
  ...(options.usage ? [[4, usage(options.usage)] as Field] : []), ...(options.minute !== undefined ? [[9, message([4, at(options.minute)])] as Field] : []),
  ...(options.retries ?? []).map(retry => [17, message([2, usage(retry)])] as Field), ...(options.secret ? [[5, options.secret] as Field] : []))])
/** A steps row's metadata. */
const step = (options: { modelId?: number; name?: string; usage?: Usage; minute?: number }): Uint8Array => message(
  [24, message(...(options.modelId !== undefined ? [[1, options.modelId] as Field] : []), ...(options.name ? [[12, options.name] as Field] : []))],
  ...(options.usage ? [[9, usage(options.usage)] as Field] : []), ...(options.minute !== undefined ? [[8, at(options.minute)] as Field] : []))

function conversation(path: string, rows: { generations?: Uint8Array[]; steps?: (Uint8Array | null)[]; startedMinute?: number }): void {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB); CREATE TABLE trajectory_metadata_blob (data BLOB)')
  rows.generations?.forEach((data, idx) => db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(idx, data))
  rows.steps?.forEach((data, idx) => db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(idx, data))
  if (rows.startedMinute !== undefined) db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(message([2, at(rows.startedMinute)]))
  db.close()
}

const OWNED = 'aaaaaaaa-1111-4111-8111-111111111111'
const OUTSIDE = 'bbbbbbbb-2222-4222-8222-222222222222'
const SECRET = 'PROMPT-TEXT-THAT-MUST-NOT-LEAVE'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-usage-history-antigravity-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-history-antigravity-')); roots.push(root)
  const own = antigravityFolders(join(root, 'sotto')).appData
  const home = join(root, 'home')
  const folders = { own: join(own, 'conversations'), cli: join(home, '.gemini', 'antigravity-cli', 'conversations'), backup: join(home, '.gemini', 'antigravity-backup'), config: join(home, '.config', 'antigravity') }
  for (const folder of Object.values(folders)) await mkdir(folder, { recursive: true })
  const scan = (sink: ReturnType<typeof memorySink>, owned = new Map([[OWNED, 'adapter-thread-1']])) =>
    scanAntigravityHistory({ own, home, owned }, sink.sink, new AbortController().signal)
  return { folders, scan }
}

describe('Antigravity history reader', () => {
  it('counts a generation, its retry and the step that repeats it once, with input holding the cache', async () => {
    const { folders, scan } = await setup()
    conversation(join(folders.cli, `${OUTSIDE}.db`), {
      generations: [generation({ modelId: 1402, name: 'Claude Opus 5.5', minute: 3, secret: SECRET,
        usage: { uncached: 100, cached: 400, write: 50, output: 20, reasoning: 30, id: 'req-1' }, retries: [{ modelId: 1016, uncached: 7, output: 2, id: 'req-retry' }] })],
      steps: [step({ modelId: 1402, usage: { uncached: 100, cached: 400, write: 50, output: 60, id: 'req-1' }, minute: 4 }), null],
    })
    const sink = memorySink()
    await scan(sink)
    const rows = [...sink.rows().values()].sort((a, b) => (b.tokens.input ?? 0) - (a.tokens.input ?? 0))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ providerId: 'antigravity', modelId: 'claude-opus-5-5', origin: 'history', source: 'outside', client: 'antigravity',
      tokens: { input: 550, cached: 400, cacheWrite: 50, output: 60 } })
    // The step's own instant is earlier than none: the generation's is kept as the earlier of two own instants.
    expect(rows[0]!.at).toBe(iso(3))
    // The retry ran on another model; its ID names it from the fixed table.
    expect(rows[1]).toMatchObject({ modelId: 'gemini-3.1-pro', tokens: { input: 7, output: 2 } })
    for (const row of rows) { expect(usageTokenObservationSchema.safeParse(row).success).toBe(true); expect(isUsageHistoryThreadId(row.threadId)).toBe(true) }
    expect(JSON.stringify([sink.tokens, [...sink.cursors]])).not.toContain(SECRET)
    expect(JSON.stringify([sink.tokens, [...sink.cursors]])).not.toContain(OUTSIDE)
  })

  it('reports an owned session as Sotto work and a copy in another folder once', async () => {
    const { folders, scan } = await setup()
    const rows = { generations: [generation({ modelId: 1016, minute: 10, usage: { uncached: 5, output: 9, id: 'req-own' } })] }
    conversation(join(folders.own, `${OWNED}.db`), rows)
    conversation(join(folders.backup, `${OWNED}.db`), rows)
    const sink = memorySink()
    await scan(sink)
    const kept = [...sink.rows().values()]
    const owned = kept.filter(row => row.threadId === 'adapter-thread-1')
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({ modelId: 'gemini-3.1-pro', recordKey: nativeUsageKey('antigravity', 'row', 'adapter-thread-1', '11:req-own') })
    expect(owned[0]).not.toHaveProperty('source')
    expect(kept).toHaveLength(1)
  })

  it('learns a model ID from a named row, keeps no free text as a model, and falls back to the conversation instant', async () => {
    const { folders, scan } = await setup()
    conversation(join(folders.config, `${OUTSIDE}.db`), {
      startedMinute: 30,
      generations: [generation({ modelId: 77, name: 'Gemini 9 Flash', usage: { uncached: 1, output: 1, id: 'named' }, minute: 31 }),
        generation({ modelId: 77, usage: { uncached: 2, output: 2, id: 'unnamed' } }),
        generation({ modelId: 88, name: 'please refactor my login page', usage: { uncached: 3, output: 3, id: 'free-text' }, minute: 32 })],
    })
    const sink = memorySink()
    await scan(sink)
    const byInput = new Map([...sink.rows().values()].map(row => [row.tokens.input, row]))
    expect(byInput.get(1)).toMatchObject({ modelId: 'gemini-9-flash', at: iso(31) })
    expect(byInput.get(2)).toMatchObject({ modelId: 'gemini-9-flash', at: iso(30) })
    expect(byInput.get(3)).toMatchObject({ modelId: 'antigravity-model-88' })
  })

  it('reads a file again only when it changed, and skips what is not a conversation', async () => {
    const { folders, scan } = await setup()
    const path = join(folders.cli, `${OUTSIDE}.db`)
    conversation(path, { generations: [generation({ modelId: 1016, minute: 1, usage: { uncached: 5, output: 5, id: 'one' } })] })
    const index = new DatabaseSync(join(folders.cli, 'conversation_summaries.db')); index.exec('CREATE TABLE summaries (id TEXT)'); index.close()
    await writeFile(join(folders.cli, 'broken.db'), 'not a database')
    const sink = memorySink()
    await scan(sink)
    expect(sink.tokens).toHaveLength(1)
    // The broken file keeps no cursor, so it is tried again; the index and the conversation keep theirs.
    expect(sink.cursors.size).toBe(2)
    await scan(sink)
    expect(sink.tokens).toHaveLength(1)
    const db = new DatabaseSync(path)
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, generation({ modelId: 1016, minute: 2, usage: { uncached: 6, output: 6, id: 'two' } }))
    db.close()
    await scan(sink)
    expect(sink.rows().size).toBe(2)
  })

  it('refuses a truncated protobuf field', () => {
    expect(() => protobufFields(Uint8Array.from([0x0a, 0x05, 0x01]))).toThrow()
    expect(protobufFields(message([2, 300], [3, 'x'])).get(2)).toEqual([300])
  })
})
