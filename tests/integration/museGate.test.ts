// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { RESUME_RECORD_MAX_AGE_MS } from '../../src/main/agents/restartResume'
import { immutableModels, isImmutableModels } from '../../src/main/agents/activitySnapshots'
import { modelsWithoutMuse } from '../../src/main/agents/museGate'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { SubagentStore } from '../../src/main/agents/subagentStore'
import { startHeadlessHost } from '../../src/host'
import { DesktopHostRouter, type DesktopHostConnection } from '../../src/main/hosts/desktopHostRouter'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, publicProviderEntityId, type AgentHostSnapshot } from '../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-muse-gate-'))
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}
const MUSE = 'muse-thread'
const CODEX = 'codex-thread'
const MODEL = publicProviderEntityId('muse', 'model', 'muse-model')
const PROJECT = publicProviderEntityId('muse', 'project', 'muse-project')
function snapshot(root: string): AgentHostSnapshot {
  return { ...structuredClone(EMPTY_AGENT_HOST), connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true, observe: true },
    models: [{ id: MODEL, provider: 'Muse', providerId: 'muse', name: 'Muse model', ready: true },
      { id: 'codex-model', provider: 'Codex', providerId: 'codex', name: 'Codex model', ready: true }],
    projects: [{ id: PROJECT, providerId: 'muse', title: 'Muse project', path: root },
      { id: 'codex-project', providerId: 'codex', title: 'Codex project', path: root }],
    providers: ['muse', 'codex'].map(id => ({ id: id as 'muse' | 'codex', name: id, version: '1', connection: 'connected', capabilities: { ...EMPTY_AGENT_HOST.capabilities } })),
    threads: [MUSE, CODEX].map(id => ({ id, providerId: id === MUSE ? 'muse' : 'codex', kind: 'project', title: id,
      projectId: id === MUSE ? PROJECT : 'codex-project', modelId: id === MUSE ? MODEL : 'codex-model', status: 'idle', requests: [],
      messages: [{ id: 'user-' + id, role: 'user', text: 'Synthetic saved message ' + id, createdAt: new Date().toISOString() }] })) }
}
function databaseRows(root: string, name: string, tables: readonly string[], id: string) {
  const db = new DatabaseSync(join(root, name), { readOnly: true })
  try { return Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table + ' WHERE thread_id = ? ORDER BY rowid').all(id)])) }
  finally { db.close() }
}
const threadTables = ['events', 'messages', 'activities', 'activity_epochs', 'visuals', 'wake_ups']
const subagentTables = ['subagent_threads', 'subagent_rows', 'subagent_assignments', 'subagent_classifications']
it('keeps enabled Watcher work available on a legacy host while Muse is disabled', async () => {
  const root = await directory()
  const host = Object.assign(new FakeProviderHost(), { watcherThreadIds: () => ['session-workshop'] })
  const control = await agentControlFixture({ directory: root, host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, museEnabled: false } })
  cleanup.push(control.dispose)
  await control.control.start()
  await control.control.command({ type: 'connect', provider: 'codex' })
  const result = await control.control.command({ type: 'select-thread', threadId: 'session-workshop' })
  expect(result.error).toBeNull()
  expect(control.control.shell().activeThreadId).toBe('session-workshop')
})
it('keeps certified catalog sharing after hiding cached Muse and leaves ordinary catalogs whole', () => {
  const models = immutableModels(snapshot('synthetic').models)
  const visible = modelsWithoutMuse(models)
  expect(visible.map(model => model.providerId)).toEqual(['codex'])
  expect(isImmutableModels(visible)).toBe(true)
  expect(modelsWithoutMuse(models)).toBe(visible)
  expect(modelsWithoutMuse(visible)).toBe(visible)
})
async function owlProfile(root: string) {
  const owl = new WorkspaceHost(new FakeProviderHost(snapshot(root)), root, () => true, undefined, true, true)
  await owl.initialize(); await owl.connect()
  const control = await agentControlFixture({ directory: root, host: owl, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, museEnabled: true } })
  await control.control.start()
  await control.dispose(); await control.control.closed(); await owl.close()
  const file = join(root, 'agents.json'), saved = JSON.parse(await readFile(file, 'utf8'))
  const at = new Date().toISOString(), draftId = randomUUID()
  const draft = { threadId: MUSE, draftId, requestId: null, text: 'Synthetic dormant draft', attachments: [], updatedAt: at }
  saved.configuration = { ...defaultAgentConfiguration(), provider: 'muse', enabledProviders: ['muse', 'codex'],
    defaultModelId: MODEL, newThreadModelId: MODEL, newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'approval-required' }
  Object.assign(saved, { activeThreadId: MUSE, activeProjectId: PROJECT, draftThreadId: MUSE, draft: draft.text,
    composing: true, manualDraftId: draftId, threadDrafts: [draft] })
  await writeFile(file, JSON.stringify(saved))
  const followup = { id: randomUUID(), threadId: MUSE, draftId: randomUUID(), text: 'Synthetic dormant follow-up', attachments: [],
    status: 'dispatching', createdAt: at, updatedAt: at, commandId: randomUUID(), messageId: randomUUID() }
  await writeFile(join(root, 'followups.json'), JSON.stringify({ items: [followup], receipts: [] }))
  const threads = new ThreadStore(join(root, 'threads.sqlite')), subagents = new SubagentStore(join(root, 'subagents.sqlite'))
  threads.open(); subagents.open()
  try {
    for (const id of [MUSE, CODEX]) {
      const activity = { id: 'activity-' + id, turnId: 'turn-' + id, sequence: 1, kind: 'tool' as const, status: 'completed' as const,
        startedAt: at, title: 'Synthetic saved activity', toolName: 'synthetic' }
      threads.syncActivities(id, [activity]); threads.addWakeUps(id, ['wake-' + id])
      threads.addVisual(id, { visual: { id: 'visual-' + id, kind: 'mermaid', title: 'Synthetic visual', source: 'graph TD; A-->B' },
        createdAt: at, anchorMessageId: 'user-' + id, anchorUserMessageId: 'user-' + id })
      subagents.ingest(id, [{ id: 'child-' + id, assignmentId: 'task-' + id, status: 'running', observedAt: at,
        title: 'Synthetic saved task', prompt: 'Synthetic task words' }], undefined, [activity])
    }
  } finally { threads.close(); subagents.close() }
  return { saved, draft, followup }
}

it.each(['off', 'expired', 'capped'] as const)('loads dormant Muse ownership before real runtime resume %s pruning', async scenario => {
  const root = await directory()
  await owlProfile(root)
  const file = join(root, 'agents.json'), saved = JSON.parse(await readFile(file, 'utf8'))
  saved.configuration.checkClientUpdates = false
  await writeFile(file, JSON.stringify(saved))
  const since = new Date(Date.now() - (scenario === 'expired' ? RESUME_RECORD_MAX_AGE_MS + 60_000 : 0)).toISOString()
  const row = { threadId: MUSE, since, resumes: scenario === 'capped' ? 3 : 1, ...(scenario === 'off' ? { queued: true as const } : {}) }
  const ordinary = { ...row, threadId: CODEX }, resumeFile = join(root, 'restart-resume.json')
  await writeFile(resumeFile, JSON.stringify({ version: 1, working: [row, ordinary] }))
  const settings = { ...DEFAULT_SETTINGS, threadTitles: false, resumeThreadsAfterRestart: scenario !== 'off' }
  const providers = { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost() }
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const runtime = await createAgentRuntime({ directory: root, credentials, providers, reasoner: {},
    watcherEnabled: false, museEnabled: false, resumeAfterRestart: true,
    settings: () => settings, writingSettings: async () => settings, historyEnabled: () => true, openExternal: async () => undefined,
    installedProviders: async () => ['codex', 'muse'] })
  cleanup.push(runtime.close)
  await expect.poll(() => runtime.agentControl.shell().host.providers?.find(provider => provider.id === 'codex')?.connection).toBe('connected')
  expect(runtime.agentHost.preservesDormantThread(MUSE)).toBe(true)
  expect(runtime.agentControl.shell().host.threads.some(thread => thread.providerId === 'muse')).toBe(false)
  await runtime.close()
  expect(JSON.parse(await readFile(resumeFile, 'utf8'))).toEqual({ version: 1, working: [row] })
  expect(providers.muse.connectCalls).toBe(0)
  expect(providers.muse.commands).toEqual([])
  expect(providers.muse.sideWrites).toEqual([])
  expect(providers.codex.commands.some(command => command.type === 'send')).toBe(false)
})

it.each([
  { scenario: 'startup', streaming: false }, { scenario: 'startup', streaming: true },
  { scenario: 'privacy-change', streaming: false }, { scenario: 'privacy-change', streaming: true },
])('hides cached Muse and preserves its records through history-off $scenario and Owl return (streaming $streaming)', async ({ scenario, streaming }) => {
  const root = await directory(), original = await owlProfile(root)
  const beforeThread = databaseRows(root, 'threads.sqlite', threadTables, MUSE)
  const beforeSubagents = databaseRows(root, 'subagents.sqlite', subagentTables, MUSE)
  const originalWorkspace = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'))
  let history = scenario !== 'startup'
  const inner = new FakeProviderHost({ ...structuredClone(EMPTY_AGENT_HOST), connected: true })
  const stable = new WorkspaceHost(inner, root, () => history, undefined, true, false, streaming)
  cleanup.push(() => stable.close())
  await stable.initialize()
  const control = await agentControlFixture({ directory: root, host: stable, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, museEnabled: false, historyEnabled: () => history, installedProviders: async () => ['codex', 'muse'] } })
  cleanup.push(control.dispose)
  await control.control.start()
  expect(stable.dormantThreadIds()).toEqual([MUSE])
  for (const read of [stable.workspaceSnapshot(), await stable.snapshot()]) {
    expect(read.threads.map(thread => thread.id)).toEqual([CODEX])
    expect(read.models.some(model => model.providerId === 'muse')).toBe(false)
    expect(read.projects.some(project => project.providerId === 'muse')).toBe(false)
    expect(read.providers?.some(provider => provider.id === 'muse')).not.toBe(true)
  }
  expect(stable.eventsAfter(0).some(event => event.threadId === MUSE)).toBe(false)
  expect(stable.eventsAfter(0, MUSE)).toEqual([])
  expect(stable.flushEvents(MUSE)).toBe(true)
  expect(stable.threadMessages(MUSE)).toEqual([])
  await expect(stable.execute({ type: 'send', commandId: randomUUID(), threadId: MUSE, messageId: randomUUID(), text: 'Refused prompt' })).rejects.toThrow('Muse is available in Sotto Owl')
  expect(inner.commands).toEqual([])
  const shell = control.control.shell()
  expect(shell.threadDrafts).toEqual([]); expect(shell.followups).toEqual([])
  expect(shell.draft).toBe(''); expect(shell.activeThreadId).toBeNull()
  expect(shell.configuration).toMatchObject({ provider: 'codex', enabledProviders: ['codex'], defaultModelId: '', newThreadModelId: '' })
  expect((await control.control.command({ type: 'connect', provider: 'muse' })).error).toContain('Muse is available in Sotto Owl')
  await control.control.command({ type: 'connect' })
  expect(control.control.shell().installedProviders).toEqual(['codex'])
  history = false; await control.control.privacyChanged()
  await control.control.command({ type: 'configure', patch: { enabledProviders: ['claude'], provider: 'claude' } })
  await control.dispose(); await control.control.closed(); await stable.close()
  expect(databaseRows(root, 'threads.sqlite', threadTables, MUSE)).toEqual(beforeThread)
  expect(databaseRows(root, 'subagents.sqlite', subagentTables, MUSE)).toEqual(beforeSubagents)
  expect(databaseRows(root, 'threads.sqlite', threadTables, CODEX).messages).toEqual([])
  const saved = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'))
  expect(saved.threadDrafts).toContainEqual(original.draft)
  expect(saved.draft).toBe(original.draft.text)
  expect(JSON.parse(await readFile(join(root, 'followups.json'), 'utf8')).items).toEqual([original.followup])
  expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).snapshot.threads.find((thread: { id: string }) => thread.id === MUSE))
    .toEqual(originalWorkspace.snapshot.threads.find((thread: { id: string }) => thread.id === MUSE))
  const owl = new WorkspaceHost(new FakeProviderHost(), root, () => true, undefined, true, true)
  cleanup.push(() => owl.close()); await owl.initialize()
  const reopened = await agentControlFixture({ directory: root, host: owl, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, museEnabled: true } })
  cleanup.push(reopened.dispose); await reopened.control.start()
  expect(owl.workspaceSnapshot().threads.some(thread => thread.id === MUSE)).toBe(true)
  expect(owl.threadMessages(MUSE).map(message => message.text)).toContain('Synthetic saved message ' + MUSE)
  expect(reopened.control.shell().configuration).toMatchObject({ provider: 'muse', enabledProviders: ['claude', 'muse'],
    defaultModelId: MODEL, newThreadModelId: MODEL, newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'approval-required' })
  expect(reopened.control.shell().threadDrafts).toContainEqual(original.draft)
})

it.each([false, true])('headless startup offers and starts Muse only when its immutable Owl gate is %s', async owl => {
  const root = await directory()
  const providers = { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost() }
  const host = await startHeadlessHost({ dataDirectory: root, providers, reasoner: {}, sottoVersion: owl ? '0.1.37-owl.20261012.1' : '0.1.37' })
  cleanup.push(host.close)
  await expect.poll(() => host.service.shell().host.providers?.find(provider => provider.id === 'codex')?.connection).toBe('connected')
  if (owl) await expect.poll(() => providers.muse.connectCalls).toBe(1)
  expect(host.service.shell().configuration.enabledProviders?.includes('muse')).toBe(owl)
  expect(host.service.shell().host.providers?.some(provider => provider.id === 'muse')).toBe(owl)
  expect(providers.muse.connectCalls).toBe(owl ? 1 : 0)
})

it('a stable desktop hides Muse from a paired Owl host and refuses its provider and thread commands', async () => {
  const hostId = randomUUID(), state = emptyDesktopState(hostId), root = await directory()
  state.host = { ...snapshot(root), hostId }; state.configuration.provider = 'muse'; state.configuration.enabledProviders = ['muse', 'codex']
  state.activeThreadId = MUSE; state.draftThreadId = MUSE; state.draft = 'Synthetic remote draft'
  const command = vi.fn(async () => state), detail = vi.fn(async () => null)
  const connection: DesktopHostConnection = { hostId, name: 'Paired host', kind: 'remote', service: { shell: () => state, command,
    subscribe: () => () => undefined }, detail, preview: () => null }
  const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true, museEnabled: false })
  router.add(connection); router.select(hostId)
  const shell = router.shell()
  expect(shell.host.threads.map(thread => thread.id)).toEqual([hostEntityKey(hostId, CODEX)])
  expect(shell.host.clientHosts?.[0]?.providers?.some(provider => provider.id === 'muse')).toBe(false)
  expect(shell.host.clientHosts?.[0]?.models.some(model => model.providerId === 'muse')).toBe(false)
  expect(shell.draft).toBe(''); expect(shell.configuration.provider).toBe('codex')
  expect(router.preservesDormantThread(hostEntityKey(hostId, MUSE))).toBe(true)
  const client = desktopWindowClient('synthetic-muse-gate')
  await expect(router.command({ type: 'connect', provider: 'muse' }, client)).rejects.toThrow('Sotto Owl')
  await expect(router.command({ type: 'queue-client-updates', providers: ['muse'] }, client)).rejects.toThrow('Sotto Owl')
  await expect(router.command({ type: 'cancel-client-updates', providers: ['muse'] }, client)).rejects.toThrow('Sotto Owl')
  await expect(router.threadDetail(hostEntityKey(hostId, MUSE))).rejects.toThrow('Sotto Owl')
  expect(command).not.toHaveBeenCalled(); expect(detail).not.toHaveBeenCalled()
  router.dispose()
})
