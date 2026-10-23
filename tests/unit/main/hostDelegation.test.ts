// @vitest-environment node
// A headless host's own delegation (#1310): the desktop defaults it keeps, the ceiling it holds starts to, where its threads
// may delegate, the desktop's push of the defaults, and the Owl answer that builds none of it on stable.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopDefaultsStore, hostDelegationMachines, KEPT_DESKTOP_DEFAULTS, THIS_MACHINE } from '../../../src/main/agents/hostDelegation'
import { DesktopDefaultsPush, followDesktopDefaults, type DesktopDefaultsTarget } from '../../../src/main/hosts/desktopDefaults'
import { delegationToolDefinitions } from '../../../src/main/agents/delegationTools'
import { HostFactsSource } from '../../../src/main/agents/hostFacts'
import { createAgentRuntime } from '../../../src/main/agents/runtime'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { roleStartNote } from '../../../src/shared/workerRoles'
import { desktopDefaultsSchema } from '../../../src/shared/desktopDefaults'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { DesktopDefaultsInput } from '../../../src/shared/desktopDefaults'
import { testCredentials } from '../../fixtures/testCredentials'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-host-delegation-unit-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
const folder = async () => { const root = await mkdtemp(join(tmpdir(), 'sotto-host-delegation-unit-')); roots.push(root); return root }

describe('the desktop defaults a host keeps', () => {
  it('holds every start to Ask for approval until a desktop tells it, and then only as far as that desktop may answer', async () => {
    const root = await folder(), store = new DesktopDefaultsStore(root)
    await store.load()
    expect(store.ceiling(() => true)).toEqual({ mode: 'approval-required', held: 'not-told' })
    expect(store.roles(() => true)).toEqual({})
    await store.record('desktop-a', { newThreadRuntimeMode: 'full-access', workerRoles: { 'code-review': { modelId: 'model-a', reasoningEffort: 'low', runtimeMode: 'auto' }, retired: { modelId: 'x' } } })
    expect(store.ceiling(clientId => clientId === 'desktop-a')).toEqual({ mode: 'full-access' })
    expect(store.ceiling(() => false)).toEqual({ mode: 'approval-required', held: 'no-answer-grant' })
    // A newer desktop's role an older host does not know costs only that row.
    expect(store.roles(() => true)).toEqual({ 'code-review': { modelId: 'model-a', reasoningEffort: 'low', runtimeMode: 'auto' } })
    // Roles from a desktop that does not count do not apply either.
    expect(store.roles(() => false)).toEqual({})
    // The provider's own default reads as Ask for approval.
    await store.record('desktop-b', { newThreadRuntimeMode: null })
    expect(store.ceiling(() => true)).toEqual({ mode: 'approval-required' })
    expect(store.roles(() => true)).toEqual({})
  })

  it('applies the last defaults sent by a desktop that still counts, and falls back when one stops counting', async () => {
    const root = await folder()
    let now = Date.parse('2026-10-23T10:00:00.000Z')
    const store = new DesktopDefaultsStore(root, () => new Date(now += 1000))
    await store.load()
    await store.record('desktop-a', { newThreadRuntimeMode: 'full-access', workerRoles: { 'code-review': { modelId: 'model-a', reasoningEffort: 'low', runtimeMode: 'auto' } } })
    await store.record('desktop-b', { newThreadRuntimeMode: 'auto' })
    const counting = new Set(['desktop-a', 'desktop-b']), counts = (clientId: string) => counting.has(clientId)
    // The last one sent wins, roles and all.
    expect(store.ceiling(counts)).toEqual({ mode: 'auto' })
    expect(store.roles(counts)).toEqual({})
    // Desktop B forgotten, or its grant taken away: desktop A's defaults apply again.
    counting.delete('desktop-b')
    expect(store.ceiling(counts)).toEqual({ mode: 'full-access' })
    expect(store.roles(counts)).toEqual({ 'code-review': { modelId: 'model-a', reasoningEffort: 'low', runtimeMode: 'auto' } })
    // Neither counts: Ask for approval, with the roles' own defaults.
    counting.delete('desktop-a')
    expect(store.ceiling(counts)).toEqual({ mode: 'approval-required', held: 'no-answer-grant' })
    expect(store.roles(counts)).toEqual({})
    // The same after a restart: what was kept is read back newest first, and still asked afresh.
    const again = new DesktopDefaultsStore(root); await again.load()
    expect(again.ceiling(counts)).toEqual({ mode: 'approval-required', held: 'no-answer-grant' })
    expect(again.ceiling(() => true)).toEqual({ mode: 'auto' })
    expect(again.ceiling(clientId => clientId === 'desktop-a')).toEqual({ mode: 'full-access' })
    // A desktop that sends again replaces its own defaults and becomes the last.
    await again.record('desktop-a', { newThreadRuntimeMode: 'auto-accept-edits' })
    expect(again.ceiling(() => true)).toEqual({ mode: 'auto-accept-edits' })
  })

  it('builds each record on the one saved before it, so two desktops sending at once never bring back replaced defaults', async () => {
    const root = await folder(), store = new DesktopDefaultsStore(root)
    await store.load()
    await store.record('desktop-a', { newThreadRuntimeMode: 'full-access' })
    // Desktop A narrows to Ask for approval while desktop B sends Ask for approval too, both before either has saved.
    await Promise.all([store.record('desktop-a', { newThreadRuntimeMode: 'approval-required' }), store.record('desktop-b', { newThreadRuntimeMode: 'approval-required' })])
    // Desktop B revoked or forgotten: desktop A's Ask for approval applies, never the Full access it replaced.
    const onlyA = (clientId: string) => clientId === 'desktop-a'
    expect(store.ceiling(onlyA)).toEqual({ mode: 'approval-required' })
    const again = new DesktopDefaultsStore(root); await again.load()
    expect(again.ceiling(onlyA)).toEqual({ mode: 'approval-required' })
    expect(again.ceiling(() => true)).toEqual({ mode: 'approval-required' })
  })

  it('keeps no more than its limit of desktops, dropping the oldest', async () => {
    const root = await folder()
    let now = Date.parse('2026-10-23T10:00:00.000Z')
    const store = new DesktopDefaultsStore(root, () => new Date(now += 1000))
    for (let index = 0; index <= KEPT_DESKTOP_DEFAULTS; index++) await store.record(`desktop-${index}`, { newThreadRuntimeMode: 'auto' })
    const saved = JSON.parse(await readFile(join(root, 'desktop-defaults.json'), 'utf8')) as { desktops: { clientId: string }[] }
    expect(saved.desktops).toHaveLength(KEPT_DESKTOP_DEFAULTS)
    expect(saved.desktops[0]!.clientId).toBe(`desktop-${KEPT_DESKTOP_DEFAULTS}`)
    expect(saved.desktops.some(item => item.clientId === 'desktop-0')).toBe(false)
  })

  it('keeps them across a restart, and reads a damaged record as never told', async () => {
    const root = await folder()
    await new DesktopDefaultsStore(root).record('desktop-a', { newThreadRuntimeMode: 'auto' })
    const saved = JSON.parse(await readFile(join(root, 'desktop-defaults.json'), 'utf8')) as { desktops: Record<string, unknown>[] }
    expect(saved.desktops).toMatchObject([{ clientId: 'desktop-a', newThreadRuntimeMode: 'auto' }])
    const again = new DesktopDefaultsStore(root); await again.load()
    expect(again.ceiling(() => true)).toEqual({ mode: 'auto' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'desktop-defaults.json'), '{"version":1,"desktops":[{"clientId":""}]}')
    const damaged = new DesktopDefaultsStore(root); await damaged.load()
    expect(damaged.ceiling(() => true)).toEqual({ mode: 'approval-required', held: 'not-told' })
  })

  it('takes only a permission mode and bounded roles on the wire', () => {
    expect(desktopDefaultsSchema.safeParse({ newThreadRuntimeMode: 'auto' }).success).toBe(true)
    expect(desktopDefaultsSchema.safeParse({ newThreadRuntimeMode: 'everything' }).success).toBe(false)
    expect(desktopDefaultsSchema.safeParse({ newThreadRuntimeMode: 'auto', key: 'secret' }).success).toBe(false)
  })
})

describe('where a thread on a host may delegate', () => {
  const facts = (family: 'linux' | 'macos' | null) => ({ read: async () => ({ observedAt: new Date().toISOString(), os: { family, name: null, version: null },
    architecture: null, totalMemoryBytes: null, freeMemoryBytes: null, logicalCpuCount: null }) }) as unknown as HostFactsSource
  const machines = (family: 'linux' | 'macos' | null = 'linux') => hostDelegationMachines(() => 'host-a', facts(family), () => [{ status: 'running' }, { status: 'idle' }])
  const project = { hostId: 'host-a', projectId: 'project-a' }

  it('lists this machine alone and starts on it, by its ID or its own system', async () => {
    expect(await machines().list()).toMatchObject({ status: 'ok', machines: [{ hostId: 'host-a', name: THIS_MACHINE, factsState: 'reported', runningThreads: 1 }] })
    expect(await machines().place({}, project, 'this-computer')).toMatchObject({ hostId: 'host-a', receipt: { name: THIS_MACHINE, awayFromDefault: false } })
    expect(await machines().place({ machine: 'host-a', os: 'linux' }, project, 'this-computer')).toMatchObject({ hostId: 'host-a' })
  })

  it('refuses another machine or system in plain words, and a system it cannot read', async () => {
    expect(await machines().place({ machine: 'host-b' }, project, 'this-computer')).toMatchObject({ status: 'refused',
      message: 'A thread on this machine delegates only to threads on this machine for now. It cannot start on another machine. Leave out the machine and system to start it here. Nothing was started.' })
    expect(await machines().place({ os: 'macos' }, project, 'this-computer')).toMatchObject({ status: 'refused', message: expect.stringContaining('This machine is not a Mac') })
    expect(await machines(null).place({ os: 'linux' }, project, 'this-computer')).toMatchObject({ status: 'refused', message: expect.stringContaining('does not say which system it runs') })
  })

  it('says this machine in the tools a thread there is offered', () => {
    const definitions = delegationToolDefinitions(true, true, 'this-machine')
    const delegate = definitions.find(tool => tool.name === 'delegate')!, list = definitions.find(tool => tool.name === 'list_machines')!
    expect(delegate.description).toContain('Hand work to another thread on this machine')
    expect(delegate.description).toContain('working on this machine after a start')
    expect(delegate.description).not.toContain('This computer')
    expect(list.description).toContain('List this machine')
  })

  it('says why a role\'s permission was held on a host', () => {
    const start = { role: 'code-review' as const, named: [], modelId: 'model-a', roleModelId: 'model-a' } as unknown as Parameters<typeof roleStartNote>[0]
    expect(roleStartNote(start, [], { wanted: 'auto', startedOn: 'approval-required', by: 'not-told' })).toContain('has not been told the user\'s new-thread default yet')
    expect(roleStartNote(start, [], { wanted: 'auto', startedOn: 'approval-required', by: 'no-answer-grant' })).toContain('does not let the user\'s desktop answer permission requests here')
  })
})

describe('the desktop\'s push of its defaults', () => {
  const target = (hostId: string, supports: boolean, sent: DesktopDefaultsInput[], fail = false): DesktopDefaultsTarget => ({ hostId, kind: 'remote',
    service: { supportsHostDelegation: supports, desktopDefaults: async defaults => {
      await new Promise(resolve => setTimeout(resolve, 5)); sent.push(defaults)
      if (fail) throw new Error('away'); return { receivedAt: new Date().toISOString() } } } })

  it('sends to hosts that take them when they connect and when the defaults change, never to an older host, and last one wins', async () => {
    const takes: DesktopDefaultsInput[] = [], older: DesktopDefaultsInput[] = []
    const hosts = [target('host-a', true, takes), target('host-b', false, older)]
    const events: string[] = []
    const push = new DesktopDefaultsPush({ connections: () => hosts, log: event => events.push(event) })
    // Nothing is sent before main says what the defaults are.
    push.connected(hosts[0]!)
    await push.settled(); expect(takes).toEqual([])
    const roles = { 'code-review': { modelId: 'model-a', reasoningEffort: null } }
    push.update('auto', roles)
    // The same defaults again, by value and by identity, send nothing.
    push.update('auto', roles)
    push.update('full-access', roles)
    push.connected(hosts[1]!)
    await push.settled()
    expect(older).toEqual([])
    expect(takes.at(-1)).toEqual({ newThreadRuntimeMode: 'full-access', workerRoles: roles })
    expect(takes).toHaveLength(2)
    expect(events).toEqual(['desktop-defaults-sent', 'desktop-defaults-sent'])
    // Worker roles off: none are sent, and the host uses the roles' defaults.
    push.update(undefined, undefined)
    await push.settled()
    expect(takes.at(-1)).toEqual({ newThreadRuntimeMode: null })
  })

  it('says a failed send by its event name alone, and sends again on the host\'s next connection', async () => {
    const sent: DesktopDefaultsInput[] = [], events: string[] = []
    const away = target('host-a', true, sent, true)
    const push = new DesktopDefaultsPush({ connections: () => [away], log: event => events.push(event) })
    push.update('auto', undefined)
    await push.settled()
    expect(events).toEqual(['desktop-defaults-failed'])
    push.connected(target('host-a', true, sent))
    await push.settled()
    expect(events).toEqual(['desktop-defaults-failed', 'desktop-defaults-sent'])
    push.close(); push.update('full-access', undefined); await push.settled()
    expect(sent).toHaveLength(2)
  })

  it('follows the default the router publishes, whichever host gives it, and this computer\'s roles', async () => {
    const sent: DesktopDefaultsInput[] = []
    const host = target('host-a', true, sent)
    const states: ((state: { configuration: { newThreadRuntimeMode?: 'auto' | 'full-access' } }) => void)[] = []
    const connections: ((connection: DesktopDefaultsTarget) => void)[] = []
    const source = { subscribe: (listener: typeof states[number]) => { states.push(listener); return () => { states.splice(states.indexOf(listener), 1) } },
      subscribeConnected: (listener: typeof connections[number]) => { connections.push(listener); return () => { connections.splice(connections.indexOf(listener), 1) } } }
    let roles: Record<string, { modelId: string; reasoningEffort: null }> | undefined
    const push = new DesktopDefaultsPush({ connections: () => [host] })
    const follow = followDesktopDefaults(push, source, () => roles)
    // Roles that change before any state go with the first one.
    roles = { 'code-review': { modelId: 'model-a', reasoningEffort: null } }
    follow.rolesChanged()
    await push.settled(); expect(sent).toEqual([])
    // The router's state carries this computer's default while its host runs, the selected host's while it is off.
    for (const listener of states) listener({ configuration: { newThreadRuntimeMode: 'auto' } })
    await push.settled()
    expect(sent.at(-1)).toEqual({ newThreadRuntimeMode: 'auto', workerRoles: roles })
    for (const listener of states) listener({ configuration: {} })
    await push.settled()
    expect(sent.at(-1)).toEqual({ newThreadRuntimeMode: null, workerRoles: roles })
    // New roles keep the default last published.
    for (const listener of states) listener({ configuration: { newThreadRuntimeMode: 'full-access' } })
    roles = { 'code-review': { modelId: 'model-b', reasoningEffort: null } }
    follow.rolesChanged()
    await push.settled()
    expect(sent.at(-1)).toEqual({ newThreadRuntimeMode: 'full-access', workerRoles: roles })
    // A connection the router takes is told.
    const count = sent.length
    for (const listener of connections) listener(host)
    await push.settled()
    expect(sent).toHaveLength(count + 1)
    follow.dispose()
    expect(states).toHaveLength(0); expect(connections).toHaveLength(0)
  })
})

describe('the Owl answer', () => {
  async function runtime(crossMachineEnabled: boolean) {
    const root = await folder()
    const credentials = await testCredentials(root, { encryption: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '' } })
    return createAgentRuntime({ directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
      historyEnabled: () => true, openExternal: async () => undefined, host: new E2EAgentHost(), reasoner: e2eAgentReasoner, watcherEnabled: true, delegationEnabled: true,
      runsAs: 'headless-host', crossMachineEnabled, hostDelegation: { roles: true, counts: () => false } })
  }
  it('builds delegation and keeps desktop defaults on a host only where Work across machines is on', async () => {
    const stable = await runtime(false)
    try {
      expect(stable.delegation).toBeUndefined()
      expect(stable.hostService.supportsHostDelegation).toBe(false)
    } finally { await stable.close() }
    const owl = await runtime(true)
    try {
      expect(owl.delegation).toBeDefined()
      expect(owl.hostService.supportsHostDelegation).toBe(true)
    } finally { await owl.close() }
  })
})
