// @vitest-environment node
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CommandCenterLaunchProfiles } from '../../src/main/agents/commandCenterLaunchProfiles'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { emptyCommandCenterRecord } from '../../src/shared/commandCenter'
import type { AgentThread } from '../../src/shared/agents'
import type { CommandCenterProfileTools, ThreadLaunchProfiles } from '../../src/main/agents/host'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }))

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-profile-')); roots.push(root)
  const hostId = randomUUID(), threadId = randomUUID()
  const thread: AgentThread = { id: threadId, hostId, kind: 'command-center', providerId: 'codex', projectId: 'special', title: 'Any title', modelId: 'model', status: 'idle', messages: [], requests: [] }
  const record = emptyCommandCenterRecord()
  record.current = { target: { hostId, threadId }, projectId: 'special', provider: 'codex', creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
  const save = () => writeFile(join(root, 'agents.json'), JSON.stringify({ commandCenter: record }))
  await save()
  const source = new CommandCenterLaunchProfiles(root, () => hostId, id => id === threadId ? thread : undefined)
  const tools: CommandCenterProfileTools = { name: 'sotto_threads', definitions: [{ name: 'list_threads', description: 'Stand in', inputSchema: {} }],
    mcpServer: vi.fn(async () => ({ name: 'sotto_threads', type: 'http' as const, url: 'http://127.0.0.1:12345/mcp', headers: [{ name: 'Authorization', value: 'Bearer fixture' }] })), revoke: vi.fn() }
  source.useTools(tools)
  return { root, hostId, threadId, thread, record, save, source, tools }
}
it('shares a single read for concurrent checks and unchanged creation/admission checks', async () => {
  const f = await setup(), path = join(f.root, 'agents.json'), reads = vi.spyOn(fs, 'readFile')
  await Promise.all(Array.from({ length: 8 }, () => f.source.profileFor('ordinary')))
  await f.source.profileFor(f.threadId)
  await f.source.assertCreationBinding(f.threadId, 'special', 'codex')
  await f.source.profileFor(f.threadId)
  expect(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(1)
})

it('sees an atomic same-size identity replacement on the next check even with its mtime restored', async () => {
  const f = await setup(), path = join(f.root, 'agents.json')
  const store = AtomicJsonStore.compact(path, value => value, () => ({}))
  await store.write({ commandCenter: f.record })
  await f.source.profileFor(f.threadId)
  const before = await fs.stat(path), replacement = randomUUID()
  f.record.current!.target.threadId = replacement
  await store.write({ commandCenter: f.record })
  await fs.utimes(path, before.atime, before.mtime)
  expect((await fs.stat(path)).size).toBe(before.size)
  await expect(f.source.profileFor(f.threadId)).rejects.toThrow('saved identity')
  expect(await f.source.profileFor(replacement)).toMatchObject({ kind: 'command-center' })
})

it.each(['current', 'creation', 'history'] as const)('retains last known %s identity only for refusal when the file becomes corrupt', async location => {
  const f = await setup(), identity = f.record.current!
  f.record.current = null
  if (location === 'current') f.record.current = identity
  else if (location === 'history') f.record.history = [identity]
  else f.record.creation = { phase: 'intent', identity, replaces: null }
  await f.save()
  await f.source.profileFor('ordinary')
  f.thread.kind = 'project'
  await writeFile(join(f.root, 'agents.json'), '{')
  await expect(f.source.profileFor(f.threadId)).rejects.toThrow('saved identity')
  expect(await f.source.profileFor('ordinary')).toBeUndefined()
  expect(f.tools.mcpServer).not.toHaveBeenCalled()
  await writeFile(join(f.root, 'agents.json'), '{}')
  expect(await f.source.profileFor(f.threadId)).toBeUndefined()
})

it('isolates unknown ordinary kinds but refuses both special kinds when identity is invalid', async () => {
  const f = await setup()
  await writeFile(join(f.root, 'agents.json'), '{"commandCenter":{"version":999}}')
  await expect(f.source.profileFor(f.threadId)).rejects.toThrow('saved identity')
  f.thread.kind = 'command-center-history'
  await expect(f.source.profileFor(f.threadId)).rejects.toThrow('saved identity')
  delete f.thread.kind
  expect(await f.source.profileFor(f.threadId)).toBeUndefined()
  await writeFile(join(f.root, 'agents.json'), '{}')
  expect(await f.source.profileFor(f.threadId)).toBeUndefined()
  expect(f.tools.revoke).toHaveBeenCalledTimes(2)
})

it('does not cache or admit an identity replaced during the read', async () => {
  const f = await setup(), path = join(f.root, 'agents.json'), read = fs.readFile
  let replaced = false
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const value = await read(...args)
    if (args[0] === path && !replaced) { replaced = true; f.record.current = null; await f.save() }
    return value
  })
  await expect(f.source.profileFor(f.threadId)).rejects.toThrow('saved identity')
  expect(f.tools.mcpServer).not.toHaveBeenCalled()
})
it('uses only the durable current identity, corroborated by host, kind, project and provider', async () => {
  const f = await setup()
  expect(await f.source.profileFor('ordinary')).toBeUndefined()
  expect(await f.source.profileFor(f.threadId)).toMatchObject({ kind: 'command-center', toolNames: ['list_threads'] })
  await f.source.assertCreationBinding(f.threadId, 'special', 'codex')
  await expect(f.source.assertCreationBinding(f.threadId, 'special', 'claude')).rejects.toThrow('saved identity')
  await expect(f.source.assertCreationBinding(f.threadId, 'other-project', 'codex')).rejects.toThrow('saved identity')
  f.thread.kind = 'project'
  await expect(f.source.profileFor(f.threadId)).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
  f.thread.kind = 'command-center'; f.thread.providerId = 'claude'
  await expect(f.source.profileFor(f.threadId)).rejects.toThrow('saved identity')
  f.thread.providerId = 'codex'; f.record.current!.target.hostId = randomUUID(); await f.save()
  await expect(f.source.profileFor(f.threadId)).rejects.toThrow('saved identity')
})
it('refuses forged kinds, history, absent servers and revoked admission with a recovery reason', async () => {
  const f = await setup()
  const offered = await f.source.profileFor(f.threadId)
  offered!.revoke('Session stopped. Reopen to recover.')
  expect(f.tools.revoke).toHaveBeenCalledWith(f.threadId)
  await expect(f.source.profileFor(f.threadId)).rejects.toThrow('Reopen to recover')
  f.record.history = [f.record.current!]; f.record.current = null; await f.save()
  await expect(f.source.profileFor(f.threadId)).rejects.toThrow('earlier command center')
  f.record.history = []; await f.save()
  await expect(f.source.profileFor(f.threadId)).rejects.toThrow('saved identity')
  const noServer = await setup()
  const unadmitted = new CommandCenterLaunchProfiles(noServer.root, () => noServer.hostId, () => noServer.thread)
  await expect(unadmitted.profileFor(noServer.threadId)).rejects.toThrow('tool server is unavailable')
})
it('maps profile lookups through Sotto bindings and unbound early-start identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-profile-')); roots.push(root)
  await mkdir(root, { recursive: true })
  const registry = new ThreadRegistry(root); await registry.load()
  registry.reserve('sotto-master', 'codex', 'native-master', 'special'); await registry.flush()
  class ProfileFake extends FakeProviderHost {
    profiles: ThreadLaunchProfiles | undefined
    useLaunchProfiles(profiles: ThreadLaunchProfiles): void { this.profiles = profiles }
    async startThreadSession(id: string): Promise<void> { await this.profiles?.profileFor(id) }
  }
  const inner = new ProfileFake(), wrapper = new SottoThreadHost('codex', inner, registry)
  const source = { profileFor: vi.fn<ThreadLaunchProfiles['profileFor']>(async () => undefined) }
  wrapper.useLaunchProfiles(source)
  await inner.profiles!.profileFor('native-master')
  expect(source.profileFor).toHaveBeenLastCalledWith('sotto-master')
  await wrapper.startThreadSession('unbound-master', { modelId: 'model' })
  expect(source.profileFor).toHaveBeenLastCalledWith('unbound-master')
  await inner.profiles!.profileFor('unknown-native')
  expect(source.profileFor).toHaveBeenCalledTimes(2)
  source.profileFor.mockImplementation(async () => ({ kind: 'command-center', server: { name: 'sotto_threads', type: 'http',
    url: 'http://127.0.0.1:12345/mcp', headers: [] }, toolNames: ['list_threads'], revoke: vi.fn() }))
  await wrapper.listThreadSkills('unbound-master', true, { providerId: 'codex', workingDirectory: root }).catch(() => undefined)
  expect(source.profileFor).toHaveBeenLastCalledWith('unbound-master')
})

it('normalizes failed admission and changed durable identity without exposing provider error text', async () => {
  const f = await setup()
  f.tools.mcpServer = async () => { throw new Error('fixture secret protocol body') }
  await expect(f.source.profileFor(f.threadId)).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: expect.not.stringContaining('fixture secret') })
  expect(f.tools.revoke).toHaveBeenCalledWith(f.threadId)
  const changing = await setup()
  const original = changing.tools.mcpServer
  changing.tools.mcpServer = async id => { changing.record.current = null; await changing.save(); return original(id) }
  await expect(changing.source.profileFor(changing.threadId)).rejects.toMatchObject({ code: 'READ_ONLY_PROFILE_UNAVAILABLE' })
  expect(changing.tools.revoke).toHaveBeenCalledWith(changing.threadId)
})

it('preflights unstarted master settings and refuses provider or working-copy changes before local mutation', async () => {
  let f = await workspaceFixture()
  try {
    await f.host.connect('codex'); const snapshot = await f.host.connect('claude')
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const other = snapshot.models.find(model => model.providerId === 'claude')!
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: project.id, title: 'Draft master', modelId: model.id, workingCopy: 'shared' })
    const thread = f.host.workspaceSnapshot().threads.find(thread => thread.id === id)!
    await f.stop()
    const disk = JSON.parse(await readFile(join(f.root, 'workspace.json'), 'utf8'))
    disk.snapshot.threads.find((thread: AgentThread) => thread.id === id).kind = 'command-center'
    await writeFile(join(f.root, 'workspace.json'), JSON.stringify(disk))
    const record = emptyCommandCenterRecord()
    record.current = { target: { hostId: thread.hostId!, threadId: id }, projectId: project.id, provider: 'codex', creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
    await writeFile(join(f.root, 'agents.json'), JSON.stringify({ commandCenter: record }))
    f = await workspaceFixture(f.root)
    const fixture = await setup(); f.host.useCommandCenterTools(fixture.tools)
    await f.host.connect('codex'); await f.host.connect('claude')
    let before = f.host.workspaceSnapshot().threads.find(thread => thread.id === id)!
    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: other.id })).rejects.toThrow('new command-center conversation')
    expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high' })).accepted).toBe(true)
    before = f.host.workspaceSnapshot().threads.find(thread => thread.id === id)!
    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' })).rejects.toThrow('cannot be widened')
    await expect(f.host.configureThreadWorkingCopy(id, { workingCopy: 'independent' })).rejects.toThrow('working folder cannot be changed')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === id)).toEqual(before)
  } finally { await f.stop(); await f.remove() }
})
