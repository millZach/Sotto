// @vitest-environment node
/**
 * Owner-scale WorktreeCleanup sweep cost: 1,200 threads carrying message and activity histories, including 240 settled
 * threads with ready independent worktrees (matching the development laptop profile that stalled main and the engine
 * process for 1.2-1.6 s per cloneHostSnapshot call and ~4.5 s across back-to-back calls).
 *
 * The default test verifies deterministically that a full sweep makes zero `cloneHostSnapshot` and zero
 * `workspaceSnapshot` calls. Run the repeatable before/after timing benchmark with:
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/worktreeCleanupSweep.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *   sh:          SOTTO_PERF_BENCH=1 npx vitest run tests/perf/worktreeCleanupSweep.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { WorktreeCleanup, type WorktreeCleanupHost } from '../../src/main/agents/worktreeCleanup'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentMessage, type AgentThread } from '../../src/shared/agents'
import { DEFAULT_WORKTREE_CLEANUP } from '../../src/shared/settings'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { PERF_BENCH, round } from '../fixtures/perfBench'
import { expectWithinBudget } from '../fixtures/perfBudget'

const cloneCounter = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../src/main/agents/cloneHostSnapshot', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/cloneHostSnapshot')>()
  return {
    ...original,
    cloneHostSnapshot: (snapshot: Parameters<typeof original.cloneHostSnapshot>[0]) => {
      cloneCounter.calls += 1
      return original.cloneHostSnapshot(snapshot)
    },
  }
})

const THREADS = 1_200
const SETTLED_WORKTREE_CANDIDATES = 240
const MESSAGES_PER_THREAD = 16
const ACTIVITIES_PER_THREAD = 16
const PROJECTS = 12

const roots: string[] = []
afterAll(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-cleanup-bench-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

function buildOwnerScaleSnapshot(root: string): AgentHostSnapshot {
  const projects = Array.from({ length: PROJECTS }, (_, index) => ({
    id: `project-${index}`,
    title: `Project ${index}`,
    path: join(root, `repo-${index}`),
  }))
  const threads: AgentThread[] = Array.from({ length: THREADS }, (_, index) => {
    const projectIndex = index % PROJECTS
    const settled = index < SETTLED_WORKTREE_CANDIDATES
    const messages: AgentMessage[] = Array.from({ length: MESSAGES_PER_THREAD }, (__, step) => ({
      id: `m-${index}-${step}`,
      role: step % 2 === 0 ? 'user' : 'assistant',
      text: `Synthetic message ${step} for thread ${index} describing repository state and verification output.`,
      createdAt: '2026-11-20T00:00:00.000Z',
    }))
    const activities: AgentActivity[] = Array.from({ length: ACTIVITIES_PER_THREAD }, (__, step) => ({
      id: `a-${index}-${step}`,
      turnId: `t-${index}-${Math.floor(step / 4)}`,
      sequence: step,
      kind: 'command',
      status: 'completed',
      title: `Run command ${step}`,
      command: `npm run check -- --step ${step}`,
      output: `Output line for thread ${index} step ${step}`,
      startedAt: '2026-11-20T00:00:00.000Z',
      completedAt: '2026-11-20T00:00:01.000Z',
    }))
    return {
      id: `codex:thread-${index}`,
      projectId: projects[projectIndex]!.id,
      title: `Owner-scale thread ${index}`,
      modelId: 'codex:gpt-5',
      status: 'idle',
      messages,
      activities,
      requests: [],
      updatedAt: '2026-11-20T00:00:00.000Z',
      ...(settled ? { workspaceSettledAt: '2026-11-20T00:00:00.000Z' } : {}),
      ...(index >= SETTLED_WORKTREE_CANDIDATES && index < SETTLED_WORKTREE_CANDIDATES + 40
        ? { delegatedBy: `codex:thread-${index + 40}` } : {}),
      worktree: settled
        ? {
            mode: 'independent',
            status: 'ready',
            path: join(root, 'worktrees', `thread-${index}`),
            repositoryRoot: projects[projectIndex]!.path,
            branch: `fix/thread-${index}`,
            sentBranch: `fix/thread-${index}`,
            baseCommit: '0123456789abcdef0123456789abcdef01234567',
            baseBranch: 'main',
          }
        : {
            mode: 'shared',
            status: 'ready',
            path: projects[projectIndex]!.path,
            repositoryRoot: projects[projectIndex]!.path,
            branch: 'main',
            sentBranch: 'main',
          },
    }
  })
  return {
    ...structuredClone(EMPTY_AGENT_HOST),
    name: 'fake',
    version: '1',
    connected: true,
    capabilities: { ...structuredClone(EMPTY_AGENT_HOST.capabilities), projects: true, threads: true, submit: true, observe: true },
    projects,
    threads,
  }
}

async function createOwnerScaleHost() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-cleanup-bench-'))
  roots.push(root)
  const snapshot = buildOwnerScaleSnapshot(root)
  const adapter = new FakeProviderHost(structuredClone(snapshot))
  const host = new WorkspaceHost(adapter, root, { historyEnabled: () => false })
  await host.initialize()
  await host.connect()
  // Seed workspace-owned metadata (worktree, workspaceSettledAt, delegatedBy) onto the connected host's records.
  const sourceById = new Map(snapshot.threads.map(thread => [thread.id, thread]))
  for (const live of host.workspaceView().threads) {
    const source = sourceById.get(live.id)
    if (!source) continue
    if (source.worktree) live.worktree = source.worktree
    if (source.workspaceSettledAt !== undefined) live.workspaceSettledAt = source.workspaceSettledAt
    if (source.delegatedBy !== undefined) live.delegatedBy = source.delegatedBy
  }
  return { root, host }
}

describe('WorktreeCleanup owner-scale sweep (1,200 threads, 240 settled ready worktrees)', () => {
  it('makes zero cloneHostSnapshot and zero workspaceSnapshot calls across a full sweep', async () => {
    const { host } = await createOwnerScaleHost()
    try {
      let attempted = 0
      vi.spyOn(host, 'reclaimThreadWorktree').mockImplementation(async () => {
        attempted += 1
        throw new Error('kept: uncommitted work')
      })
      const snapshotSpy = vi.spyOn(host, 'workspaceSnapshot')
      cloneCounter.calls = 0

      const sweeper = new WorktreeCleanup({
        host,
        rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, onSettle: true }),
        autoSettleMerged: () => true,
        pullRequestMerged: async () => false,
        watched: () => false,
        git: async () => 'main\n',
        intervalMs: 60_000_000,
      })

      const started = performance.now()
      await sweeper.sweep()
      const elapsedMs = performance.now() - started

      expect(attempted).toBe(SETTLED_WORKTREE_CANDIDATES)
      expect(cloneCounter.calls).toBe(0)
      expect(snapshotSpy).not.toHaveBeenCalled()
      expectWithinBudget(elapsedMs, 100, 'WorktreeCleanup owner-scale sweep')
    } finally {
      host.disconnect()
      host.dispose()
    }
  }, 30_000)

  it.skipIf(!PERF_BENCH)('reports before/after sweep time and cloneHostSnapshot counts at owner scale (SOTTO_PERF_BENCH=1)', async () => {
    const { host } = await createOwnerScaleHost()
    try {
      vi.spyOn(host, 'reclaimThreadWorktree').mockImplementation(async () => { throw new Error('kept: uncommitted work') })

      // Before: legacy snapshot-cloning host without workspaceView, plus the pre-fix extra clone inside eligible().
      const beforeSampleCandidates = 10
      let beforeSeen = 0
      const legacyHost: WorktreeCleanupHost = {
        workspaceSnapshot: () => host.workspaceSnapshot(),
        reclaimThreadWorktree: async () => {
          beforeSeen += 1
          throw new Error('kept: uncommitted work')
        },
        subscribe: listener => host.subscribe(listener),
      }
      cloneCounter.calls = 0
      const beforeSyncStart = performance.now()
      // Exact pre-fix synchronous 3-clone sequence on the first eligible candidate: sweepWorktrees + eligible + atWork.
      legacyHost.workspaceSnapshot()
      legacyHost.workspaceSnapshot()
      legacyHost.workspaceSnapshot()
      const beforeFirstCandidateSyncStallMs = performance.now() - beforeSyncStart
      const singleCloneMs = beforeFirstCandidateSyncStallMs / 3

      // Run a bounded legacy sweep (10 candidates, extrapolating full 240-candidate sweep linearly from exact clones).
      cloneCounter.calls = 0
      const beforeStart = performance.now()
      const beforeSweeper = new WorktreeCleanup({
        host: legacyHost,
        rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, onSettle: true }),
        keeps: id => Number(id.replace('codex:thread-', '')) >= beforeSampleCandidates,
        intervalMs: 60_000_000,
      })
      await beforeSweeper.sweep()
      const beforeSampleMs = performance.now() - beforeStart
      const beforeSampleClones = cloneCounter.calls

      // After: full 240-candidate sweep using WorkspaceHost.workspaceView() + autoSettleMerged.
      cloneCounter.calls = 0
      const afterStart = performance.now()
      const afterSweeper = new WorktreeCleanup({
        host,
        rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, onSettle: true }),
        autoSettleMerged: () => true,
        pullRequestMerged: async () => false,
        watched: () => false,
        git: async () => 'main\n',
        intervalMs: 60_000_000,
      })
      await afterSweeper.sweep()
      const afterSweepMs = performance.now() - afterStart
      const afterClones = cloneCounter.calls

      // Pre-fix full 240-candidate sweep made 1 (sweepWorktrees) + 2 * 240 (eligible + atWork) = 481 clones (plus 1 for settleMerged = 482).
      const preFixFullSweepClones = 2 + SETTLED_WORKTREE_CANDIDATES * 2
      const preFixEstimatedFullSweepMs = singleCloneMs * preFixFullSweepClones

      console.log(`worktree cleanup owner-scale bench (${THREADS} threads, ${SETTLED_WORKTREE_CANDIDATES} candidates): ${JSON.stringify({
        threads: THREADS,
        messagesPerThread: MESSAGES_PER_THREAD,
        activitiesPerThread: ACTIVITIES_PER_THREAD,
        candidates: SETTLED_WORKTREE_CANDIDATES,
        beforeSingleCloneMs: round(singleCloneMs, 1),
        beforeFirstCandidateSyncStallMs: round(beforeFirstCandidateSyncStallMs, 1),
        beforeSampleCandidates: beforeSeen,
        beforeSampleClones,
        beforeSampleMs: round(beforeSampleMs, 1),
        preFixFullSweepClones,
        preFixEstimatedFullSweepMs: round(preFixEstimatedFullSweepMs, 1),
        afterFullSweepClones: afterClones,
        afterFullSweepMs: round(afterSweepMs, 2),
        speedupVsFullSweep: round(preFixEstimatedFullSweepMs / Math.max(afterSweepMs, 0.01), 0),
      })}`)

      expect(afterClones).toBe(0)
      expect(beforeSampleClones).toBe(1 + beforeSampleCandidates)
    } finally {
      host.disconnect()
      host.dispose()
    }
  }, 60_000)
})
