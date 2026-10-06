// @vitest-environment node
/**
 * Early start (#769) for Claude Code. The first keystroke in a thread's composer starts the CLI the thread's next send
 * would start, so that send pays nothing to start it. For a new thread, whose first send creates it, that is a spare:
 * the CLI started on the session ID the send will create the thread under, answered `initialize` and nothing more.
 * These run the whole stack a window's command goes through (workspace, Sotto thread host, adapter) over the fake CLI.
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdapterSessionOptions } from './adapterContract'
import type { RecordedRpc } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

/** The fake CLI's thread launches, each with the session ID it was started on; the account check's own run is not one. */
const launches = (records: RecordedRpc[]) => records.filter(record => record.method === 'launch' || record.method === 'resume')
  .map(record => (record.params?.frame as { args: string[] }).args).filter(args => args.includes('--session-id') || args.includes('--resume'))
  .map(args => ({ resume: args.includes('--resume'), session: args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1]!, args }))
/** Every session file the fake CLI has written, by session ID. */
async function sessionFiles(f: Fixture): Promise<string[]> {
  const projects = join(f.root, 'home', 'projects')
  const folders = await readdir(projects).catch(() => [] as string[])
  return (await Promise.all(folders.map(folder => readdir(join(projects, folder)).catch(() => [] as string[])))).flat()
    .filter(name => name.endsWith('.jsonl')).map(name => name.slice(0, -'.jsonl'.length))
}
const aliases = async (f: Fixture): Promise<Record<string, { sessionId: string }>> => JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8').catch(() => '{}')) as Record<string, { sessionId: string }>

/** A workspace over the Claude fixture, as the app composes it, with one project on the fixture's folder. */
async function stack(session: AdapterSessionOptions = {}) {
  const f = await claudeFixture(undefined, undefined, undefined, session)
  const registry = new ThreadRegistry(join(f.root, 'identity'))
  const workspace = new WorkspaceHost(new SottoThreadHost('claude', f.host, registry), join(f.root, 'workspace'))
  cleanup.push(async () => { workspace.dispose(); await f.cleanup() })
  await workspace.connect()
  await workspace.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  /** A new thread in the shared checkout, as New thread opens one: nothing native exists for it until its first send. */
  const draft = async (options: { reasoningEffort?: string } = {}): Promise<string> => {
    const threadId = randomUUID()
    await workspace.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Typed into', modelId: f.modelId, workingCopy: 'shared', ...options })
    expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === threadId)).toMatchObject({ nativeSessionStarted: false, worktree: { mode: 'shared', status: 'ready' } })
    return threadId
  }
  const send = (threadId: string, text = 'Synthetic first prompt') => workspace.execute({ type: 'send', threadId, commandId: randomUUID(), messageId: randomUUID(), text })
  return { f, registry, workspace, draft, send }
}

describe('Claude early start', () => {
  it('runs a new thread’s first send on the CLI typing started, so the send starts none', async () => {
    const { f, registry, workspace, draft, send } = await stack()
    const threadId = await draft()
    await workspace.startThreadSession(threadId)
    const [spare, ...more] = launches(await f.driver.requests())
    expect(more).toEqual([])
    expect(spare).toMatchObject({ resume: false })
    // Nothing native or durable exists for the thread yet: no session file, no adapter record, no binding.
    expect(await sessionFiles(f)).toEqual([])
    expect(Object.values(await aliases(f)).map(alias => alias.sessionId)).not.toContain(spare!.session)
    expect(registry.byThread(threadId)).toBeUndefined()
    expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.nativeSessionStarted).toBe(false)

    expect(await send(threadId)).toEqual({ accepted: true })
    // The send created the thread on the spare's session and wrote its prompt to that same CLI.
    expect(launches(await f.driver.requests())).toHaveLength(1)
    expect(await f.realId(registry.byThread(threadId)!.sessionId)).toBe(spare!.session)
    expect(await sessionFiles(f)).toEqual([spare!.session])
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(1)
    await expect.poll(() => workspace.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.providerSessionOpen).toBe(true)
  })

  it('starts a stopped thread’s CLI once, and the send that follows starts none', async () => {
    const { f, registry, workspace, draft, send } = await stack()
    const threadId = await draft()
    expect(await send(threadId)).toEqual({ accepted: true })
    await f.driver.completeTurn(registry.byThread(threadId)!.sessionId, 'Done')
    const sessionId = registry.byThread(threadId)!.sessionId
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === sessionId)?.status).toBe('idle')
    // A restart leaves the thread with no CLI, as the reaper does.
    f.adapter.disconnect(); await f.adapter.closed(); await workspace.connect()
    const before = launches(await f.driver.requests()).length
    expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.providerSessionOpen).toBeUndefined()
    await workspace.startThreadSession(threadId)
    expect(launches(await f.driver.requests()).slice(before)).toMatchObject([{ resume: true }])
    expect(await send(threadId, 'Synthetic second prompt')).toEqual({ accepted: true })
    expect(launches(await f.driver.requests())).toHaveLength(before + 1)
  })

  it('leaves nothing behind when the user types and never sends: the reaper stops the spare', async () => {
    const { f, registry, workspace, draft } = await stack({ reaperSweepMs: 20, sessionIdleMs: 150 })
    const threadId = await draft()
    await workspace.startThreadSession(threadId)
    const [spare] = launches(await f.driver.requests())
    // The fake keeps its pid in alive-<session>.json while it runs and removes it as it exits; the stop is the assertion.
    await expect.poll(async () => (await f.driver.requests()).some(record => record.method === 'exit' && (record.params?.frame as { session?: string }).session === spare!.session), { timeout: 12_000 }).toBe(true)
    expect(await sessionFiles(f)).toEqual([])
    expect(await aliases(f)).toEqual({})
    expect(registry.byThread(threadId)).toBeUndefined()
    expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.nativeSessionStarted).toBe(false)
  })

  it('starts the thread’s own CLI when it is created with other settings than its spare, and stops the spare', async () => {
    const { f, registry, workspace, draft, send } = await stack()
    const threadId = await draft({ reasoningEffort: 'low' })
    await workspace.startThreadSession(threadId)
    const [spare] = launches(await f.driver.requests())
    expect(await workspace.execute({ type: 'configure-thread', commandId: randomUUID(), threadId, reasoningEffort: 'high' })).toMatchObject({ accepted: true })
    expect(await send(threadId)).toEqual({ accepted: true })
    const all = launches(await f.driver.requests())
    expect(all).toHaveLength(2)
    expect(all[1]!.args[all[1]!.args.indexOf('--effort') + 1]).toBe('high')
    expect(await f.realId(registry.byThread(threadId)!.sessionId)).not.toBe(spare!.session)
    await expect.poll(async () => (await f.driver.requests()).some(record => record.method === 'exit' && (record.params?.frame as { session?: string }).session === spare!.session)).toBe(true)
    expect(await sessionFiles(f)).not.toContain(spare!.session)
  })

  it('gives a thread whose worktree the first send makes no early start', async () => {
    const { f, workspace } = await stack()
    const threadId = randomUUID()
    await workspace.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'New worktree', modelId: f.modelId, workingCopy: 'independent' })
    await workspace.startThreadSession(threadId)
    expect(launches(await f.driver.requests())).toEqual([])
  })

  it('starts the watched set’s CLIs at connect a few at a time, not one after another', async () => {
    const { f } = await stack()
    const ids: string[] = []
    for (let index = 0; index < 6; index++) {
      const id = randomUUID(); ids.push(id)
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: `Watched ${index}`, modelId: f.modelId })
    }
    f.adapter.disconnect(); await f.adapter.closed()
    // Every CLI holds its answer to `initialize` until released, so the launches seen meanwhile are the ones started together.
    await writeFile(join(f.root, 'initialize-script.json'), JSON.stringify({ gate: true }))
    const before = launches(await f.driver.requests()).length
    f.adapter.observeThreads(ids)
    const connected = f.adapter.connect()
    await expect.poll(async () => launches(await f.driver.requests()).length - before).toBe(4)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(launches(await f.driver.requests()).length - before).toBe(4)
    await writeFile(join(f.root, 'initialize-release'), '')
    await connected
    expect(launches(await f.driver.requests()).length - before).toBe(6)
    await rm(join(f.root, 'initialize-script.json'))
    const snapshot = await f.adapter.snapshot()
    expect(ids.every(id => snapshot.threads.find(thread => thread.id === id)?.providerSessionOpen)).toBe(true)
  })
})
