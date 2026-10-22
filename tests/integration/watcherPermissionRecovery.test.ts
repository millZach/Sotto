// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  workspace.adapters.grok.state.models[0]!.runtimeModes = ['approval-required', 'auto', 'full-access']
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  let control = f.control
  const makeService = () => new WatcherService({ directory: f.root, host: workspace.host, control, historyEnabled: () => true })
  let service = makeService(), tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); await f.dispose(); await control.closed(); await workspace.stop() })
  const connect = async () => {
    await control.start()
    await control.commandShell({ type: 'connect', provider: 'codex' })
    await control.commandShell({ type: 'connect', provider: 'grok' })
    await service.recover()
  }
  await connect()
  const models = control.watcherSnapshot().models
  return { workspace, codex: models.find(model => model.providerId === 'codex')!, grok: models.find(model => model.providerId === 'grok')!,
    get control() { return control }, get service() { return service },
    restart: async () => {
      service.close(); await tools.close(); control.dispose(); await control.closed()
      control = f.create(); service = makeService(); tools = new WatcherToolServer(service); workspace.host.useWatcherTools(tools)
      await connect()
    },
    savePendingGrok: async () => {
      const project = control.watcherSnapshot().projects.find(item => item.providerId === 'grok')!
      const identity = { target: { hostId: control.hostId()!, threadId: randomUUID() }, projectId: project.id, provider: 'grok' as const,
        creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
      await control.updateWatcher(record => {
        record.lastRuntimeMode = 'auto-accept-edits'; record.current = identity
        record.creation = { identity, modelId: models.find(model => model.providerId === 'grok')!.id, phase: 'intent', replaces: null }
      })
      return identity
    },
  }
}

it('refuses an incompatible remembered mode before first creation and lets the user choose a supported one', async () => {
  const f = await fixture()
  expect(await f.service.setPermission({ runtimeMode: 'auto-accept-edits' })).toMatchObject({ status: 'ok' })
  const projects = f.control.watcherSnapshot().projects
  expect(await f.service.open({ provider: 'grok', modelId: f.grok.id })).toMatchObject({ status: 'refused', code: 'PERMISSION_NOT_COMPARABLE', message: expect.stringContaining('Choose a supported permission mode') })
  expect(f.control.watcherRecord()).toMatchObject({ current: null, creation: null, lastRuntimeMode: 'auto-accept-edits' })
  expect(f.control.watcherSnapshot().projects).toEqual(projects)
  expect(await f.service.setPermission({ runtimeMode: 'approval-required' })).toMatchObject({ status: 'ok' })
  expect(await f.service.open({ provider: 'grok', modelId: f.grok.id })).toMatchObject({ status: 'ok', state: { current: { provider: 'grok' }, currentOptions: { runtimeMode: 'approval-required' } } })
})

it('keeps the current Codex Watcher whole after Allow edits then Grok, and replaces it only after a compatible user choice', async () => {
  const f = await fixture()
  expect(await f.service.open({ provider: 'codex', modelId: f.codex.id })).toMatchObject({ status: 'ok' })
  expect(await f.service.setPermission({ runtimeMode: 'auto-accept-edits' })).toMatchObject({ status: 'ok' })
  const current = f.service.state().current!
  expect(await f.service.open({ provider: 'grok', modelId: f.grok.id })).toMatchObject({ status: 'refused', code: 'PERMISSION_NOT_COMPARABLE' })
  expect(f.control.watcherRecord()).toMatchObject({ current, creation: null, history: [], lastRuntimeMode: 'auto-accept-edits' })
  expect(f.control.watcherSnapshot().threads.find(thread => thread.id === current.target.threadId)).toMatchObject({ kind: 'watcher', runtimeMode: 'auto-accept-edits' })
  expect(await f.service.setPermission({ runtimeMode: 'approval-required' })).toMatchObject({ status: 'ok' })
  expect(await f.service.open({ provider: 'grok', modelId: f.grok.id })).toMatchObject({ status: 'ok', state: { current: { provider: 'grok' }, currentOptions: { runtimeMode: 'approval-required' }, history: [current] } })
  expect(f.service.state().current!.target.threadId).not.toBe(current.target.threadId)
})

it('recovers a persisted missing-thread creation intent by changing its incompatible remembered mode', async () => {
  const f = await fixture(), identity = await f.savePendingGrok()
  await f.restart()
  expect(f.service.state().recoveryNotice).toContain('Choose a supported permission mode')
  expect(f.control.watcherRecord()).toMatchObject({ current: identity, creation: { identity }, lastRuntimeMode: 'auto-accept-edits' })
  expect(f.control.watcherSnapshot().threads.some(thread => thread.id === identity.target.threadId)).toBe(false)
  expect(await f.service.setPermission({ runtimeMode: 'auto-accept-edits' })).toMatchObject({ status: 'refused', code: 'PERMISSION_NOT_COMPARABLE' })
  expect(await f.service.setPermission({ runtimeMode: 'approval-required' })).toMatchObject({ status: 'ok', state: { current: identity, runtimeMode: 'approval-required' } })
  expect(await f.service.open({ provider: 'grok', modelId: f.grok.id })).toMatchObject({ status: 'ok', state: { current: identity, currentOptions: { runtimeMode: 'approval-required' }, recoveryNotice: null } })
  expect(f.control.watcherRecord().creation).toBeNull()
  expect(f.control.watcherRecord().history).toEqual([])
})

it('keeps an uncertain missing-thread creation fenced while the user chooses a new mode', async () => {
  const f = await fixture(), identity = await f.savePendingGrok()
  vi.spyOn(f.control, 'hasPendingThreadWork').mockReturnValue(true)
  expect(await f.service.setPermission({ runtimeMode: 'approval-required' })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
  expect(f.control.watcherRecord()).toMatchObject({ current: identity, creation: { identity }, lastRuntimeMode: 'auto-accept-edits' })
})

it('changes Watcher\'s permissions, model and effort from its room after a prompt on its own thread is set aside', async () => {
  const f = await fixture()
  expect(await f.service.open({ provider: 'codex', modelId: f.codex.id })).toMatchObject({ status: 'ok' })
  const threadId = f.service.state().current!.target.threadId
  const original = { type: 'manual-send' as const, threadId, draftId: randomUUID(), text: 'Synthetic unconfirmed Watcher prompt' }
  const adapter = f.workspace.adapters.codex, execute = adapter.execute.bind(adapter)
  vi.spyOn(adapter, 'execute').mockImplementation(async command => {
    if (command.type === 'send' && command.text === original.text) {
      // The write has an unknown outcome and no echo, so the user sets it aside.
      adapter.commands.push(structuredClone(command))
      return { accepted: false, uncertain: true, error: 'Synthetic lost send acknowledgement' }
    }
    if (command.type === 'configure-thread') {
      // The fake keeps no settings for a started thread; a provider that took the change shows it in its state.
      const native = adapter.state.threads.find(thread => thread.id === command.threadId)!
      for (const key of ['modelId', 'reasoningEffort', 'runtimeMode'] as const) if (command[key] !== undefined) Object.assign(native, { [key]: command[key] })
    }
    return execute(command)
  })
  await f.control.commandShell(original)
  expect((await f.control.commandShell({ type: 'set-aside-send', threadId, draftId: original.draftId })).error).toBeNull()
  const configures = () => adapter.commands.filter(command => command.type === 'configure-thread')
  // Watcher's room sends these with a Watcher origin, but they are the user's choices, as a change in the thread is.
  expect(await f.service.setPermission({ runtimeMode: 'auto-accept-edits' })).toMatchObject({ status: 'ok', state: { currentOptions: { runtimeMode: 'auto-accept-edits' } } })
  expect(configures()).toEqual([expect.objectContaining({ runtimeMode: 'auto-accept-edits' })])
  expect(await f.service.open({ provider: 'codex', modelId: f.codex.id, reasoningEffort: 'high' })).toMatchObject({ status: 'ok' })
  expect(configures()).toEqual([expect.objectContaining({ runtimeMode: 'auto-accept-edits' }), expect.objectContaining({ reasoningEffort: 'high' })])
  expect(f.control.watcherSnapshot().threads.find(thread => thread.id === threadId)).toMatchObject({ runtimeMode: 'auto-accept-edits', reasoningEffort: 'high' })
  // Neither change sends the set-aside prompt again or settles it.
  expect(adapter.commands.filter(command => command.type === 'send' && command.text === original.text)).toHaveLength(1)
  expect(f.control.shell().deliveries?.find(item => item.draftId === original.draftId)).toMatchObject({ status: 'uncertain', setAside: true })
})
