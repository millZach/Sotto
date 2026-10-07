// @vitest-environment node
/**
 * Early start (#769) for Claude Code. The first keystroke in a thread's composer starts the CLI the thread's next send
 * would start, so that send pays nothing to start it. For a new thread, whose first send creates it, that is a spare:
 * the CLI started on the session ID the send will create the thread under, answered `initialize` and nothing more.
 * These run the whole stack a window's command goes through (workspace, Sotto thread host, adapter) over the fake CLI.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterSessionOptions } from './adapterContract'
import { claudeFixture } from '../fixtures/claudeFixture'
import { fakeClaudeExited, fakeClaudeLaunch, fakeClaudeLaunches, fakeClaudeRecords, fakeClaudeSessionFiles, fakeClaudeSessionFolder } from '../fixtures/fakeClaudeRecords'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

const launches = (f: Fixture) => fakeClaudeLaunches(f.root)
const sessionFiles = (f: Fixture) => fakeClaudeSessionFiles(f.root)
const exited = (f: Fixture, session: string) => fakeClaudeExited(f.root, session)
const violations = (f: Fixture) => readFile(join(f.root, 'violations.jsonl'), 'utf8').catch(() => '')
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
    const [spare, ...more] = await launches(f)
    expect(more).toEqual([])
    expect(spare).toMatchObject({ resume: false })
    // Nothing native or durable exists for the thread yet: no session file, no adapter record, no binding.
    expect(await sessionFiles(f)).toEqual([])
    expect(Object.values(await aliases(f)).map(alias => alias.sessionId)).not.toContain(spare!.session)
    expect(registry.byThread(threadId)).toBeUndefined()
    expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.nativeSessionStarted).toBe(false)

    expect(await send(threadId)).toEqual({ accepted: true })
    // The send created the thread on the spare's session and wrote its prompt to that same CLI.
    expect(await launches(f)).toHaveLength(1)
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
    const before = (await launches(f)).length
    expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.providerSessionOpen).toBeUndefined()
    await workspace.startThreadSession(threadId)
    expect((await launches(f)).slice(before)).toMatchObject([{ resume: true }])
    expect(await send(threadId, 'Synthetic second prompt')).toEqual({ accepted: true })
    expect(await launches(f)).toHaveLength(before + 1)
  })

  it('leaves nothing behind when the user types and never sends: the reaper stops the spare', async () => {
    const { f, registry, workspace, draft } = await stack({ reaperSweepMs: 20, sessionIdleMs: 150 })
    const threadId = await draft()
    await workspace.startThreadSession(threadId)
    const [spare] = await launches(f)
    // The fake keeps its pid in alive-<session>.json while it runs and removes it as it exits; the stop is the assertion.
    await expect.poll(() => exited(f, spare!.session), { timeout: 12_000 }).toBe(true)
    expect(await sessionFiles(f)).toEqual([])
    expect(await aliases(f)).toEqual({})
    expect(registry.byThread(threadId)).toBeUndefined()
    expect(workspace.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.nativeSessionStarted).toBe(false)
  })

  it('starts the thread’s own CLI when it is created with other settings than its spare, and stops the spare', async () => {
    const { f, registry, workspace, draft, send } = await stack()
    const threadId = await draft({ reasoningEffort: 'low' })
    await workspace.startThreadSession(threadId)
    const [spare] = await launches(f)
    expect(await workspace.execute({ type: 'configure-thread', commandId: randomUUID(), threadId, reasoningEffort: 'high' })).toMatchObject({ accepted: true })
    expect(await send(threadId)).toEqual({ accepted: true })
    const all = await launches(f)
    expect(all).toHaveLength(2)
    expect(all[1]!.args[all[1]!.args.indexOf('--effort') + 1]).toBe('high')
    expect(await f.realId(registry.byThread(threadId)!.sessionId)).not.toBe(spare!.session)
    await expect.poll(() => exited(f, spare!.session)).toBe(true)
    expect(await sessionFiles(f)).not.toContain(spare!.session)
  })

  it('starts the thread’s own CLI without waiting for a spare it did not adopt to exit', async () => {
    const { f, registry, workspace, draft, send } = await stack()
    const threadId = await draft({ reasoningEffort: 'low' })
    await workspace.startThreadSession(threadId)
    const [spare] = await launches(f)
    // A start waits for whatever is in `closing` for its thread. The stop's kill after half a second bounds any exit, so
    // timing the send could not tell a wait from none; what the stop registers can.
    const closing = (f.adapter as unknown as { closing: Map<string, Promise<void>> }).closing
    const waitedFor = vi.spyOn(closing, 'set')
    expect(await workspace.execute({ type: 'configure-thread', commandId: randomUUID(), threadId, reasoningEffort: 'high' })).toMatchObject({ accepted: true })
    expect(await send(threadId)).toEqual({ accepted: true })
    expect(await f.realId(registry.byThread(threadId)!.sessionId)).not.toBe(spare!.session)
    await expect.poll(() => exited(f, spare!.session)).toBe(true)
    // The spare ran a session of its own, so nothing waited for it to exit.
    expect(waitedFor).not.toHaveBeenCalled()
    expect(await violations(f)).toBe('')
  })

  it('stops a spare and waits for it before resuming a session file already on its session ID', async () => {
    const { f, registry, workspace, draft, send } = await stack()
    const threadId = await draft()
    await workspace.startThreadSession(threadId)
    const [spare] = await launches(f)
    // A Claude Code that wrote its session file at `initialize` would leave this, and the send then resumes it.
    const folder = fakeClaudeSessionFolder(f.root, f.root)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${spare!.session}.jsonl`), '')
    await writeFile(join(f.root, 'exit-delay.json'), JSON.stringify({ ms: 300 }))
    expect(await send(threadId)).toEqual({ accepted: true })
    expect(await f.realId(registry.byThread(threadId)!.sessionId)).toBe(spare!.session)
    const order = (await fakeClaudeRecords(f.root)).flatMap(record => {
      const launch = fakeClaudeLaunch(record)
      return launch ? [launch.resume ? 'resume' : 'launch'] : record.method === 'exit' && record.params?.frame?.session === spare!.session ? ['spare exit'] : []
    })
    expect(order).toEqual(['launch', 'spare exit', 'resume'])
    await rm(join(f.root, 'exit-delay.json'))
    expect(await violations(f)).toBe('')
  })

  it('gives a thread whose worktree the first send makes no early start', async () => {
    const { f, workspace } = await stack()
    const threadId = randomUUID()
    await workspace.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'New worktree', modelId: f.modelId, workingCopy: 'independent' })
    await workspace.startThreadSession(threadId)
    expect(await launches(f)).toEqual([])
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
    const before = (await launches(f)).length
    f.adapter.observeThreads(ids)
    const connected = f.adapter.connect()
    await expect.poll(async () => (await launches(f)).length - before).toBe(4)
    await writeFile(join(f.root, 'initialize-release'), '')
    await connected
    expect((await launches(f)).length - before).toBe(6)
    // At no point were more than four started and not yet answered: each later start waited for an answer.
    let waiting = 0; let peak = 0
    for (const record of await fakeClaudeRecords(f.root)) {
      if (fakeClaudeLaunch(record)) peak = Math.max(peak, ++waiting)
      else if (record.method === 'initialize-answered') waiting--
    }
    expect(peak).toBe(4)
    await rm(join(f.root, 'initialize-script.json'))
    const snapshot = await f.adapter.snapshot()
    expect(ids.every(id => snapshot.threads.find(thread => thread.id === id)?.providerSessionOpen)).toBe(true)
  })
})
