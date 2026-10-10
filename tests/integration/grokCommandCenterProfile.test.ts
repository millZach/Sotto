// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import type { AgentHostCommand, CommandCenterLaunchProfile } from '../../src/main/agents/host'
import { COMMAND_CENTER_PERMISSION_FAILURE, CommandCenterProfileRefusal } from '../../src/main/agents/commandCenterProfile'
import type { CommandCenterAdmission } from '../../src/main/agents/commandCenterAdmission'
import { GROK_COMMAND_CENTER_INSPECTED_BUILD, GROK_COMMAND_CENTER_INSPECTED_VERSION, grokCommandCenterAdmission, grokCommandCenterArguments, grokCommandCenterEnvironment, grokCommandCenterMeta, grokCommandCenterVersion, preflightGrokCommandCenter, preflightGrokCommandCenterConfiguration } from '../../src/main/agents/commandCenterGrokProfile'
import { grokPending } from '../../src/main/agents/grokRequests'
import { GrokRpc, type GrokFrame } from '../../src/main/agents/grokRpc'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

let f: Awaited<ReturnType<typeof grokFixture>> | undefined
afterEach(async () => { await f?.cleanup(); f = undefined })
function profile(): CommandCenterLaunchProfile {
  return { kind: 'command-center', server: { name: 'sotto_threads', type: 'http', url: 'http://127.0.0.1:43210/mcp', headers: [{ name: 'Authorization', value: 'Bearer stand-in' }] }, toolNames: ['list_threads', 'read_project'], revoke: vi.fn() }
}
async function setup(create = false, pollIntervalMs = 60000) {
  f = await grokFixture(undefined, 2000, pollIntervalMs)
  await f.script({ cliVersion: GROK_COMMAND_CENTER_INSPECTED_VERSION })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  if (create) await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Ordinary thread' })
  const restricted = profile()
  f.host.useLaunchProfiles({ profileFor: async threadId => threadId === id ? restricted : undefined })
  return { id, restricted }
}
const admissions: readonly CommandCenterAdmission[] = [{ provider: 'grok', platform: process.platform === 'darwin' ? 'darwin' : 'win32',
  version: GROK_COMMAND_CENTER_INSPECTED_VERSION, build: GROK_COMMAND_CENTER_INSPECTED_BUILD, verificationNote: 'tests/fake-provider-verification' }]
const admittedScript = { cliVersion: GROK_COMMAND_CENTER_INSPECTED_VERSION, cliBuild: GROK_COMMAND_CENTER_INSPECTED_BUILD,
  catalog: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture Grok', _meta: {
    supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: [{ id: 'high' }, { id: 'low' }],
  } }] } }
async function admittedSetup(create = true, script: Record<string, unknown> = {}) {
  f = await grokFixture(undefined, 2000, 60000, {}, { commandCenterAdmissions: admissions })
  await f.script({ ...admittedScript, ...script }); await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID(), restricted = profile()
  f.host.useLaunchProfiles({ profileFor: async threadId => threadId === id ? restricted : undefined })
  if (create) await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Command center' })
  return { id, restricted }
}
// Preflight admits no production launches. Model a profiled process at the defensive
// callback seam so its refusal and reconnect checks remain separate from ordinary requests.
function guardedProcess(id: string): void {
  const native = f!.host as unknown as { processes: Map<string, { commandCenter: boolean }> }
  native.processes.get(id)!.commandCenter = true
}
const workRequests = async () => (await f!.driver.requests()).filter(record => ['session/new', 'session/load', 'session/set_model', 'session/prompt'].includes(record.method ?? ''))
const processes = async () => (await f!.driver.requests()).filter(record => record.method === 'fixture/process')
/** A revoked process may be killed before acknowledging session/close. Observe the actual fake process. */
const nativeProcessStopped = async (): Promise<boolean> => {
  const pid = Number((await processes()).at(-1)?.params?.pid)
  if (!pid) return false
  try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
function delayedProfile() {
  let resolve!: (value: CommandCenterLaunchProfile | undefined) => void
  let reject!: (error: Error) => void
  const promise = new Promise<CommandCenterLaunchProfile | undefined>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

it('disconnects safely when its synchronous subscriber also disconnects', async () => {
  await admittedSetup()
  let observing = false, calls = 0
  const unsubscribe = f!.host.subscribe(() => {
    if (observing && calls++ < 10) f!.host.disconnect()
  })
  try {
    observing = true
    f!.host.disconnect()
    expect(calls).toBe(1)
    await f!.host.closed()
  } finally { unsubscribe() }
})

it('builds an explicit discovery/invocation-only configuration instead of the native allow-list fallback', () => {
  const p = profile(); const meta = grokCommandCenterMeta(p)
  expect(meta).toMatchObject({ yoloMode: false, autoMode: false, agentProfile: { injectDefaultTools: false, discoverSkills: false, inheritSkills: false, skills: [], agentsMd: false, permissionMode: 'dontAsk', hooks: {}, memory: null, mcpInheritance: 'none', mcpServers: [] } })
  expect(meta.agentProfile.toolConfig.tools.map(tool => tool.id)).toEqual(['GrokBuild:search_tool', 'GrokBuild:use_tool'])
  expect(meta.agentProfile.description).toContain('sotto_threads__list_threads, sotto_threads__read_project')
  expect(grokCommandCenterArguments()).toEqual(['--no-subagents', '--disable-web-search', '--permission-mode', 'dontAsk', 'agent', '--no-leader', 'stdio'])
})

it('isolates Grok configuration without reading, copying or replacing the existing account', () => {
  const nativeHome = join(process.cwd(), 'native-grok'); const auth = join(nativeHome, 'existing-account.json')
  const owned = join(process.cwd(), 'sotto-owned')
  const env = grokCommandCenterEnvironment(owned, '../outside', { GROK_HOME: nativeHome, GROK_AUTH_PATH: auth, GROK_AGENT: 'unconfined', GROK_MEMORY: '1', GROK_CLAUDE_HOOKS_ENABLED: '1', XAI_API_KEY: 'synthetic' })
  expect(dirname(env.GROK_HOME!)).toBe(join(owned, 'command-center', 'grok'))
  expect(basename(env.GROK_HOME!)).toMatch(/^[a-f0-9]{64}$/u)
  expect(env).toMatchObject({ GROK_AUTH_PATH: auth, GROK_MEMORY: '0', GROK_SUBAGENTS: '0', GROK_MANAGED_MCPS_ENABLED: '0', GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0', GROK_DISABLE_API_KEY_AUTH: '1' })
  expect(env).not.toHaveProperty('GROK_AGENT'); expect(env).not.toHaveProperty('XAI_API_KEY')
  expect(grokCommandCenterEnvironment(owned, 'thread', { GROK_HOME: nativeHome }).GROK_AUTH_PATH).toBe(join(nativeHome, 'auth.json'))
})

it('makes requested launch configuration and fake offered tools observable on new and cold load without adding attestation to ACP', async () => {
  f = await grokFixture(undefined, 2000, 60000)
  const p = profile(); const env = grokCommandCenterEnvironment(f.root, 'restricted-fixture')
  const start = () => new GrokRpc(process.execPath, [resolve('tests/fixtures/fakeGrokThreadAgent.mjs'), f!.root, ...grokCommandCenterArguments()], f!.root, env, 2000, () => undefined, () => undefined)
  let rpc = start(); let sessionId = ''
  try {
    await rpc.request('session/new', { cwd: f.root, mcpServers: [p.server], _meta: grokCommandCenterMeta(p) }, value => { sessionId = (value as { sessionId: string }).sessionId })
    rpc.close(); await rpc.closed
    rpc = start()
    await rpc.request('session/load', { sessionId, cwd: f.root, mcpServers: [p.server], _meta: grokCommandCenterMeta(p) }, () => undefined)
    const records = await f.driver.requests()
    expect(records.filter(record => record.method === 'fixture/offered-tools').map(record => record.params)).toEqual([
      { sessionId, nativeTools: ['GrokBuild:search_tool', 'GrokBuild:use_tool'], servers: ['sotto_threads'] },
      { sessionId, nativeTools: ['GrokBuild:search_tool', 'GrokBuild:use_tool'], servers: ['sotto_threads'] },
    ])
    for (const launch of records.filter(record => record.method === 'fixture/process')) {
      expect(launch.params?.args).toEqual(grokCommandCenterArguments())
      expect(launch.params?.environment).toMatchObject({ GROK_HOME: env.GROK_HOME, GROK_AUTH_PATH: env.GROK_AUTH_PATH, GROK_MEMORY: '0', GROK_SUBAGENTS: '0' })
    }
  } finally { rpc.close(); await rpc.closed }
})

it.each(['win32', 'darwin', 'linux'] as const)('refuses every unlisted model on %s with the plain recovery reason', platform => {
  for (const model of ['grok-code', 'strict-harness-model']) {
    expect(() => preflightGrokCommandCenter(profile(), GROK_COMMAND_CENTER_INSPECTED_VERSION, model, platform)).toThrow(CommandCenterProfileRefusal)
    expect(() => preflightGrokCommandCenter(profile(), '1.0.51', model, platform)).toThrow('Nothing was sent. Use an ordinary thread, or check for a Sotto update.')
  }
})

it.each(['win32', 'darwin'] as const)('admits only a live-checked exact version and build on %s', platform => {
  const checked: CommandCenterAdmission[] = [{ ...admissions[0]!, platform }]
  expect(() => preflightGrokCommandCenter(profile(), GROK_COMMAND_CENTER_INSPECTED_VERSION, 'grok-code', platform, checked, GROK_COMMAND_CENTER_INSPECTED_BUILD)).not.toThrow()
  expect(() => preflightGrokCommandCenterConfiguration(profile(), GROK_COMMAND_CENTER_INSPECTED_VERSION, 'grok-code', platform, checked)).not.toThrow()
  for (const version of ['1.0.49', '1.0.51', '1.0.50-beta']) expect(() => preflightGrokCommandCenter(profile(), version, 'grok-code', platform, checked, GROK_COMMAND_CENTER_INSPECTED_BUILD)).toThrow(CommandCenterProfileRefusal)
  for (const build of [undefined, 'different-build']) expect(() => preflightGrokCommandCenter(profile(), GROK_COMMAND_CENTER_INSPECTED_VERSION, 'grok-code', platform, checked, build)).toThrow(CommandCenterProfileRefusal)
  expect(() => preflightGrokCommandCenter(profile(), GROK_COMMAND_CENTER_INSPECTED_VERSION, 'grok-code', platform === 'win32' ? 'darwin' : 'win32', checked, GROK_COMMAND_CENTER_INSPECTED_BUILD)).toThrow(CommandCenterProfileRefusal)
})

it('reads only an exact CLI version and build from the native version output', () => {
  expect(grokCommandCenterVersion('1.0.50 (c58f321264ba)\n')).toEqual({ version: '1.0.50', build: 'c58f321264ba' })
  expect(grokCommandCenterVersion('grok 1.0.50 (c58f321264ba)')).toEqual({ version: '1.0.50', build: 'c58f321264ba' })
  for (const output of ['1.0.50', '1.0.50 (unknown)', '1.0.50-beta (c58f321264ba)', '1.0.50 (c58f321264ba)\nextra']) expect(grokCommandCenterVersion(output)).toBeUndefined()
})

it('admits only exact tools on the caller server with a one-time native choice', () => {
  const p = profile()
  const permission = (name: string) => grokPending(1, 'session/request_permission', { sessionId: 'native', toolCall: { toolCallId: 'call', rawInput: { tool_name: name } }, options: [{ optionId: 'once', name: 'Once', kind: 'allow_once' }] }, 'sotto')!
  expect(grokCommandCenterAdmission(permission('sotto_threads__list_threads'), p)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  for (const name of ['sotto_threads__list_threads_extra', 'sotto_threads__write_project', 'sotto_browser__read_project', 'foreign__list_threads']) expect(grokCommandCenterAdmission(permission(name), p)).toBeUndefined()
  const permanent = permission('sotto_threads__read_project'); permanent.permission!.options[0]!.kind = 'allow_always'
  expect(grokCommandCenterAdmission(permanent, p)).toBeUndefined()
})

it('refuses creation and draft early start before starting a process or native session', async () => {
  const { id, restricted } = await setup(); const before = (await processes()).length
  await expect(f!.host.startThreadSession(id, { modelId: f!.modelId })).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', retryable: false })
  await expect(f!.host.execute({ type: 'create-thread', commandId: 'create', threadId: id, projectId: f!.projectId, modelId: f!.modelId, title: 'Command center', runtimeMode: 'full-access' })).rejects.toThrow('Nothing was sent. Use an ordinary thread')
  expect(await workRequests()).toEqual([]); expect(await processes()).toHaveLength(before)
  expect(restricted.revoke).toHaveBeenCalled()
})

it('refuses existing-session early start, settings, model, turns, steer and skills before using an ordinary process', async () => {
  const { id } = await setup(true); const before = await workRequests(); const opened = (await processes()).length
  const commands: AgentHostCommand[] = [
    { type: 'configure-thread', commandId: 'settings', threadId: id, runtimeMode: 'full-access' },
    { type: 'configure-thread', commandId: 'model', threadId: id, modelId: 'other-model', reasoningEffort: 'low' },
    { type: 'send', commandId: 'turn', threadId: id, messageId: 'turn', text: 'Synthetic prompt' },
    { type: 'steer', commandId: 'steer', threadId: id, messageId: 'steer', text: 'Synthetic steer' },
  ]
  await expect(f!.host.startThreadSession(id)).rejects.toThrow(CommandCenterProfileRefusal)
  for (const command of commands) await expect(f!.host.execute(command)).rejects.toThrow(CommandCenterProfileRefusal)
  await expect(f!.host.refreshThread(id)).rejects.toThrow(CommandCenterProfileRefusal)
  await expect(f!.host.listThreadSkills(id)).rejects.toThrow(CommandCenterProfileRefusal)
  await expect(f!.host.writeShortText(id, { instruction: 'Synthetic instruction', material: 'Synthetic material' })).rejects.toThrow(CommandCenterProfileRefusal)
  expect(await workRequests()).toEqual(before); expect(await processes()).toHaveLength(opened)
})

it('refuses observed cold load and preserves the typed recovery reason', async () => {
  const { id, restricted } = await setup(true); const before = await workRequests()
  f = await f!.driver.restart()
  f.host.useLaunchProfiles({ profileFor: async threadId => threadId === id ? restricted : undefined })
  f.host.observeThreads([id])
  await expect(f.host.connect()).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: expect.stringContaining('Nothing was sent. Use an ordinary thread') })
  expect(await workRequests()).toEqual(before)
})

it('cancels a permission outside the profile and stops and revokes instead of presenting an approval card', async () => {
  const { id, restricted } = await admittedSetup()
  let latest: AgentHostSnapshot | undefined
  const unsubscribe = f!.host.subscribe(snapshot => { latest = snapshot })
  try {
    await f!.action(id, { type: 'permission', text: 'Synthetic shell request', rawInput: { command: 'synthetic' } })
    await expect.poll(() => restricted.revoke).toHaveBeenCalledWith(COMMAND_CENTER_PERMISSION_FAILURE)
    await expect.poll(() => latest?.threads.find(thread => thread.id === id)?.requestNotice).toBe(COMMAND_CENTER_PERMISSION_FAILURE)
    expect(latest?.threads.find(thread => thread.id === id)?.requests).toEqual([])
    await expect.poll(nativeProcessStopped).toBe(true)
    const responses = (await f!.driver.requests()).filter(record => record.result && Object.hasOwn(record.result, 'outcome'))
    expect(responses.at(-1)?.result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(responses.some(record => f!.protocol.permissionDecision(record) === true)).toBe(false)
  } finally { unsubscribe() }
})

it('launches and cold-resumes the exact admitted client through the restricted profile', async () => {
  const { id, restricted } = await admittedSetup(false)
  await f!.host.startThreadSession(id, { modelId: f!.modelId })
  expect(await workRequests()).toEqual([])
  await f!.host.execute({ type: 'create-thread', commandId: 'create-admitted', threadId: id, projectId: f!.projectId, modelId: f!.modelId, title: 'Command center' })
  await f!.host.execute({ type: 'configure-thread', commandId: 'settings-admitted', threadId: id, runtimeMode: 'full-access' })
  f = await f!.driver.restart()
  f.host.useLaunchProfiles({ profileFor: async threadId => threadId === id ? restricted : undefined })
  f.host.observeThreads([id]); await f.host.connect(); await f.host.startThreadSession(id)
  const records = await workRequests()
  expect(records.some(record => record.method === 'session/new')).toBe(true)
  expect(records.some(record => record.method === 'session/load')).toBe(true)
  for (const record of records.filter(record => record.method === 'session/new' || record.method === 'session/load')) {
    expect(record.params?._meta).toEqual(grokCommandCenterMeta(restricted))
    expect(record.params?.mcpServers).toEqual([restricted.server])
  }
  expect(restricted.revoke).not.toHaveBeenCalled()
  const thread = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
  expect(thread.requests).toEqual([]); expect(thread.status).toBe('idle')
})

it('admits an exact supplied Sotto tool without showing a native request card', async () => {
  const { id, restricted } = await admittedSetup()
  let showedRequest = false
  const unsubscribe = f!.host.subscribe(snapshot => { if (snapshot.threads.find(thread => thread.id === id)?.requests.length) showedRequest = true })
  try {
    await f!.action(id, { type: 'permission', text: 'Synthetic thread tool', rawInput: { tool_name: 'sotto_threads__list_threads' } })
    await expect.poll(async () => (await f!.driver.requests()).some(record => f!.protocol.permissionDecision(record) === true)).toBe(true)
    expect(showedRequest).toBe(false); expect(restricted.revoke).not.toHaveBeenCalled()
  } finally { unsubscribe() }
})

it.each([
  { name: 'newer version', script: { cliVersion: '1.0.51' } },
  { name: 'older version', script: { cliVersion: '1.0.49' } },
  { name: 'different build', script: { cliBuild: 'abcdef123456' } },
  { name: 'missing build', script: { versionOutput: '1.0.50\n' } },
  { name: 'unreadable version', script: { versionOutput: 'unreadable\n' } },
] as const)('refuses an injected combination with $name before a session or turn exists', async ({ script }) => {
  const { id, restricted } = await admittedSetup(false, script)
  await expect(f!.host.startThreadSession(id, { modelId: f!.modelId })).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: expect.stringContaining('Nothing was sent.') })
  expect(await workRequests()).toEqual([])
  expect(restricted.revoke).toHaveBeenCalled()
  expect((await f!.host.snapshot()).threads.flatMap(thread => thread.requests)).toEqual([])
})

it('checks the new process’s own ACP version before authentication, session creation or turn work', async () => {
  const { id, restricted } = await admittedSetup(false)
  await f!.script({ ...admittedScript, acpVersion: '1.0.51' })
  await expect(f!.host.startThreadSession(id, { modelId: f!.modelId })).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: expect.stringContaining('Grok Build 1.0.51') })
  const threadProcess = (await processes()).at(-1)!.params!.pid
  const sent = (await f!.driver.requests()).filter(record => (record as unknown as { process: unknown }).process === threadProcess)
  expect(sent.some(record => record.method === 'authenticate')).toBe(false)
  expect(await workRequests()).toEqual([]); expect(restricted.revoke).toHaveBeenCalled()
  await expect.poll(nativeProcessStopped).toBe(true)
})

it('changes a command-center effort with native confirmation and retains its restricted tools', async () => {
  const { id, restricted } = await admittedSetup()
  await f!.host.execute({ type: 'configure-thread', commandId: 'change-effort', threadId: id, reasoningEffort: 'low' })
  const thread = (await f!.host.snapshot()).threads.find(thread => thread.id === id)!
  expect(thread.reasoningEffort).toBe('low'); expect(thread.status).toBe('idle')
  const load = (await workRequests()).findLast(record => record.method === 'session/load')!
  expect(load.params?._meta).toEqual(grokCommandCenterMeta(restricted))
  expect(load.params?.mcpServers).toEqual([restricted.server])
  expect(restricted.revoke).not.toHaveBeenCalled()
  await expect(f!.host.listThreadSkills(id)).rejects.toThrow('Native skills are unavailable')
  await expect(f!.host.writeShortText(id, { instruction: 'Synthetic instruction', material: 'Synthetic material' })).resolves.toBeNull()
})

it('stops and revokes an unconfirmed command-center effort change with no approval card', async () => {
  const { id, restricted } = await admittedSetup()
  await f!.script({ ...admittedScript, unconfirmedModel: true })
  await expect(f!.host.execute({ type: 'configure-thread', commandId: 'unconfirmed-effort', threadId: id, reasoningEffort: 'low' })).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: expect.stringContaining('Nothing was sent.') })
  expect(restricted.revoke).toHaveBeenCalled(); await expect.poll(nativeProcessStopped).toBe(true)
  expect((await f!.host.snapshot()).threads.find(thread => thread.id === id)?.requests).toEqual([])
})

it('rechecks actual build admission when a cold resume replaces the process', async () => {
  const { id, restricted } = await admittedSetup()
  const before = await workRequests()
  await f!.script({ ...admittedScript, cliBuild: 'abcdef123456' })
  f = await f!.driver.restart(); f.host.useLaunchProfiles({ profileFor: async threadId => threadId === id ? restricted : undefined })
  f.host.observeThreads([id])
  await expect(f.host.connect()).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: expect.stringContaining('Nothing was sent.') })
  expect(await workRequests()).toEqual(before); expect(restricted.revoke).toHaveBeenCalled()
})

it('keeps ordinary launches and permissions unchanged when main supplies no profile', async () => {
  const { id } = await setup(true)
  f!.host.useLaunchProfiles({ profileFor: async () => undefined })
  await f!.host.execute({ type: 'configure-thread', commandId: 'ordinary-mode', threadId: id, runtimeMode: 'full-access' })
  const request = (await workRequests()).findLast(record => record.method === 'session/load')!
  expect(request.params?._meta).toEqual({ yoloMode: true, autoMode: false })
  await f!.driver.raisePermission(id, 'Synthetic ordinary permission')
  await expect.poll(async () => (await f!.host.snapshot()).threads[0]!.requests.length).toBe(1)
  const pending = (await f!.host.snapshot()).threads[0]!.requests[0]!
  await f!.host.execute({ type: 'answer', commandId: 'answer', threadId: id, requestId: pending.id, answer: '', approved: true })
  await expect.poll(async () => (await f!.driver.requests()).some(record => f!.protocol.permissionDecision(record) === true)).toBe(true)
})

it('stops a native permission request when the durable profile resolver refuses instead of using ordinary approval UI', async () => {
  f = await grokFixture(undefined, 2000, 60000); await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: 'thread', threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Thread' })
  guardedProcess(id)
  const reason = 'The command center tool server is unavailable. Reopen the command center to recover.'
  f.host.useLaunchProfiles({ profileFor: async threadId => { if (threadId === id) throw new CommandCenterProfileRefusal(reason); return undefined } })
  let latest: AgentHostSnapshot | undefined
  const unsubscribe = f.host.subscribe(snapshot => { latest = snapshot })
  try {
    await f.action(id, { type: 'permission', text: 'Synthetic permission', rawInput: { tool_name: 'sotto_threads__list_threads' } })
    await expect.poll(() => latest?.threads.find(thread => thread.id === id)?.requestNotice).toBe(reason)
    expect(latest?.threads.find(thread => thread.id === id)?.requests).toEqual([])
    await expect.poll(nativeProcessStopped).toBe(true)
    expect((await f.driver.requests()).some(record => f!.protocol.permissionDecision(record) === true)).toBe(false)
  } finally { unsubscribe() }
})

it('revokes the owning process for a permission carrying an unknown session identity', async () => {
  const { id, restricted } = await setup(true)
  guardedProcess(id)
  await f!.action(id, { type: 'unreadable', method: 'session/request_permission', text: 'Synthetic malformed request', params: { sessionId: 'unknown-session' } })
  await expect.poll(() => restricted.revoke).toHaveBeenCalledWith(COMMAND_CENTER_PERMISSION_FAILURE)
  await expect.poll(nativeProcessStopped).toBe(true)
  expect((await f!.driver.requests()).some(record => f!.protocol.permissionDecision(record) === true)).toBe(false)
})

it('never downgrades a previously resolved profile when main removes its admission', async () => {
  const { id, restricted } = await setup(true)
  await expect(f!.host.startThreadSession(id)).rejects.toThrow(CommandCenterProfileRefusal)
  f!.host.useLaunchProfiles({ profileFor: async () => undefined })
  await expect(f!.host.startThreadSession(id)).rejects.toThrow('no longer admitted')
  expect(restricted.revoke).toHaveBeenCalled()
})

it.each(['early-start', 'process-start', 'create'] as const)('does not carry a delayed ordinary %s lookup onto a reconnected host', async path => {
  const { id } = await setup(); const gate = delayedProfile(); let lookups = 0; let entered = false
  const delayedLookup = path === 'process-start' ? 2 : 1
  f!.host.useLaunchProfiles({ profileFor: async threadId => {
    if (threadId === id && ++lookups === delayedLookup) { entered = true; return gate.promise }
    return undefined
  } })
  const work = path === 'create'
    ? f!.host.execute({ type: 'create-thread', commandId: 'delayed-create', threadId: id, projectId: f!.projectId, modelId: f!.modelId, title: 'Ordinary thread' })
    : f!.host.startThreadSession(id, { modelId: f!.modelId })
  const outcome = work.then(() => undefined, error => error as Error)
  await expect.poll(() => entered).toBe(true)
  f!.host.disconnect(); await f!.host.closed(); await f!.host.connect()
  const opened = (await processes()).length; const before = await workRequests()
  gate.resolve(undefined)
  expect(await outcome).toMatchObject({ message: expect.stringContaining('connection changed') })
  expect(await processes()).toHaveLength(opened); expect(await workRequests()).toEqual(before)
})

it.each([
  { stage: 'profile', result: 'ordinary' },
  { stage: 'admission', result: 'ordinary' },
  { stage: 'profile', result: 'refused' },
  { stage: 'profile', result: 'restricted' },
] as const)('ignores a delayed $stage permission lookup returning $result after disconnect', async ({ stage, result }) => {
  const { id, restricted } = await setup(true); const gate = delayedProfile(); let lookups = 0; let entered = false; let waiting = true
  guardedProcess(id)
  f!.host.useLaunchProfiles({ profileFor: async threadId => {
    if (threadId === id && waiting && ++lookups === (stage === 'admission' ? 2 : 1)) { entered = true; return gate.promise }
    return undefined
  } })
  let latest: AgentHostSnapshot | undefined
  let disconnected = false; let staleRequestPublished = false
  const unsubscribe = f!.host.subscribe(snapshot => {
    latest = snapshot
    if (disconnected && snapshot.threads.find(thread => thread.id === id)?.requests.length) staleRequestPublished = true
  })
  try {
    await f!.action(id, { type: 'permission', text: 'Synthetic delayed request', rawInput: { command: 'synthetic' } })
    await expect.poll(() => entered).toBe(true)
    waiting = false
    disconnected = true
    f!.host.disconnect()
    // Grok's close barrier drains receive callbacks. Reconnect begins while this callback is held,
    // then waits for its stale lookup to settle before the replacement can start.
    const reconnect = f!.host.connect()
    if (result === 'refused') gate.reject(new CommandCenterProfileRefusal('Synthetic stale profile refusal.'))
    else gate.resolve(result === 'restricted' ? restricted : undefined)
    await f!.host.closed(); await reconnect; await f!.host.startThreadSession(id)
    const replacement = Number((await processes()).at(-1)?.params?.pid)
    // A real history read also proves that the replacement process remains usable after stale input settles.
    await f!.host.refreshThread(id)
    expect(latest?.threads.find(thread => thread.id === id)?.requests).toEqual([])
    expect(latest?.threads.find(thread => thread.id === id)?.requestNotice).toBeUndefined()
    expect(restricted.revoke).not.toHaveBeenCalled()
    expect(staleRequestPublished).toBe(false)
    expect(() => process.kill(replacement, 0)).not.toThrow()
    expect((await f!.driver.requests()).some(record => f!.protocol.permissionDecision(record) === true)).toBe(false)
  } finally { gate.resolve(undefined); unsubscribe() }
})

it.each(['ordinary', 'refused', 'restricted'] as const)('keeps a live replacement safe when an old RPC permission lookup later returns %s', async result => {
  const { id, restricted } = await setup(true); const gate = delayedProfile(); let entered = false
  const native = f!.host as unknown as { processes: Map<string, { rpc: GrokRpc }>; frame(frame: GrokFrame, rpc: GrokRpc): Promise<void> }
  guardedProcess(id)
  const oldRpc = native.processes.get(id)!.rpc
  f!.host.useLaunchProfiles({ profileFor: async threadId => {
    if (threadId === id && !entered) { entered = true; return gate.promise }
    return undefined
  } })
  // Invoke the adapter callback with an actual fake-process RPC, outside that transport's serial
  // receive queue, so the old lookup can remain held after its replacement is fully connected.
  const settled = native.frame({ jsonrpc: '2.0', id: 9000, method: 'session/request_permission', params: {
    sessionId: await f!.realId(id), toolCall: { toolCallId: 'stale-call', title: 'Synthetic old permission', rawInput: { command: 'synthetic' } },
    options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }],
  } }, oldRpc).catch(() => undefined)
  try {
    await expect.poll(() => entered).toBe(true)
    f!.host.disconnect(); await f!.host.closed(); await f!.host.connect(); await f!.host.startThreadSession(id)
    const replacement = native.processes.get(id)!.rpc
    expect(replacement).not.toBe(oldRpc)
    if (result === 'refused') gate.reject(new CommandCenterProfileRefusal('Synthetic old RPC refusal.'))
    else gate.resolve(result === 'restricted' ? restricted : undefined)
    await settled; await f!.host.refreshThread(id)
    const thread = (await f!.host.snapshot()).threads.find(thread => thread.id === id)!
    expect(thread.requests).toEqual([]); expect(thread.requestNotice).toBeUndefined()
    expect(restricted.revoke).not.toHaveBeenCalled()
    expect(native.processes.get(id)?.rpc).toBe(replacement)
    expect(() => process.kill(replacement.pid!, 0)).not.toThrow()
  } finally { gate.resolve(undefined); await settled }
})

it('does not revoke or stop a replacement process when an earlier profile lookup later refuses', async () => {
  const { id, restricted } = await setup(true); const gate = delayedProfile(); let entered = false
  f!.host.useLaunchProfiles({ profileFor: async threadId => {
    if (threadId === id && !entered) { entered = true; return gate.promise }
    return undefined
  } })
  const outcome = f!.host.startThreadSession(id).then(() => undefined, error => error as Error)
  try {
    await expect.poll(() => entered).toBe(true)
    f!.host.disconnect(); await f!.host.closed(); await f!.host.connect(); await f!.host.startThreadSession(id)
    const replacement = Number((await processes()).at(-1)?.params?.pid)
    gate.reject(new CommandCenterProfileRefusal('Synthetic stale profile refusal.'))
    expect(await outcome).toMatchObject({ message: expect.stringContaining('connection changed') })
    await f!.host.refreshThread(id)
    expect(restricted.revoke).not.toHaveBeenCalled()
    expect(() => process.kill(replacement, 0)).not.toThrow()
    expect((await f!.host.snapshot()).threads.find(thread => thread.id === id)?.requestNotice).toBeUndefined()
  } finally { gate.resolve(undefined) }
})
