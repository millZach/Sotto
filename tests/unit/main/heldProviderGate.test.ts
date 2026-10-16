// @vitest-environment node
/**
 * The held-provider gate holds whatever its set names (#1102). Muse is the one held provider today; each case here runs
 * for Muse and for Grok Build standing in as a second, test-only held provider, and expects the same holding of both.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { immutableModels, isImmutableModels } from '../../../src/main/agents/activitySnapshots'
import {
  catalogWithoutHeld, heldProviderChosenBy, heldProviderOfClientUpdateEnumeration, heldProviderOfCommand, heldProviderOfModelId,
  heldProviderOfProjectId, heldProviderOfThread, heldProviderOfThreadRecord, heldProviderOfWatcherRequest, heldProviderRefusedBy,
  HeldProviderHost, heldWatcherRefusal, modelsWithoutHeld, rememberDormantProviderThreads, type DormantProviderThread,
} from '../../../src/main/agents/heldProviderGate'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { RetainedDraftStore, type RetainedDraft } from '../../../src/main/agents/retainedDraftStore'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { watcherRoomInputs } from '../../../src/main/agents/watcherRoomInput'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState, inactiveLocalHost } from '../../../src/main/hosts/inactiveLocalHost'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, PROVIDER_LABELS, publicProviderEntityId, type AgentCommand, type AgentHostSnapshot,
  type AgentState, type ProviderClientUpdate } from '../../../src/shared/agents'
import { HELD_PROVIDER_ENTRIES, heldProviderRefusal, heldProvidersOf, heldProvidersOption, releasesHeldProvider, type HeldProviderEntry } from '../../../src/shared/heldProviders'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { HostRequest } from '../../../src/shared/hostProtocol'
import { watcherHostControlSchema, watcherHostReadSchema, type WatcherHostControl, type WatcherHostRead } from '../../../src/shared/watcherHost'
import { agentControlFixture } from '../../fixtures/agentControlFixture'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { centerHostId, centerTime, watcherRecordFixture, watcherToolFixtures } from '../../fixtures/watcher'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-held-provider-gate-'))
  cleanup.push(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return root
}

/** Muse, as today, and Grok Build held only by this suite's own set. */
const HELD = new Set(['muse', 'grok'] as const)
const providers = ['muse', 'grok'] as const
type Held = typeof providers[number]
const refusal = (provider: Held) => `${PROVIDER_LABELS[provider]} is available in Sotto Owl. Open an Owl build to continue. Nothing was sent.`

const record = watcherRecordFixture(), master = record.current!
const { id: requestId, watcher, rootUserMessageId, createdAt } = record.requests[0]!
const request = { id: requestId, watcher, rootUserMessageId, createdAt }, operation = record.operations[0]!
const read = (name: NonNullable<WatcherHostRead['call']>['name'], input: unknown): WatcherHostRead => watcherHostReadSchema.parse({ master, call: { name, input } })
const control = (name: WatcherHostControl['call']['name'], input: unknown): WatcherHostControl =>
  watcherHostControlSchema.parse({ master, request, ceiling: 'approval-required', operation, call: { name, input } })

/** A host with an ordinary Codex thread and one of `provider`'s, its models and projects native, scoped and label-only. */
function hostState(provider: Held): AgentState {
  const state = emptyDesktopState(centerHostId), label = PROVIDER_LABELS[provider]
  state.host.connected = true; state.connection = 'connected'
  state.host.models = [{ id: 'model', providerId: 'codex', provider: 'Codex', name: 'Ordinary', ready: true },
    { id: 'native-model', providerId: provider, provider: label, name: label, ready: true },
    { id: publicProviderEntityId(provider, 'model', 'scoped-model'), providerId: provider, provider: label, name: 'Scoped', ready: true },
    { id: 'label-model', provider: label, name: 'Label only', ready: true }]
  state.host.projects = [{ id: 'project', providerId: 'codex', title: 'Ordinary', path: '/ordinary' },
    { id: 'shared', title: 'Shared', path: '/shared' },
    { id: 'native-project', providerId: provider, title: label, path: '/held' },
    { id: publicProviderEntityId(provider, 'project', 'scoped-project'), providerId: provider, title: 'Scoped', path: '/scoped' }]
  state.host.threads = [{ id: 'worker', providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Ordinary', status: 'idle', messages: [], requests: [] },
    { id: 'held-worker', providerId: provider, projectId: 'shared', modelId: 'native-model', title: label, status: 'idle', messages: [], requests: [] }]
  state.host.providers = (['codex', provider] as const).map(id => ({ id, name: PROVIDER_LABELS[id], connection: 'connected' as const, version: '1.1.1',
    capabilities: state.host.capabilities }))
  state.installedProviders = ['codex', provider]
  const update = (id: 'codex' | Held): ProviderClientUpdate => ({ id, installed: '1.1.1', published: '1.1.2', behind: true, channel: 'npm',
    canInstall: true, checkedAt: centerTime, state: 'idle' })
  state.clientUpdates = [update('codex'), update(provider)]
  state.clientUpdateRun = { total: 2, done: 0, line: ['codex', provider] }
  state.configuration = { ...state.configuration, provider, enabledProviders: ['codex', provider],
    defaultModelId: publicProviderEntityId(provider, 'model', 'scoped-model'), newThreadModelId: publicProviderEntityId(provider, 'model', 'scoped-model') }
  return state
}

describe('the held-provider table', () => {
  it('holds a provider until its Owl feature is on, and a missing answer holds it', () => {
    const entries: readonly HeldProviderEntry[] = [...HELD_PROVIDER_ENTRIES, { provider: 'grok', feature: 'usage' }]
    expect([...heldProvidersOf({}, entries)]).toEqual(['muse', 'grok'])
    expect([...heldProvidersOf({ muse: true }, entries)]).toEqual(['grok'])
    expect([...heldProvidersOf({ muse: true, usage: true }, entries)]).toEqual([])
    expect(releasesHeldProvider(new Set(['grok']), entries)).toBe(true)
    expect(releasesHeldProvider(new Set(['muse', 'grok']), entries)).toBe(false)
    expect([...heldProvidersOf({})]).toEqual(['muse'])
  })
  it('reads an older Muse answer as the held set, and the held set wins', () => {
    expect([...heldProvidersOption({})]).toEqual(['muse'])
    expect([...heldProvidersOption({ museEnabled: true })]).toEqual([])
    expect([...heldProvidersOption({ museEnabled: true, heldProviders: HELD })]).toEqual(['muse', 'grok'])
  })
  it("keeps Muse's refusal word for word and builds another's from its label", () => {
    expect(heldProviderRefusal('muse')).toBe('Muse is available in Sotto Owl. Open an Owl build to continue. Nothing was sent.')
    expect(heldProviderRefusal('grok')).toBe('Grok Build is available in Sotto Owl. Open an Owl build to continue. Nothing was sent.')
  })
})

describe.each(providers)('the gate functions hold %s', provider => {
  const other = provider === 'muse' ? 'grok' : 'muse'
  const scopedModel = publicProviderEntityId(provider, 'model', 'scoped-model')
  const scopedProject = publicProviderEntityId(provider, 'project', 'scoped-project')

  it('drops its models, projects and provider rows from a catalog and shares a certified one', () => {
    const host = hostState(provider).host
    const certified = immutableModels(host.models)
    const visible = modelsWithoutHeld(certified, HELD)
    expect(visible.map(model => model.id)).toEqual(['model'])
    expect(isImmutableModels(visible)).toBe(true)
    expect(modelsWithoutHeld(certified, HELD)).toBe(visible)
    expect(modelsWithoutHeld(certified, new Set())).toBe(certified)
    expect(modelsWithoutHeld(certified, new Set([other]))).toBe(certified)
    const catalog = catalogWithoutHeld(host, HELD)
    expect(catalog.projects.map(project => project.id)).toEqual(['project', 'shared'])
    expect(catalog.providers?.map(row => row.id)).toEqual(['codex'])
  })

  it('names it for each model and project identity it owns', () => {
    const host = hostState(provider).host
    for (const id of ['native-model', scopedModel, 'scoped-model', 'label-model']) expect(heldProviderOfModelId(id, HELD, host)).toBe(provider)
    for (const id of ['native-project', scopedProject, 'scoped-project']) expect(heldProviderOfProjectId(id, HELD, host)).toBe(provider)
    expect(heldProviderOfModelId('model', HELD, host)).toBeUndefined()
    expect(heldProviderOfProjectId('shared', HELD, host)).toBeUndefined()
    expect(heldProviderOfModelId('native-model', new Set(), host)).toBeUndefined()
  })

  const commands = (): AgentCommand[] => [
    { type: 'connect', provider },
    { type: 'queue-client-updates', providers: ['codex', provider] },
    { type: 'cancel-client-updates', providers: [provider] },
    { type: 'configure', patch: { provider } },
    { type: 'configure', patch: { enabledProviders: ['codex', provider] } },
    { type: 'configure', patch: { defaultModelId: scopedModel } },
    { type: 'configure', patch: { newThreadModelId: scopedModel } },
  ]
  it('refuses the commands that choose it, at the coordinator and every host boundary', () => {
    for (const command of commands()) {
      expect(heldProviderChosenBy(command, HELD)).toBe(provider)
      expect(heldProviderOfCommand(command, HELD)).toBe(provider)
      expect(heldProviderChosenBy(command, new Set([other]))).toBeUndefined()
    }
    const host = hostState(provider).host
    const owned: AgentCommand[] = [
      { type: 'configure', patch: { disconnectedProviders: [provider] } },
      { type: 'configure', patch: { defaultModelId: 'native-model' } },
      { type: 'create-thread', projectId: 'project', title: 'New', modelId: 'native-model' },
      { type: 'create-thread', projectId: 'native-project', title: 'New', modelId: 'model' },
    ]
    for (const command of owned) expect(heldProviderOfCommand(command, HELD, host)).toBe(provider)
    expect(heldProviderOfCommand({ type: 'connect', provider: 'codex' }, HELD, host)).toBeUndefined()
    expect(heldProviderOfCommand({ type: 'create-thread', projectId: 'project', title: 'New', modelId: 'model' }, HELD, host)).toBeUndefined()
  })

  it('refuses a wildcard client check while it is connected, and any without a snapshot', () => {
    const host = hostState(provider).host
    expect(heldProviderOfClientUpdateEnumeration({ type: 'check-client-updates' }, HELD, host)).toBe(provider)
    expect(heldProviderRefusedBy({ type: 'check-client-updates' }, HELD, host)).toBe(provider)
    expect(heldProviderOfClientUpdateEnumeration({ type: 'check-client-updates' }, new Set([provider]))).toBe(provider)
    host.providers = host.providers!.map(row => row.id === provider ? { ...row, connection: 'disconnected' } : row)
    expect(heldProviderOfClientUpdateEnumeration({ type: 'check-client-updates' }, HELD, host)).toBeUndefined()
    delete host.providers
    expect(heldProviderOfClientUpdateEnumeration({ type: 'check-client-updates' }, HELD, host)).toBeUndefined()
  })

  it('names its threads by provider or model, and remembers them after the shell omits them', () => {
    const host = hostState(provider).host
    const [ordinary, heldThread] = host.threads
    expect(heldProviderOfThread(heldThread!, host, HELD)).toBe(provider)
    expect(heldProviderOfThread({ ...heldThread!, providerId: undefined }, host, HELD)).toBe(provider)
    expect(heldProviderOfThread(ordinary!, host, HELD)).toBeUndefined()
    expect(heldProviderOfThreadRecord({ providerId: undefined, modelId: scopedModel }, HELD)).toBe(provider)
    expect(heldProviderOfThreadRecord(heldThread!, HELD)).toBe(provider)
    const remembered = rememberDormantProviderThreads(new Map<string, DormantProviderThread>(), host, HELD)
    expect([...remembered]).toEqual([['held-worker', { projectId: 'shared', provider }]])
    expect(watcherRoomInputs(host, ['worker', 'held-worker'], HELD).map(row => row.id)).toEqual(['worker'])
    host.threads = host.threads.slice(0, 1)
    expect(watcherRoomInputs({ ...host, threads: [...host.threads, heldThread!] }, ['worker', 'held-worker'], HELD, remembered).map(row => row.id)).toEqual(['worker'])
  })

  it('refuses Watcher requests on its threads, models and projects in its name', () => {
    const host = hostState(provider).host
    const target = { hostId: centerHostId, threadId: 'held-worker' }
    const start = (modelId: string, projectId: string) => control('start_thread', { ...watcherToolFixtures.start_thread.input as object,
      modelId, project: { hostId: centerHostId, projectId } })
    const held = [read('read_thread', { target }), control('send_to_thread', { ...watcherToolFixtures.send_to_thread.input as object, target }),
      start('native-model', 'project'), start('model', 'native-project'),
      read('list_threads', { project: { hostId: centerHostId, projectId: 'shared' } }), read('list_threads', { hostId: centerHostId }),
      read('list_projects', { hostId: centerHostId })]
    for (const value of held) expect(heldProviderOfWatcherRequest(value, HELD, host)).toBe(provider)
    expect(heldProviderOfWatcherRequest(read('read_thread', { target }), new Set([other]), host)).toBeUndefined()
    const known = rememberDormantProviderThreads(new Map(), host, HELD)
    expect(heldProviderOfWatcherRequest(read('read_thread', { target }), HELD, { ...host, threads: [] }, known)).toBe(provider)
    expect(heldWatcherRefusal(provider)).toEqual({ status: 'refused', code: 'PROVIDER_UNAVAILABLE', retryable: false, message: refusal(provider) })
  })

  it('stands a refusing host in for its adapter', async () => {
    const stand = new HeldProviderHost(provider)
    await expect(stand.connect()).rejects.toThrow(`${PROVIDER_LABELS[provider]} is available in Sotto Owl; it is not in this build.`)
    await expect(stand.execute()).rejects.toThrow(`${PROVIDER_LABELS[provider]} is available in Sotto Owl.`)
    expect((await stand.snapshot()).name).toBe(PROVIDER_LABELS[provider])
  })
})

describe.each(providers)('every boundary holds %s', provider => {
  function routerFixture() {
    const state = hostState(provider)
    const command = vi.fn(async (_input: AgentCommand) => { void _input; return state })
    const calls: unknown[] = []
    const connection: DesktopHostConnection = { hostId: centerHostId, kind: 'remote', name: 'Paired Owl', detail: () => null, preview: () => null,
      offersClientUpdates: () => true,
      service: { shell: () => state, subscribe: () => () => undefined, command, supportsWatcherReads: true, supportsWatcherControl: true,
        watcherRead: async value => { calls.push(value); return null }, watcherControl: async value => { calls.push(value); return null } } }
    const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true, heldProviders: HELD })
    router.add(connection); cleanup.push(() => router.dispose())
    return { state, router, command, calls }
  }

  it('hides it on the remote host router and refuses it before dispatch', async () => {
    const { state, router, command, calls } = routerFixture(), before = structuredClone(state)
    const shown = router.watcherHosts().snapshot(centerHostId)!
    expect(shown.threads.map(thread => thread.id)).toEqual(['worker'])
    expect(shown.models.map(model => model.id)).toEqual(['model'])
    expect(shown.projects.map(project => project.id)).toEqual(['project', 'shared'])
    expect(shown.providers?.map(row => row.id)).toEqual(['codex'])
    const host = router.shell().host.clientHosts?.[0]
    expect(host?.clientUpdates?.map(update => update.id)).toEqual(['codex'])
    expect(host?.clientUpdateRun?.line).toEqual(['codex'])
    expect(router.preservesDormantThread(hostEntityKey(centerHostId, 'held-worker'))).toBe(true)
    expect(router.preservesDormantThread(hostEntityKey(centerHostId, 'worker'))).toBe(false)
    for (const input of [{ type: 'connect', provider } as const, { type: 'check-client-updates' } as const, { type: 'queue-client-updates', providers: [provider] } as const]) {
      await expect(router.command(input, desktopWindowClient())).rejects.toThrow(refusal(provider))
    }
    expect(await router.watcherHosts().read(centerHostId, read('read_thread', { target: { hostId: centerHostId, threadId: 'held-worker' } })))
      .toEqual(heldWatcherRefusal(provider))
    expect(command).not.toHaveBeenCalled(); expect(calls).toEqual([])
    expect(state).toEqual(before)
  })

  it('refuses it on the socket host before the wire', async () => {
    const state = hostState(provider), frames: HostRequest[] = []
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'synthetic', expectedHostId: centerHostId,
      watcherEnabled: true, heldProviders: HELD, catchUpEvents: false })
    const internal = client as unknown as { publish(value: AgentState): void }
    Object.assign(client, { features: ['watcher-reads', 'watcher-control'], frames: { close: () => undefined, send: (frame: HostRequest) => { frames.push(frame); return true } },
      session: { session: 'synthetic', hostId: centerHostId } })
    internal.publish(state); cleanup.push(() => client.close())
    await expect(client.command({ type: 'connect', provider })).rejects.toThrow(refusal(provider))
    await expect(client.command({ type: 'interrupt', threadId: 'held-worker' })).rejects.toThrow(`${PROVIDER_LABELS[provider]} is available in Sotto Owl. Nothing was sent.`)
    expect(await client.watcherRead(read('read_thread', { target: { hostId: centerHostId, threadId: 'held-worker' } }))).toEqual(heldWatcherRefusal(provider))
    expect(frames).toEqual([])
  })

  it('parks its remote drafts as read and restores them when it is no longer held', async () => {
    const root = await directory(), hostId = randomUUID()
    const edit = (threadId: string, providerId: 'codex' | Held): RetainedDraft => ({ hostId, providerId, draft: { threadId, draftId: randomUUID(),
      text: 'Synthetic retained ' + threadId, attachments: [], requestId: null, updatedAt: new Date().toISOString() }, questionsDigest: null, saved: false, recovery: false })
    const parked = edit('held', provider), ordinary = edit('ordinary', 'codex')
    const owl = new RetainedDraftStore({ directory: root, watcherEnabled: true, heldProviders: new Set() })
    owl.put(parked); owl.put(ordinary); await owl.close()
    const stable = new RetainedDraftStore({ directory: root, watcherEnabled: true, heldProviders: HELD, historyEnabled: () => false })
    await stable.load(); await stable.privacyChanged()
    expect(stable.list(hostId)).toEqual([])
    expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([parked])
    const reopened = new RetainedDraftStore({ directory: root, watcherEnabled: true, heldProviders: new Set() })
    await reopened.load()
    expect(reopened.list(hostId)).toEqual([{ ...parked, recovery: true }])
  })

  it('keeps its threads dormant on an inactive local host', async () => {
    const root = await directory()
    await writeFile(join(root, 'workspace.json'), JSON.stringify({ snapshot: { threads: [{ id: 'held-worker', providerId: provider }, { id: 'worker', providerId: 'codex' }] } }))
    const runtime = await inactiveLocalHost(root, HELD)
    cleanup.push(() => runtime.close())
    expect(runtime.agentHost.dormantThreadIds?.()).toEqual(['held-worker'])
  })

  it('hides its threads, parks its choices and restores them whole when it is no longer held', async () => {
    const root = await directory(), scopedModel = publicProviderEntityId(provider, 'model', 'scoped-model')
    const owlSnapshot: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), ...hostState(provider).host,
      capabilities: { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true, observe: true } }
    const owl = new WorkspaceHost(new FakeProviderHost(owlSnapshot), root, () => true, undefined, true, new Set())
    await owl.initialize(); await owl.connect()
    const first = await agentControlFixture({ directory: root, host: owl, credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: true, heldProviders: new Set() } })
    await first.control.start(); await first.dispose(); await first.control.closed(); await owl.close()
    const file = join(root, 'agents.json'), saved = JSON.parse(await readFile(file, 'utf8'))
    saved.configuration = { ...defaultAgentConfiguration(), provider, enabledProviders: [provider, 'codex'], defaultModelId: scopedModel,
      newThreadModelId: scopedModel, newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'approval-required' }
    await writeFile(file, JSON.stringify(saved))

    const stable = new WorkspaceHost(new FakeProviderHost({ ...structuredClone(EMPTY_AGENT_HOST), connected: true }), root, () => true, undefined, true, HELD)
    cleanup.push(() => stable.close()); await stable.initialize()
    const held = await agentControlFixture({ directory: root, host: stable, credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: true, heldProviders: HELD } })
    await held.control.start()
    expect(stable.dormantThreadIds()).toEqual(['held-worker'])
    expect(stable.workspaceSnapshot().threads.map(thread => thread.id)).toEqual(['worker'])
    await expect(stable.execute({ type: 'send', commandId: randomUUID(), threadId: 'held-worker', messageId: randomUUID(), text: 'Refused prompt' })).rejects.toThrow(refusal(provider))
    expect(held.control.shell().configuration).toMatchObject({ provider: 'codex', enabledProviders: ['codex'], defaultModelId: '', newThreadModelId: '' })
    expect((await held.control.command({ type: 'connect', provider })).error).toBe(refusal(provider))
    await held.dispose(); await held.control.closed(); await stable.close()
    const parked = JSON.parse(await readFile(file, 'utf8'))
    const choices = { provider, enabled: true, defaultModelId: scopedModel, newThreadModelId: scopedModel, newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'approval-required' }
    // Muse's record keeps the name an Owl build reads; another held provider parks under its own ID.
    if (provider === 'muse') { expect(parked.dormantMuseConfiguration).toEqual(choices); expect(parked.dormantProviderConfigurations).toBeUndefined() }
    else { expect(parked.dormantProviderConfigurations).toEqual({ [provider]: choices }); expect(parked.dormantMuseConfiguration).toBeUndefined() }

    const back = new WorkspaceHost(new FakeProviderHost(), root, () => true, undefined, true, new Set())
    cleanup.push(() => back.close()); await back.initialize()
    const reopened = await agentControlFixture({ directory: root, host: back, credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: true, heldProviders: new Set() } })
    cleanup.push(reopened.dispose); await reopened.control.start()
    expect(back.workspaceSnapshot().threads.map(thread => thread.id)).toContain('held-worker')
    expect(reopened.control.shell().configuration).toMatchObject({ provider, enabledProviders: ['codex', provider], defaultModelId: scopedModel,
      newThreadModelId: scopedModel, newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'approval-required' })
  })
})
