// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import { devinFixture } from '../fixtures/devinFixture'
import type { CommandCenterLaunchProfile } from '../../src/main/agents/host'
import { assertCodexCommandCenterPreflight, commandCenterCodexArguments, commandCenterCodexConfig } from '../../src/main/agents/commandCenterCodexProfile'
import { COMMAND_CENTER_PERMISSION_FAILURE } from '../../src/main/agents/commandCenterProfile'
import type { CodexProcess, RpcFrame } from '../../src/main/agents/codexProcess'
import type { DevinRpc } from '../../src/main/agents/devinRpc'
import type { CommandCenterAdmission } from '../../src/main/agents/commandCenterAdmission'
import { CODEX_COMMAND_CENTER_REPORT_FAILURE } from '../../src/main/agents/commandCenterCodexProfile'

const profile = (): CommandCenterLaunchProfile => ({ kind: 'command-center', server: { name: 'sotto_threads', type: 'http',
  url: 'http://127.0.0.1:12345/mcp', headers: [{ name: 'Authorization', value: 'Bearer fixture-only' }] }, toolNames: ['list_threads', 'read_thread'], revoke: vi.fn() })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

const admitted: readonly CommandCenterAdmission[] = [{ provider: 'codex', platform: process.platform as 'win32' | 'darwin',
  version: '0.162.0', verificationNote: 'fixture-only evidence' }]
function startup(offered: CommandCenterLaunchProfile, version = 'codex/0.162.0') {
  const effectiveConfig: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(commandCenterCodexConfig(offered))) {
    const parts = key.split('.'); let parent = effectiveConfig
    for (const part of parts.slice(0, -1)) { parent[part] ??= {}; parent = parent[part] as Record<string, unknown> }
    parent[parts.at(-1)!] = value
  }
  return { version, effectiveConfig, mcpServers: [{ name: 'sotto_threads', tools: Object.fromEntries(offered.toolNames.map(name => [name, { name }])) }] }
}

describe('Codex admitted combinations and process reports', () => {
  it.each(['disabled', 'late-server', 'still-enabled', 'still-running', 'cached-tools', 'supplied-helper'] as const)('checks inherited servers when they are %s', async scenario => {
    const offered = profile()
    const f = await codexFixture(undefined, false, 5000, { commandCenterAdmissions: admitted }); cleanups.push(f.cleanup)
    const script = startup(offered)
    const names = ['context7', 'node_repl', 'quote"and.dot']
    const config = script.effectiveConfig
    for (const name of names) (config.mcp_servers as Record<string, unknown>)[name] = { command: 'fixture', enabled: true }
    if (scenario === 'supplied-helper') ((config.mcp_servers as Record<string, unknown>).sotto_threads as Record<string, unknown>).http_headers_helper = 'fixture-command'
    config.plugins = { 'fixture@plugin': { enabled: true } }
    config.apps = { _default: { enabled: false }, 'fixture.app': { enabled: true } }
    ;(config.skills as Record<string, unknown>).config = [{ name: 'fixture', enabled: true }]
    const inheritedStatuses = names.map(name => ({ name, tools: scenario === 'cached-tools' ? { fixture: { name: 'fixture' } } : {}, runtimeStatus: scenario === 'cached-tools' ? null : 'connected' }))
    await f.script({ ...script, mcpServers: [...script.mcpServers, ...inheritedStatuses], honorInheritedDisables: scenario !== 'still-enabled',
      addServerAfterDiscovery: scenario === 'late-server', keepInheritedRunning: scenario === 'still-running' || scenario === 'cached-tools' })
    await f.host.connect(); f.host.useLaunchProfiles!({ profileFor: async () => offered })
    const start = f.host.startThreadSession!('master', { modelId: f.modelId, workingDirectory: f.root })
    if (scenario === 'disabled') {
      await start
      expect(offered.revoke).not.toHaveBeenCalled()
      const records = (await f.servers()).filter(record => record.method === 'initialize') as { args?: string[] }[]
      const finalArgs = records.at(-1)!.args!
      const servers = finalArgs.find(arg => arg.startsWith('mcp_servers='))!
      for (const name of names) expect(servers).toContain(`${JSON.stringify(name)} = { "enabled" = false }`)
      expect((await f.driver.requests()).filter(request => request.method === 'config/read')).toHaveLength(2)
    } else {
      await expect(start).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
      expect(offered.revoke).toHaveBeenCalled()
      const requests = await f.driver.requests()
      if (scenario === 'supplied-helper' || scenario === 'late-server' || scenario === 'still-enabled') expect(requests.some(request => request.method === 'mcpServerStatus/list')).toBe(false)
      expect(requests.some(request => ['thread/start', 'turn/start'].includes(request.method!))).toBe(false)
    }
  })

  it('rechecks the immutable command-center process without runtime MCP reload after a config change', async () => {
    const offered = profile()
    const f = await codexFixture(undefined, false, 5000, { commandCenterAdmissions: admitted }); cleanups.push(f.cleanup)
    await f.script(startup(offered)); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    f.host.useLaunchProfiles!({ profileFor: async () => offered })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'master', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
    await mkdir(join(f.root, 'home'), { recursive: true })
    await writeFile(join(f.root, 'home', 'config.toml'), '# changed fixture configuration\n')
    const before = (await f.driver.requests()).length
    const sent = await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: 'master', messageId: randomUUID(), text: 'fixture prompt' })
    expect(sent.accepted).toBe(true)
    const methods = (await f.driver.requests()).slice(before).map(request => request.method)
    expect(methods).not.toContain('config/mcpServer/reload')
    expect(methods.indexOf('config/read')).toBeGreaterThanOrEqual(0)
    expect(methods.indexOf('config/read')).toBeLessThan(methods.indexOf('turn/start'))
    expect(offered.revoke).not.toHaveBeenCalled()
  })

  it('refuses an ordinary launch already pending when an admitted profile appears', async () => {
    const offered = profile()
    const f = await codexFixture(undefined, false, 5000, { commandCenterAdmissions: admitted }); cleanups.push(f.cleanup)
    await f.script(startup(offered)); await f.host.connect()
    await f.script({ ...startup(offered), holdReply: 'initialize' })
    const before = (await f.driver.requests()).length
    const draft = { modelId: f.modelId, workingDirectory: f.root }
    const ordinaryStart = f.host.startThreadSession!('master', draft)
    await vi.waitFor(async () => expect((await f.driver.requests()).slice(before).some(request => request.method === 'initialize')).toBe(true))
    f.host.useLaunchProfiles!({ profileFor: async () => offered })
    const profiledStart = f.host.startThreadSession!('master', draft)
    const refused = expect(profiledStart).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: expect.stringContaining('Nothing was sent') })
    await new Promise<void>(resolve => setImmediate(resolve))
    await writeFile(join(f.root, 'control.json'), JSON.stringify({ id: randomUUID(), type: 'release-reply', method: 'initialize' }))
    await ordinaryStart; await refused
    expect(offered.revoke).toHaveBeenCalled()
    expect(f.adapter.resumedThreads()).toEqual([])
    expect((await f.driver.requests()).some(request => ['thread/start', 'turn/start'].includes(request.method!))).toBe(false)
    expect((await f.host.snapshot()).threads.flatMap(thread => thread.requests)).toEqual([])
  })

  it.each(['create', 'resume'] as const)('refuses a widened %s policy even when the process configuration report matches', async path => {
    const offered = profile()
    const f = await codexFixture(undefined, false, 5000, { commandCenterAdmissions: admitted }); cleanups.push(f.cleanup)
    await f.script(startup(offered)); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    f.host.useLaunchProfiles!({ profileFor: async () => offered })
    const create = () => f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'master', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
    if (path === 'resume') { await create(); f.host.disconnect(); await f.adapter.closed(); await f.host.connect() }
    await f.script({ ...startup(offered), [path === 'create' ? 'threadStartSettings' : 'threadResumeSettings']: { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } } })
    await expect(path === 'create' ? create() : f.host.startThreadSession!('master')).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    expect(offered.revoke).toHaveBeenCalledWith(CODEX_COMMAND_CENTER_REPORT_FAILURE)
    expect((await f.driver.requests()).some(request => request.method === 'turn/start')).toBe(false)
    expect(f.adapter.resumedThreads()).toEqual([])
    expect((await f.host.snapshot()).threads.flatMap(thread => thread.requests)).toEqual([])
  })

  it.each(['0.162.0', '0.163.0'] as const)('admits %s only after the real fake process reports its settings and tools', async version => {
    const offered = profile()
    const f = await codexFixture(undefined, false, 5000, { commandCenterAdmissions: admitted }); cleanups.push(f.cleanup)
    await f.script(startup(offered, `codex/${version}`)); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    f.host.useLaunchProfiles!({ profileFor: async () => offered })
    await f.host.startThreadSession!('master', { modelId: f.modelId, workingDirectory: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'master', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: 'master', messageId: randomUUID(), text: 'fixture prompt' })
    const methods = (await f.driver.requests()).map(request => request.method)
    expect(methods.indexOf('config/read')).toBeLessThan(methods.indexOf('turn/start'))
    expect(methods.indexOf('mcpServerStatus/list')).toBeLessThan(methods.indexOf('turn/start'))
    expect((await f.host.snapshot()).threads.find(thread => thread.id === 'master')!.requests).toEqual([])
    expect(offered.revoke).not.toHaveBeenCalled()
    await f.driver.completeTurn('master', 'fixture reply')
    await vi.waitFor(async () => expect((await f.host.snapshot()).threads.find(thread => thread.id === 'master')!.status).toBe('idle'))
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: 'master', reasoningEffort: 'high' })
    f.host.disconnect(); await f.adapter.closed(); await f.host.connect(); await f.host.startThreadSession!('master')
    expect((await f.driver.requests()).filter(request => request.method === 'config/read').length).toBeGreaterThanOrEqual(3)
    expect(offered.revoke).not.toHaveBeenCalled()
  })

  it('refuses an older version and the actual process version when the catalog is stale', async () => {
    const offered = profile()
    const f = await codexFixture(undefined, false, 5000, { commandCenterAdmissions: admitted }); cleanups.push(f.cleanup)
    await f.script(startup(offered)); await f.host.connect()
    f.host.useLaunchProfiles!({ profileFor: async () => offered })
    await f.script(startup(offered, 'codex/0.161.0'))
    await expect(f.host.startThreadSession!('master', { modelId: f.modelId, workingDirectory: f.root })).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    expect(offered.revoke).toHaveBeenCalled()
    expect((await f.driver.requests()).some(request => request.method === 'turn/start')).toBe(false)
    expect(f.adapter.resumedThreads()).toEqual([])
  })

  it.each(['shell', 'sandbox', 'approval', 'extra-server', 'missing-tool', 'renamed-tool', 'missing-report', 'unreadable-report', 'repeated-page', 'endless-pages'] as const)(
    'stops and revokes a %s report before turn work or a request card', async wrong => {
      const offered = profile()
      const f = await codexFixture(undefined, false, 5000, { commandCenterAdmissions: admitted }); cleanups.push(f.cleanup)
      const script: Record<string, unknown> = startup(offered)
      const config = script.effectiveConfig as Record<string, unknown>
      if (wrong === 'shell') (config.features as Record<string, unknown>).shell_tool = true
      if (wrong === 'sandbox') config.sandbox_mode = 'workspace-write'
      if (wrong === 'approval') config.approval_policy = 'on-request'
      if (wrong === 'extra-server') (script.mcpServers as unknown[]).push({ name: 'extra', tools: {} })
      if (wrong === 'missing-tool') script.mcpServers = [{ name: 'sotto_threads', tools: { list_threads: { name: 'list_threads' } } }]
      if (wrong === 'renamed-tool') script.mcpServers = [{ name: 'sotto_threads', tools: { list_threads: { name: 'list_threads' }, changed: { name: 'changed' } } }]
      if (wrong === 'missing-report') script.reject = 'config/read'
      if (wrong === 'unreadable-report') script.configReadMalformed = true
      if (wrong === 'repeated-page') script.mcpPages = { first: { data: [], nextCursor: 'again' }, again: { data: [], nextCursor: 'again' } }
      if (wrong === 'endless-pages') script.mcpPages = Object.fromEntries(Array.from({ length: 102 }, (_, index) => [index === 0 ? 'first' : `page-${index}`, { data: [], nextCursor: `page-${index + 1}` }]))
      await f.script(script); await f.host.connect()
      f.host.useLaunchProfiles!({ profileFor: async () => offered })
      await expect(f.host.startThreadSession!('master', { modelId: f.modelId, workingDirectory: f.root })).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: CODEX_COMMAND_CENTER_REPORT_FAILURE })
      expect(offered.revoke).toHaveBeenCalledWith(CODEX_COMMAND_CENTER_REPORT_FAILURE)
      expect((await f.driver.requests()).some(request => ['thread/start', 'turn/start'].includes(request.method!))).toBe(false)
      expect((await f.host.snapshot()).threads.flatMap(thread => thread.requests)).toEqual([])
      expect(f.adapter.resumedThreads()).toEqual([])
    })

  it.each([true, false])('checks reports before another prompt when config reload support is %s', async reloadSupported => {
    const offered = profile()
    const f = await codexFixture(undefined, false, 5000, { commandCenterAdmissions: admitted }); cleanups.push(f.cleanup)
    await f.script(startup(offered)); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    f.host.useLaunchProfiles!({ profileFor: async () => offered })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'master', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
    const internal = f.adapter as unknown as { runtimes: Map<string, { reloadSupported: boolean }> }
    internal.runtimes.get('master')!.reloadSupported = reloadSupported
    await f.script({ ...startup(offered), mcpServers: [{ name: 'extra', tools: {} }] })
    await expect(f.host.execute({ type: 'send', commandId: randomUUID(), threadId: 'master', messageId: randomUUID(), text: 'fixture prompt' })).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    expect(offered.revoke).toHaveBeenCalled()
    expect((await f.driver.requests()).some(request => request.method === 'turn/start')).toBe(false)
    expect((await f.host.snapshot()).threads.find(thread => thread.id === 'master')!.requests).toEqual([])
  })
})

describe('Codex command-center profile', () => {
  it('does not publish a stale observation error into an ordinary replacement thread', async () => {
    const f = await codexFixture(); cleanups.push(f.cleanup)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'worker', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
    let resolveLookup!: (value: undefined) => void
    let lookupEntered!: () => void
    let first = true
    const entered = new Promise<void>(resolve => { lookupEntered = resolve })
    const lookup = new Promise<undefined>(resolve => { resolveLookup = resolve })
    f.host.useLaunchProfiles!({ profileFor: () => { if (!first) return Promise.resolve(undefined); first = false; lookupEntered(); return lookup } })
    f.host.observeThreads!(['worker'])
    await entered
    f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
    const before = (await f.host.snapshot()).threads.find(thread => thread.id === 'worker')!.status
    resolveLookup(undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect((await f.host.snapshot()).threads.find(thread => thread.id === 'worker')!.status).toBe(before)
    expect(before).toBe('idle')
  })

  it('does not start stale ordinary work when its profile lookup crosses reconnect', async () => {
    const f = await codexFixture(); cleanups.push(f.cleanup)
    await f.host.connect()
    let resolveLookup!: (value: undefined) => void
    let lookupEntered!: () => void
    const entered = new Promise<void>(resolve => { lookupEntered = resolve })
    const lookup = new Promise<undefined>(resolve => { resolveLookup = resolve })
    f.host.useLaunchProfiles!({ profileFor: () => { lookupEntered(); return lookup } })
    const starting = f.host.startThreadSession!('draft', { modelId: f.modelId, workingDirectory: f.root })
    const cancelled = expect(starting).rejects.toThrow('connection changed')
    await entered
    f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
    const before = await f.servers()
    resolveLookup(undefined)
    await cancelled
    expect(await f.servers()).toEqual(before)
  })

  it.each(['ordinary', 'failed'] as const)('ignores a closed process’s %s permission lookup after reconnect', async outcome => {
    const f = await codexFixture(); cleanups.push(f.cleanup)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'worker', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
    const frames = f.adapter as unknown as { runtimes: Map<string, { server: CodexProcess; commandCenter: boolean }>; frame(server: CodexProcess, frame: RpcFrame): Promise<void> }
    // Model an already-profiled process only at this defensive callback seam.
    frames.runtimes.get('worker')!.commandCenter = true
    const original = frames.runtimes.get('worker')!.server
    let resolveLookup!: (value: undefined) => void
    let rejectLookup!: (reason: Error) => void
    let lookupEntered!: () => void
    let first = true
    const entered = new Promise<void>(resolve => { lookupEntered = resolve })
    const lookup = new Promise<undefined>((resolve, reject) => { resolveLookup = resolve; rejectLookup = reject })
    f.host.useLaunchProfiles!({ profileFor: () => { if (!first) return Promise.resolve(undefined); first = false; lookupEntered(); return lookup } })
    const handling = frames.frame(original, { id: 991, method: 'item/commandExecution/requestApproval', params: {
      threadId: await f.realId('worker'), turnId: 'fixture-turn', itemId: 'fixture-item', command: 'fixture-command', cwd: f.root,
    } })
    await entered
    f.host.disconnect(); await f.adapter.closed(); await f.host.connect(); await f.host.startThreadSession!('worker')
    const replacement = frames.runtimes.get('worker')!.server
    if (outcome === 'failed') rejectLookup(new Error('Synthetic lookup failure'))
    else resolveLookup(undefined)
    await handling
    expect((await f.host.snapshot()).threads.find(thread => thread.id === 'worker')!.requests).toEqual([])
    expect(frames.runtimes.get('worker')!.server).toBe(replacement)
    expect(replacement.alive).toBe(true)
  })

  it('builds exact MCP preallowance and strict supported configuration without inherited servers', () => {
    const config = commandCenterCodexConfig(profile())
    expect(config).toMatchObject({ sandbox_mode: 'read-only', approval_policy: 'never', approvals_reviewer: 'user',
      'features.shell_tool': false, 'features.multi_agent': false, 'features.apps': false, 'features.hooks': false,
      'features.view_image': false, web_search: 'disabled' })
    expect(config).not.toHaveProperty('tools.view_image')
    expect(config).not.toHaveProperty('orchestrator.skills.enabled')
    expect(config.mcp_servers).toEqual({ sotto_threads: { url: 'http://127.0.0.1:12345/mcp', enabled: true, omit_tools_from: ['deferred', 'code_mode'],
      http_headers: { Authorization: 'Bearer fixture-only' }, enabled_tools: ['list_threads', 'read_thread'],
      default_tools_approval_mode: 'prompt', tools: { list_threads: { approval_mode: 'approve' }, read_thread: { approval_mode: 'approve' } } } })
    const args = commandCenterCodexArguments(profile())
    expect(args.slice(0, 3)).toEqual(['app-server', '--stdio', '--strict-config'])
    expect(args.find(arg => arg.startsWith('mcp_servers='))).toContain('"sotto_threads" = {')
  })
  it('refuses known and unknown versions/models/platforms without a complete compatibility proof', () => {
    for (const [version, model, platform] of [['0.162.0', 'gpt-6.1-sol', 'win32'], ['0.162.0', 'gpt-6.1-sol', 'darwin'],
      ['0.162.0', 'gpt-6.1-sol', 'linux'], ['0.163.0', 'gpt-6.1-sol', 'win32'], ['0.162.0', '', 'win32']] as const) {
      expect(() => assertCodexCommandCenterPreflight(profile(), version, model, platform, [])).toThrow(expect.objectContaining({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' }))
    }
  })
  it.each(['create', 'early-start'] as const)('refuses %s before any thread process or provider session starts', async path => {
    const f = await codexFixture(undefined, false, 2000, { commandCenterAdmissions: [] }); cleanups.push(f.cleanup)
    await f.script({ version: 'codex/0.162.0' }); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    f.host.useLaunchProfiles!({ profileFor: async () => profile() })
    const before = await f.servers()
    const action = path === 'early-start' ? f.host.startThreadSession!('master', { modelId: f.modelId, workingDirectory: f.root })
      : f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'master', projectId: f.projectId, title: 'Fixture', modelId: f.modelId, runtimeMode: 'full-access' })
    await expect(action).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: expect.stringContaining('Nothing was sent') })
    expect(await f.servers()).toEqual(before)
    expect((await f.driver.requests()).some(request => request.method === 'thread/start')).toBe(false)
  })
  it.each(['send', 'steer', 'configure', 'resume', 'cold-load'] as const)('rechecks %s and never uses an ordinary process as a master', async path => {
    let f = await codexFixture(); cleanups.push(async () => f.cleanup())
    await f.script({ version: 'codex/0.162.0' }); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'master', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
    if (path === 'cold-load') { f.host.disconnect(); await f.adapter.closed(); f = await codexFixture(f.root); await f.host.connect() }
    const before = (await f.driver.requests()).length
    f.host.useLaunchProfiles!({ profileFor: async () => profile() })
    const common = { commandId: randomUUID(), threadId: 'master' }
    const action = path === 'resume' || path === 'cold-load' ? f.host.startThreadSession!('master')
      : path === 'configure' ? f.host.execute({ type: 'configure-thread', ...common, reasoningEffort: 'high', runtimeMode: 'full-access' })
        : f.host.execute({ type: path, ...common, messageId: randomUUID(), text: 'synthetic fixture prompt' })
    await expect(action).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    expect((await f.driver.requests()).slice(before).some(request => ['turn/start', 'turn/steer', 'thread/settings/update', 'thread/resume'].includes(request.method!))).toBe(false)
    expect(f.adapter.resumedThreads()).not.toContain('master')
  })
  it('stops and revokes an unexpected permission without presenting or approving it', async () => {
    const f = await codexFixture(); cleanups.push(f.cleanup)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'master', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
    const offered = profile(); f.host.useLaunchProfiles!({ profileFor: async () => offered })
    const native = f.adapter as unknown as { runtimes: Map<string, { commandCenter: boolean }> }
    native.runtimes.get('master')!.commandCenter = true
    await f.driver.raisePermission('master', 'synthetic outside permission')
    await vi.waitFor(() => expect(offered.revoke).toHaveBeenCalledWith(COMMAND_CENTER_PERMISSION_FAILURE))
    const thread = (await f.host.snapshot()).threads.find(thread => thread.id === 'master')!
    expect(thread.requests).toEqual([]); expect(thread.requestNotice).toBe(COMMAND_CENTER_PERMISSION_FAILURE)
    expect(f.adapter.resumedThreads()).not.toContain('master')
    expect((await f.driver.requests()).some(request => request.result?.decision === 'accept')).toBe(false)
  })
})

it('refuses Devin as a command-center host before creation and early start', async () => {
  const f = await devinFixture(); cleanups.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
  const before = (await f.driver.requests()).length
  const offered = profile(); f.host.useLaunchProfiles({ profileFor: async () => offered })
  await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'master', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: expect.stringContaining('Devin cannot host') })
  await expect(f.host.startThreadSession('master')).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
  expect(offered.revoke).toHaveBeenCalled()
  expect((await f.driver.requests()).slice(before).some(request => request.method === 'session/new')).toBe(false)
})

it('does not reopen an ordinary Devin session after disconnect while its profile lookup waits', async () => {
  const f = await devinFixture(); cleanups.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'worker', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
  const before = (await f.driver.requests()).length
  let resolveLookup!: (value: undefined) => void
  let lookupEntered!: () => void
  const entered = new Promise<void>(resolve => { lookupEntered = resolve })
  const lookup = new Promise<undefined>(resolve => { resolveLookup = resolve })
  f.host.useLaunchProfiles({ profileFor: () => { lookupEntered(); return lookup } })
  const reading = f.host.refreshThread('worker')
  const cancelled = expect(reading).rejects.toThrow('connection changed')
  await entered
  f.host.disconnect()
  resolveLookup(undefined)
  await cancelled
  expect((await f.driver.requests()).slice(before).some(request => ['initialize', 'session/new', 'session/load'].includes(request.method ?? ''))).toBe(false)
})

it.each(['profile', 'failed'] as const)('drains Devin’s real native request queue after a %s lifecycle refusal', async outcome => {
  const f = await devinFixture(); cleanups.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'worker', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
  const offered = profile()
  const resolver = vi.fn(async () => { if (outcome === 'failed') throw new Error('Synthetic lookup failure'); return offered })
  f.host.useLaunchProfiles({ profileFor: resolver })
  await f.driver.raisePermission('worker', 'Synthetic outside permission')
  await vi.waitFor(async () => expect((await f.host.snapshot()).threads.find(thread => thread.id === 'worker')!.requests).toHaveLength(1))
  expect(resolver).not.toHaveBeenCalled()
  await expect(f.host.startThreadSession('worker')).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
  await vi.waitFor(async () => expect(await f.sessions.stopped('worker')).toBe(true))
  await f.host.closed()
  expect(await f.sessions.stopped('worker')).toBe(true)
  const thread = (await f.host.snapshot()).threads.find(thread => thread.id === 'worker')!
  expect(thread.requests).toEqual([])
  expect(thread.status).toBe('error')
  expect(thread.requestNotice).toBeTruthy()
  if (outcome === 'profile') expect(offered.revoke).toHaveBeenCalled()
})

it.each(['profile', 'failed'] as const)('keeps a replacement Devin connection safe when the ordinary %s permission path skips profile resolution', async outcome => {
  const f = await devinFixture(); cleanups.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'worker', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
  const frames = f.host as unknown as { connections: Map<string, { rpc: DevinRpc }> }
  const original = frames.connections.get('worker')!
  const offered = profile()
  const resolver = vi.fn(async () => { if (outcome === 'failed') throw new Error('Synthetic lookup failure'); return offered })
  f.host.useLaunchProfiles({ profileFor: resolver })
  await f.driver.raisePermission('worker', 'Synthetic ordinary permission')
  await vi.waitFor(async () => expect((await f.host.snapshot()).threads.find(thread => thread.id === 'worker')!.requests).toHaveLength(1))
  expect(resolver).not.toHaveBeenCalled()
  f.host.useLaunchProfiles({ profileFor: async () => undefined })
  original.rpc.close(); await original.rpc.closed
  await f.host.startThreadSession('worker')
  const replacement = frames.connections.get('worker')!
  expect(frames.connections.get('worker')).toBe(replacement)
  expect(await f.sessions.stopped('worker')).toBe(false)
  expect((await f.host.snapshot()).threads.find(thread => thread.id === 'worker')!.requests).toEqual([])
  expect(offered.revoke).not.toHaveBeenCalled()
})
