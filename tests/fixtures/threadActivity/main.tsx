// Test-only page: the real Threads page and transcript with Codex activity records in each state the UI must read.
import React from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { defaultAgentConfiguration, type AgentState, type AgentThread } from '../../../src/shared/agents'
import { designThreadsFixture, E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { publishFixtureState } from './agentContextStub'
import '../../../src/renderer/src/styles/global.css'
import '../../../src/renderer/src/agents/threads.css'

export type Scenario = 'settled' | 'live' | 'disconnected' | 'restored'
declare global { interface Window { activityFixture?: { show: (scenario: Scenario) => void } } }

const THREAD = 'wav-preview'
const at = (minute: number): string => new Date(E2E_THREADS_NOW - (60 - minute) * 60_000).toISOString()
let order = 0
const record = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: order++, kind: 'command', status: 'completed', title: 'Command', timingSource: 'provider', ...patch })
const lifecycle = (patch: Partial<AgentActivity>): AgentActivity => record({ id: `turn:${patch.turnId ?? 'turn-1'}`, kind: 'turn', title: 'Turn', ...patch })

const DIFF = [
  '@@ -38,9 +38,10 @@ export class WavStream {',
  '   write(chunk: Int16Array): void {',
  '     this.sink.write(Buffer.from(chunk.buffer))',
  '-    this.pending += chunk.byteLength',
  '+    this.written += chunk.byteLength',
  '+    this.patchLength(this.written)',
  '   }',
  ' ',
  '-  close(): void { this.patchLength(this.pending) }',
  '+  close(): void { this.sink.end() }',
].join('\n')

function messages(live: boolean): AgentThread['messages'] {
  const base: AgentThread['messages'] = [
    { id: 'm1', role: 'user', createdAt: at(10), text: 'The WAV preview stalls after two seconds. Find out why, fix it and run the tests.' },
    { id: 'm2', role: 'assistant', createdAt: at(12), text: 'The writer patches the length marker only when the stream closes, so the player stops at the placeholder length. Patching it after every chunk instead.' },
    { id: 'm3', role: 'assistant', createdAt: at(14), text: 'Fixed. The length marker is patched after every chunk, so playback no longer stops at two seconds. Lint flagged one `let` that I changed to `const`; the three new tests pass.' },
  ]
  return live ? [...base, { id: 'm4', role: 'user', createdAt: at(58), text: 'Run the full audio suite once more and check nothing else relied on close-time patching.' }] : base
}

function settledActivities(restored: boolean): AgentActivity[] {
  order = 0
  const untimed = (item: AgentActivity): AgentActivity => {
    if (!restored) return item
    const rest: AgentActivity = { ...item, status: item.status === 'completed' ? 'unknown' : item.status, ...(item.output ? { truncated: true } : {}) }
    delete rest.durationMs; delete rest.startedAt; delete rest.completedAt; delete rest.timingSource
    return rest
  }
  return [
    lifecycle({ afterMessageId: 'm1', status: restored ? 'unknown' : 'completed', durationMs: 124_000 }),
    record({ id: 'reason', kind: 'reasoning', title: 'Reasoning summary', afterMessageId: 'm1', text: '**Tracing the stall**\n\nThe stall lines up with the RIFF length marker, so the stream writer’s header patching is the first place to look.' }),
    record({ id: 'search', afterMessageId: 'm1', command: 'rg -n "patchLength" src/main/audio', cwd: 'D:\\Projects\\sotto', durationMs: 380,
      output: 'src/main/audio/wavStream.ts:24:  private patchLength(bytes: number): void {\nsrc/main/audio/wavStream.ts:46:  close(): void { this.patchLength(this.pending) }' }),
    record({ id: 'read', afterMessageId: 'm1', command: 'Get-Content -Path src/main/audio/wavStream.ts -TotalCount 80', cwd: 'D:\\Projects\\sotto', durationMs: 910, output: 'export class WavStream {\n  private pending = 0\n  …' }),
    record({ id: 'edit', kind: 'file-change', title: 'File changes', afterMessageId: 'm2', changes: [
      { path: 'src/main/audio/wavStream.ts', kind: 'update', diff: DIFF },
      { path: 'tests/unit/wavStream.test.ts', kind: 'add', diff: '+import { WavStream } from \'../../src/main/audio/wavStream\'\n+\n+test(\'patches the length after each chunk\', () => { /* … */ })' },
    ] }),
    record({ id: 'lint', afterMessageId: 'm2', command: 'npm run lint', status: 'failed', exitCode: 1, durationMs: 6_300,
      output: 'src/main/audio/wavStream.ts\n  42:7  error  \'written\' is never reassigned. Use \'const\' instead  prefer-const\n\n✖ 1 problem (1 error, 0 warnings)' }),
    record({ id: 'agents', kind: 'subagent', title: 'spawnAgent', afterMessageId: 'm2', text: 'Check every other caller of patchLength for the same close-time assumption.', durationMs: 31_000,
      agents: [{ id: 'codex-agent-1', status: 'completed', message: 'No other caller depends on close-time patching.' }] }),
    record({ id: 'tests', afterMessageId: 'm2', command: 'npm test -- --run tests/unit/wavStream.test.ts', startedAt: at(13), completedAt: new Date(Date.parse(at(13)) + 4_200).toISOString(), timingSource: 'observed',
      output: ' ✓ tests/unit/wavStream.test.ts (3 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)' }),
  ].map(untimed)
}

function liveActivities(): AgentActivity[] {
  const settled = settledActivities(false)
  const now = Date.now()
  const since = (ms: number): string => new Date(now - ms).toISOString()
  return [...settled,
    lifecycle({ turnId: 'turn-2', afterMessageId: 'm4', status: 'running', startedAt: since(65_000), timingSource: 'observed' }),
    record({ turnId: 'turn-2', id: 'l-reason', kind: 'reasoning', title: 'Reasoning summary', afterMessageId: 'm4', text: 'Running the whole audio suite first; callers of patchLength come after.' }),
    record({ turnId: 'turn-2', id: 'l-agents', kind: 'subagent', title: 'spawnAgent', status: 'running', afterMessageId: 'm4', startedAt: since(40_000), text: 'List every caller of patchLength outside src/main/audio.',
      agents: [{ id: 'codex-agent-2', status: 'running', message: 'Searching src/renderer' }, { id: 'codex-agent-3', status: 'pendingInit' }] }),
    record({ turnId: 'turn-2', id: 'l-tests', afterMessageId: 'm4', command: 'npm test -- --run tests/unit/audio', status: 'running', startedAt: since(8_000), output: ' ✓ tests/unit/audio/wav.test.ts (12 tests) 88ms' }),
  ]
}

function state(scenario: Scenario): AgentState {
  const fixture = designThreadsFixture()
  const live = scenario === 'live' || scenario === 'disconnected'
  const thread: AgentThread = {
    id: THREAD, title: 'WAV preview stall', projectId: 'workshop', modelId: 'codex:gpt', status: live ? 'running' : 'idle', nativeSessionStarted: true,
    updatedAt: at(live ? 58 : 14), messages: messages(live), requests: [],
    activities: live ? liveActivities() : settledActivities(scenario === 'restored'),
  }
  return {
    configuration: { ...defaultAgentConfiguration(), enabled: true, defaultModelId: 'codex:gpt' },
    connection: 'connected',
    host: {
      connected: scenario !== 'disconnected', name: 'Codex', version: 'fixture',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      models: [...fixture.models], projects: [...fixture.projects], threads: [thread, ...structuredClone(fixture.threads).filter(item => item.projectId !== 'workshop')] as AgentState['host']['threads'],
    },
    assignments: [], queue: [], activeThreadId: THREAD, activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false, threadDrafts: [], deliveries: [], deliveredDrafts: [],
    pendingRequest: '', busy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
    membership: { status: 'beta', label: 'Development beta', expiresAt: null },
  }
}

const params = new URLSearchParams(location.search)
publishFixtureState(state((params.get('scenario') as Scenario | null) ?? 'settled'))
window.activityFixture = { show: scenario => publishFixtureState(state(scenario)) }

createRoot(document.getElementById('root')!).render(<div style={{ display: 'flex', height: '100vh' }}><ThreadsView onOpenAgents={() => undefined} now={E2E_THREADS_NOW} /></div>)
