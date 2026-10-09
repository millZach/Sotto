// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import { devinFixture } from '../fixtures/devinFixture'
import type { CommandCenterLaunchProfile } from '../../src/main/agents/host'
import { assertCodexCommandCenterPreflight, commandCenterCodexArguments, commandCenterCodexConfig } from '../../src/main/agents/commandCenterCodexProfile'
import { COMMAND_CENTER_PERMISSION_FAILURE } from '../../src/main/agents/commandCenterProfile'
import type { CodexProcess, RpcFrame } from '../../src/main/agents/codexProcess'
import type { DevinRpc, DevinFrame } from '../../src/main/agents/devinRpc'

const profile = (): CommandCenterLaunchProfile => ({ kind: 'command-center', server: { name: 'sotto_threads', type: 'http',
  url: 'http://127.0.0.1:12345/mcp', headers: [{ name: 'Authorization', value: 'Bearer fixture-only' }] }, toolNames: ['list_threads', 'read_thread'], revoke: vi.fn() })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

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
    const frames = f.adapter as unknown as { runtimes: Map<string, { server: CodexProcess }>; frame(server: CodexProcess, frame: RpcFrame): Promise<void> }
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
    expect(config.mcp_servers).toEqual({ sotto_threads: { url: 'http://127.0.0.1:12345/mcp',
      http_headers: { Authorization: 'Bearer fixture-only' }, enabled_tools: ['list_threads', 'read_thread'],
      default_tools_approval_mode: 'prompt', tools: { list_threads: { approval_mode: 'approve' }, read_thread: { approval_mode: 'approve' } } } })
    const args = commandCenterCodexArguments(profile())
    expect(args.slice(0, 3)).toEqual(['app-server', '--stdio', '--strict-config'])
    expect(args.find(arg => arg.startsWith('mcp_servers='))).toContain('"sotto_threads" = {')
  })
  it('refuses known and unknown versions/models/platforms without a complete compatibility proof', () => {
    for (const [version, model, platform] of [['0.162.0', 'gpt-6.1-sol', 'win32'], ['0.162.0', 'gpt-6.1-sol', 'darwin'],
      ['0.162.0', 'gpt-6.1-sol', 'linux'], ['0.163.0', 'gpt-6.1-sol', 'win32'], ['0.162.0', '', 'win32']] as const) {
      expect(() => assertCodexCommandCenterPreflight(profile(), version, model, platform)).toThrow(expect.objectContaining({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' }))
    }
  })
  it.each(['create', 'early-start'] as const)('refuses %s before any thread process or provider session starts', async path => {
    const f = await codexFixture(); cleanups.push(f.cleanup)
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

it.each(['profile', 'failed'] as const)('drains Devin’s real native request queue after a %s permission refusal', async outcome => {
  const f = await devinFixture(); cleanups.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'worker', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
  const offered = profile()
  const resolver = vi.fn(async () => { if (outcome === 'failed') throw new Error('Synthetic lookup failure'); return offered })
  f.host.useLaunchProfiles({ profileFor: resolver })
  await f.driver.raisePermission('worker', 'Synthetic outside permission')
  await vi.waitFor(() => expect(resolver).toHaveBeenCalled())
  await vi.waitFor(async () => expect(await f.sessions.stopped('worker')).toBe(true))
  await f.host.closed()
  expect(await f.sessions.stopped('worker')).toBe(true)
  const thread = (await f.host.snapshot()).threads.find(thread => thread.id === 'worker')!
  expect(thread.requests).toEqual([])
  expect(thread.status).toBe('error')
  expect(thread.requestNotice).toBeTruthy()
  if (outcome === 'profile') expect(offered.revoke).toHaveBeenCalled()
})

it.each(['profile', 'failed'] as const)('does not stop a replacement Devin connection after an old %s permission lookup', async outcome => {
  const f = await devinFixture(); cleanups.push(f.cleanup)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'worker', projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
  const frames = f.host as unknown as { connections: Map<string, { rpc: DevinRpc }>; frame(id: string, connection: unknown, frame: DevinFrame, observer: boolean): Promise<void> }
  const original = frames.connections.get('worker')!
  const offered = profile()
  let resolveLookup!: (value: CommandCenterLaunchProfile) => void
  let rejectLookup!: (reason: Error) => void
  let lookupEntered!: () => void
  let first = true
  const entered = new Promise<void>(resolve => { lookupEntered = resolve })
  const lookup = new Promise<CommandCenterLaunchProfile>((resolve, reject) => { resolveLookup = resolve; rejectLookup = reject })
  f.host.useLaunchProfiles({ profileFor: () => { if (!first) return Promise.resolve(undefined); first = false; lookupEntered(); return lookup } })
  const handling = frames.frame('worker', original, { jsonrpc: '2.0', id: 'fixture-request', method: 'session/request_permission', params: { sessionId: await f.realId('worker') } }, false)
  await entered
  original.rpc.close(); await original.rpc.closed
  await f.host.startThreadSession('worker')
  const replacement = frames.connections.get('worker')!
  if (outcome === 'failed') rejectLookup(new Error('Synthetic lookup failure'))
  else resolveLookup(offered)
  await handling
  expect(frames.connections.get('worker')).toBe(replacement)
  expect(await f.sessions.stopped('worker')).toBe(false)
  expect((await f.host.snapshot()).threads.find(thread => thread.id === 'worker')!.requests).toEqual([])
  expect(offered.revoke).not.toHaveBeenCalled()
})
