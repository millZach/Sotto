// @vitest-environment node
// Node -> Rust -> Node for the coordinator's own stores, `workspace.json`, `threads.json` and `agents.json` (ADR-0214).
// A Rust host re-encoded each thread's worktree and last turn from its own structs, dropping `baseCommit`, `sentBranch`,
// `reclaimedAt` and the rest. Here Node's own parsers read each store before and after a Rust host's start and stop,
// and read the stores a Rust host writes for a thread it made. Runs when `SOTTO_TEST_RUST_HOST=1` (the Rust host CI job,
// and locally after a `cargo build`).
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSavedAgents } from '../../src/main/agents/control'
import { parseThreadRegistry } from '../../src/main/agents/threads'
import { parseWorkspaceFile } from '../../src/main/agents/workspace'
import { runRustStoreTest } from './rustHostNodeStores'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'
const FIXTURES = resolve('tests/fixtures/nodeHostStores')

/** What Node reads of each store, without the facts of the running host that each host program writes afresh. */
const STORES: readonly { file: string; read: (value: unknown) => unknown }[] = [
  { file: 'workspace.json', read: value => {
    const { snapshot, ...rest } = parseWorkspaceFile(value)
    const { connected, name, version, capabilities, models, ...kept } = snapshot
    void connected; void name; void version; void capabilities; void models
    return { ...rest, snapshot: kept }
  } },
  { file: 'threads.json', read: parseThreadRegistry },
  { file: 'agents.json', read: parseSavedAgents },
]

const rustTest = (name: string, dir: string): void => runRustStoreTest(`coordinator::tests::${name}`, dir)

describe.skipIf(!RUN_RUST_HOST)('coordinator stores across a Rust host and a rollback to Node', () => {
  let dir: string
  const before = new Map<string, unknown>()

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sotto-rust-host-stores-'))
    for (const { file, read } of STORES) {
      await copyFile(join(FIXTURES, file), join(dir, file))
      // What Node reads of the store as Node wrote it; a fixture Node itself would refuse fails here.
      before.set(file, read(JSON.parse(await readFile(join(dir, file), 'utf8'))))
    }
    rustTest('node_host_stores_survive_a_rust_load_and_save', dir)
  }, 600_000)

  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it.each(STORES.map(store => store.file))('%s reads in Node after a Rust load and save exactly as before', async file => {
    const { read } = STORES.find(store => store.file === file)!
    expect(read(JSON.parse(await readFile(join(dir, file), 'utf8')))).toEqual(before.get(file))
  })
})

describe.skipIf(!RUN_RUST_HOST)('coordinator stores for a thread a Rust host made', () => {
  let dir: string
  const THREAD = '00000000-0000-4000-8000-00000000000a'

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sotto-rust-made-thread-'))
    rustTest('a_thread_made_here_is_written_the_way_node_reads_it', dir)
  }, 600_000)

  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(join(dir, file), 'utf8'))

  it('workspace.json reads in Node with the thread in it', async () => {
    const workspace = parseWorkspaceFile(await read('workspace.json'))
    expect(workspace.snapshot.threads.find(thread => thread.id === THREAD)).toMatchObject({ title: 'Made on Rust', providerId: 'codex' })
  })

  it('threads.json reads in Node with the thread bound to its provider', async () => {
    expect(parseThreadRegistry(await read('threads.json')).bindings).toContainEqual(expect.objectContaining({ threadId: THREAD, provider: 'codex' }))
  })

  it('agents.json reads in Node', async () => {
    const agents = await read('agents.json')
    expect(() => parseSavedAgents(agents)).not.toThrow()
  })
})
