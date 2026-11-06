// @vitest-environment node
/**
 * The cheaper workspace flush keeps each thread's text (#1332): a save serializes again only the threads that changed, and
 * what reaches `workspace.json` is the same, byte for byte, as serializing the whole saved state. The verifying mode
 * (`SOTTO_VERIFY_THREAD_CHANGES=1`) makes every save check its text against the whole, so a thread changed without being
 * marked fails the save here.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const THREADS = 40

function state(root: string): AgentHostSnapshot {
  return {
    ...structuredClone(EMPTY_AGENT_HOST), name: 'Fake provider', version: '1', connected: true,
    capabilities: { ...structuredClone(EMPTY_AGENT_HOST.capabilities), projects: true, threads: true, submit: true, observe: true },
    projects: [{ id: 'project', title: 'Synthetic project', path: root }],
    models: [{ id: 'fake:model', provider: 'Fake', name: 'Test model', ready: true }],
    threads: Array.from({ length: THREADS }, (_, index): AgentThread => ({
      id: `thread-${index}`, projectId: 'project', title: `Synthetic thread ${index}`, modelId: 'fake:model', status: 'idle', messages: [], requests: [],
      usage: { total: { input: 1_000 + index, output: 200 }, rateVersions: [], partial: false, updatedAt: '2026-11-05T00:00:00.000Z' },
    })),
  }
}

const cleanup: Array<() => Promise<void>> = []
beforeEach(() => { vi.stubEnv('SOTTO_VERIFY_THREAD_CHANGES', '1') })
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(history = { enabled: true }) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-thread-texts-'))
  cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-thread-texts-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  })
  const adapter = new FakeProviderHost(state(root))
  const host = new WorkspaceHost(adapter, root, () => history.enabled, undefined, false, false, true)
  cleanup.push(async () => { host.disconnect(); host.dispose() })
  await host.initialize()
  await host.connect()
  await host.flush()
  // The first publication after a connect is taken in whole, which marks every thread; the ones after carry changes.
  adapter.emit()
  await host.flush()
  return { root, adapter, host, history }
}

/** The characters `JSON.stringify` made during `work`: the flush's serializing, which no longer grows with every thread. */
async function serialized(work: () => Promise<void>): Promise<number> {
  const native = JSON.stringify
  let characters = 0
  vi.spyOn(JSON, 'stringify').mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
    const text = native(...args)
    characters += text?.length ?? 0
    return text
  }) as typeof JSON.stringify)
  try { await work() } finally { vi.mocked(JSON.stringify).mockRestore() }
  return characters
}

const saved = async (root: string) => JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')) as { snapshot: { threads: AgentThread[] } }

describe('the threads’ kept text in the workspace flush (#1332)', () => {
  it('serializes again only the thread that changed, and writes what the whole state says', async () => {
    const { root, adapter, host } = await fixture()
    const file = (await readFile(join(root, 'workspace.json'), 'utf8')).length
    // Verifying serializes the whole state as well, so this count is taken with it off.
    vi.stubEnv('SOTTO_VERIFY_THREAD_CHANGES', '')
    const thread = adapter.state.threads[3]!
    thread.usage = { ...thread.usage!, total: { input: 99_999, output: 200 } }
    adapter.emit()
    const characters = await serialized(() => host.flush())
    // One thread and the organization around the threads, rather than all forty of them.
    expect(characters).toBeLessThan(file / 4)
    expect((await saved(root)).snapshot.threads[3]!.usage?.total?.input).toBe(99_999)

    // The text matches the whole saved state through further changes, a renamed thread among them.
    vi.stubEnv('SOTTO_VERIFY_THREAD_CHANGES', '1')
    await host.renameThread('thread-7', 'Renamed by the user')
    adapter.state.threads[0]!.status = 'running'
    adapter.emit()
    await host.flush()
    const threads = (await saved(root)).snapshot.threads
    expect(threads[7]!.title).toBe('Renamed by the user')
    expect(threads[0]!.status).toBe('running')
    expect(threads).toHaveLength(THREADS)
  })

  it('writes nothing again when nothing changed, and serializes no thread to find that out', async () => {
    const { root, adapter, host } = await fixture()
    const file = (await readFile(join(root, 'workspace.json'), 'utf8')).length
    vi.stubEnv('SOTTO_VERIFY_THREAD_CHANGES', '')
    adapter.emit()
    const characters = await serialized(() => host.flush())
    expect(characters).toBeLessThan(file / 4)
  })

  it('serializes every thread again when local history is turned off, and strips what it must', async () => {
    const { root, adapter, host, history } = await fixture()
    history.enabled = false
    await host.privacyChanged()
    adapter.emit()
    await host.flush()
    const threads = (await saved(root)).snapshot.threads
    expect(threads).toHaveLength(THREADS)
    for (const thread of threads) expect(thread.requests).toEqual([])
  })
})
