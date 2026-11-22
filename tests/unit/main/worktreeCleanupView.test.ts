// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { WorktreeCleanup, type WorktreeCleanupHost } from '../../../src/main/agents/worktreeCleanup'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { heldProvidersOf } from '../../../src/shared/heldProviders'
import { DEFAULT_WORKTREE_CLEANUP } from '../../../src/shared/settings'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

function makeThread(id: string, overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id,
    projectId: 'project-1',
    title: `Thread ${id}`,
    modelId: 'codex:gpt-5',
    status: 'idle',
    messages: [{ id: `msg-${id}`, role: 'assistant', text: 'Done.', createdAt: '2026-11-20T00:00:00.000Z' }],
    requests: [],
    worktree: {
      mode: 'independent',
      status: 'ready',
      path: `/worktrees/${id}`,
      repositoryRoot: '/repo',
      branch: `feat/${id}`,
      sentBranch: `feat/${id}`,
      baseCommit: '1'.repeat(40),
      baseBranch: 'main',
    },
    ...overrides,
  }
}

function makeSnapshot(threads: AgentThread[], overrides: Partial<AgentHostSnapshot> = {}): AgentHostSnapshot {
  return {
    ...structuredClone(EMPTY_AGENT_HOST),
    name: 'fake',
    version: '1',
    connected: true,
    capabilities: { ...structuredClone(EMPTY_AGENT_HOST.capabilities), projects: true, threads: true, submit: true, observe: true },
    projects: [{ id: 'project-1', title: 'Repo', path: '/repo' }],
    threads,
    ...overrides,
  }
}

async function hostFixture(snapshot: AgentHostSnapshot, options?: ConstructorParameters<typeof WorkspaceHost>[2]) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-cleanup-view-'))
  const adapter = new FakeProviderHost(structuredClone(snapshot))
  const host = new WorkspaceHost(adapter, root, options)
  cleanup.push(async () => {
    host.disconnect()
    await host.privacyChanged()
    host.dispose()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-cleanup-view-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  })
  await host.initialize()
  await host.connect()
  // Seed workspace-owned metadata (worktree, workspaceSettledAt, delegatedBy) onto the connected host's records.
  const sourceById = new Map(snapshot.threads.map(thread => [thread.id, thread]))
  for (const live of host.workspaceView().threads) {
    const source = sourceById.get(live.id)
    if (!source) continue
    if (source.worktree) live.worktree = structuredClone(source.worktree)
    if (source.workspaceSettledAt !== undefined) live.workspaceSettledAt = source.workspaceSettledAt
    if (source.delegatedBy !== undefined) live.delegatedBy = source.delegatedBy
  }
  return { root, adapter, host }
}

describe('WorkspaceHost.workspaceView and WorktreeCleanup read path', () => {
  it('returns the same visible projects and threads as workspaceSnapshot without cloning thread records', async () => {
    const visible = makeThread('codex:visible')
    const watcher = makeThread('codex:watcher', { kind: 'watcher' })
    const held = makeThread('muse:held', { projectId: 'muse:proj', providerId: 'muse', modelId: 'muse:muse-1' })
    const snapshot = makeSnapshot([visible, watcher, held], {
      projects: [
        { id: 'project-1', title: 'Repo', path: '/repo' },
        { id: 'muse:proj', title: 'Held project', path: '/held' },
      ],
    })
    const { host } = await hostFixture(snapshot, { watcherEnabled: false, heldProviders: heldProvidersOf({ muse: false }) })

    const snap = host.workspaceSnapshot()
    const firstView = host.workspaceView()
    const secondView = host.workspaceView()

    expect(firstView.projects.map(project => project.id)).toEqual(snap.projects.map(project => project.id))
    expect(firstView.threads.map(thread => thread.id)).toEqual(snap.threads.map(thread => thread.id))
    expect(firstView.threads.map(thread => thread.id)).toEqual(['codex:visible'])
    // Read-only view shares thread objects rather than deep-cloning them, while returning fresh arrays safe to iterate.
    expect(firstView.threads[0]).toBe(secondView.threads[0])
    expect(firstView.threads).not.toBe(secondView.threads)
    expect(firstView.projects).not.toBe(secondView.projects)
  })

  it('runs WorktreeCleanup start, sweepWorktrees and settleMerged without calling workspaceSnapshot', async () => {
    const settled = makeThread('settled-ready', { workspaceSettledAt: '2026-11-20T00:00:00.000Z' })
    const unsettled = makeThread('unsettled-merged')
    const { host } = await hostFixture(makeSnapshot([settled, unsettled]))

    const reclaimed: string[] = []
    vi.spyOn(host, 'reclaimThreadWorktree').mockImplementation(async threadId => { reclaimed.push(threadId); return EMPTY_AGENT_HOST })
    vi.spyOn(host, 'setWorkspaceSettled').mockImplementation(async (_kind, id, settledFlag, _options, guard) => {
      guard?.()
      const live = host.workspaceView().threads.find(item => item.id === id)
      if (live) live.workspaceSettledAt = settledFlag ? '2026-11-22T00:00:00.000Z' : null
      return EMPTY_AGENT_HOST
    })
    const snapshotSpy = vi.spyOn(host, 'workspaceSnapshot')
    const viewSpy = vi.spyOn(host, 'workspaceView')

    const tip = 'a'.repeat(40)
    const git = async (_cwd: string, args: readonly string[]) => {
      if (args[0] === 'symbolic-ref') return 'origin/main\n'
      if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/main') return `${tip}\n`
      if (args[0] === 'rev-parse' && args.includes('--verify')) return `${tip}\n`
      throw new Error(`unexpected git ${args.join(' ')}`)
    }

    const sweeper = new WorktreeCleanup({
      host,
      rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, onSettle: true }),
      autoSettleMerged: () => true,
      pullRequestMerged: async () => true,
      watched: () => false,
      git,
      intervalMs: 60_000_000,
    })
    cleanup.push(() => sweeper.close())

    sweeper.start()
    await sweeper.request()

    expect(snapshotSpy).not.toHaveBeenCalled()
    expect(viewSpy).toHaveBeenCalled()
    expect(reclaimed).toEqual(['settled-ready', 'unsettled-merged'])
  })

  it('re-checks live work and watch state through workspaceView when state changes mid-sweep', async () => {
    const candidate = makeThread('becomes-busy', { workspaceSettledAt: '2026-11-20T00:00:00.000Z' })
    const merged = makeThread('becomes-watched')
    const { host } = await hostFixture(makeSnapshot([candidate, merged]))

    const reclaimed: string[] = []
    vi.spyOn(host, 'reclaimThreadWorktree').mockImplementation(async threadId => { reclaimed.push(threadId); return EMPTY_AGENT_HOST })
    const settleSpy = vi.spyOn(host, 'setWorkspaceSettled').mockImplementation(async (_kind, id, settledFlag, _options, guard) => {
      guard?.()
      const live = host.workspaceView().threads.find(item => item.id === id)
      if (live) live.workspaceSettledAt = settledFlag ? '2026-11-22T00:00:00.000Z' : null
      return EMPTY_AGENT_HOST
    })
    const snapshotSpy = vi.spyOn(host, 'workspaceSnapshot')
    let watched = false

    const tip = 'b'.repeat(40)
    const git = async (_cwd: string, args: readonly string[]) => {
      if (args[0] === 'symbolic-ref') return 'origin/main\n'
      if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/main') return `${tip}\n`
      if (args[0] === 'rev-parse' && args.includes('--verify')) return `${tip}\n`
      throw new Error(`unexpected git ${args.join(' ')}`)
    }

    const sweeper = new WorktreeCleanup({
      host,
      rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, onSettle: true }),
      autoSettleMerged: () => true,
      pullRequestMerged: async (_root, branch) => {
        if (branch === 'feat/becomes-watched') watched = true
        return true
      },
      watched: id => id === 'becomes-watched' && watched,
      git,
    })

    // Mark the candidate running right before the post-eligible live atWork check in sweepWorktrees.
    const originalView = host.workspaceView.bind(host)
    let viewCalls = 0
    vi.spyOn(host, 'workspaceView').mockImplementation(() => {
      viewCalls += 1
      const view = originalView()
      // Calls: 1 settleMerged start, 2 settleMerged post-GitHub recheck, 3 sweepWorktrees start, 4 eligible live check, 5 post-eligible live check.
      if (viewCalls === 5) {
        const live = view.threads.find(item => item.id === 'becomes-busy')
        if (live) live.status = 'running'
      }
      return view
    })

    await sweeper.sweep()

    expect(snapshotSpy).not.toHaveBeenCalled()
    expect(settleSpy).not.toHaveBeenCalled()
    expect(reclaimed).toEqual([])
    expect(host.workspaceView().threads.find(item => item.id === 'becomes-watched')?.workspaceSettledAt).toBeFalsy()
  })

  it('skips settling a parent whose delegated child is working or watched without cloning', async () => {
    const parent = makeThread('parent')
    const child = makeThread('child', { delegatedBy: 'parent', status: 'running' })
    const { host } = await hostFixture(makeSnapshot([parent, child]))

    vi.spyOn(host, 'setWorkspaceSettled').mockImplementation(async (_kind, id, settledFlag, _options, guard) => {
      guard?.()
      const live = host.workspaceView().threads.find(item => item.id === id)
      if (live) live.workspaceSettledAt = settledFlag ? '2026-11-22T00:00:00.000Z' : null
      return EMPTY_AGENT_HOST
    })
    const snapshotSpy = vi.spyOn(host, 'workspaceSnapshot')
    const tip = 'c'.repeat(40)
    const git = async (_cwd: string, args: readonly string[]) => {
      if (args[0] === 'symbolic-ref') return 'origin/main\n'
      if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/main') return `${tip}\n`
      if (args[0] === 'rev-parse' && args.includes('--verify')) return `${tip}\n`
      throw new Error(`unexpected git ${args.join(' ')}`)
    }

    let childWatched = false
    const sweeper = new WorktreeCleanup({
      host,
      rules: () => DEFAULT_WORKTREE_CLEANUP,
      autoSettleMerged: () => true,
      pullRequestMerged: async () => true,
      watched: id => id === 'child' && childWatched,
      git,
    })

    await sweeper.sweep()
    expect(host.workspaceView().threads.find(item => item.id === 'parent')?.workspaceSettledAt).toBeFalsy()

    // Child becomes idle, but Watcher watches it: parent must still stay unsettled.
    host.workspaceView().threads.find(item => item.id === 'child')!.status = 'idle'
    childWatched = true
    await sweeper.sweep()
    expect(host.workspaceView().threads.find(item => item.id === 'parent')?.workspaceSettledAt).toBeFalsy()

    // Child unwatched and idle: parent settles.
    childWatched = false
    await sweeper.sweep()
    expect(host.workspaceView().threads.find(item => item.id === 'parent')?.workspaceSettledAt).toBeTruthy()
    expect(snapshotSpy).not.toHaveBeenCalled()
  })

  it('does not reclaim a later thread when its project is restored mid-sweep while an earlier candidate is awaited', async () => {
    const first = makeThread('project-thread-1')
    const second = makeThread('project-thread-2')
    const { host } = await hostFixture(makeSnapshot([first, second]))
    await host.setWorkspaceSettled('project', 'project-1', true)

    const snapshotSpy = vi.spyOn(host, 'workspaceSnapshot')
    const reclaimed: string[] = []
    vi.spyOn(host, 'reclaimThreadWorktree').mockImplementation(async threadId => {
      reclaimed.push(threadId)
      if (threadId === 'project-thread-1') {
        // User restores the project while the first thread's worktree is being reclaimed.
        const project = host.workspaceView().projects.find(item => item.id === 'project-1')
        if (project) project.workspaceSettledAt = null
      }
      return EMPTY_AGENT_HOST
    })

    await new WorktreeCleanup({
      host,
      rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, onSettle: true }),
    }).sweep()

    expect(snapshotSpy).not.toHaveBeenCalled()
    expect(reclaimed).toEqual(['project-thread-1'])
  })

  it('aborts reclamation if a thread or its project is restored between eligible and reclaimThreadWorktree', async () => {
    const first = makeThread('restored-before-reclaim')
    const { host } = await hostFixture(makeSnapshot([first]))
    await host.setWorkspaceSettled('project', 'project-1', true)

    const snapshotSpy = vi.spyOn(host, 'workspaceSnapshot')
    const reclaimed: string[] = []
    vi.spyOn(host, 'reclaimThreadWorktree').mockImplementation(async threadId => { reclaimed.push(threadId); return EMPTY_AGENT_HOST })

    const originalView = host.workspaceView.bind(host)
    let viewCalls = 0
    vi.spyOn(host, 'workspaceView').mockImplementation(() => {
      viewCalls += 1
      const view = originalView()
      // Calls: 1 sweepWorktrees start, 2 eligible live check, 3 post-eligible live re-verification.
      if (viewCalls === 3) {
        const project = view.projects.find(item => item.id === 'project-1')
        if (project) project.workspaceSettledAt = null
      }
      return view
    })

    await new WorktreeCleanup({
      host,
      rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, onSettle: true }),
    }).sweep()

    expect(snapshotSpy).not.toHaveBeenCalled()
    expect(reclaimed).toEqual([])
  })

  it('re-reads live project settlement on hosts without workspaceView when a project object is replaced mid-sweep', async () => {
    const threads = [
      makeThread('settled-1'),
      makeThread('settled-2'),
    ]
    let snapshot = makeSnapshot(threads, {
      projects: [{ id: 'project-1', title: 'Repo', path: '/repo', workspaceSettledAt: '2026-11-20T00:00:00.000Z' }],
    })
    const reclaimed: string[] = []
    const legacyHost: WorktreeCleanupHost = {
      workspaceSnapshot: () => snapshot,
      reclaimThreadWorktree: async id => {
        reclaimed.push(id)
        if (id === 'settled-1') {
          // Replace the project record with a fresh unsettled object mid-sweep.
          snapshot = { ...snapshot, projects: [{ id: 'project-1', title: 'Repo', path: '/repo', workspaceSettledAt: null }] }
        }
      },
      subscribe: () => () => undefined,
    }

    await new WorktreeCleanup({
      host: legacyHost,
      rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, onSettle: true }),
    }).sweep()

    expect(reclaimed).toEqual(['settled-1'])
  })
})
