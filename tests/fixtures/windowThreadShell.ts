import type { AgentState } from '../../src/shared/agents'
import { threadsStateFixture, agentThread } from './agentState'
import { syntheticModelCatalog } from './modelCatalog'

export function windowThreadShellFixture(): AgentState {
  const at = '2026-10-13T12:00:00.000Z'
  const models = syntheticModelCatalog(874)
  const state = threadsStateFixture({ projects: Array.from({ length: 43 }, (_, i) => ({ id: `project-${i}`, title: `Synthetic project ${i}`, path: `D:/synthetic/project-${i}` })),
    host: { models, threads: Array.from({ length: 204 }, (_, i) => agentThread({ id: `thread-${i}`, projectId: `project-${i % 43}`, modelId: models[i % 13]!.id,
      title: `Synthetic development task ${i}`, workspaceSettledAt: i < 161 ? at : null,
      summary: { messageCount: 12, activityCount: 24, lastMessageAt: at, lastUser: { id: `user-${i}`, text: 'Implement the synthetic development task and verify its behavior.', createdAt: at }, lastAssistant: { id: `answer-${i}`, text: 'The synthetic implementation is ready for review.', createdAt: at } },
      worktree: { mode: 'independent', status: 'ready', path: `D:/synthetic/.worktrees/task-${i}`, repositoryRoot: `D:/synthetic/project-${i % 43}`, branch: `feat/synthetic-task-${i}`, baseCommit: 'a'.repeat(40), sentBranch: `feat/synthetic-task-${i}`, dirty: false,
        git: { isRepository: true, branch: `feat/synthetic-task-${i}`, upstream: `origin/feat/synthetic-task-${i}`, hasRemote: true, defaultBranch: 'main', isDefaultBranch: false, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 2, behind: 0, aheadOfDefault: 2, pullRequest: null, fetchedAt: at, readAt: at } },
      usage: { latest: { input: 12400, output: 5600, cached: 8200 }, total: { input: 193400, output: 52500, cached: 120300, cacheWrite: 8400 }, contextUsed: 22000, contextWindow: 200000, elapsedMs: 98000, estimatedUsd: 1.27, elapsedKind: 'api', rateVersions: ['synthetic-2026'], partial: false, updatedAt: at, contextUpdatedAt: at, modelId: models[i % 13]!.id },
    })) } })
  return state
}
