import { cleanup, render } from '@testing-library/react'
import React from 'react'
import { afterEach, vi } from 'vitest'
import type { AgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadOptions } from '../../../src/renderer/src/agents/ThreadOptions'
import { pendingSettingsStore } from '../../../src/renderer/src/agents/pendingSettings'
import { defaultAgentConfiguration, PROVIDER_LABELS, providerIdSchema, type AgentCommand, type AgentState, type AgentThread } from '../../../src/shared/agents'


export const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
export function fixture(thread: Partial<AgentThread> = {}): AgentState {
  return {
    configuration: { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'claude', 'grok'] }, connection: 'connected',
    host: { connected: true, name: 'Providers', version: '', capabilities: caps, projects: [],
      providers: providerIdSchema.options.map(id => ({ id, name: PROVIDER_LABELS[id], version: '1.2.3', connection: 'connected', capabilities: caps })),
      models: providerIdSchema.options.map(id => ({ id: `${id}:model`, name: `${PROVIDER_LABELS[id]} model`, provider: PROVIDER_LABELS[id], providerId: id, ready: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium', runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] })),
      threads: [{ id: 'thread', providerId: 'claude', projectId: 'project', title: 'Claude work', modelId: 'claude:model', status: 'idle', messages: [], requests: [], nativeSessionStarted: false, reasoningEffort: 'high', runtimeMode: 'auto', ...thread }],
    }, assignments: [], queue: [], activeThreadId: 'thread', activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
  }
}
export function mount(state = fixture()) {
  const command = vi.fn(async () => state)
  render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
  return { command }
}

/**
 * The chips over a thread whose settings actually move when a command is confirmed, the way `AgentContext`
 * moves them: main's answer is applied to the state before the command's own promise resolves. Tests that
 * care what the control shows before and after a confirmation need that, because a static fixture confirms a
 * change and then reports the level it always had.
 */
export function Live({ answer }: { answer: (effort: string) => Promise<AgentState | null> }): React.ReactElement {
  const [state, setState] = React.useState(fixture)
  const command: AgentConnection['command'] = async request => {
    const next = await answer('reasoningEffort' in request ? request.reasoningEffort ?? '' : '')
    if (next) setState(next)
    return next
  }
  return <ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />
}
/**
 * The chips over a thread whose state moves when main answers, for any setting. `answer` gets each command and the
 * state the window holds, and returns the state main answers with; the window takes it before the command's own
 * promise resolves, as `AgentContext` does, unless `draw` is false, which is a reply that landed before the broadcast
 * carrying it (#306). `redraw` then commits a state the way that later broadcast would.
 */
export function LiveThread({ answer, draw = true, start = fixture(), redraw }: {
  answer: (request: AgentCommand, current: AgentState) => Promise<AgentState | null>; draw?: boolean; start?: AgentState
  redraw?: (commit: (next: AgentState) => void) => void
}): React.ReactElement {
  const [state, setState] = React.useState(start)
  const current = React.useRef(state)
  current.current = state
  React.useEffect(() => { redraw?.(setState) }, [redraw])
  const command: AgentConnection['command'] = async request => {
    const next = await answer(request, current.current)
    if (next && draw) setState(next)
    return next
  }
  return <ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />
}
export const withThread = (state: AgentState, patch: Partial<AgentThread>): AgentState =>
  ({ ...state, error: null, host: { ...state.host, threads: [{ ...state.host.threads[0]!, ...patch }] } })
export function setupThreadOptionsTests(): void {
  afterEach(() => { cleanup(); pendingSettingsStore.clear() })
}
