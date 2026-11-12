// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { GitActions } from '../../src/main/agents/git/gitActions'
import { GitStatusReader } from '../../src/main/agents/git/gitStatus'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { PROJECT_FOLDER_MISSING, type AgentHostSnapshot, type AgentProject } from '../../src/shared/agents'
import { watcherToolSchemas } from '../../src/shared/watcher'
import type { WatcherRemoteHosts } from '../../src/shared/watcherHost'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

// November 12, 2026: Zach asked Watcher to start a thread in D:\AI Sentiment Index, a folder that was not a project, and
// start_thread refused it as unavailable. Watcher had no way to add a folder as a project, or to make one.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  workspace.host.setGitActions(new GitActions({ status: new GitStatusReader({ fetchIntervalMs: () => 30_000 }), writeCommitMessage: async () => null, writePullRequestText: async () => null }))
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => true, watcherEnabled: true } })
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcherId = service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
  const requestId = service.state().requests.at(-1)!.id
  const call = async <N extends keyof typeof watcherToolSchemas>(name: N, input: unknown) =>
    watcherToolSchemas[name].output.parse((await tools.call(watcherId, name, input)).structuredContent)
  const add = (input: object, retryKey = randomUUID()) => call('add_project', { requestId, retryKey, ...input })
  const hostId = f.control.hostId()!
  return { ...f, workspace, service, call, add, requestId, model, hostId }
}

it('adds an existing folder on This computer as a project that start_thread uses at once, and answers a retry as the first call did', async () => {
  const f = await fixture()
  const path = join(f.workspace.root, 'AI Sentiment Index')
  await mkdir(path)
  const retryKey = randomUUID()
  const added = await f.add({ path }, retryKey)
  if (added.status !== 'ok') throw new Error(added.message)
  expect(added).toMatchObject({ project: { target: { hostId: f.hostId }, title: 'AI Sentiment Index', displayRoot: path }, folderMade: false, gitInitialized: false, alreadyAdded: false })
  const listed = await f.call('list_projects', { query: 'Sentiment' })
  expect(listed).toMatchObject({ status: 'ok', projects: [{ target: added.project.target, title: 'AI Sentiment Index' }] })
  // The window's selection stays where it was: Watcher chose no project to show.
  expect(f.control.shell().activeProjectId).not.toBe(added.project.target.projectId)
  const started = await f.call('start_thread', { requestId: f.requestId, retryKey: randomUUID(), project: added.project.target, modelId: f.model.id,
    title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt' })
  expect(started).toMatchObject({ status: 'ok' })
  // The same key answers as the first call; a new one finds the project already there and adds nothing more.
  expect(await f.add({ path }, retryKey)).toEqual(added)
  expect(await f.add({ path })).toMatchObject({ status: 'ok', project: { target: added.project.target }, alreadyAdded: true })
  expect(f.control.shell().host.projects.filter(item => item.path === path)).toHaveLength(1)
  expect(await f.add({ path: join(path, 'other') }, retryKey)).toMatchObject({ status: 'refused', code: 'RETRY_KEY_CONFLICT' })
})

it('makes a new folder anywhere with Git when asked, or by title in the default projects directory', async () => {
  const f = await fixture()
  const path = join(f.workspace.root, 'anywhere', 'Fresh Index')
  const made = await f.add({ path, newFolder: true, gitInit: true })
  expect(made).toMatchObject({ status: 'ok', project: { title: 'Fresh Index', displayRoot: path }, folderMade: true, gitInitialized: true, alreadyAdded: false })
  expect((await stat(join(path, '.git'))).isDirectory()).toBe(true)
  // Asked again with a new key, the project it made is the answer, not a refusal that the folder already exists.
  expect(await f.add({ path, newFolder: true, gitInit: true })).toMatchObject({ status: 'ok', folderMade: false, gitInitialized: false, alreadyAdded: true })
  const directory = join(f.workspace.root, 'Projects')
  await mkdir(directory)
  expect((await f.control.commandShell({ type: 'configure', patch: { projectsDirectory: directory } })).error).toBeNull()
  expect(await f.add({ title: 'Titled', newFolder: true })).toMatchObject({ status: 'ok', project: { title: 'Titled', displayRoot: join(directory, 'Titled') }, folderMade: true, gitInitialized: false })
  await expect(stat(join(directory, 'Titled', '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('adds nothing outside the user’s own request, and refuses what it cannot do in plain words', async () => {
  const f = await fixture()
  const before = f.control.shell().host.projects.length
  const existing = join(f.workspace.root, 'Existing')
  await mkdir(existing)
  expect(await f.call('add_project', { requestId: randomUUID(), retryKey: randomUUID(), path: existing })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(await f.add({ path: existing, gitInit: true })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT', message: expect.stringContaining('gitInit runs only in a folder Sotto makes') })
  expect(await f.add({ newFolder: true })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT', message: expect.stringContaining('absolute path') })
  expect(await f.add({ path: join(f.workspace.root, 'Missing') })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT', message: PROJECT_FOLDER_MISSING })
  expect(await f.add({ path: existing, newFolder: true })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT', message: expect.stringContaining('That folder already exists') })
  expect(await f.add({ path: join(f.root, 'watcher', 'workspace') })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT', message: expect.stringContaining('Sotto\'s own') })
  expect(f.control.shell().host.projects).toHaveLength(before)
})

it('adds and makes projects on a connected machine with that machine’s own create-project, and sets up Git there only where it can', async () => {
  const f = await fixture()
  const remoteId = randomUUID(), sent: unknown[] = []
  let projects: AgentProject[] = [], gitInit = false
  const snapshot = () => ({ ...f.control.watcherSnapshot(), hostId: remoteId, projects, threads: [] }) as AgentHostSnapshot
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: remoteId, name: 'forge', control: false, reads: false, gitInit, connected: true, permissionCeiling: 'approval-required' }],
    read: async () => { throw new Error('Synthetic host reads nothing') }, control: async () => { throw new Error('Synthetic host controls nothing') },
    snapshot: id => id === remoteId ? snapshot() : undefined, subscribe: () => () => undefined,
    addProject: async (_id, command) => {
      sent.push(command)
      if (command.path === '/home/zach/Refused') throw new Error('That folder no longer exists. Nothing was added. Choose another folder.')
      const path = command.path ?? `/home/zach/Projects/${command.title}`
      projects = [...projects, { id: `project-${projects.length}`, title: command.title, path } as AgentProject]
      return projects
    },
  }
  f.service.useRemoteHosts(remote)
  expect(await f.add({ hostId: remoteId, path: '/home/zach/AI Sentiment Index/' })).toMatchObject({ status: 'ok',
    project: { target: { hostId: remoteId, projectId: 'project-0' }, title: 'AI Sentiment Index' }, folderMade: false, alreadyAdded: false })
  expect(sent).toEqual([{ title: 'AI Sentiment Index', path: '/home/zach/AI Sentiment Index/', useExisting: true }])
  expect(await f.add({ hostId: remoteId, title: 'Fresh', newFolder: true, gitInit: true })).toMatchObject({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE' })
  expect(sent).toHaveLength(1)
  gitInit = true
  expect(await f.add({ hostId: remoteId, title: 'Fresh', newFolder: true, gitInit: true })).toMatchObject({ status: 'ok',
    project: { target: { hostId: remoteId, projectId: 'project-1' }, displayRoot: '/home/zach/Projects/Fresh' }, folderMade: true, gitInitialized: true })
  expect(sent.at(-1)).toEqual({ title: 'Fresh', gitInit: true })
  // A new folder that is already one of the machine's projects is that project, and the machine is not asked again.
  expect(await f.add({ hostId: remoteId, path: '/home/zach/Projects/Fresh', newFolder: true })).toMatchObject({ status: 'ok', project: { target: { projectId: 'project-1' } }, alreadyAdded: true })
  expect(sent).toHaveLength(2)
  expect(await f.add({ hostId: remoteId, path: '/home/zach/Refused' })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT', message: PROJECT_FOLDER_MISSING })
  expect(await f.add({ hostId: randomUUID(), path: '/home/zach/Elsewhere' })).toMatchObject({ status: 'refused', code: 'UNKNOWN_TARGET' })
})
