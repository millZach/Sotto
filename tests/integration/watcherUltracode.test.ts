// @vitest-environment node
// Ultracode is a person's choice for a thread, never Watcher's (ADR-0148): Watcher neither lists it among a worker
// model's levels, nor starts a worker on it, nor lands on it from the new-thread default.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas } from '../../src/shared/watcher'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  // The fake Claude model reports Extra high, so Claude Code's catalog would offer Ultracode after Max.
  for (const model of workspace.adapters.claude.state.models) model.reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => true, watcherEnabled: true } })
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  for (const id of ['codex', 'claude'] as const) await f.control.commandShell({ type: 'connect', provider: id })
  await service.recover()
  const watcherModel = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: watcherModel.id })).toMatchObject({ status: 'ok' })
  const id = service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
  const requestId = service.state().requests.at(-1)!.id
  const call = async <N extends keyof typeof watcherToolSchemas>(name: N, input: unknown) =>
    watcherToolSchemas[name].output.parse((await tools.call(id, name, input)).structuredContent)
  const claude = f.control.shell().host.models.find(item => item.providerId === 'claude')!
  const project = f.control.shell().host.projects.find(item => item.providerId === 'claude')!
  const start = (extra: Record<string, unknown> = {}) => call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: project.id },
    modelId: claude.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt', ...extra })
  return { f, workspace, call, claude, project, start }
}

it('lists a Claude worker model\'s levels without Ultracode', async () => {
  const { call, claude, project } = await fixture()
  expect(claude.reasoningEfforts).toContain('ultracode')
  const listed = await call('list_projects', { includeModels: true })
  if (listed.status !== 'ok' || !('projects' in listed)) throw new Error('list refused')
  const worker = listed.projects.find(item => item.target.projectId === project.id)!.workers!.find(item => item.modelId === claude.id)!
  expect(worker.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
})

it('refuses a worker it names Ultracode for, and lands a new-thread default of Ultracode on Max', async () => {
  const { f, workspace, claude, start } = await fixture()
  expect(await start({ reasoningEffort: 'ultracode' })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })

  await f.control.commandShell({ type: 'configure', patch: { newThreadModelId: claude.id, newThreadReasoningEffort: 'ultracode' } })
  const started = await start()
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  // What reached Claude's adapter: the default's place among the levels, with Ultracode left out.
  const created = workspace.adapters.claude.commands.filter(command => command.type === 'create-thread')
  expect(created).toHaveLength(1)
  expect(created[0]).toMatchObject({ reasoningEffort: 'max' })
})
