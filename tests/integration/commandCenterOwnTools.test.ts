// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandCenterLaunchProfiles } from '../../src/main/agents/commandCenterLaunchProfiles'
import { COMMAND_CENTER_SYSTEM_PROMPT } from '../../src/main/agents/commandCenterPrompt'
import type { AgentHost, CommandCenterProfileTools } from '../../src/main/agents/host'
import type { ScopedThreadTools } from '../../src/main/agents/threadToolServer'
import type { AgentThread } from '../../src/shared/agents'
import { emptyCommandCenterRecord } from '../../src/shared/commandCenter'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { interruptCommandCenterLiveTurn, observeCommandCenterLivePermissionAnswers } from '../fixtures/commandCenterLiveInterrupt'
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
async function attach(host: AgentHost, root: string, threadId: string, projectId: string, provider: 'codex' | 'claude' | 'grok') {
  const record = emptyCommandCenterRecord(), hostId = randomUUID()
  record.current = { target: { hostId, threadId }, projectId, provider, creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
  await writeFile(join(root, 'agents.json'), JSON.stringify({ commandCenter: record }))
  const source = new CommandCenterLaunchProfiles(root, () => hostId, id => id === threadId ? {
    id, hostId, projectId, providerId: provider, kind: 'command-center', title: 'Center', modelId: 'fixture-model', status: 'idle', messages: [], requests: [],
  } as AgentThread : undefined)
  const tools: CommandCenterProfileTools = { ...scoped('sotto_threads'), definitions: [{ name: 'list_threads', description: 'Synthetic', inputSchema: {} }], revoke: vi.fn() }
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
      expect(params).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only',
        developerInstructions: expect.stringContaining(COMMAND_CENTER_SYSTEM_PROMPT) })
      expect(params!.developerInstructions).toContain('Synthetic project developer instructions')
      const config = params!.config as { mcp_servers: Record<string, unknown> }
      if (process.platform === 'win32') expect(config).toHaveProperty('windows.sandbox', 'unelevated')
      else expect(config).not.toHaveProperty('windows.sandbox')
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
      expect(flag(args, '--append-system-prompt')).toBe(COMMAND_CENTER_SYSTEM_PROMPT)
      expect(flag(args, '--permission-mode')).toBe('manual')
      expect(flag(args, '--permission-prompts')).toBe('host')
      expect(args).toContain('mcp__sotto_threads__list_threads')
      expect(args).toContain('mcp__sotto_visual__fixture_tool')
      expect(args).toContain('mcp__sotto_pull_requests__fixture_tool')
      for (const denied of ['--tools', '--safe-mode', '--restricted', '--strict-mcp-config', '--setting-sources']) expect(args).not.toContain(denied)
    }
    for (const record of records.filter(record => record.method === 'command-center-launch')) {
      expect((record.params!.frame as { serverNames: string[] }).serverNames.sort()).toEqual([...names].sort())
    }
  } else {
    const launches = records.filter(record => ['session/new', 'session/load'].includes(record.method ?? ''))
    expect(launches.length).toBeGreaterThan(0)
    for (const { params } of launches) {
      expect(params!._meta).toEqual({ yoloMode: false, autoMode: false, systemPromptOverride: COMMAND_CENTER_SYSTEM_PROMPT })
      expect((params!.mcpServers as { name: string }[]).map(server => server.name).sort()).toEqual([...names].sort())
    }
    for (const record of records.filter(record => record.method === 'fixture/process')) {
      expect(record.params!.args).not.toContain('--no-subagents')
      expect(record.params!.environment).not.toHaveProperty('GROK_SUBAGENTS')
      expect(record.params!.environment).not.toHaveProperty('GROK_MEMORY')
    }
  }
}

for (const provider of Object.keys(factories) as (keyof typeof factories)[]) describe(`${provider} command-center own tools`, () => {
  it('keeps tools, asking mode and instructions through early start, send, settings, replacement and cold resume', async () => {
    const f = await factories[provider](); cleanups.push(f.cleanup)
    const id = randomUUID(), tools = await attach(f.host, f.root, id, f.projectId, provider)
    await seedModels(f.root, provider)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
    await f.host.startThreadSession!(id, { modelId: f.modelId, workingDirectory: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId })
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic first turn' })
    await f.driver.completeTurn(id, 'Synthetic complete')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
    assertConfiguration(provider, await f.driver.requests())
    for (const runtimeMode of ['auto-accept-edits', 'auto', 'full-access'] as const) {
      await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode })).rejects.toThrow('cannot be widened')
    }
    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, providerMode: 'anything' })).rejects.toThrow('cannot be widened')
    expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high', modelId: 'fixture-second-model' })).accepted).toBe(true)
    await f.clientUpdate!.install()
    await seedModels(f.root, provider, true)
    await f.host.clientUpdated!(provider)
    await f.host.startThreadSession!(id)
    await f.driver.raisePermission(id, 'Synthetic edit or writing command')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
    expect(tools.revoke).not.toHaveBeenCalled()
    let permissionAnswers = 0
    observeCommandCenterLivePermissionAnswers(f.adapter, provider, id, () => { permissionAnswers++ })
    const beforeInterrupt = (await f.driver.requests()).length
    await interruptCommandCenterLiveTurn(f.adapter, provider, id)
    f.host.disconnect(); await f.adapter.closed()
    expect(permissionAnswers).toBe(0)
    const interruptionTraffic = (await f.driver.requests()).slice(beforeInterrupt)
    expect(interruptionTraffic.some(record => {
      if (provider === 'codex') return !!record.result && 'decision' in record.result
      if ('protocol' in f) return f.protocol.permissionDecision(record) !== undefined
      return false
    })).toBe(false)
    await f.host.connect(); await f.host.startThreadSession!(id)
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic resumed turn' })
    assertConfiguration(provider, await f.driver.requests())
    expect(tools.revoke).not.toHaveBeenCalled()
    if (provider === 'codex') {
      const servers = (await readFile(join(f.root, 'servers.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      for (const server of servers.filter(server => server.method === 'initialize' && server.args.includes('sandbox_mode="read-only"'))) {
        expect(server.args).toContain('approval_policy="on-request"')
        if (process.platform === 'win32') {
          expect(server.args).toContain('windows.sandbox="unelevated"')
          expect(servers.filter(record => record.pid === server.pid && record.method === 'command/exec')).toHaveLength(2)
        } else expect(server.args).not.toContain('windows.sandbox="unelevated"')
        expect(server.args.some((arg: string) => arg.includes('enabled=false') || arg.includes('shell_tool'))).toBe(false)
      }
    }
  })
})

it('keeps Devin unavailable because its adapter cannot attach a scoped Sotto server', async () => {
  const f = await devinFixture(); cleanups.push(f.cleanup)
  f.host.useLaunchProfiles!({ profileFor: async () => ({ kind: 'command-center', server: { name: 'sotto_threads', type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: [] }, toolNames: ['list_threads'], revoke: vi.fn() }) })
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
  await f.action(id, provider === 'codex' ? { type: 'permission', text: 'Synthetic write', params: { availableDecisions: ['accept', 'acceptForSession', 'decline'] } }
    : { type: 'permission', text: 'Synthetic write', options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] })
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests[0]?.kind).toBe('permission')
  const request = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests[0]!
  const answer = { type: 'answer' as const, commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true }
  await expect(f.host.execute({ ...answer, permissionChoice: provider === 'codex' ? 'acceptForSession' : 'always' })).rejects.toThrow('cannot be widened')
  expect((await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests).toHaveLength(1)
  expect((await f.host.execute({ ...answer, commandId: randomUUID(), permissionChoice: provider === 'codex' ? 'accept' : 'yes' })).accepted).toBe(true)
})

it('pins every Codex uncertain-settings resume, including a resident recovery read', async () => {
  const f = await codexFixture(undefined, false, 10_000); cleanups.push(f.cleanup)
  const id = randomUUID()
  await attach(f.host, f.root, id, f.projectId, 'codex')
  await f.script({ developerInstructions: 'Synthetic project developer instructions' })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId })
  const native = f.adapter as unknown as { aliases: Record<string, { pendingSettings?: { modelId: string; reasoningEffort: string; runtimeMode: 'approval-required' } }> }
  native.aliases[id]!.pendingSettings = { modelId: f.modelId, reasoningEffort: 'high', runtimeMode: 'approval-required' }
  await f.host.refreshThread!(id)
  assertConfiguration('codex', await f.driver.requests())
  f.host.disconnect(); await f.adapter.closed()
  await f.host.connect(); await f.host.startThreadSession!(id)
  assertConfiguration('codex', await f.driver.requests())
})

for (const outcome of ['read-failed', 'write-allowed', 'setup-failed', 'unrelated-write-failure'] as const) it.skipIf(process.platform !== 'win32')(`stops a Windows center before sending when its sandbox probe returns ${outcome}`, async () => {
  const f = await codexFixture(undefined, false, 10_000); cleanups.push(f.cleanup)
  const id = randomUUID()
  await attach(f.host, f.root, id, f.projectId, 'codex')
  await f.script({ commandCenterSandbox: outcome })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
  await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Center', modelId: f.modelId }))
    .rejects.toThrow("Codex's read-only sandbox isn't working on this computer")
  const records = await f.driver.requests()
  expect(records.some(record => record.method === 'turn/start')).toBe(false)
  expect(records.some(record => record.method === 'thread/start')).toBe(false)
  expect((await f.host.snapshot()).connected).toBe(true)
  // The failed Watcher launch cannot change an ordinary thread's sandbox or block it.
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
