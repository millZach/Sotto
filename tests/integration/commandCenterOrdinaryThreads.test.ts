// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHostSnapshot, AgentThread } from '../../src/shared/agents'
import { CommandCenterLaunchProfiles } from '../../src/main/agents/commandCenterLaunchProfiles'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { emptyCommandCenterRecord } from '../../src/shared/commandCenter'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { devinFixture } from '../fixtures/devinFixture'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }))

const factories = { claude: claudeFixture, codex: codexFixture, grok: () => grokFixture(undefined, 2000, 60000), devin: devinFixture }
const cleanups: (() => Promise<void>)[] = []
async function nativePid(provider: keyof typeof factories, f: { root: string; realId(id: string): Promise<string> }, adapterId: string): Promise<number> {
  const sessionId = await f.realId(adapterId)
  if (provider === 'claude') return Number(await fs.readFile(join(f.root, `alive-${sessionId}.json`), 'utf8'))
  if (provider === 'devin') return Number(await fs.readFile(join(f.root, `owner-${sessionId}.json`), 'utf8'))
  const records = (await fs.readFile(join(f.root, provider === 'codex' ? 'servers.jsonl' : 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return provider === 'codex' ? Number(records.findLast(record => record.threadId === sessionId)?.pid)
    : Number(records.findLast(record => record.method === 'fixture/process')?.params?.pid)
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

for (const provider of ['claude', 'codex', 'grok', 'devin'] as const) describe(`${provider} ordinary profile isolation`, () => {
  it('reads unchanged agents.json once across workspace send, early start and read', async () => {
    const f = await factories[provider](); cleanups.push(f.cleanup)
    const directory = join(f.root, 'workspace')
    await fs.mkdir(directory); await fs.writeFile(join(directory, 'agents.json'), '{}')
    const reads = vi.spyOn(fs, 'readFile')
    const host = new WorkspaceHost(f.host, directory)
    cleanups.push(() => host.close())
    const snapshot = await host.connect(provider)
    const modelId = snapshot.models[0]!.id
    const projectId = randomUUID(), threadId = randomUUID()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId, title: 'Fixture', path: f.root, provider })
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId, title: 'Worker', modelId, workingCopy: 'shared' })
    await host.startThreadSession(threadId)
    expect((await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Synthetic prompt' })).accepted).toBe(true)
    await host.refreshThread(threadId)
    expect(reads.mock.calls.filter(([path]) => path === join(directory, 'agents.json'))).toHaveLength(1)
  })

  it.each(['corrupt', 'invalid record', 'unreadable'] as const)('keeps ordinary launch and permission cards with %s identity', async failure => {
    const f = await factories[provider](); cleanups.push(f.cleanup)
    const path = join(f.root, 'agents.json')
    await fs.writeFile(path, failure === 'corrupt' ? '{' : failure === 'invalid record' ? '{"commandCenter":{"version":999}}' : '{}')
    if (failure === 'unreadable') {
      const read = fs.readFile
      vi.spyOn(fs, 'readFile').mockImplementation((...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === path) return Promise.reject(Object.assign(new Error('Synthetic read denial'), { code: 'EACCES' }))
        return read(...args)
      })
    }
    const hostId = randomUUID(), threadId = randomUUID(), master = randomUUID()
    const source = new CommandCenterLaunchProfiles(f.root, () => hostId, id => ({ id, hostId,
      kind: id === master ? 'command-center' : 'project', providerId: provider, projectId: f.projectId,
      title: 'Fixture', modelId: f.modelId, status: 'idle', messages: [], requests: [] } as AgentThread))
    f.host.useLaunchProfiles!(source)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Worker', modelId: f.modelId })
    await f.host.startThreadSession!(threadId, { modelId: f.modelId, workingDirectory: f.root })
    expect((await f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Synthetic prompt' })).accepted).toBe(true)
    await f.driver.raisePermission(threadId, 'Synthetic permission')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === threadId)?.requests[0]?.kind).toBe('permission')
    const snapshot = await f.host.snapshot(), thread = snapshot.threads.find(thread => thread.id === threadId)!
    expect(snapshot.error ?? '').not.toMatch(/command.center/iu)
    expect(thread.requestNotice ?? '').not.toMatch(/command.center/iu)
    await expect(f.host.startThreadSession!(master, { modelId: f.modelId, workingDirectory: f.root })).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
  })

  it('handles ordinary requests without consulting a newly failing resolver', async () => {
    const f = await factories[provider](); cleanups.push(f.cleanup)
    await f.host.connect()
    const threadId = randomUUID()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
    f.host.useLaunchProfiles!({ profileFor: async () => undefined })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Worker', modelId: f.modelId })
    const resolver = vi.fn(async () => { throw new Error('Synthetic failing identity check') })
    let latest: AgentHostSnapshot | undefined
    const unsubscribe = f.host.subscribe(snapshot => { latest = snapshot })
    cleanups.push(async () => { unsubscribe() })
    f.host.useLaunchProfiles!({ profileFor: resolver })
    await f.driver.raisePermission(threadId, 'Synthetic ordinary permission')
    await expect.poll(() => latest?.threads.find(thread => thread.id === threadId)?.requests[0]?.kind).toBe('permission')
    expect(resolver).not.toHaveBeenCalled()
  })

  it.each(['send', 'configure', 'stale refusal'] as const)('handles a disk-change workspace %s without retaining an unverified process or stopping its replacement', async action => {
    const f = await factories[provider](); cleanups.push(f.cleanup)
    const directory = join(f.root, 'workspace')
    await fs.mkdir(directory); await fs.writeFile(join(directory, 'agents.json'), '{}')
    const registry = new ThreadRegistry(directory)
    const hosts = { claude: new FakeProviderHost(), codex: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() }
    const native = new ConfiguredProviderHost({ directory, provider: () => provider, enabledProviders: () => [provider],
      threadProvider: id => registry.byThread(id)?.provider,
      hosts: { ...hosts, [provider]: new SottoThreadHost(provider, f.host, registry) } })
    const host = new WorkspaceHost(native, directory)
    cleanups.push(async () => { await host.close(); await registry.flush() })
    const snapshot = await host.connect(provider)
    const modelId = snapshot.models.find(model => model.providerId === provider)!.id
    const projectId = randomUUID(), threadId = randomUUID()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId, title: 'Fixture', path: f.root, provider })
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId, title: 'Worker', modelId, workingCopy: 'shared' })
    await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Synthetic original turn' })
    const adapterId = registry.byThread(threadId)!.sessionId, pid = await nativePid(provider, f, adapterId)
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).not.toThrow()
    const record = emptyCommandCenterRecord()
    record.current = { target: { hostId: host.workspaceSnapshot().threads.find(thread => thread.id === threadId)!.hostId!, threadId },
      projectId, provider: provider === 'devin' ? 'codex' : provider, creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
    await fs.writeFile(join(directory, 'agents.json'), JSON.stringify({ commandCenter: record }))
    if (action === 'stale refusal') {
      const profiles = (host as unknown as { launchProfiles: CommandCenterLaunchProfiles }).launchProfiles
      const resolve = profiles.profileFor.bind(profiles)
      let first = true
      const { promise: waiting, resolve: entered } = deferred<void>()
      const { promise: gate, resolve: release } = deferred<void>()
      vi.spyOn(profiles, 'profileFor').mockImplementation(async id => {
        if (!first) return resolve(id)
        first = false
        try { return await resolve(id) } catch (error) { entered(); await gate; throw error }
      })
      const sending = host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Synthetic stale turn' })
      const refused = expect(sending).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
      try {
        await waiting
        await fs.writeFile(join(directory, 'agents.json'), '{}')
        host.disconnect(); await f.adapter.closed(); await host.connect(provider)
        await native.startThreadSession(threadId)
        const replacement = await nativePid(provider, f, adapterId)
        expect(replacement).not.toBe(pid)
        release(); await refused
        await native.refreshThread(threadId)
        expect(await nativePid(provider, f, adapterId)).toBe(replacement)
        expect(() => process.kill(replacement, 0)).not.toThrow()
      } finally { release(); await refused }
      return
    }
    const command = action === 'send'
      ? { type: 'send' as const, commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Synthetic refused turn' }
      : { type: 'configure-thread' as const, commandId: randomUUID(), threadId, reasoningEffort: 'high' }
    await expect(host.execute(command)).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    await expect.poll(() => {
      try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
    }).toBe(true)
    const promptMethod = provider === 'claude' ? 'user' : provider === 'codex' ? 'turn/start' : 'session/prompt'
    expect((await f.driver.requests()).filter(request => request.method === promptMethod)).toHaveLength(1)
  })
})

it.each(['send', 'refresh', 'skills', 'short text', 'rollback'] as const)('stops a retained early process after a switched draft is refused by %s', async action => {
  const claude = await claudeFixture(), codex = await codexFixture()
  cleanups.push(claude.cleanup, codex.cleanup)
  const directory = join(claude.root, 'workspace')
  await fs.mkdir(directory); await fs.writeFile(join(directory, 'agents.json'), '{}')
  const registry = new ThreadRegistry(directory)
  const native = new ConfiguredProviderHost({ directory, provider: () => 'claude', enabledProviders: () => ['claude', 'codex'],
    threadProvider: id => registry.byThread(id)?.provider,
    hosts: { claude: new SottoThreadHost('claude', claude.host, registry), codex: new SottoThreadHost('codex', codex.host, registry),
      grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
  const host = new WorkspaceHost(native, directory)
  cleanups.push(async () => { await host.close(); await registry.flush() })
  await host.connect('claude')
  const snapshot = await host.connect('codex')
  const projectId = randomUUID(), threadId = randomUUID()
  await host.execute({ type: 'create-project', commandId: randomUUID(), projectId, title: 'Fixture', path: claude.root, provider: 'claude' })
  await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId, title: 'Worker',
    modelId: snapshot.models.find(model => model.providerId === 'claude')!.id, workingCopy: 'shared' })
  await host.startThreadSession(threadId)
  const alive = (await fs.readdir(claude.root)).find(name => name.startsWith('alive-'))!
  const earlyPid = Number(await fs.readFile(join(claude.root, alive), 'utf8'))
  expect(() => process.kill(earlyPid, 0)).not.toThrow()
  await host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId,
    modelId: snapshot.models.find(model => model.providerId === 'codex')!.id })
  await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Synthetic first turn' })
  expect(registry.byThread(threadId)?.provider).toBe('codex')
  const boundPid = await nativePid('codex', codex, registry.byThread(threadId)!.sessionId)
  expect(() => process.kill(earlyPid, 0)).not.toThrow()
  const record = emptyCommandCenterRecord()
  record.current = { target: { hostId: host.workspaceSnapshot().threads.find(thread => thread.id === threadId)!.hostId!, threadId },
    projectId, provider: 'codex', creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
  await fs.writeFile(join(directory, 'agents.json'), JSON.stringify({ commandCenter: record }))
  const refused = action === 'send' ? host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Synthetic refused turn' })
    : action === 'refresh' ? host.refreshThread(threadId)
    : action === 'skills' ? host.listThreadSkills(threadId)
    : action === 'short text' ? host.writeShortText(threadId, { instruction: 'Synthetic instruction', material: 'Synthetic material' })
    : host.rollbackThread(threadId, 1, [host.workspaceSnapshot().threads.find(thread => thread.id === threadId)!.messages.find(message => message.role === 'user')!.id])
  await expect(refused).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
  for (const pid of [earlyPid, boundPid]) await expect.poll(() => {
    try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  }).toBe(true)
})

it('cancels a Claude early launch refused while its tool server is still starting', async () => {
  const f = await claudeFixture(); cleanups.push(f.cleanup)
  cleanups.push(async () => {
    // The regression exposes an untracked child on the old implementation; clean up only this fake's own PID markers.
    for (const name of (await fs.readdir(f.root)).filter(name => name.startsWith('alive-'))) {
      const pid = Number(await fs.readFile(join(f.root, name), 'utf8').catch(() => '0'))
      if (pid > 0) try { process.kill(pid) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  })
  await f.host.connect()
  const threadId = randomUUID(), hostId = randomUUID(), path = join(f.root, 'agents.json')
  await fs.writeFile(path, '{}')
  f.host.useLaunchProfiles!(new CommandCenterLaunchProfiles(f.root, () => hostId, id => ({ id, hostId,
    kind: 'project', providerId: 'claude', projectId: f.projectId, title: 'Fixture', modelId: f.modelId,
    status: 'idle', messages: [], requests: [] } as AgentThread)))
  const launches = (await f.driver.requests()).filter(request => ['launch', 'resume'].includes(request.method ?? ''))
  const { promise: waiting, resolve: entered } = deferred<void>(), { promise: gate, resolve: release } = deferred<void>()
  f.host.useThreadTools!([{ name: 'fixture_tools', definitions: [], mcpServer: async () => { entered(); await gate; return undefined } }])
  const starting = f.host.startThreadSession!(threadId, { modelId: f.modelId, workingDirectory: f.root })
  try {
    await waiting
    const record = emptyCommandCenterRecord()
    record.current = { target: { hostId, threadId }, projectId: f.projectId, provider: 'claude',
      creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
    await fs.writeFile(path, JSON.stringify({ commandCenter: record }))
    await expect(f.host.listThreadSkills!(threadId)).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
    release(); await starting
    expect((await f.driver.requests()).filter(request => ['launch', 'resume'].includes(request.method ?? ''))).toEqual(launches)
  } finally {
    release(); await starting
  }
})

it('publishes an ordinary Claude permission synchronously before the following frame', async () => {
  const f = await claudeFixture(); cleanups.push(f.cleanup)
  await f.host.connect()
  const threadId = randomUUID(), requestId = randomUUID(), messageId = randomUUID()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Fixture', path: f.root })
  f.host.useLaunchProfiles!({ profileFor: async () => undefined })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Worker', modelId: f.modelId })
  const order: string[] = []
  const unsubscribe = f.host.subscribe(snapshot => {
    if (snapshot.threads.find(thread => thread.id === threadId)?.requests.some(request => request.id === requestId) && !order.includes('permission')) order.push('permission')
  })
  const unsubscribeEvents = f.host.subscribeEvents!(event => {
    if (event.event.kind === 'message-added' && event.event.message.id === messageId) order.push('following frame')
  })
  cleanups.push(async () => { unsubscribe(); unsubscribeEvents() })
  await f.action(threadId, { type: 'raw-burst', frames: [
    { type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: randomUUID(), input: { command: 'synthetic' } } },
    { type: 'assistant', uuid: messageId, message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic following frame' }] } },
  ] })
  await expect.poll(() => order).toEqual(['permission', 'following frame'])
})
