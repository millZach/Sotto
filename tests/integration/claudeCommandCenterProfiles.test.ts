// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHostCommand, CommandCenterLaunchProfile } from '../../src/main/agents/host'
import { COMMAND_CENTER_PERMISSION_FAILURE, CommandCenterProfileRefusal } from '../../src/main/agents/commandCenterProfile'
import { CLAUDE_COMMAND_CENTER_CLIENT_VERSION, claudeCommandCenterArguments, claudeCommandCenterManagedPolicy,
  claudeCommandCenterMcpConfig, preflightClaudeCommandCenter } from '../../src/main/agents/commandCenterClaudeProfile'
import { ClaudeProtocol, type ClaudeFrame } from '../../src/main/agents/claudeProtocol'
import { claudeFixture } from '../fixtures/claudeFixture'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })
const profile = (): CommandCenterLaunchProfile => ({ kind: 'command-center',
  server: { name: 'sotto_threads', type: 'http', url: 'http://127.0.0.1:39123/mcp', headers: [{ name: 'Authorization', value: 'Bearer fixture-only' }] },
  toolNames: ['list_threads', 'read_thread'], revoke: vi.fn() })
const flag = (args: readonly string[], name: string): string | undefined => args[args.indexOf(name) + 1]
const starts = async (f: Fixture) => (await f.driver.requests()).filter(record => {
  const args = (record.params?.frame as { args?: string[] } | undefined)?.args
  return ['launch', 'resume'].includes(record.method ?? '') && (args?.includes('--session-id') || args?.includes('--resume'))
})
async function fixture(): Promise<Fixture> {
  const f = await claudeFixture()
  cleanup.push(() => f.cleanup())
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Profile fixture', path: f.root })
  return f
}
async function ordinary(f: Fixture): Promise<string> {
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Fixture', modelId: f.modelId })
  return id
}
function admit(f: Fixture, id: string, value = profile()) {
  const resolver = vi.fn(async (threadId: string) => threadId === id ? value : undefined)
  f.adapter.useLaunchProfiles({ profileFor: resolver })
  return { value, resolver }
}
/** Only the original lookup waits; a replacement connection gets its own immediate ordinary-thread answer. */
function pendingProfileLookup(f: Fixture) {
  let resolveLookup!: (value: CommandCenterLaunchProfile | undefined) => void
  let rejectLookup!: (error: Error) => void
  let lookupEntered!: () => void
  const entered = new Promise<void>(resolveEntered => { lookupEntered = resolveEntered })
  const lookup = new Promise<CommandCenterLaunchProfile | undefined>((resolvePending, rejectPending) => {
    resolveLookup = resolvePending; rejectLookup = rejectPending
  })
  let first = true
  f.adapter.useLaunchProfiles({ profileFor: () => {
    if (first) { first = false; lookupEntered(); return lookup }
    return Promise.resolve(undefined)
  } })
  return { entered, resolve: resolveLookup, reject: rejectLookup }
}

describe('Claude command-center profile', () => {
  it('does not start an ordinary session after disconnection while its profile lookup waits', async () => {
    const f = await fixture(), id = await ordinary(f), before = await starts(f)
    let resolveLookup!: (value: undefined) => void
    let lookupEntered!: () => void
    const entered = new Promise<void>(resolve => { lookupEntered = resolve })
    const lookup = new Promise<undefined>(resolve => { resolveLookup = resolve })
    f.adapter.useLaunchProfiles({ profileFor: () => { lookupEntered(); return lookup } })
    const reading = f.host.refreshThread!(id)
    const stopped = expect(reading).rejects.toThrow('connection changed')
    await entered
    f.host.disconnect()
    resolveLookup(undefined)
    await stopped
    expect(await starts(f)).toEqual(before)
  })

  it('refuses an early start whose original profile lookup crosses a reconnect', async () => {
    const f = await fixture(), id = randomUUID(), before = await starts(f), pending = pendingProfileLookup(f)
    const starting = f.adapter.startThreadSession(id, { workingDirectory: f.root, modelId: f.modelId })
    const cancelled = expect(starting).rejects.toThrow('connection was cancelled')
    await pending.entered
    await f.adapter.connect()
    pending.resolve(undefined)
    await cancelled
    expect(await starts(f)).toEqual(before)
    expect(await readFile(join(f.root, 'claude-threads.json'), 'utf8').catch(() => '{}')).not.toContain(id)
  })

  it('does not publish an old observation lookup failure into a successfully reconnected thread', async () => {
    const f = await fixture(), id = await ordinary(f), pending = pendingProfileLookup(f)
    f.adapter.observeThreads([id])
    await pending.entered
    const reconnected = await f.adapter.connect()
    expect(reconnected.connected).toBe(true)
    expect(reconnected.error).toBeUndefined()
    expect(reconnected.threads.find(thread => thread.id === id)).toMatchObject({ status: 'idle', providerSessionOpen: true })
    const before = await starts(f), errors: string[] = []
    const unsubscribe = f.adapter.subscribe(snapshot => { if (snapshot.error) errors.push(snapshot.error) })
    cleanup.push(async () => { unsubscribe() })
    pending.resolve(undefined)
    // A fresh read yields through the stale callback and keeps the replacement session in use.
    const snapshot = await f.adapter.refreshThread(id)
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.threads.find(thread => thread.id === id)).toMatchObject({ status: 'idle', providerSessionOpen: true })
    expect(errors).toEqual([])
    expect(await starts(f)).toEqual(before)
    expect(await f.sessions!.stopped(id)).toBe(false)
  })

  it.each(['create-thread', 'send'] as const)('refuses a stale %s command after its original lookup crosses a reconnect', async type => {
    const f = await fixture(), id = type === 'send' ? await ordinary(f) : randomUUID(), pending = pendingProfileLookup(f)
    const command: AgentHostCommand = type === 'send'
      ? { type, commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic stale prompt' }
      : { type, commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Synthetic stale thread', modelId: f.modelId }
    const executing = f.host.execute(command), cancelled = expect(executing).rejects.toThrow('connection was cancelled')
    await pending.entered
    await f.adapter.connect()
    if (type === 'send') await f.adapter.startThreadSession(id)
    const before = await starts(f)
    pending.resolve(undefined)
    await cancelled
    expect(await starts(f)).toEqual(before)
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toEqual([])
    if (type === 'create-thread') expect(await readFile(join(f.root, 'claude-threads.json'), 'utf8').catch(() => '{}')).not.toContain(id)
    else expect(await f.sessions!.stopped(id)).toBe(false)
  })

  it.each(['profile', 'refusal'] as const)('keeps a delayed native permission %s owned by its original process across reconnect', async result => {
    const f = await fixture(), id = await ordinary(f), pending = pendingProfileLookup(f), value = profile()
    await f.driver.raisePermission(id, 'Synthetic stale permission')
    await pending.entered
    await f.adapter.connect()
    await f.adapter.startThreadSession(id)
    const before = await starts(f), replacement = await f.liveSettings.effective(id)
    if (result === 'profile') pending.resolve(value)
    else pending.reject(new CommandCenterProfileRefusal('Synthetic stale profile refusal'))
    // A fresh action must keep using the replacement; the old callback cannot stop it or poison its profile cache.
    await f.adapter.startThreadSession(id)
    expect(await starts(f)).toEqual(before)
    expect((await f.liveSettings.effective(id)).process).toBe(replacement.process)
    expect(await f.sessions!.stopped(id)).toBe(false)
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests).toEqual([])
    expect(value.revoke).not.toHaveBeenCalled()
    expect((await f.driver.requests()).filter(record => record.method === 'control_response')).toEqual([])
  })

  it.each(['skills', 'side-call', 'rollback'] as const)('refuses stale %s entry work after its profile lookup crosses a reconnect', async action => {
    const f = await fixture(), id = await ordinary(f), pending = pendingProfileLookup(f)
    const work = action === 'skills' ? f.adapter.listThreadSkills(id)
      : action === 'side-call' ? f.adapter.writeShortText(id, { instruction: 'Synthetic instruction', material: 'Synthetic material' })
        : f.adapter.rollbackThread(id, 1, [])
    const cancelled = expect(work).rejects.toThrow('connection was cancelled')
    await pending.entered
    await f.adapter.connect()
    const before = await starts(f)
    pending.resolve(undefined)
    await cancelled
    expect(await starts(f)).toEqual(before)
    expect(await readFile(join(f.root, 'oneshot.jsonl'), 'utf8').catch(() => '')).toBe('')
  })

  it('builds exact launch restrictions and only the caller’s supplied server', () => {
    const value = profile(), args = claudeCommandCenterArguments(value)
    expect(flag(args, '--tools')).toBe('AskUserQuestion')
    expect(flag(args, '--setting-sources')).toBe('')
    expect(flag(args, '--permission-mode')).toBe('manual')
    expect(flag(args, '--permission-prompts')).toBe('host')
    expect(flag(args, '--permission-prompt-tool')).toBe('stdio')
    expect(['--strict-mcp-config', '--safe-mode', '--restricted', '--disable-slash-commands', '--no-chrome'].every(name => args.includes(name))).toBe(true)
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['mcp__sotto_threads__list_threads', 'mcp__sotto_threads__read_thread'])
    expect(args).not.toContain('--bare')
    expect(args).not.toContain('--allow-dangerously-skip-permissions')
    expect(JSON.parse(flag(args, '--managed-settings')!)).toEqual(claudeCommandCenterManagedPolicy)
    expect(claudeCommandCenterMcpConfig(value)).toEqual({ mcpServers: { sotto_threads: {
      type: 'http', url: value.server.url, headers: { Authorization: 'Bearer fixture-only' },
    } } })
  })

  it('makes the proposed flags, parent policy and offered tool names observable in a fake child process', async () => {
    const f = await fixture(), value = profile(), session = randomUUID(), config = join(f.root, 'stand-in-mcp.json')
    await writeFile(config, JSON.stringify(claudeCommandCenterMcpConfig(value)))
    const frames: ClaudeFrame[] = []
    const args = [resolve('tests/fixtures/fakeClaudeThread.mjs'), f.root, '--mcp-config', config,
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      ...claudeCommandCenterArguments(value), '--session-id', session, '--model', f.modelId]
    const protocol = new ClaudeProtocol(process.execPath, args, f.root, process.env, 5000, frame => frames.push(frame), () => undefined)
    cleanup.push(async () => { protocol.stop(); await protocol.closed })
    await protocol.control({ subtype: 'initialize', hooks: {}, sdkMcpServers: [], promptSuggestions: false })
    await expect.poll(() => frames.find(frame => frame.type === 'system' && frame.subtype === 'init')?.tools)
      .toEqual(['AskUserQuestion', 'mcp__sotto_threads__list_threads', 'mcp__sotto_threads__read_thread'])
    expect((await f.driver.requests()).find(record => record.method === 'command-center-profile')?.params?.frame)
      .toMatchObject({ serverNames: ['sotto_threads'], policy: claudeCommandCenterManagedPolicy })
    // This is observable fake wiring, deliberately not a claim that the installed client enforces the policy.
  })

  it.each(['win32', 'darwin', 'linux'] as const)('refuses %s even for the inspected version instead of equating flags with effective proof', platform => {
    expect(() => preflightClaudeCommandCenter(profile(), CLAUDE_COMMAND_CENTER_CLIENT_VERSION, platform, 'fixture-model'))
      .toThrow('startup policy and complete tool list')
    try { preflightClaudeCommandCenter(profile(), 'unknown-client', platform, 'unknown-model') }
    catch (error) { expect(error).toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', retryable: false }) }
  })

  it('refuses an unverified new launch and early start before creating any native process or alias', async () => {
    const f = await fixture(), id = randomUUID(), { value, resolver } = admit(f, id)
    await expect(f.adapter.startThreadSession(id, { workingDirectory: f.root, modelId: f.modelId }))
      .rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Master', modelId: f.modelId, runtimeMode: 'full-access' }))
      .rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    expect(await starts(f)).toEqual([])
    expect(await readFile(join(f.root, 'claude-threads.json'), 'utf8').catch(() => '{}')).not.toContain(id)
    expect(resolver.mock.calls.map(call => call[0])).toEqual([id, id])
    expect(value.revoke).toHaveBeenCalledTimes(2)
  })

  it('checks the durable profile before live settings, model changes, every send and native steer', async () => {
    const f = await fixture(), id = await ordinary(f), { value } = admit(f, id)
    const before = await starts(f)
    const commands: AgentHostCommand[] = [
      { type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high' },
      { type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'unknown-model' },
      { type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' },
      { type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic prompt' },
      { type: 'steer', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic steer' },
    ]
    for (const command of commands) await expect(f.host.execute(command)).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    expect(await starts(f)).toEqual(before)
    expect((await f.driver.requests()).some(record => ['set_model', 'apply_flag_settings', 'set_permission_mode', 'user'].includes(record.method ?? ''))).toBe(false)
    expect(await f.sessions!.stopped(id)).toBe(true)
    expect(value.revoke).toHaveBeenCalledTimes(commands.length)
    const worker = await ordinary(f)
    expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: worker, messageId: randomUUID(), text: 'Ordinary synthetic prompt' })).accepted).toBe(true)
    await f.driver.raisePermission(worker, 'Ordinary synthetic permission')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === worker)?.requests.length).toBe(1)
    const request = (await f.host.snapshot()).threads.find(thread => thread.id === worker)!.requests[0]!
    expect((await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: worker, requestId: request.id, answer: 'Approved', approved: true })).accepted).toBe(true)
  })

  it('refuses cold resume and watched reconnect with the plain-words recovery reason', async () => {
    const f = await fixture(), id = await ordinary(f)
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic prior turn' })
    await f.driver.completeTurn(id, 'Done')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
    f.adapter.disconnect(); await f.adapter.closed()
    const { value } = admit(f, id), before = await starts(f)
    f.adapter.observeThreads([id])
    const snapshot = await f.adapter.connect()
    expect(snapshot.error).toContain('startup policy and complete tool list')
    await expect(f.adapter.startThreadSession(id)).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    await expect(f.adapter.refreshThread(id)).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    expect(await starts(f)).toEqual(before)
    expect(value.revoke).toHaveBeenCalled()
  })

  it('stops and revokes an outside native permission before publishing any request card or answer', async () => {
    const f = await fixture(), id = await ordinary(f), { value } = admit(f, id)
    await f.driver.raisePermission(id, 'Synthetic native permission')
    await expect.poll(() => vi.mocked(value.revoke).mock.calls[0]?.[0]).toBe(COMMAND_CENTER_PERMISSION_FAILURE)
    await expect.poll(() => f.sessions!.stopped(id)).toBe(true)
    const snapshot = await f.host.snapshot()
    expect(snapshot.threads.find(thread => thread.id === id)).toMatchObject({ status: 'error', requests: [] })
    expect(snapshot.error).toBe(COMMAND_CENTER_PERMISSION_FAILURE)
    expect((await f.driver.requests()).filter(record => record.method === 'control_response')).toEqual([])
  })

  it('stops without a request card when durable profile resolution itself refuses a native permission', async () => {
    const f = await fixture(), id = await ordinary(f)
    const reason = 'The command center’s tools are unavailable. Reopen the command center to recover.'
    f.adapter.useLaunchProfiles({ profileFor: async threadId => {
      if (threadId === id) throw new CommandCenterProfileRefusal(reason)
      return undefined
    } })
    await f.driver.raisePermission(id, 'Synthetic native permission')
    await expect.poll(() => f.sessions!.stopped(id)).toBe(true)
    const snapshot = await f.host.snapshot()
    expect(snapshot.error).toBe(reason)
    expect(snapshot.threads.find(thread => thread.id === id)).toMatchObject({ status: 'error', requests: [] })
    expect((await f.driver.requests()).filter(record => record.method === 'control_response')).toEqual([])
  })

  it('refuses a known profile disappearing instead of restarting as an ordinary thread', async () => {
    const f = await fixture(), id = await ordinary(f), { value } = admit(f, id)
    await expect(f.adapter.startThreadSession(id)).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    const before = await starts(f)
    f.adapter.useLaunchProfiles({ profileFor: async () => undefined })
    await expect(f.adapter.startThreadSession(id)).rejects.toThrow('profile is no longer available')
    await expect(f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic prompt' }))
      .rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    expect(await starts(f)).toEqual(before)
    expect(value.revoke).toHaveBeenLastCalledWith(expect.stringContaining('profile is no longer available'))
    expect(await f.sessions!.stopped(id)).toBe(true)
  })

  it('preserves an ordinary request cancellation while durable profile resolution is pending', async () => {
    const f = await fixture(), id = await ordinary(f), requestId = randomUUID()
    let release!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const resolver = vi.fn(async () => { await gate; return undefined })
    f.adapter.useLaunchProfiles({ profileFor: resolver })
    await f.action(id, { type: 'raw-burst', frames: [
      { type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion',
        tool_use_id: randomUUID(), input: { questions: [{ question: 'Synthetic choice', header: 'Choice', options: [{ label: 'Blue', description: 'Blue' }], multiSelect: false }] } } },
      { type: 'control_cancel_request', request_id: requestId },
    ] })
    await expect.poll(() => resolver.mock.calls.length).toBe(1)
    release()
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests).toEqual([])
    expect(await f.sessions!.stopped(id)).toBe(false)
  })
})
