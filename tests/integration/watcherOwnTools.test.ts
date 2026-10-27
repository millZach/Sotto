// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatcherLaunchProfiles } from '../../src/main/agents/watcherLaunchProfiles'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { WATCHER_ROLES_PROMPT, WATCHER_SYSTEM_PROMPT, watcherSystemPrompt } from '../../src/main/agents/watcherPrompt'
import { WATCHER_COMPACTED_NOTE, watcherRequestLine, watcherRequestNote, watcherTextAsTyped } from '../../src/main/agents/watcherRequestNote'
import { WATCHER_WAKE_UP_PROMPT } from '../../src/main/agents/watcherNews'
import { questionInstructions } from '../../src/main/agents/questionInstructions'
import type { AgentHost, WatcherProfileTools } from '../../src/main/agents/host'
import type { ScopedThreadTools } from '../../src/main/agents/threadToolServer'
import type { AgentRuntimeMode, AgentThread } from '../../src/shared/agents'
import { emptyWatcherRecord } from '../../src/shared/watcher'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { museFixture } from '../fixtures/museFixture'
import { MUSE_WATCHER_INSTRUCTIONS, museWatcherInstructions } from '../../src/main/agents/muse'
import { museToolName } from '../../src/main/agents/museRequests'
import { cursorWatcherInstructions } from '../../src/main/agents/cursor'
import { cursorModeArguments } from '../../src/main/agents/cursorModels'
import { cursorFixture } from '../fixtures/fakeCursorFixture'
import { interruptWatcherLiveTurn, observeWatcherLivePermissionAnswers } from '../fixtures/watcherLiveInterrupt'
import type { RecordedRpc } from '../fixtures/adapterFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const factories = { codex: () => codexFixture(undefined, false, 10_000), claude: () => claudeFixture(undefined, 10_000),
  grok: () => grokFixture(undefined, 10_000, 60_000), muse: () => museFixture(undefined, 10_000), cursor: () => cursorFixture(undefined, 10_000) }
/** Each of Sotto's servers on Muse goes by its own name and the thread's suffix (ADR-0079). */
const MUSE_SUFFIX = /_[0-9a-f]{10}$/u
const MSP_MODE: Record<AgentRuntimeMode, string | undefined> = { 'approval-required': 'promptUnmatched', 'auto-accept-edits': undefined, auto: 'onRequest', 'full-access': 'allowAll' }
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]
// Watcher's own tools and its pull request babysitting; a thread's other scoped tools, its visuals among them, stay out.
const names = ['sotto_threads', 'sotto_pull_requests']
function scoped(name: string): ScopedThreadTools {
  return { name, definitions: [{ name: 'fixture_tool', description: 'Synthetic', inputSchema: {} }],
    mcpServer: async () => ({ name, type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: [] }) }
}
async function seedModels(root: string, provider: keyof typeof factories, updated = false) {
  const ids = ['fixture-model', 'fixture-second-model']
  // Cursor's own list shape: each model with its effort option. The first keeps the fixture's default model's ID.
  if (provider === 'cursor') await writeFile(join(root, 'script.json'), JSON.stringify({ ...(updated ? { cliVersion: '2026.10.24-01-02-03-abcdef1' } : {}),
    models: ['gpt-fixture', ids[1]].map(value => ({ value, name: value, configOptions: [{ id: 'reasoning', name: 'Reasoning', category: 'thought_level', type: 'select', currentValue: 'low',
      options: [{ value: 'low', name: 'low' }, { value: 'high', name: 'high' }] }] })) }))
  else if (provider === 'claude') await writeFile(join(root, 'models.json'), JSON.stringify(ids.map(value => ({ value, displayName: value, supportsEffort: true, supportedEffortLevels: ['low', 'high'] }))))
  else if (provider === 'muse') await writeFile(join(root, 'script.json'), JSON.stringify({ ...(updated ? { cliVersion: '1.2.0' } : {}),
    models: ids.map(modelId => ({ modelId, providerId: 'meta', displayLabel: modelId, isDefault: modelId === ids[0] })) }))
  else await writeFile(join(root, 'script.json'), JSON.stringify(provider === 'codex' ? {
    ...(updated ? { version: 'codex/0.200.0' } : {}), developerInstructions: 'Synthetic project developer instructions',
    models: ids.map(model => ({ id: model, model, displayName: model, isDefault: model === ids[0], defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] })),
  } : { ...(updated ? { cliVersion: '1.0.41' } : {}), catalog: { currentModelId: ids[0], availableModels: ids.map(modelId => ({ modelId, name: modelId, _meta: { reasoningEffort: 'high', supportsReasoningEffort: true, reasoningEfforts: [{ id: 'high' }] } })) } }))
}
async function attach(host: AgentHost, root: string, threadId: string, projectId: string, provider: 'codex' | 'claude' | 'grok' | 'muse' | 'cursor', hostId: string = randomUUID(), instructions?: string) {
  const record = emptyWatcherRecord()
  record.current = { target: { hostId, threadId }, projectId, provider, creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
  await writeFile(join(root, 'agents.json'), JSON.stringify({ watcher: record }))
  const source = new WatcherLaunchProfiles(root, () => hostId, id => id === threadId ? {
    id, hostId, projectId, providerId: provider, kind: 'watcher', title: 'Center', modelId: 'fixture-model', status: 'idle', messages: [], requests: [],
  } as AgentThread : undefined, true)
  const tools: WatcherProfileTools = { ...scoped('sotto_threads'), definitions: [{ name: 'list_threads', description: 'Synthetic', inputSchema: {} }], revoke: vi.fn(), ...(instructions !== undefined ? { instructions } : {}) }
  source.useTools(tools); host.useLaunchProfiles!(source)
  host.useThreadTools!(['sotto_visual', 'sotto_pull_requests', 'sotto_host_setup', 'sotto_browser'].map(scoped))
  host.useBrowserTools!({ call: async () => ({ content: [] }), definitions: [], mcpServer: vi.fn(async () => { throw new Error('The center must not attach browser tools') }) })
  return tools
}
function assertConfiguration(provider: keyof typeof factories, records: RecordedRpc[]): void {
  if (provider === 'codex') {
    const launches = records.filter(record => ['thread/start', 'thread/resume'].includes(record.method ?? ''))
    expect(launches.length).toBeGreaterThan(0)
    for (const { params } of launches) {
      expect(params).toMatchObject({ developerInstructions: expect.stringContaining(WATCHER_SYSTEM_PROMPT) })
      expect(params!.developerInstructions).toContain('Synthetic project developer instructions')
      const config = params!.config as { mcp_servers: Record<string, unknown> }
      expect(config).not.toHaveProperty('windows.sandbox')
      expect(Object.keys(config.mcp_servers).sort()).toEqual([...names].sort())
      expect(config.mcp_servers.sotto_threads).toMatchObject({ enabled_tools: ['list_threads'], default_tools_approval_mode: 'prompt',
        tools: { list_threads: { approval_mode: 'approve' } } })
      expect(Object.keys(config).some(key => key.includes('shell_tool') || key.includes('skills') || key.includes('plugins'))).toBe(false)
    }
  } else if (provider === 'claude') {
    const launches = records.filter(record => ['launch', 'resume'].includes(record.method ?? ''))
    expect(launches.length).toBeGreaterThan(0)
    for (const record of launches) {
      const args = (record.params!.frame as { args: string[] }).args
      if (args.includes('--no-session-persistence')) continue
      expect(flag(args, '--append-system-prompt')).toBe(`${questionInstructions('AskUserQuestion', false)}\n\n${WATCHER_SYSTEM_PROMPT}`)
      expect(['default', 'acceptEdits', 'auto', 'bypassPermissions']).toContain(flag(args, '--permission-mode'))
      expect(flag(args, '--permission-prompts')).toBe('host')
      expect(args).toContain('mcp__sotto_threads__list_threads')
      expect(args.some(arg => arg.includes('sotto_visual'))).toBe(false)
      expect(args).toContain('mcp__sotto_pull_requests__fixture_tool')
      for (const denied of ['--tools', '--safe-mode', '--restricted', '--strict-mcp-config', '--setting-sources']) expect(args).not.toContain(denied)
    }
    for (const record of records.filter(record => record.method === 'watcher-launch')) {
      expect((record.params!.frame as { serverNames: string[] }).serverNames.sort()).toEqual([...names].sort())
    }
  } else if (provider === 'muse') {
    // Watcher's session starts on Ask me, so no reviewer of Muse's decides what it asks; each new host gets its servers.
    const launches = records.filter(record => ['session/start', 'session/resume'].includes(record.method ?? ''))
    expect(launches.some(record => record.params?.config !== undefined)).toBe(true)
    for (const { method, params } of launches) {
      if (method === 'session/start') expect(params).toMatchObject({ permissionProfile: ':ask-me' })
      const given = (params?.config as { mcpServers?: Record<string, unknown> } | undefined)?.mcpServers
      if (given) expect(Object.keys(given).map(name => { expect(name).toMatch(MUSE_SUFFIX); return name.replace(MUSE_SUFFIX, '') }).sort()).toEqual([...names].sort())
    }
    // MSP takes no instructions from a client, so they go ahead of Watcher's first message, which is shown alone.
    const turns = records.filter(record => record.method === 'turn/start')
    expect((turns[0]!.params!.input as unknown[])[0]).toEqual({ type: 'text', text: MUSE_WATCHER_INSTRUCTIONS })
    for (const record of turns) expect(record.params!.displayText).toEqual(expect.any(String))
  } else if (provider === 'cursor') {
    // Watcher's session is given its own server and the scoped servers it takes, never the browser, on every new process.
    const launches = records.filter(record => ['session/new', 'session/load'].includes(record.method ?? ''))
    expect(launches.length).toBeGreaterThan(0)
    for (const { params } of launches) expect((params!.mcpServers as { name: string }[]).map(server => server.name).sort()).toEqual([...names].sort())
    // Cursor takes no instructions from a client, so they go ahead of Watcher's first message on a process.
    const prompts = records.filter(record => record.method === 'session/prompt')
    expect(prompts.length).toBeGreaterThan(0)
    expect((prompts[0]!.params!.prompt as { text: string }[])[0]!.text.startsWith(cursorWatcherInstructions())).toBe(true)
  } else {
    const launches = records.filter(record => ['session/new', 'session/load'].includes(record.method ?? ''))
    expect(launches.length).toBeGreaterThan(0)
    for (const { params } of launches) {
      expect(params!._meta).toMatchObject({ systemPromptOverride: WATCHER_SYSTEM_PROMPT })
      expect((params!.mcpServers as { name: string }[]).map(server => server.name).sort()).toEqual([...names].sort())
    }
    for (const record of records.filter(record => record.method === 'fixture/process')) {
      expect(record.params!.args).not.toContain('--no-subagents')
      expect(record.params!.environment).not.toHaveProperty('GROK_SUBAGENTS')
      expect(record.params!.environment).not.toHaveProperty('GROK_MEMORY')
    }
  }
}

function assertRuntimeConfiguration(provider: keyof typeof factories, records: RecordedRpc[], mode: AgentRuntimeMode): void {
  if (provider === 'codex') {
    const approvalPolicy = mode === 'approval-required' ? 'untrusted' : mode === 'full-access' ? 'never' : 'on-request'
    const approvalsReviewer = mode === 'auto' ? 'auto_review' : 'user'
    const sandbox = mode === 'approval-required' ? 'read-only' : mode === 'full-access' ? 'danger-full-access' : 'workspace-write'
    const settings = records.filter(record => ['thread/start', 'thread/resume', 'thread/settings/update'].includes(record.method ?? ''))
    expect(settings.length).toBeGreaterThan(0)
    for (const record of settings) {
      expect(record.params).toMatchObject({ approvalPolicy, approvalsReviewer })
      if (record.method === 'thread/settings/update') expect(record.params!.sandboxPolicy).toEqual({ type: sandbox === 'read-only' ? 'readOnly' : sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite' })
      else expect(record.params!.sandbox).toBe(sandbox)
    }
    for (const record of records.filter(record => record.method === 'turn/start')) expect(record.params).toMatchObject({ approvalPolicy, approvalsReviewer })
  } else if (provider === 'claude') {
    const native = { 'approval-required': 'default', 'auto-accept-edits': 'acceptEdits', auto: 'auto', 'full-access': 'bypassPermissions' }[mode]
    const settings = records.filter(record => ['launch', 'resume', 'set_permission_mode'].includes(record.method ?? ''))
    expect(settings.length).toBeGreaterThan(0)
    for (const record of settings) {
      const frame = record.params!.frame as { args: string[]; request?: { mode: string } }
      if (record.method === 'set_permission_mode') expect(frame.request!.mode).toBe(native)
      else {
        if (frame.args.includes('--no-session-persistence')) continue
        expect(flag(frame.args, '--permission-mode')).toBe(native)
        expect(frame.args.includes('--allow-dangerously-skip-permissions')).toBe(mode === 'full-access')
      }
    }
  } else if (provider === 'muse') {
    // Muse keeps a session's approval mode itself; a start or a change names it, and a resume carries none.
    for (const record of records.filter(record => record.method === 'session/start')) expect(record.params!.approvalMode).toBe(MSP_MODE[mode])
    for (const record of records.filter(record => record.method === 'session/setApprovalMode')) expect(record.params!.mode).toBe(MSP_MODE[mode])
  } else if (provider === 'cursor') {
    // Each thread process takes its approval mode when it starts; a model change starts none, so it may have none to read.
    const threadProcesses = new Set(records.filter(record => ['session/new', 'session/load'].includes(record.method ?? '')).map(record => (record as RecordedRpc & { process?: number }).process))
    for (const record of records.filter(record => record.method === 'fixture/process' && threadProcesses.has(record.params!.pid as number))) {
      expect(record.params!.args).toEqual([...cursorModeArguments(mode === 'auto-accept-edits' ? 'approval-required' : mode), 'acp'])
    }
  } else {
    const settings = records.filter(record => ['session/new', 'session/load'].includes(record.method ?? ''))
    expect(settings.length).toBeGreaterThan(0)
    for (const record of settings) expect(record.params!._meta).toEqual({ yoloMode: mode === 'full-access', autoMode: mode === 'auto', systemPromptOverride: WATCHER_SYSTEM_PROMPT })
  }
}

for (const provider of Object.keys(factories) as (keyof typeof factories)[]) describe(`${provider} watcher own tools`, () => {
  // MSP has no skill catalog a client may read, so Muse offers no skills (ADR-0079).
  it.skipIf(provider === 'muse')('discovers and sends selected native skills while retaining the launch profile', async () => {
    const f = await factories[provider](); cleanups.push(f.cleanup)
    const id = randomUUID(), tools = await attach(f.host, f.root, id, f.projectId, provider)
    const path = join(f.root, 'SKILL.md')
    if (provider === 'codex') await writeFile(join(f.root, 'script.json'), JSON.stringify({
      skills: [{ name: 'check', description: 'Synthetic', path, scope: 'repo', enabled: true }],
    }))
    else if (provider === 'cursor') await writeFile(join(f.root, 'script.json'), JSON.stringify({ commands: [{ name: 'check', description: 'Synthetic' }] }))
    else await writeFile(join(f.root, 'skills.json'), JSON.stringify(provider === 'claude'
      ? [{ name: 'check', description: 'Synthetic (project)' }]
      : { skills: [{ name: 'check', description: 'Synthetic', source: { path, type: 'project' }, userInvocable: true }] }))
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Watcher', modelId: f.modelId })
    const catalog = await (f.host as AgentHost).listThreadSkills!(id, true)
    expect(catalog).toMatchObject({ threadId: id, providerId: provider, status: 'ready' })
    const skill = catalog.skills[0]!
    expect(skill.name).toBe('check')
    expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(),
      text: '$check verify', skills: [{ name: skill.name, path: skill.path }] })).accepted).toBe(true)
    const records = await f.driver.requests()
    const prompt = records.find(record => record.method === (provider === 'codex' ? 'turn/start' : provider === 'claude' ? 'user' : 'session/prompt'))!
    if (provider === 'codex') expect(prompt.params!.input).toContainEqual({ type: 'skill', name: 'check', path })
    // Cursor reads a skill at the start of the prompt, so its `/check` goes ahead of Watcher's instructions.
    else if (provider === 'cursor') expect((prompt.params!.prompt as { text: string }[])[0]!.text).toBe(`/check ${cursorWatcherInstructions()}$check verify`)
    else expect(JSON.stringify(prompt.params)).toContain('/check verify')
    expect(tools.revoke).not.toHaveBeenCalled()
    await writeFile(join(f.root, 'agents.json'), '{')
    await expect((f.host as AgentHost).listThreadSkills!(id, true)).rejects.toThrow('saved identity')
    expect(tools.revoke).toHaveBeenCalledWith(id)
  })

  it('keeps ordinary permission mappings and scoped tools through widening, narrowing, early start, replacement and cold resume', async () => {
    const f = await factories[provider](); cleanups.push(f.cleanup)
    const id = randomUUID(), tools = await attach(f.host, f.root, id, f.projectId, provider)
    await seedModels(f.root, provider)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
    await f.host.startThreadSession!(id, { modelId: f.modelId, workingDirectory: f.root, runtimeMode: 'full-access' })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId, runtimeMode: 'full-access' })
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic first turn' })
    await f.driver.completeTurn(id, 'Synthetic complete')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
    assertConfiguration(provider, await f.driver.requests())
    assertRuntimeConfiguration(provider, await f.driver.requests(), 'full-access')
    const modes: AgentRuntimeMode[] = provider === 'grok' || provider === 'muse' || provider === 'cursor' ? ['approval-required', 'auto', 'full-access'] : ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
    for (const runtimeMode of modes) {
      const before = (await f.driver.requests()).length
      expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode })).accepted).toBe(true)
      expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.runtimeMode).toBe(runtimeMode)
      await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic mode turn' })
      await f.driver.completeTurn(id, 'Synthetic complete')
      await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
      assertRuntimeConfiguration(provider, (await f.driver.requests()).slice(before), runtimeMode)
      if ('liveSettings' in f && f.liveSettings) expect((await f.liveSettings.effective(id)).runtimeMode).toBe(runtimeMode)
    }
    // Muse is told Watcher's instructions once on a host (#1418): the turns after the first carry the message alone.
    const museTurns = async () => (await f.driver.requests()).filter(record => record.method === 'turn/start').map(record => record.params!.input as unknown[])
    if (provider === 'muse') expect((await museTurns()).map(input => input.length)).toEqual([2, ...modes.map(() => 1)])
    // Cursor is told them once on a process (#1418), and a mode change starts a new process, so each of these turns has them.
    const cursorPrompts = async () => (await f.driver.requests()).filter(record => record.method === 'session/prompt').map(record => (record.params!.prompt as { text: string }[])[0]!.text)
    if (provider === 'cursor') expect((await cursorPrompts()).map(text => text.startsWith(cursorWatcherInstructions()))).toEqual([true, ...modes.map(() => true)])
    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, providerMode: 'anything' })).rejects.toThrow('ordinary permission modes')
    const beforeModelChange = (await f.driver.requests()).length
    expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high', modelId: 'fixture-second-model' })).accepted).toBe(true)
    if ('liveSettings' in f && f.liveSettings) expect((await f.liveSettings.effective(id)).runtimeMode).toBe('full-access')
    else assertRuntimeConfiguration(provider, (await f.driver.requests()).slice(beforeModelChange), 'full-access')
    const beforeReplacement = (await f.driver.requests()).length
    await f.clientUpdate!.install()
    await seedModels(f.root, provider, true)
    await f.host.clientUpdated!(provider)
    await f.host.startThreadSession!(id)
    assertRuntimeConfiguration(provider, (await f.driver.requests()).slice(beforeReplacement), 'full-access')
    await f.driver.raisePermission(id, 'Synthetic edit or writing command')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
    expect(tools.revoke).not.toHaveBeenCalled()
    let permissionAnswers = 0
    observeWatcherLivePermissionAnswers(f.adapter, provider, id, () => { permissionAnswers++ })
    const beforeInterrupt = (await f.driver.requests()).length
    await interruptWatcherLiveTurn(f.adapter, provider, id)
    f.host.disconnect(); await f.adapter.closed()
    expect(permissionAnswers).toBe(0)
    const interruptionTraffic = (await f.driver.requests()).slice(beforeInterrupt)
    expect(interruptionTraffic.some(record => {
      if (provider === 'codex') return !!record.result && 'decision' in record.result
      if ('protocol' in f) return f.protocol.permissionDecision(record) !== undefined
      return false
    })).toBe(false)
    const beforeResume = (await f.driver.requests()).length
    await f.host.connect(); await f.host.startThreadSession!(id)
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic resumed turn' })
    assertConfiguration(provider, await f.driver.requests())
    // A cold resume is a new host, which tells the resumed session the instructions again.
    if (provider === 'muse') expect((await museTurns()).at(-1)![0]).toEqual({ type: 'text', text: MUSE_WATCHER_INSTRUCTIONS })
    if (provider === 'cursor') expect((await cursorPrompts()).at(-1)).toBe(cursorWatcherInstructions() + 'Synthetic resumed turn')
    assertRuntimeConfiguration(provider, (await f.driver.requests()).slice(beforeResume), 'full-access')
    expect(tools.revoke).not.toHaveBeenCalled()
    if (provider === 'codex') {
      const servers = (await readFile(join(f.root, 'servers.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      for (const server of servers.filter(server => server.method === 'initialize')) {
        expect(server.args).not.toContain('windows.sandbox="unelevated"')
        expect(servers.filter(record => record.pid === server.pid && record.method === 'command/exec')).toEqual([])
        expect(server.args.some((arg: string) => arg.includes('enabled=false') || arg.includes('shell_tool'))).toBe(false)
      }
    }
  })
})

/** A Watcher thread and an ordinary thread beside it on one provider, for the request note checks. */
async function watcherBesideOrdinary(f: { host: AgentHost; root: string; projectId: string; modelId: string }, provider: 'codex' | 'claude' | 'grok' | 'muse' | 'cursor', instructions?: string) {
  const id = randomUUID(), ordinary = randomUUID()
  await attach(f.host, f.root, id, f.projectId, provider, randomUUID(), instructions)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId })
  // Watcher refuses Sotto's browser tools; an ordinary thread is started with them.
  f.host.useBrowserTools!({ call: async () => ({ content: [] }), definitions: [], mcpServer: async () => ({ name: 'sotto_browser', type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: [] }) })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: ordinary, projectId: f.projectId, title: 'Ordinary', modelId: f.modelId })
  return { id, ordinary }
}
it('gives a Codex Watcher its request note as the turn’s application context and sends the user’s words as typed', async () => {
  const f = await codexFixture(undefined, false, 10_000); cleanups.push(f.cleanup)
  const { id, ordinary } = await watcherBesideOrdinary(f, 'codex')
  const typed = 'Synthetic instruction to Watcher', note = watcherRequestNote(randomUUID(), randomUUID())
  for (const threadId of [id, ordinary]) {
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: typed, watcherRequestNote: note })
  }
  const [watcher, other] = (await f.driver.requests()).filter(record => record.method === 'turn/start')
  // What Codex receives as the user's input is what the user typed; the note is the application's context beside it.
  expect(watcher!.params!.input).toEqual([expect.objectContaining({ type: 'text', text: typed })])
  expect(watcher!.params!.additionalContext).toEqual({ sotto_watcher_request: { value: note, kind: 'application' } })
  // An ordinary thread is never given a note, even one a command carried.
  expect(other!.params!.input).toEqual([expect.objectContaining({ type: 'text', text: typed })])
  expect(other!.params).not.toHaveProperty('additionalContext')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.messages.find(message => message.role === 'user')?.text).toBe(typed)
})

it('gives a Claude Watcher its request note through its own UserPromptSubmit hook and sends the user’s words as typed', async () => {
  const f = await claudeFixture(undefined, 10_000); cleanups.push(f.cleanup)
  const { id, ordinary } = await watcherBesideOrdinary(f, 'claude')
  const typed = 'Synthetic instruction to Watcher', first = watcherRequestNote(randomUUID(), randomUUID()), second = watcherRequestNote(randomUUID(), randomUUID())
  expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: typed, watcherRequestNote: first })).accepted).toBe(true)
  await f.driver.completeTurn(id, 'Synthetic complete')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
  // A wake-up or any send without a note gives the hook nothing, never an earlier request's note.
  expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic news' })).accepted).toBe(true)
  await f.driver.completeTurn(id, 'Synthetic complete')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
  // A prompt of Claude Code's own that reaches the hook first is not the one the note was written for.
  const foreign = '<task-notification>Synthetic background task finished</task-notification>'
  await writeFile(join(f.root, 'script.json'), JSON.stringify({ foreignHookPrompt: foreign }))
  expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: typed, watcherRequestNote: second })).accepted).toBe(true)
  expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: ordinary, messageId: randomUUID(), text: typed, watcherRequestNote: first })).accepted).toBe(true)
  const records = await f.driver.requests()
  type Frame = { request?: { hooks?: Record<string, unknown> }; message?: { content?: unknown }; additionalContext?: string | null; prompt?: string }
  const frame = (record: RecordedRpc) => record.params!.frame as Frame
  // Only the Watcher's CLI registers the hook; an ordinary thread's CLI, like the account check's, starts with none.
  const hooks = records.filter(record => record.method === 'initialize').map(record => frame(record).request?.hooks ?? {})
  expect(hooks.filter(registered => Object.keys(registered).length)).toEqual([{ UserPromptSubmit: [{ hookCallbackIds: ['sotto_watcher_request'] }] }])
  expect(hooks.filter(registered => !Object.keys(registered).length).length).toBeGreaterThanOrEqual(2)
  // What Claude Code receives as the user's message is what the user typed.
  const prompts = records.filter(record => record.method === 'user').map(record => frame(record).message?.content)
  expect(prompts).toEqual([typed, 'Synthetic news', typed, typed])
  // The note reaches the model as the hook's context, once, for its own prompt.
  expect(records.filter(record => record.method === 'hook-context').map(record => [frame(record).prompt, frame(record).additionalContext]))
    .toEqual([[typed, first], ['Synthetic news', null], [foreign, null], [typed, second]])
  const shown = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages.filter(message => message.role === 'user').map(message => message.text)
  expect(shown).toEqual([typed, 'Synthetic news', typed])
})

it('gives a Grok Watcher its request note as one Sotto line after the user’s words, its only prompt channel', async () => {
  const f = await grokFixture(undefined, 10_000); cleanups.push(f.cleanup)
  const { id, ordinary } = await watcherBesideOrdinary(f, 'grok')
  const typed = 'Synthetic instruction to Watcher', request = { requestId: randomUUID(), hostId: randomUUID() }, note = watcherRequestNote(request.requestId, request.hostId)
  for (const threadId of [id, ordinary]) {
    expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: typed, watcherRequestNote: note })).accepted).toBe(true)
  }
  const prompts = (await f.driver.requests()).filter(record => record.method === 'session/prompt').map(record => record.params!.prompt)
  // The line lists no projects and is the only addition; an ordinary thread is sent the words alone.
  expect(prompts).toEqual([[{ type: 'text', text: typed + watcherRequestLine(note) }], [{ type: 'text', text: typed }]])
  // Grok's own echo is what Sotto reads back, so the coordinator's snapshot is where the line comes off (see watcherRequestNote.test.ts).
  expect(watcherTextAsTyped((await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages.find(message => message.role === 'user')!.text, request)).toBe(typed)
})

it('gives a Muse Watcher its instructions ahead of each message and its request note after the words, and shows the words as typed', async () => {
  const f = await museFixture(undefined, 10_000); cleanups.push(f.cleanup)
  const { id, ordinary } = await watcherBesideOrdinary(f, 'muse')
  const typed = 'Synthetic instruction to Watcher', note = watcherRequestNote(randomUUID(), randomUUID())
  for (const threadId of [id, ordinary]) {
    expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: typed, watcherRequestNote: note })).accepted).toBe(true)
  }
  const [watcher, other] = (await f.driver.requests()).filter(record => record.method === 'turn/start')
  expect(watcher!.params!.input).toEqual([{ type: 'text', text: MUSE_WATCHER_INSTRUCTIONS }, { type: 'text', text: typed + watcherRequestLine(note) }])
  expect(watcher!.params!.displayText).toBe(typed)
  // An ordinary thread is sent the words alone, even when a command carried a note.
  expect(other!.params!.input).toEqual([{ type: 'text', text: typed }])
  expect(other!.params).not.toHaveProperty('displayText')
  // Muse's transcript keeps the display text, and that is what Sotto shows: no line comes off, none was shown.
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.messages.find(message => message.role === 'user')?.text).toBe(typed)
  // Muse's own servers for an ordinary thread include the browser; Watcher's never do.
  const starts = (await f.driver.requests()).filter(record => record.method === 'session/start')
  const named = (index: number) => Object.keys((starts[index]!.params!.config as { mcpServers: Record<string, unknown> }).mcpServers).map(name => name.replace(MUSE_SUFFIX, ''))
  expect(named(0)).not.toContain('sotto_browser')
  expect(named(1)).toContain('sotto_browser')
  expect(starts[0]!.params).toMatchObject({ permissionProfile: ':ask-me' })
  expect(starts[1]!.params).not.toHaveProperty('permissionProfile')
})

it('tells a Muse Watcher its profile’s instructions once, again after a compaction, and shows each message as typed', async () => {
  const f = await museFixture(undefined, 10_000); cleanups.push(f.cleanup)
  // With worker roles on, the profile's instructions carry the roles lines (#1417).
  const { id } = await watcherBesideOrdinary(f, 'muse', watcherSystemPrompt(true))
  const send = async (text: string, note: string) => {
    expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text, watcherRequestNote: note })).accepted).toBe(true)
    await f.driver.completeTurn(id, 'Synthetic complete')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
  }
  const note = () => watcherRequestNote(randomUUID(), randomUUID())
  const instructions = { type: 'text', text: museWatcherInstructions(watcherSystemPrompt(true)) }
  const first = note(), second = note()
  await send('Synthetic first', first)
  // Muse keeps no display text from here on, so the second message is shown from the wire text, with Sotto's note off.
  await writeFile(join(f.root, 'script.json'), JSON.stringify({ dropDisplayText: true }))
  await send('Synthetic second', second)
  expect((await f.host.execute({ type: 'compact-thread', commandId: randomUUID(), threadId: id })).accepted).toBe(true)
  await send('Synthetic after compaction', note())
  await send('Synthetic fourth', note())
  // A note that says the conversation is new or was compacted, as after one Muse made by itself, brings them back too.
  const compacted = watcherRequestNote(randomUUID(), randomUUID(), true)
  expect(compacted).toContain(WATCHER_COMPACTED_NOTE)
  await send('Synthetic after a compaction Muse made', compacted)
  // The line stays in each note until Watcher reads its state, and asks for the instructions only once.
  await send('Synthetic before reading state', watcherRequestNote(randomUUID(), randomUUID(), true))
  const turns = (await f.driver.requests()).filter(record => record.method === 'turn/start').map(record => record.params!.input as { type: string; text: string }[])
  expect(turns[0]).toEqual([instructions, { type: 'text', text: 'Synthetic first' + watcherRequestLine(first) }])
  expect(turns[0]![0]!.text).toContain(WATCHER_ROLES_PROMPT)
  expect(turns[1]).toEqual([{ type: 'text', text: 'Synthetic second' + watcherRequestLine(second) }])
  expect(turns.map(input => input[0]!.text === instructions.text)).toEqual([true, false, true, false, true, false])
  const shown = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages.filter(message => message.role === 'user').map(message => message.text)
  expect(shown).toEqual(['Synthetic first', 'Synthetic second', 'Synthetic after compaction', 'Synthetic fourth', 'Synthetic after a compaction Muse made', 'Synthetic before reading state'])
})

it('tells a Cursor Watcher its profile’s instructions once on a process, again when the note says the conversation is new, and shows each message as typed', async () => {
  const f = await cursorFixture(undefined, 10_000); cleanups.push(f.cleanup)
  // With worker roles on, the profile's instructions carry the roles lines (#1417).
  const { id } = await watcherBesideOrdinary(f, 'cursor', watcherSystemPrompt(true))
  const send = async (text: string, note: string) => {
    expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text, watcherRequestNote: note })).accepted).toBe(true)
    await f.driver.completeTurn(id, 'Synthetic complete')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
  }
  const note = () => watcherRequestNote(randomUUID(), randomUUID())
  const instructions = cursorWatcherInstructions(watcherSystemPrompt(true))
  const first = note(), second = note()
  await send('Synthetic first', first)
  await send('Synthetic second', second)
  // A note that says the conversation is new or was compacted brings them back, once while the line stays in each note.
  const compacted = watcherRequestNote(randomUUID(), randomUUID(), true)
  expect(compacted).toContain(WATCHER_COMPACTED_NOTE)
  await send('Synthetic in a new conversation', compacted)
  await send('Synthetic before reading state', watcherRequestNote(randomUUID(), randomUUID(), true))
  // A new process tells the session it loads them again, though its replayed history carried them.
  f.host.disconnect(); await f.adapter.closed(); await f.host.connect(); await f.host.startThreadSession!(id)
  await send('Synthetic on a new process', note())
  await send('Synthetic after that', note())
  const prompts = (await f.driver.requests()).filter(record => record.method === 'session/prompt').map(record => (record.params!.prompt as { text: string }[])[0]!.text)
  expect(prompts[0]).toBe(instructions + 'Synthetic first' + watcherRequestLine(first))
  expect(prompts[0]).toContain(WATCHER_ROLES_PROMPT)
  expect(prompts[1]).toBe('Synthetic second' + watcherRequestLine(second))
  expect(prompts.map(text => text.startsWith(instructions))).toEqual([true, false, true, false, true, false])
  // Replayed on the new process and live, each shows as typed: Sotto's instructions and a note alone both come off.
  const shown = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.messages.filter(message => message.role === 'user').map(message => message.text)
  expect(shown).toEqual(['Synthetic first', 'Synthetic second', 'Synthetic in a new conversation', 'Synthetic before reading state', 'Synthetic on a new process', 'Synthetic after that'])
})

it('keeps words a user typed that look like Watcher’s instructions in a Muse message shown from its wire text', async () => {
  const f = await museFixture(undefined, 10_000); cleanups.push(f.cleanup)
  const { ordinary } = await watcherBesideOrdinary(f, 'muse')
  // An ordinary thread's message has no display text, so it is shown from the wire text; the digest proves the words typed.
  const typed = `${MUSE_WATCHER_INSTRUCTIONS}Synthetic question about that block`
  expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: ordinary, messageId: randomUUID(), text: typed })).accepted).toBe(true)
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === ordinary)?.messages.find(message => message.role === 'user')?.text).toBe(typed)
})

it.each([
  ['keeps no display text', { dropDisplayText: true }, (typed: string) => typed],
  ['cuts the message short', { truncateUserText: MUSE_WATCHER_INSTRUCTIONS.length + 12 }, (typed: string) => typed.slice(0, 12)],
])('shows a Muse Watcher message without Sotto’s instructions or note when Muse %s', async (_case, script, shown) => {
  const f = await museFixture(undefined, 10_000); cleanups.push(f.cleanup)
  const { id } = await watcherBesideOrdinary(f, 'muse')
  await writeFile(join(f.root, 'script.json'), JSON.stringify(script))
  const typed = 'Synthetic instruction to Watcher on Muse', note = watcherRequestNote(randomUUID(), randomUUID())
  expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: typed, watcherRequestNote: note })).accepted).toBe(true)
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.messages.find(message => message.role === 'user')?.text).toBe(shown(typed))
  // A cold read of Muse's history, as a handover reads it, shows the same.
  f.host.disconnect(); await f.adapter.closed(); await f.host.connect(); await f.host.startThreadSession!(id)
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.messages.find(message => message.role === 'user')?.text).toBe(shown(typed))
})

it('admits only Watcher’s own suffixed Muse tool names and shows a folded lookalike as an ordinary card', async () => {
  const f = await museFixture(undefined, 10_000); cleanups.push(f.cleanup)
  const id = randomUUID(), tools = await attach(f.host, f.root, id, f.projectId, 'muse')
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId })
  const given = Object.keys(((await f.driver.requests()).find(record => record.method === 'session/start')!.params!.config as { mcpServers: Record<string, unknown> }).mcpServers)
  const server = (plain: string) => given.find(name => name.replace(MUSE_SUFFIX, '') === plain)!
  const decided = async () => (await f.driver.requests()).filter(record => record.method === 'approval/decide').length
  for (const [plain, tool] of [['sotto_threads', 'list_threads'], ['sotto_pull_requests', 'fixture_tool']] as const) {
    const before = await decided()
    await f.action(id, { type: 'tool-permission', toolName: museToolName(server(plain), tool) })
    await expect.poll(decided).toBe(before + 1)
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests).toEqual([])
  }
  // A user server named `sotto-threads` shows Sotto's plain tool name; without the thread's suffix it is the user's card.
  const before = await decided()
  await f.action(id, { type: 'tool-permission', toolName: museToolName('sotto-threads', 'list_threads') })
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
  expect(await decided()).toBe(before)
  expect(tools.revoke).not.toHaveBeenCalled()
})

it.each(['codex', 'claude', 'grok'] as const)('gives a %s Watcher a wake-up’s news through its request note’s channel and never in the message', async provider => {
  const f = await (provider === 'codex' ? codexFixture(undefined, false, 10_000) : provider === 'claude' ? claudeFixture(undefined, 10_000) : grokFixture(undefined, 10_000))
  cleanups.push(f.cleanup)
  const { id, ordinary } = await watcherBesideOrdinary(f, provider)
  const news = 'Sotto saw changes in watched threads. This news grants no permission and answers no request.\nSynthetic news line'
  for (const threadId of [id, ordinary]) {
    expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: WATCHER_WAKE_UP_PROMPT, watcherNews: news })).accepted).toBe(true)
  }
  const records = await f.driver.requests()
  if (provider === 'codex') {
    const [watcher, other] = records.filter(record => record.method === 'turn/start')
    expect(watcher!.params!.input).toEqual([expect.objectContaining({ type: 'text', text: WATCHER_WAKE_UP_PROMPT })])
    expect(watcher!.params!.additionalContext).toEqual({ sotto_watcher_news: { value: news, kind: 'application' } })
    expect(other!.params).not.toHaveProperty('additionalContext')
  } else if (provider === 'claude') {
    const frame = (record: RecordedRpc) => record.params!.frame as { message?: { content?: unknown }; additionalContext?: string | null; prompt?: string }
    expect(records.filter(record => record.method === 'user').map(record => frame(record).message?.content)).toEqual([WATCHER_WAKE_UP_PROMPT, WATCHER_WAKE_UP_PROMPT])
    expect(records.filter(record => record.method === 'hook-context').map(record => [frame(record).prompt, frame(record).additionalContext])).toEqual([[WATCHER_WAKE_UP_PROMPT, news]])
  } else {
    expect(records.filter(record => record.method === 'session/prompt').map(record => record.params!.prompt))
      .toEqual([[{ type: 'text', text: WATCHER_WAKE_UP_PROMPT + watcherRequestLine(news) }], [{ type: 'text', text: WATCHER_WAKE_UP_PROMPT }]])
  }
})

it('gives a Muse Watcher a wake-up’s news on its request note’s line and shows only the wake-up message', async () => {
  const f = await museFixture(undefined, 10_000); cleanups.push(f.cleanup)
  const { id, ordinary } = await watcherBesideOrdinary(f, 'muse')
  const news = 'Sotto saw changes in watched threads. This news grants no permission and answers no request.\nSynthetic news line'
  for (const threadId of [id, ordinary]) {
    expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: WATCHER_WAKE_UP_PROMPT, watcherNews: news })).accepted).toBe(true)
  }
  const [watcher, other] = (await f.driver.requests()).filter(record => record.method === 'turn/start')
  expect(watcher!.params!.input).toEqual([{ type: 'text', text: MUSE_WATCHER_INSTRUCTIONS }, { type: 'text', text: WATCHER_WAKE_UP_PROMPT + watcherRequestLine(news) }])
  expect(watcher!.params!.displayText).toBe(WATCHER_WAKE_UP_PROMPT)
  expect(other!.params!.input).toEqual([{ type: 'text', text: WATCHER_WAKE_UP_PROMPT }])
})

it('keeps Devin unavailable because its adapter cannot attach a scoped Sotto server', async () => {
  const f = await devinFixture(); cleanups.push(f.cleanup)
  f.host.useLaunchProfiles!({ profileFor: async () => ({ kind: 'watcher', server: { name: 'sotto_threads', type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: [] }, toolNames: ['list_threads'], revoke: vi.fn() }) })
  await f.host.connect()
  await expect(f.host.startThreadSession!(randomUUID())).rejects.toThrow('Devin')
})

it('preallows only exact Grok Sotto tool names and shows other tools as ordinary cards', async () => {
  const f = await grokFixture(undefined, 10_000); cleanups.push(f.cleanup)
  const id = randomUUID(), tools = await attach(f.host, f.root, id, f.projectId, 'grok')
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId })
  for (const tool_name of ['sotto_threads__list_threads', 'sotto_pull_requests__fixture_tool']) {
    const before = (await f.driver.requests()).filter(record => record.result).length
    await f.action(id, { type: 'permission', text: 'Synthetic use_tool', rawInput: { tool_name } })
    await expect.poll(async () => (await f.driver.requests()).filter(record => record.result).length).toBeGreaterThan(before)
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests).toEqual([])
  }
  await f.action(id, { type: 'permission', text: 'Synthetic use_tool', rawInput: { tool_name: 'sotto_threads__list_threads_extra' } })
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
  expect(tools.revoke).not.toHaveBeenCalled()
})

/** A native permission request offering one-time, session and lasting grants, in each provider's own form. */
function rememberedPermission(provider: 'codex' | 'grok' | 'muse') {
  return provider === 'codex' ? { type: 'permission', text: 'Synthetic write', params: { availableDecisions: ['accept', 'acceptForSession', { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'synthetic.invalid' } } }, 'decline'] } }
    : provider === 'grok' ? { type: 'permission', text: 'Synthetic write', options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] }
      : { type: 'permission', text: 'Synthetic write', choices: [{ choiceId: 'yes', decision: 'approved', label: 'Allow once', scope: 'once' },
        { choiceId: 'session', decision: 'approvedForSession', label: 'Allow for this session', scope: 'session' },
        { choiceId: 'always', decision: 'approved', label: 'Always allow', scope: 'localPersistent' }, { choiceId: 'no', decision: 'denied', label: 'Deny', scope: 'once' }] }
}
const rememberedChoices = { codex: ['acceptForSession', 'native-decision:2'], grok: ['always'], muse: ['session', 'always'] }
const onceChoice = { codex: 'accept', grok: 'yes', muse: 'yes' }
for (const provider of ['codex', 'grok', 'muse'] as const) it(`${provider} refuses remembered permission grants while allowing a single native approval`, async () => {
  const f = await factories[provider](); cleanups.push(f.cleanup)
  const id = randomUUID()
  await attach(f.host, f.root, id, f.projectId, provider)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId })
  await f.action(id, rememberedPermission(provider))
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
  const request = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests[0]!
  const answer = { type: 'answer' as const, commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true }
  for (const permissionChoice of rememberedChoices[provider]) {
    await expect(f.host.execute({ ...answer, commandId: randomUUID(), permissionChoice })).rejects.toThrow('cannot remember')
  }
  expect((await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests).toHaveLength(1)
  expect((await f.host.execute({ ...answer, commandId: randomUUID(), permissionChoice: onceChoice[provider] })).accepted).toBe(true)
})

for (const provider of ['codex', 'grok', 'muse'] as const) it(`${provider} keeps the workspace session and card after refusing a remembered grant`, async () => {
  const f = await factories[provider](); cleanups.push(f.cleanup)
  const native = new ConfiguredProviderHost({ directory: f.root, provider: () => provider, enabledProviders: () => [provider],
    threadProvider: () => provider, hosts: { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost(), opencode: new FakeProviderHost(), cursor: new FakeProviderHost(), deepseek: new FakeProviderHost(), [provider]: f.host } })
  const workspace = new WorkspaceHost(native, f.root, () => true, undefined, true, true)
  cleanups.push(() => workspace.close())
  await workspace.initialize()
  await workspace.connect()
  await workspace.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  const id = randomUUID(), hostId = workspace.workspaceSnapshot().hostId!
  const tools = await attach(f.host, f.root, id, f.projectId, provider, hostId)
  workspace.useWatcherTools(tools)
  const modelId = workspace.workspaceSnapshot().models.find(model => model.providerId === provider)!.id
  await workspace.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Watcher', modelId })
  await workspace.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic first turn' })
  await f.driver.completeTurn(id, 'Synthetic complete')
  await expect.poll(async () => (await workspace.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
  await f.action(id, provider === 'codex' ? { type: 'permission', text: 'Synthetic write', params: { availableDecisions: ['accept', 'acceptForSession', 'decline'] } } : rememberedPermission(provider))
  await expect.poll(async () => (await workspace.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
  const request = (await workspace.snapshot()).threads.find(thread => thread.id === id)!.requests[0]!
  await expect(workspace.configureThreadWorkingCopy(id, { workingCopy: 'independent' })).rejects.toThrow('working folder cannot be changed')
  const answer = { type: 'answer' as const, commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true }
  await expect(workspace.execute({ ...answer, permissionChoice: provider === 'codex' ? 'acceptForSession' : 'always' })).rejects.toThrow('Allow this request once')
  expect(tools.revoke).not.toHaveBeenCalled()
  expect((await workspace.snapshot()).threads.find(thread => thread.id === id)!.requests).toEqual([request])
  expect((await workspace.execute({ ...answer, commandId: randomUUID(), permissionChoice: onceChoice[provider] })).accepted).toBe(true)
  await expect.poll(async () => (await workspace.snapshot()).threads.find(thread => thread.id === id)?.requests).toEqual([])
  expect((await workspace.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic retry turn' })).accepted).toBe(true)
  expect(tools.revoke).not.toHaveBeenCalled()
  await writeFile(join(f.root, 'agents.json'), '{')
  await expect(workspace.execute({ ...answer, commandId: randomUUID() })).rejects.toThrow('saved identity')
  expect(tools.revoke).toHaveBeenCalledWith(id)
})

it('keeps Codex tools and instructions without replaying uncertain permission settings on recovery reads', async () => {
  const f = await codexFixture(undefined, false, 10_000); cleanups.push(f.cleanup)
  const id = randomUUID()
  await attach(f.host, f.root, id, f.projectId, 'codex')
  await f.script({ developerInstructions: 'Synthetic project developer instructions' })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId, runtimeMode: 'full-access' })
  const native = f.adapter as unknown as { aliases: Record<string, { pendingSettings?: { modelId: string; reasoningEffort: string; runtimeMode: 'full-access' } }> }
  native.aliases[id]!.pendingSettings = { modelId: f.modelId, reasoningEffort: 'high', runtimeMode: 'full-access' }
  await f.script({ developerInstructions: 'Synthetic project developer instructions', threadResumeSettings: { reasoningEffort: 'high' } })
  const before = (await f.driver.requests()).length
  await f.host.refreshThread!(id)
  const recovery = (await f.driver.requests()).slice(before).filter(record => record.method === 'thread/resume')
  expect(recovery.length).toBeGreaterThan(0)
  for (const record of recovery) {
    for (const setting of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'model']) expect(record.params).not.toHaveProperty(setting)
    expect(record.params!.config).not.toHaveProperty('model_reasoning_effort')
  }
  assertConfiguration('codex', await f.driver.requests())
  f.host.disconnect(); await f.adapter.closed()
  await f.host.connect(); await f.host.startThreadSession!(id)
  assertConfiguration('codex', await f.driver.requests())
})

it('starts Watcher with ordinary Codex policy without the obsolete Windows read-only launch probe', async () => {
  const f = await codexFixture(undefined, false, 10_000); cleanups.push(f.cleanup)
  const id = randomUUID()
  await attach(f.host, f.root, id, f.projectId, 'codex')
  await f.script({ watcherSandbox: 'write-allowed' })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  expect((await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId, runtimeMode: 'full-access' })).accepted).toBe(true)
  await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic Watcher turn' })
  const records = await f.driver.requests()
  assertRuntimeConfiguration('codex', records, 'full-access')
  expect(records.some(record => record.method === 'command/exec')).toBe(false)
  expect((await f.host.snapshot()).connected).toBe(true)
  // Watcher's scoped tools do not change an ordinary thread's policy.
  f.host.useBrowserTools!({ call: async () => ({ content: [] }), definitions: [], mcpServer: async () => ({ name: 'sotto_browser', type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: [] }) })
  const ordinary = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: ordinary, projectId: f.projectId, title: 'Ordinary', modelId: f.modelId, runtimeMode: 'full-access' })
  await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: ordinary, messageId: randomUUID(), text: 'Synthetic ordinary turn' })
  expect((await f.driver.requests()).find(record => record.method === 'thread/start')?.params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
  const servers = (await readFile(join(f.root, 'servers.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const ordinaryServer = servers.findLast(record => record.method === 'thread/start')!.pid
  expect(servers.find(record => record.method === 'initialize' && record.pid === ordinaryServer).args).not.toContain('windows.sandbox="unelevated"')
  expect(servers.filter(record => record.pid === ordinaryServer && record.method === 'command/exec')).toEqual([])
})

it('keeps Claude callback approvals one-time even when its native request suggests remembered rules', async () => {
  const f = await claudeFixture(undefined, 10_000); cleanups.push(f.cleanup)
  const id = randomUUID()
  await attach(f.host, f.root, id, f.projectId, 'claude')
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Watcher', modelId: f.modelId, runtimeMode: 'full-access' })
  await f.host.startThreadSession!(id)
  const requestId = randomUUID()
  await f.action(id, { type: 'permission', requestId, text: 'Synthetic write', permissionSuggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] })
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
  const answer = { type: 'answer' as const, commandId: randomUUID(), threadId: id, requestId, answer: '', approved: true }
  await expect(f.host.execute({ ...answer, permissionChoice: 'always' })).rejects.toThrow('not offered')
  expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests).toHaveLength(1)
  expect((await f.host.execute({ ...answer, commandId: randomUUID(), permissionChoice: 'allow' })).accepted).toBe(true)
  await expect.poll(async () => (await f.driver.requests()).some(record => record.method === 'control_response')).toBe(true)
  const callback = (await f.driver.requests()).findLast(record => record.method === 'control_response')!
  expect((callback.params!.frame as { response: { response: unknown } }).response.response).toEqual({ behavior: 'allow', updatedInput: { command: 'npm run build', description: 'Synthetic write' } })
})

for (const provider of Object.keys(factories) as (keyof typeof factories)[]) it(`${provider} rechecks a phone connection before applying its permission mode`, async () => {
  const f = await factories[provider](); cleanups.push(f.cleanup)
  const id = randomUUID()
  await attach(f.host, f.root, id, f.projectId, provider)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Watcher', modelId: f.modelId, runtimeMode: 'approval-required' })
  await f.host.startThreadSession!(id)
  const before = (await f.driver.requests()).length
  let checks = 0
  // Claude's full-access change must restart its process; the guard runs again at that launch.
  const checksBeforeDisconnect = provider === 'claude' ? 2 : 1
  const guard = () => { if (++checks > checksBeforeDisconnect) throw new Error('Synthetic phone disconnected') }
  await expect(f.host.executeFromWatcher!({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' }, guard)).rejects.toThrow('phone disconnected')
  const traffic = (await f.driver.requests()).slice(before)
  expect(traffic.some(record => ['thread/settings/update', 'set_permission_mode', 'session/load', '_x.ai/session/close', 'session/setApprovalMode'].includes(record.method ?? ''))).toBe(false)
  expect(traffic.filter(record => ['launch', 'resume'].includes(record.method ?? '')).some(record => {
    const args = (record.params!.frame as { args: string[] }).args
    return flag(args, '--permission-mode') === 'bypassPermissions'
  })).toBe(false)
  expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.runtimeMode).toBe('approval-required')
  if (provider === 'codex') expect((f.adapter as unknown as { aliases: Record<string, { pendingSettings?: unknown }> }).aliases[id]!.pendingSettings).toBeUndefined()
})
