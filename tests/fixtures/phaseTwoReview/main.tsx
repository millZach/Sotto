// Review-only page: the real Threads workspace for a Codex-capable host (steer, skills) in combined states the E2E
// provider cannot reach: a running turn with live activity, a diagram answer, queued follow-ups carrying skills and a
// native skill catalog. The state and bridge are synthetic; nothing here is native execution.
import React from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentSkillCatalog } from '../../../src/shared/agentSkills'
import { defaultAgentConfiguration, type AgentFollowup, type AgentState, type AgentThread } from '../../../src/shared/agents'
import { designThreadsFixture, E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { ThreadWorkspace } from '../../../src/renderer/src/agents/ThreadWorkspace'
import { publishFixtureState, setSkillRequestMode, type SkillRequestMode } from './agentContextStub'
import '../../../src/renderer/src/styles/global.css'
import '../../../src/renderer/src/agents/threads.css'

export type Scenario = 'compose' | 'catalog-error' | 'catalog-loading' | 'catalog-empty' | 'request-failed' | 'idle-queue'
declare global { interface Window { phaseTwoFixture?: { show: (scenario: Scenario) => void } } }

const THREAD = 'wav-preview'
const SECOND = 'footer-links'
const at = (minute: number): string => new Date(E2E_THREADS_NOW - (60 - minute) * 60_000).toISOString()
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const SEQUENCE = [
  '```mermaid',
  'sequenceDiagram',
  '  accTitle: How the preview reads the length marker',
  '  accDescr: The writer patches the RIFF length after each chunk, so the player reads the real length.',
  '  participant Writer',
  '  participant File',
  '  participant Player',
  '  Writer->>File: write chunk',
  '  Writer->>File: patch RIFF length',
  '  Player->>File: read header',
  '  File-->>Player: current length',
  '  Player->>Player: keep playing',
  '```',
].join('\n')

const at60 = (): string => new Date(Date.now() - 65_000).toISOString()
let order = 0
const record = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: order++, kind: 'command', status: 'completed', title: 'Command', timingSource: 'provider', ...patch })

function activities(): AgentActivity[] {
  order = 0
  return [
    record({ id: 'turn:turn-1', kind: 'turn', title: 'Turn', afterMessageId: 'm1', durationMs: 124_000 }),
    record({ id: 'search', afterMessageId: 'm1', command: 'rg -n "patchLength" src/main/audio', cwd: 'D:\\Projects\\sotto', durationMs: 380,
      output: 'src/main/audio/wavStream.ts:24:  private patchLength(bytes: number): void {' }),
    record({ id: 'edit', kind: 'file-change', title: 'File changes', afterMessageId: 'm2', changes: [
      { path: 'src/main/audio/wavStream.ts', kind: 'update', diff: '@@ -44,3 +44,4 @@\n-    this.pending += chunk.byteLength\n+    this.written += chunk.byteLength\n+    this.patchLength(this.written)' },
    ] }),
    record({ turnId: 'turn-2', id: 'turn:turn-2', kind: 'turn', title: 'Turn', afterMessageId: 'm3', status: 'running', startedAt: at60(), timingSource: 'observed' }),
    record({ turnId: 'turn-2', id: 'l-reason', kind: 'reasoning', title: 'Reasoning summary', afterMessageId: 'm3', text: 'Running the whole audio suite first; callers of patchLength come after.' }),
    record({ turnId: 'turn-2', id: 'l-tests', afterMessageId: 'm3', command: 'npm test -- --run tests/unit/audio', status: 'running', startedAt: new Date(Date.now() - 8_000).toISOString(), timingSource: 'observed', output: ' ✓ tests/unit/audio/wav.test.ts (12 tests) 88ms' }),
  ]
}

const SKILLS: AgentSkillCatalog['skills'] = [
  { name: 'audio-suite', path: 'D:\\Projects\\sotto\\.codex\\skills\\audio-suite\\SKILL.md', scope: 'repo', description: 'Run the Sotto audio tests and summarise failures by file.' },
  { name: 'changelog', path: 'D:\\Projects\\sotto\\.codex\\skills\\changelog\\SKILL.md', scope: 'repo', description: 'Add an entry to CHANGELOG.md in the house style.' },
  { name: 'release-notes', path: 'D:\\Projects\\sotto\\.codex\\skills\\release-notes\\SKILL.md', scope: 'repo', description: 'Draft GitHub release notes from the changelog, keeping the Gatekeeper instructions and Apple silicon note.' },
  { name: 'tastify', path: 'C:\\Users\\review\\.agents\\skills\\tastify\\SKILL.md', scope: 'user', description: 'Review a UI for taste: one fact once, clear hierarchy, visible focus, calm motion.' },
  { name: 'changelog', path: 'C:\\Users\\review\\.agents\\skills\\changelog\\SKILL.md', scope: 'user', description: 'Personal changelog helper that writes terse one-line entries.' },
  { name: 'grill-me', path: 'C:\\Users\\review\\.agents\\skills\\grill-me\\SKILL.md', scope: 'user', description: 'Interview me relentlessly about a plan until every branch of the decision tree is resolved.' },
  { name: 'imagegen', path: 'C:\\Users\\review\\.codex\\skills\\.system\\imagegen\\SKILL.md', scope: 'system', description: 'Generate or edit raster images for this project.' },
  { name: 'openai-docs', path: 'C:\\Users\\review\\.codex\\skills\\.system\\openai-docs\\SKILL.md', scope: 'system', description: 'Look up current OpenAI API documentation before answering.' },
  { name: 'skill-creator', path: 'C:\\Users\\review\\.codex\\skills\\.system\\skill-creator\\SKILL.md', scope: 'system', description: 'Guide for creating effective skills that extend Codex with specialised knowledge, workflows and tool integrations.' },
]

function catalog(scenario: Scenario): AgentSkillCatalog[] {
  if (scenario === 'catalog-loading' || scenario === 'request-failed') return []
  const base = { threadId: THREAD, providerId: 'codex' as const, cwd: 'D:\\Projects\\sotto' }
  if (scenario === 'catalog-error') return [{ ...base, status: 'error', skills: [], errors: [], error: 'Codex couldn’t list skills for D:\\Projects\\sotto: skills/list timed out.' }]
  if (scenario === 'catalog-empty') return [{ ...base, status: 'ready', skills: [], errors: [] }]
  return [
    { ...base, status: 'ready', skills: SKILLS, errors: [{ path: 'D:\\Projects\\sotto\\.codex\\skills\\broken\\SKILL.md', message: 'missing field `description`' }] },
    { threadId: SECOND, providerId: 'codex', cwd: 'C:/sotto-site', status: 'ready', skills: SKILLS.slice(3), errors: [] },
  ]
}

function followups(scenario: Scenario): AgentFollowup[] {
  const item = (n: number, text: string, patch: Partial<AgentFollowup> = {}): AgentFollowup =>
    ({ id: uuid(100 + n), threadId: THREAD, draftId: uuid(200 + n), text, attachments: [], createdAt: at(58), updatedAt: at(58), status: 'queued', ...patch })
  return [
    item(1, '$audio-suite Then run the full audio suite and paste any failures here.', { skills: [{ name: 'audio-suite', path: SKILLS[0]!.path }] }),
    item(2, 'Check whether anything else relied on close-time patching of the WAV length marker, including the renderer preview path and the export dialog.'),
    ...(scenario === 'idle-queue' ? [] : [item(3, '$changelog Finally update the changelog.', { skills: [{ name: 'changelog', path: SKILLS[1]!.path }], status: 'uncertain' as const,
      error: 'Sotto couldn’t confirm Codex received this. Check the thread before sending it again.' })]),
  ]
}

function state(scenario: Scenario): AgentState {
  const fixture = designThreadsFixture()
  const running = scenario !== 'idle-queue'
  const thread: AgentThread = {
    id: THREAD, title: 'WAV preview stall', projectId: 'workshop', modelId: 'codex:gpt', status: running ? 'running' : 'idle', nativeSessionStarted: true,
    updatedAt: at(58), requests: [], activities: activities(),
    workingDirectory: 'C:\\Users\\review\\.sotto\\worktrees\\workshop\\wav-preview-stall',
    worktree: { mode: 'independent', status: 'ready', path: 'C:\\Users\\review\\.sotto\\worktrees\\workshop\\wav-preview-stall', repositoryRoot: 'C:/workshop', branch: 'sotto/wav-preview-stall', dirty: true },
    ...(running ? { lastTurn: { id: 'turn-2', status: 'running' as const } } : { lastTurn: { id: 'turn-2', status: 'completed' as const } }),
    messages: [
      { id: 'm1', role: 'user', createdAt: at(10), text: 'The WAV preview stalls after two seconds. Find out why, fix it and run the tests.' },
      { id: 'm2', role: 'assistant', createdAt: at(14), text: `Fixed. The writer now patches the length marker after every chunk:\n\n${SEQUENCE}\n\nThe three new tests pass.` },
      { id: 'm3', role: 'user', createdAt: at(58), text: 'Run the full audio suite once more and check nothing else relied on close-time patching.' },
    ],
  }
  const others = structuredClone(fixture.threads).filter(item => item.projectId !== 'workshop') as AgentThread[]
  return {
    configuration: { ...defaultAgentConfiguration(), enabled: true, defaultModelId: 'codex:gpt' },
    connection: 'connected',
    host: {
      connected: true, name: 'Codex', version: 'fixture',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, skills: true, steer: true },
      models: [...fixture.models], projects: [...fixture.projects], threads: [thread, ...others],
    },
    skillCatalogs: catalog(scenario),
    followups: followups(scenario), followupReceipts: [],
    assignments: [], queue: [], activeThreadId: THREAD, activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false, threadDrafts: [], deliveries: [], deliveredDrafts: [],
    pendingRequest: '', busy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
    membership: { status: 'beta', label: 'Development beta', expiresAt: null },
  }
}

const requestModes: Partial<Record<Scenario, SkillRequestMode>> = { 'catalog-loading': 'hang', 'request-failed': 'fail' }
function show(scenario: Scenario): void {
  setSkillRequestMode(requestModes[scenario] ?? 'answer')
  publishFixtureState(state(scenario))
}
show((new URLSearchParams(location.search).get('scenario') as Scenario | null) ?? 'compose')
window.phaseTwoFixture = { show }

createRoot(document.getElementById('root')!).render(<div style={{ display: 'flex', height: '100vh' }}><ThreadWorkspace onOpenAgents={() => undefined} /></div>)
