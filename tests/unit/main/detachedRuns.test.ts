// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentBackgroundWorkSchema, type AgentBackgroundWork } from '../../../src/shared/agentMonitoring'
import { DETACHED_RUN_AFTER_TURN_MS, DETACHED_RUN_ENDED, DETACHED_RUN_UNCHECKED, DetachedRunWatch, detachedRunWork, withDetachedRuns } from '../../../src/main/agents/detachedRuns'
import type { AgentProcess, ListedProcess, ProcessTable, RunMark, ScanProcesses } from '../../../src/main/agents/detachedRunScan'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const SOTTO = 100
const SESSION = '0d15c982-fe12-44e4-8834-23b3be4bd2eb'
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers() })

const listed = (pid: number, parentPid: number, startedAt = pid * 1000): ListedProcess => ({ pid, parentPid, startedAt })
function agent(pid: number, parentPid: number, marks: readonly RunMark[], name = `run-${pid}`): AgentProcess {
  const argv = ['claude', '-p', '--name', name, '--model', 'claude-fable-5-2', '--effort', 'high', 'Read and do director.md']
  return { ...listed(pid, parentPid), client: 'Claude Code', argv, commandLine: argv.join(' '), folder: '/home/zach/Projects/2.5 shooter', marks }
}
const mark = (value = SESSION): RunMark => ({ name: 'CLAUDE_CODE_SESSION_ID', value })

/** A computer whose processes a test sets, scanned the way the real scan is: `include` decides whose marks are read. */
function computer(initial: { processes: ListedProcess[]; agents: AgentProcess[] }) {
  let current = initial
  const scan = vi.fn<ScanProcesses>(async include => {
    const processes = new Map([...current.processes, ...current.agents].map(item => [item.pid, item] as const))
    const table: ProcessTable = { processes, agents: current.agents.filter(item => include(item, processes)) }
    return table
  })
  return { scan, set(next: typeof initial) { current = next } }
}
const base = [listed(1, 0, 0), listed(SOTTO, 1, 500), listed(200, SOTTO)]

describe('the watch', () => {
  it('ties a run outside Sotto to the thread its mark names, and leaves out what runs under Sotto', async () => {
    const host = computer({ processes: base, agents: [agent(961128, 1, [mark()]), agent(300, 200, [mark()]), agent(400, 1, [mark('someone-else')])] })
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: item => item.value === SESSION ? 'thread-a' : undefined })
    cleanup.push(() => watch.close())
    const changed = vi.fn()
    watch.subscribe(changed)
    await watch.lookNow()
    const runs = watch.runsFor('thread-a')!
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ label: 'run-961128', type: 'detached-run', run: { client: 'Claude Code', model: 'claude-fable-5-2', effort: 'high', folder: '/home/zach/Projects/2.5 shooter' } })
    expect(agentBackgroundWorkSchema.safeParse(runs).success).toBe(true)
    expect(changed).toHaveBeenCalledWith(['thread-a'])
    // The same process has the same ID at every look, so the rows do not churn.
    changed.mockClear()
    await watch.lookNow()
    expect(changed).not.toHaveBeenCalled()
    expect(watch.runsFor('thread-a')![0]!.id).toBe(runs[0]!.id)
  })

  it('counts a client that starts its own client once, at the top', async () => {
    const launcher = agent(500, 1, [mark()]), inner = agent(501, 500, [mark()])
    const host = computer({ processes: base, agents: [launcher, inner] })
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: () => 'thread-a' })
    cleanup.push(() => watch.close())
    await watch.lookNow()
    expect(watch.runsFor('thread-a')?.map(run => run.label)).toEqual(['run-500'])
  })

  it('says a thread changed when its run ends, and keeps what it knew when a look fails', async () => {
    const host = computer({ processes: base, agents: [agent(961128, 1, [mark()])] })
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: () => 'thread-a' })
    cleanup.push(() => watch.close())
    await watch.lookNow()
    host.scan.mockRejectedValueOnce(new Error('ps failed'))
    await watch.lookNow()
    expect(watch.runsFor('thread-a')).toHaveLength(1)
    const changed = vi.fn()
    watch.subscribe(changed)
    host.set({ processes: base, agents: [] })
    await watch.lookNow()
    expect(watch.runsFor('thread-a')).toBeUndefined()
    expect(changed).toHaveBeenCalledWith(['thread-a'])
  })

  it('looks a few seconds after a turn ends, and again while it knows of a run, until the run ends', async () => {
    vi.useFakeTimers()
    const host = computer({ processes: base, agents: [agent(961128, 1, [mark()])] })
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: () => 'thread-a', followMs: 15_000 })
    cleanup.push(() => watch.close())
    watch.turnEnded()
    await vi.advanceTimersByTimeAsync(DETACHED_RUN_AFTER_TURN_MS - 1)
    expect(host.scan).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(host.scan).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(host.scan).toHaveBeenCalledTimes(2)
    host.set({ processes: base, agents: [] })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(host.scan).toHaveBeenCalledTimes(3)
    // Nothing left to follow, so it waits for the next turn to end.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(host.scan).toHaveBeenCalledTimes(3)
  })

  it('stops a run only once a fresh look still finds that very process', async () => {
    const host = computer({ processes: base, agents: [agent(961128, 1, [mark()])] })
    const end = vi.fn(async (pid: number) => { void pid; host.set({ processes: base, agents: [] }); return true })
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: () => 'thread-a', end })
    cleanup.push(() => watch.close())
    await watch.lookNow()
    const id = watch.runsFor('thread-a')![0]!.id
    await expect(watch.stop('thread-b', id)).rejects.toThrow(DETACHED_RUN_ENDED)
    await watch.stop('thread-a', id)
    expect(end).toHaveBeenCalledWith(961128)
    expect(watch.runsFor('thread-a')).toBeUndefined()
  })

  it('signals nothing when the process ended, or another took its number, since the row was drawn', async () => {
    const host = computer({ processes: base, agents: [agent(961128, 1, [mark()])] })
    const end = vi.fn(async () => true)
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: () => 'thread-a', end })
    cleanup.push(() => watch.close())
    await watch.lookNow()
    const id = watch.runsFor('thread-a')![0]!.id
    // The same number, started later: another process.
    host.set({ processes: base, agents: [{ ...agent(961128, 1, [mark()]), startedAt: 99_999_999 }] })
    await expect(watch.stop('thread-a', id)).rejects.toThrow(DETACHED_RUN_ENDED)
    expect(end).not.toHaveBeenCalled()
  })
})

describe('when a look fails', () => {
  it('stops nothing when the look before Stop could not read the table', async () => {
    const host = computer({ processes: base, agents: [agent(961128, 1, [mark()])] })
    const end = vi.fn(async () => true)
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: () => 'thread-a', end })
    cleanup.push(() => watch.close())
    await watch.lookNow()
    const id = watch.runsFor('thread-a')![0]!.id
    host.scan.mockRejectedValueOnce(new Error('ps failed'))
    await expect(watch.stop('thread-a', id)).rejects.toThrow(DETACHED_RUN_UNCHECKED)
    expect(end).not.toHaveBeenCalled()
  })

  it('tries again after a first look that failed, though it knows of no run yet', async () => {
    vi.useFakeTimers()
    const host = computer({ processes: base, agents: [agent(961128, 1, [mark()])] })
    host.scan.mockRejectedValueOnce(new Error('ps failed'))
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: () => 'thread-a', followMs: 15_000 })
    cleanup.push(() => watch.close())
    watch.turnEnded()
    await vi.advanceTimersByTimeAsync(DETACHED_RUN_AFTER_TURN_MS)
    expect(watch.runsFor('thread-a')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(watch.runsFor('thread-a')).toHaveLength(1)
  })
})

describe('just after Sotto starts', () => {
  it('looks again while a marked client has no owner yet, as when the adapters have not loaded their sessions', async () => {
    vi.useFakeTimers()
    const host = computer({ processes: base, agents: [agent(961128, 1, [mark()])] })
    let loaded = false
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: () => loaded ? 'thread-a' : undefined, followMs: 15_000 })
    cleanup.push(() => watch.close())
    watch.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(watch.runsFor('thread-a')).toBeUndefined()
    loaded = true
    await vi.advanceTimersByTimeAsync(15_000)
    expect(watch.runsFor('thread-a')).toHaveLength(1)
  })

  it('stops looking after a while for a client no thread will ever own', async () => {
    vi.useFakeTimers()
    const host = computer({ processes: base, agents: [agent(400, 1, [mark('someone-elses-session')])] })
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: () => undefined, followMs: 15_000 })
    cleanup.push(() => watch.close())
    watch.start()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(host.scan.mock.calls.length).toBeLessThanOrEqual(10)
  })
})

describe('many runs on one thread', () => {
  it('lists the oldest, the same ones at every look, whatever order the system gives', async () => {
    const runs = Array.from({ length: 20 }, (_, index) => ({ ...agent(1000 + index, 1, [mark()]), startedAt: (100 - index) * 1000 }))
    const host = computer({ processes: base, agents: runs })
    const watch = new DetachedRunWatch({ scan: host.scan, rootPid: SOTTO, owner: () => 'thread-a' })
    cleanup.push(() => watch.close())
    await watch.lookNow()
    const first = watch.runsFor('thread-a')!.map(run => run.label)
    expect(first).toHaveLength(16)
    expect(first[0]).toBe('run-1019')
    expect(first).not.toContain('run-1000')
    host.set({ processes: base, agents: [...runs].reverse() })
    await watch.lookNow()
    expect(watch.runsFor('thread-a')!.map(run => run.label)).toEqual(first)
  })
})

describe('background work with detached runs', () => {
  const subagent: AgentBackgroundWork = { id: '0d5c4b7e-3f5a-4f0e-8a51-2b8f1c9d7e60', label: 'Review the diff', type: 'subagent' }
  const run = detachedRunWork(agent(961128, 1, [mark()]))

  it('hands back a provider\'s list uncopied when there are no runs, and puts runs after the provider\'s work', () => {
    const work = [subagent]
    expect(withDetachedRuns(work, undefined)).toBe(work)
    expect(withDetachedRuns(undefined, undefined)).toBeUndefined()
    expect(withDetachedRuns(work, [run])).toEqual([subagent, run])
    expect(withDetachedRuns([subagent, run], [])).toEqual([subagent])
    expect(withDetachedRuns([run], undefined)).toBeUndefined()
  })
})

describe('the workspace', () => {
  it('lays a thread\'s runs over its background work, keeps them across provider updates, never saves them, and stops one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-detached-runs-'))
    const native = new FakeProviderHost()
    const host = new WorkspaceHost(native, directory)
    cleanup.push(async () => { host.dispose(); await rm(directory, { recursive: true, force: true }) })
    await host.connect()
    const threadId = host.workspaceSnapshot().threads[0]!.id
    const computerNow = computer({ processes: base, agents: [agent(961128, 1, [mark()])] })
    const end = vi.fn(async () => { computerNow.set({ processes: base, agents: [] }); return true })
    const watch = new DetachedRunWatch({ scan: computerNow.scan, rootPid: SOTTO, owner: () => threadId, end })
    cleanup.push(() => watch.close())
    host.watchDetachedRuns(watch)
    await watch.lookNow()
    const work = () => host.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.backgroundWork
    expect(work()?.map(item => item.type)).toEqual(['detached-run'])
    // A provider update merges the thread again, its own subagent first and the run after it.
    const subagent = { id: '0d5c4b7e-3f5a-4f0e-8a51-2b8f1c9d7e60', label: 'Review the diff', type: 'subagent' as const }
    native.state.threads.find(thread => thread.id === threadId)!.backgroundWork = [subagent]
    native.emit()
    expect(work()?.map(item => item.type)).toEqual(['subagent', 'detached-run'])
    await host.snapshot()
    const saved = await readFile(join(directory, 'workspace.json'), 'utf8')
    expect(saved).not.toContain('tetherfall')
    expect(saved).not.toContain('detached-run')
    await host.stopDetachedRun(threadId, work()![1]!.id)
    expect(end).toHaveBeenCalledWith(961128)
    expect(work()).toEqual([subagent])
  })

  it('keeps a thread\'s runs, and their Stop, while its provider is disconnected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-detached-runs-'))
    const native = new FakeProviderHost()
    const host = new WorkspaceHost(native, directory)
    cleanup.push(async () => { host.dispose(); await rm(directory, { recursive: true, force: true }) })
    await host.connect()
    const threadId = host.workspaceSnapshot().threads[0]!.id
    const watch = new DetachedRunWatch({ scan: computer({ processes: base, agents: [agent(961128, 1, [mark()])] }).scan, rootPid: SOTTO, owner: () => threadId })
    cleanup.push(() => watch.close())
    host.watchDetachedRuns(watch)
    await watch.lookNow()
    host.disconnect()
    expect(host.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.backgroundWork?.map(item => item.type)).toEqual(['detached-run'])
  })
})
