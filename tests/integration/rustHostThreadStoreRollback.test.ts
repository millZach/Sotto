// @vitest-environment node
// Node -> Rust -> Node for every provider store the Rust host shares with Node (ADR-0214). On forge a Rust host's save
// stripped all 208 Claude records in claude-threads.json to six fields; the rollback to Node then refused the whole
// file, set it aside as .corrupt-*, and every Claude thread there lost its resume. Here Node's own parsers check each
// store before and after a Rust load and save, which must change nothing Node reads. Runs when `SOTTO_TEST_RUST_HOST=1`
// (the Rust host CI job, and locally after a `cargo build`).
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unreadableEntries } from '../../src/main/storage/atomicJsonStore'
import { NODE_THREAD_STORES } from './rustHostNodeStores'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'
const THREAD = '6f1c2d3e-4b5a-4c6d-8e7f-001122334455', WAITING = '7a2b3c4d-5e6f-4a7b-9c8d-112233445566'
const SESSION = '1b4e28ba-2fa1-41d2-883f-0016d3cca427', EARLIER = '2c5f39cb-3a52-42e3-994e-1127e4ddb538'
const base = { projectId: 'project-1', cwd: '/home/zach/work', title: 'Fix the build', modelId: 'model-1', createdAt: '2026-11-20T10:00:00.000Z', origins: [] }

/** Each store as Node writes it: a thread with the fields Node keeps beyond Rust's own, and, where Node allows one, a thread with no session yet. */
const { claude, codex, muse, opencode, grok, devin, cursor, antigravity, hermes } = NODE_THREAD_STORES
const STORES: readonly { file: string; parse: (value: unknown) => unknown; store: Record<string, unknown> }[] = [
  { ...claude, store: {
    [THREAD]: { ...base, sessionId: SESSION, reasoningEffort: 'high', runtimeMode: 'full-access', lineage: [{ sessionId: EARLIER }], forkMessageIds: { a: 'b' }, answeredRequestIds: ['r-1'], journalGeneration: 3 } } },
  { ...codex, store: {
    [THREAD]: { ...base, codexThreadId: 'codex-thread-1', reasoningEffort: 'high', runtimeMode: 'full-access' } } },
  { ...muse, store: {
    [THREAD]: { ...base, museSessionId: SESSION, settingsConfirmed: true, origins: [], answeredRequestIds: ['r-1'] },
    [WAITING]: { ...base, title: 'Not started yet', settingsConfirmed: false, origins: [] } } },
  { ...opencode, store: {
    [THREAD]: { ...base, sessionId: 'ses_1', createToken: 'token-1', sessionConfirmed: true, runtimeMode: 'full-access', origins: [] },
    [WAITING]: { ...base, title: 'Not started yet', createToken: 'token-2', runtimeMode: 'approval-required', origins: [] } } },
  { ...grok, store: {
    [THREAD]: { ...base, grokSessionId: SESSION },
    [WAITING]: { ...base, title: 'Not started yet' } } },
  { ...devin, store: {
    [THREAD]: { ...base, devinSessionId: 'devin-1', settingsConfirmed: true, origins: [] },
    [WAITING]: { ...base, title: 'Not started yet', settingsConfirmed: false, origins: [] } } },
  { ...cursor, store: {
    [THREAD]: { ...base, cursorSessionId: 'cursor-1', runtimeMode: 'full-access' },
    [WAITING]: { ...base, title: 'Not started yet', runtimeMode: 'approval-required' } } },
  { ...antigravity, store: {
    [THREAD]: { ...base, antigravitySessionId: 'agy-1', runtimeMode: 'full-access' },
    [WAITING]: { ...base, title: 'Not started yet', runtimeMode: 'approval-required' } } },
  { ...hermes, store: {
    [THREAD]: { ...base, hermesSessionId: 'hermes-1', runtimeMode: 'full-access' },
    [WAITING]: { ...base, title: 'Not started yet', runtimeMode: 'full-access' } } },
]

describe.skipIf(!RUN_RUST_HOST)('provider stores across a Rust host and a rollback to Node', () => {
  let dir: string
  const before = new Map<string, unknown>()

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sotto-rust-thread-stores-'))
    for (const { file, parse, store } of STORES) {
      // What Node reads of the store as Node wrote it; a fixture Node itself would refuse fails here.
      before.set(file, parse(store))
      await writeFile(join(dir, file), JSON.stringify(store, null, 2))
    }
    execFileSync('cargo', ['test', '-p', 'sotto-core', '--lib', '--locked', 'providers::tests::node_thread_stores_survive_a_rust_load_and_save', '--', '--exact'], {
      stdio: 'inherit', env: { ...process.env, SOTTO_SHARED_THREAD_STORES_DIR: dir },
    })
  }, 600_000)

  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it.each(STORES.map(store => store.file))('%s reads in Node after a Rust load and save exactly as before', async file => {
    const { parse } = STORES.find(store => store.file === file)!
    const after = JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown
    expect(parse(after)).toEqual(before.get(file))
  })
})

describe.skipIf(!RUN_RUST_HOST)('provider records a Rust host makes', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sotto-rust-created-records-'))
    execFileSync('cargo', ['test', '-p', 'sotto-core', '--lib', '--locked', 'providers::tests::rust_created_acp_records_carry_what_node_requires', '--', '--exact'], {
      stdio: 'inherit', env: { ...process.env, SOTTO_SHARED_STORES_DIR: dir },
    })
  }, 600_000)
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  // Hermes has no fake to drive; the others are also checked after a real conversation in rustHostAllProviders.test.ts.
  it.each([grok, devin, cursor, antigravity, hermes].map(store => store.file))('%s reads in Node, whole', async file => {
    const { parse } = Object.values(NODE_THREAD_STORES).find(store => store.file === file)!
    const read = parse(JSON.parse(await readFile(join(dir, file), 'utf8')))
    expect(unreadableEntries(read) ?? {}).toEqual({})
    expect(read[THREAD]).toMatchObject({ projectId: 'project-1', title: 'Fix the build', createdAt: '2026-11-20T10:00:00.000Z', modelId: 'model-1' })
  })
})

describe('provider stores Node reads entry by entry', () => {
  // A record Node refuses costs only itself: before, one record Rust made without Node's fields set every other
  // thread in the file aside (ADR-0214).
  it.each(STORES.map(store => store.file))('%s keeps the threads it reads beside one it cannot', file => {
    const { parse, store } = STORES.find(entry => entry.file === file)!
    const bare = { cwd: '/home/zach/work', sessionId: SESSION }
    const read = parse({ ...store, [EARLIER]: bare }) as Record<string, unknown>
    expect(Object.keys(read).sort()).toEqual(Object.keys(store).sort())
    expect(unreadableEntries(read)).toEqual({ [EARLIER]: bare })
  })
})
