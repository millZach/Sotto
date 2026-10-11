import { defaultAgentConfiguration, type AgentConfiguration, type AgentHostSnapshot, type AgentProject, type AgentState, type AgentThread } from '../../src/shared/agents'
import { designThreadsFixture } from '../../src/shared/e2e'

export interface AgentStateOverrides {
  /** Identity regressions can borrow explicit, case-owned arrays. Defaults are always fresh. */
  cloneOverrides?: boolean
  configuration?: Partial<AgentConfiguration>
  host?: Omit<Partial<AgentHostSnapshot>, 'capabilities'> & { capabilities?: Partial<AgentHostSnapshot['capabilities']> }
  projects?: readonly Partial<AgentProject>[]
  threads?: readonly Partial<AgentThread>[]
  topLevel?: Partial<Omit<AgentState, 'configuration' | 'host'>>
}

/** Small complete records for tests that previously cast a partial snapshot. No persisted-state defaults. */
export function agentProject(patch: Partial<AgentProject> = {}): AgentProject {
  return structuredClone({ id: 'project', title: 'Project', path: 'D:/project', ...patch })
}

export function agentThread(patch: Partial<AgentThread> = {}): AgentThread {
  return structuredClone({ id: 'thread', projectId: 'project', title: 'Task', modelId: 'model', status: 'idle', messages: [], requests: [], ...patch })
}

/** The Threads design fixture as the coordinator publishes it, with per-thread drafts and deliveries. */
export function threadsStateFixture(overrides: AgentStateOverrides = {}): AgentState {
  const fixture = designThreadsFixture()
  const state: AgentState = {
    configuration: { ...defaultAgentConfiguration(), enabled: true, defaultModelId: 'claude:sonnet' },
    connection: 'connected',
    host: {
      connected: true, name: 'Codex', version: 'test',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      models: [...fixture.models], projects: [...fixture.projects], threads: structuredClone(fixture.threads) as AgentState['host']['threads'],
    },
    activeThreadId: 'visual-gate', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false, threadDrafts: [], deliveries: [], deliveredDrafts: [],
    globalLaneBusy: false, notice: '', error: null,

    credentials: { reasoning: false, secure: true },
    reasoningAccounts: [],
  }
  const result: AgentState = { ...state, ...overrides.topLevel,
    configuration: { ...state.configuration, ...overrides.configuration },
    host: { ...state.host, ...overrides.host,
      capabilities: { ...state.host.capabilities, ...overrides.host?.capabilities },
      projects: overrides.projects?.map(agentProject) ?? overrides.host?.projects ?? state.host.projects,
      threads: overrides.threads?.map(agentThread) ?? overrides.host?.threads ?? state.host.threads,
    },
  }
  return overrides.cloneOverrides === false ? result : structuredClone(result)
}
