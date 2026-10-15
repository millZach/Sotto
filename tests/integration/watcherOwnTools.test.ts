// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatcherLaunchProfiles } from '../../src/main/agents/watcherLaunchProfiles'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { WATCHER_SYSTEM_PROMPT } from '../../src/main/agents/watcherPrompt'
import { watcherRequestLine, watcherRequestNote, watcherTextAsTyped } from '../../src/main/agents/watcherRequestNote'
import { questionInstructions } from '../../src/main/agents/questionInstructions'
import type { AgentHost, WatcherProfileTools } from '../../src/main/agents/host'
import type { ScopedThreadTools } from '../../src/main/agents/threadToolServer'
import type { AgentRuntimeMode, AgentThread } from '../../src/shared/agents'
import { emptyWatcherRecord } from '../../src/shared/watcher'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { interruptWatcherLiveTurn, observeWatcherLivePermissionAnswers } from '../fixtures/watcherLiveInterrupt'
import type { RecordedRpc } from '../fixtures/adapterFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const factories = { codex: () => codexFixture(undefined, false, 10_000), claude: () => claudeFixture(undefined, 10_000),
  grok: () => grokFixture(undefined, 10_000, 60_000) }
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]
const names = ['sotto_threads', 'sotto_visual', 'sotto_pull_requests']
function scoped(name: string): ScopedThreadTools {
  return { name, definitions: [{ name: 'fixture_tool', description: 'Synthetic', inputSchema: {} }],
    mcpServer: async () => ({ name, type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: [] }) }
}
async function seedModels(root: string, provider: keyof typeof factories, updated = false) {
  const ids = ['fixture-model', 'fixture-second-model']
  if (provider === 'claude') await writeFile(join(root, 'models.json'), JSON.stringify(ids.map(value => ({ value, displayName: value, supportsEffort: true, supportedEffortLevels: ['low', 'high'] }))))
  else await writeFile(join(root, 'script.json'), JSON.stringify(provider === 'codex' ? {
    ...(updated ? { version: 'codex/0.200.0' } : {}), developerInstructions: 'Synthetic project developer instructions',
    models: ids.map(model => ({ id: model, model, displayName: model, isDefault: model === ids[0], defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] })),
  } : { ...(updated ? { cliVersion: '1.0.41' } : {}), catalog: { currentModelId: ids[0], availableModels: ids.map(modelId => ({ modelId, name: modelId, _meta: { reasoningEffort: 'high', supportsReasoningEffort: true, reasoningEfforts: [{ id: 'high' }] } })) } }))
}
async function attach(host: AgentHost, root: string, threadId: string, projectId: string, provider: 'codex' | 'claude' | 'grok', hostId: string = randomUUID()) {
  const record = emptyWatcherRecord()
  record.current = { target: { hostId, threadId }, projectId, provider, creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
  await writeFile(join(root, 'agents.json'), JSON.stringify({ watcher: record }))
  const source = new WatcherLaunchProfiles(root, () => hostId, id => id === threadId ? {
    id, hostId, projectId, providerId: provider, kind: 'watcher', title: 'Center', modelId: 'fixture-model', status: 'idle', messages: [], requests: [],
  } as AgentThread : undefined, true)
  const tools: WatcherProfileTools = { ...scoped('sotto_threads'), definitions: [{ name: 'list_threads', description: 'Synthetic', inputSchema: {} }], revoke: vi.fn() }
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
      expect(args).toContain('mcp__sotto_visual__fixture_tool')
      expect(args).toContain('mcp__sotto_pull_requests__fixture_tool')
      for (const denied of ['--tools', '--safe-mode', '--restricted', '--strict-mcp-config', '--setting-sources']) expect(args).not.toContain(denied)
    }
    for (const record of records.filter(record => record.method === 'watcher-launch')) {
      expect((record.params!.frame as { serverNames: string[] }).serverNames.sort()).toEqual([...names].sort())
    }
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
  } else {
    const settings = records.filter(record => ['session/new', 'session/load'].includes(record.method ?? ''))
    expect(settings.length).toBeGreaterThan(0)
    for (const record of settings) expect(record.params!._meta).toEqual({ yoloMode: mode === 'full-access', autoMode: mode === 'auto', systemPromptOverride: WATCHER_SYSTEM_PROMPT })
  }
}

for (const provider of Object.keys(factories) as (keyof typeof factories)[]) describe(`${provider} watcher own tools`, () => {
  it('discovers and sends selected native skills while retaining the launch profile', async () => {
    const f = await factories[provider](); cleanups.push(f.cleanup)
    const id = randomUUID(), tools = await attach(f.host, f.root, id, f.projectId, provider)
    const path = join(f.root, 'SKILL.md')
    if (provider === 'codex') await writeFile(join(f.root, 'script.json'), JSON.stringify({
      skills: [{ name: 'check', description: 'Synthetic', path, scope: 'repo', enabled: true }],
    }))
    else await writeFile(join(f.root, 'skills.json'), JSON.stringify(provider === 'claude'
      ? [{ name: 'check', description: 'Synthetic (project)' }]
      : { skills: [{ name: 'check', description: 'Synthetic', source: { path, type: 'project' }, userInvocable: true }] }))
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Watcher', modelId: f.modelId })
    const catalog = await f.host.listThreadSkills!(id, true)
    expect(catalog).toMatchObject({ threadId: id, providerId: provider, status: 'ready' })
    const skill = catalog.skills[0]!
    expect(skill.name).toBe('check')
    expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(),
      text: '$check verify', skills: [{ name: skill.name, path: skill.path }] })).accepted).toBe(true)
    const records = await f.driver.requests()
    const prompt = records.find(record => record.method === (provider === 'codex' ? 'turn/start' : provider === 'claude' ? 'user' : 'session/prompt'))!
    if (provider === 'codex') expect(prompt.params!.input).toContainEqual({ type: 'skill', name: 'check', path })
    else expect(JSON.stringify(prompt.params)).toContain('/check verify')
    expect(tools.revoke).not.toHaveBeenCalled()
    await writeFile(join(f.root, 'agents.json'), '{')
    await expect(f.host.listThreadSkills!(id, true)).rejects.toThrow('saved identity')
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
    const modes: AgentRuntimeMode[] = provider === 'grok' ? ['approval-required', 'auto', 'full-access'] : ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
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
async function watcherBesideOrdinary(f: { host: AgentHost; root: string; projectId: string; modelId: string }, provider: 'codex' | 'claude' | 'grok') {
  const id = randomUUID(), ordinary = randomUUID()
  await attach(f.host, f.root, id, f.projectId, provider)
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
  for (const tool_name of ['sotto_threads__list_threads', 'sotto_visual__fixture_tool', 'sotto_pull_requests__fixture_tool']) {
    const before = (await f.driver.requests()).filter(record => record.result).length
    await f.action(id, { type: 'permission', text: 'Synthetic use_tool', rawInput: { tool_name } })
    await expect.poll(async () => (await f.driver.requests()).filter(record => record.result).length).toBeGreaterThan(before)
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests).toEqual([])
  }
  await f.action(id, { type: 'permission', text: 'Synthetic use_tool', rawInput: { tool_name: 'sotto_threads__list_threads_extra' } })
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
  expect(tools.revoke).not.toHaveBeenCalled()
})

for (const provider of ['codex', 'grok'] as const) it(`${provider} refuses remembered permission grants while allowing a single native approval`, async () => {
  const f = await factories[provider](); cleanups.push(f.cleanup)
  const id = randomUUID()
  await attach(f.host, f.root, id, f.projectId, provider)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId })
  await f.action(id, provider === 'codex' ? { type: 'permission', text: 'Synthetic write', params: { availableDecisions: ['accept', 'acceptForSession', { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'synthetic.invalid' } } }, 'decline'] } }
    : { type: 'permission', text: 'Synthetic write', options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] })
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
  const request = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests[0]!
  const answer = { type: 'answer' as const, commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true }
  for (const permissionChoice of provider === 'codex' ? ['acceptForSession', 'native-decision:2'] : ['always']) {
    await expect(f.host.execute({ ...answer, commandId: randomUUID(), permissionChoice })).rejects.toThrow('cannot remember')
  }
  expect((await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests).toHaveLength(1)
  expect((await f.host.execute({ ...answer, commandId: randomUUID(), permissionChoice: provider === 'codex' ? 'accept' : 'yes' })).accepted).toBe(true)
})

for (const provider of ['codex', 'grok'] as const) it(`${provider} keeps the workspace session and card after refusing a remembered grant`, async () => {
  const f = await factories[provider](); cleanups.push(f.cleanup)
  const native = new ConfiguredProviderHost({ directory: f.root, provider: () => provider, enabledProviders: () => [provider],
    threadProvider: () => provider, hosts: { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost(), [provider]: f.host } })
  const workspace = new WorkspaceHost(native, f.root, () => true, undefined, true)
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
  await f.action(id, provider === 'codex' ? { type: 'permission', text: 'Synthetic write', params: { availableDecisions: ['accept', 'acceptForSession', 'decline'] } }
    : { type: 'permission', text: 'Synthetic write', options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] })
  await expect.poll(async () => (await workspace.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
  const request = (await workspace.snapshot()).threads.find(thread => thread.id === id)!.requests[0]!
  await expect(workspace.configureThreadWorkingCopy(id, { workingCopy: 'independent' })).rejects.toThrow('working folder cannot be changed')
  const answer = { type: 'answer' as const, commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true }
  await expect(workspace.execute({ ...answer, permissionChoice: provider === 'codex' ? 'acceptForSession' : 'always' })).rejects.toThrow('Allow this request once')
  expect(tools.revoke).not.toHaveBeenCalled()
  expect((await workspace.snapshot()).threads.find(thread => thread.id === id)!.requests).toEqual([request])
  expect((await workspace.execute({ ...answer, commandId: randomUUID(), permissionChoice: provider === 'codex' ? 'accept' : 'yes' })).accepted).toBe(true)
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
  expect(traffic.some(record => ['thread/settings/update', 'set_permission_mode', 'session/load', '_x.ai/session/close'].includes(record.method ?? ''))).toBe(false)
  expect(traffic.filter(record => ['launch', 'resume'].includes(record.method ?? '')).some(record => {
    const args = (record.params!.frame as { args: string[] }).args
    return flag(args, '--permission-mode') === 'bypassPermissions'
  })).toBe(false)
  expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.runtimeMode).toBe('approval-required')
  if (provider === 'codex') expect((f.adapter as unknown as { aliases: Record<string, { pendingSettings?: unknown }> }).aliases[id]!.pendingSettings).toBeUndefined()
})
