// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RetainedDraftStore, type RetainedDraft } from '../../../src/main/agents/retainedDraftStore'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { publicProviderEntityId, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import type { HostRequest } from '../../../src/shared/hostProtocol'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-muse-remote-gate-'))
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}
const hostId = randomUUID()
const edit = (threadId: string, providerId?: 'muse' | 'codex'): RetainedDraft => ({ hostId,
  ...(providerId ? { providerId } : {}), draft: { threadId, draftId: randomUUID(), text: 'Synthetic retained ' + threadId,
    attachments: [], requestId: null, updatedAt: new Date().toISOString() }, questionsDigest: null, saved: false, recovery: false })
function state(providerId: 'muse' | 'codex', threadId: string): AgentState {
  const snapshot = emptyDesktopState(hostId)
  snapshot.host.connected = true; snapshot.configuration.provider = providerId
  snapshot.host.threads = [{ id: threadId, providerId, kind: 'project', projectId: 'project', modelId: '', title: threadId,
    status: 'idle', messages: [], requests: [] }]
  return snapshot
}
function socket(store: RetainedDraftStore, museEnabled = false) {
  const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'synthetic', expectedHostId: hostId,
    watcherEnabled: true, museEnabled, retainedDrafts: store, catchUpEvents: false })
  const call = vi.fn(async () => state('codex', 'ordinary'))
  Object.assign(client, { frames: {}, features: ['draft-revisions'], call })
  const internal = client as unknown as { publish(state: AgentState): void; recoverDrafts(): void }
  return { client, call, internal }
}

it.each([true, false])('keeps Owl Muse remote edits whole through stable history-off load and restart (legacy identity %s)', async legacy => {
  const root = await directory(), ordinary = edit('ordinary', 'codex'), muse = edit('muse', legacy ? undefined : 'muse')
  // An Owl run holds no provider; the older Muse answer alone would still hold OpenCode, and with it a draft naming no provider.
  const owl = new RetainedDraftStore({ directory: root, watcherEnabled: true, heldProviders: new Set() })
  owl.put(muse); owl.put(ordinary); await owl.close()
  const stable = new RetainedDraftStore({ directory: root, watcherEnabled: true, museEnabled: false, historyEnabled: () => false })
  await stable.load(); await stable.privacyChanged()
  expect(stable.list(hostId)).toEqual([])
  expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([muse])
  const cold = new RetainedDraftStore({ directory: root, watcherEnabled: true, museEnabled: false, historyEnabled: () => false })
  await cold.load(); cold.identifyThreads(hostId, [{ id: 'muse', providerId: 'muse', kind: 'project' }]); await cold.close()
  expect(cold.list(hostId)).toEqual([])
  expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([muse])
  const reopened = new RetainedDraftStore({ directory: root, watcherEnabled: true, heldProviders: new Set() })
  await reopened.load()
  expect(reopened.list(hostId)).toEqual([{ ...muse, recovery: true }])
})

it('waits for a real thread identity before recovering old disk drafts and keeps an absent thread unresolved', async () => {
  const root = await directory(), unknown = edit('unknown')
  await writeFile(join(root, 'remote-drafts.json'), JSON.stringify([unknown]))
  const store = new RetainedDraftStore({ directory: root, museEnabled: false, watcherEnabled: true })
  await store.load()
  expect(store.list(hostId)).toEqual([])
  const f = socket(store)
  f.internal.publish(state('codex', 'other'))
  f.internal.recoverDrafts()
  expect(f.call).not.toHaveBeenCalled()
  f.internal.publish(state('muse', 'unknown'))
  f.internal.recoverDrafts()
  await store.close()
  expect(f.call).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([unknown])
  await expect(f.client.command({ type: 'compose', threadId: 'unknown', text: 'Refused edit' })).rejects.toThrow('Muse is available in Sotto Owl')
})

it('erases an old unclassified ordinary disk draft once its host identifies it while history is off', async () => {
  const root = await directory(), unknown = edit('ordinary')
  await writeFile(join(root, 'remote-drafts.json'), JSON.stringify([unknown]))
  const store = new RetainedDraftStore({ directory: root, museEnabled: false, watcherEnabled: true, historyEnabled: () => false })
  await store.load()
  expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([unknown])
  store.identifyThreads(hostId, [{ id: 'ordinary', providerId: 'codex', kind: 'project' }]); await store.close()
  expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([])
  expect(store.list(hostId)).toEqual([])
})

it('resolves ordinary legacy copies for normal recovery while Muse remains dormant', async () => {
  const root = await directory(), unknown = edit('ordinary')
  await writeFile(join(root, 'remote-drafts.json'), JSON.stringify([unknown]))
  const store = new RetainedDraftStore({ directory: root, museEnabled: false, watcherEnabled: true })
  await store.load()
  const f = socket(store)
  f.internal.publish(state('codex', 'ordinary')); f.internal.recoverDrafts()
  await vi.waitFor(() => expect(f.call).toHaveBeenCalledWith(expect.objectContaining({ op: 'command', command: expect.objectContaining({ type: 'save-thread-draft', threadId: 'ordinary', text: unknown.draft.text }) }), expect.any(String)))
  await store.close()
})

it('records provider ownership when Owl retains a new remote Muse compose', async () => {
  const store = new RetainedDraftStore({ museEnabled: true, watcherEnabled: true })
  const f = socket(store, true)
  Object.assign(f.client, { cached: state('muse', 'muse') })
  await f.client.command({ type: 'compose', threadId: 'muse', text: 'Synthetic latest edit' })
  expect(store.get(hostId, 'muse')?.providerId).toBe('muse')
})

it('preserves gated and unidentified remote recovery copies while erasing identified ordinary copies', async () => {
  const root = await directory(), path = join(root, 'remote-drafts.json')
  const muse = edit('muse', 'muse'), unknown = edit('unknown'), ordinary = edit('ordinary', 'codex')
  await writeFile(path, JSON.stringify([]))
  const mixed = path + '.corrupt-mixed', broken = path + '.tmp-broken'
  await writeFile(mixed, JSON.stringify([ordinary, muse, unknown]))
  const cutOff = '[{"hostId":"' + hostId + '","draft":'
  await writeFile(broken, cutOff)
  const store = new RetainedDraftStore({ directory: root, watcherEnabled: true, museEnabled: false, historyEnabled: () => false })
  await store.load(); await store.close()
  expect(JSON.parse(await readFile(mixed, 'utf8'))).toEqual([muse, unknown])
  expect(await readFile(broken, 'utf8')).toBe(cutOff)
})

/** A paired Owl socket records every protocol frame without running any provider or client updater. */
function pairedOwlSocket(museEnabled = false) {
  const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'synthetic-pairing', expectedHostId: hostId,
    watcherEnabled: true, museEnabled, catchUpEvents: false })
  const snapshot = state('codex', 'ordinary'), frames: HostRequest[] = []
  snapshot.host.models = [
    { id: 'native-muse', providerId: 'muse', provider: 'Muse', name: 'Muse model', ready: true },
    { id: publicProviderEntityId('muse', 'model', 'scoped-muse'), providerId: 'muse', provider: 'Muse', name: 'Scoped Muse', ready: true },
    { id: 'codex-model', providerId: 'codex', provider: 'Codex', name: 'Ordinary model', ready: true },
  ]
  snapshot.host.projects = [{ id: 'native-muse-project', providerId: 'muse', title: 'Muse project', path: '/synthetic/muse' },
    { id: publicProviderEntityId('muse', 'project', 'scoped-muse-project'), providerId: 'muse', title: 'Scoped Muse', path: '/synthetic/scoped' },
    { id: 'ordinary-project', providerId: 'codex', title: 'Ordinary project', path: '/synthetic/codex' }]
  const internal = client as unknown as { receive(text: string): void }
  Object.assign(client, { features: ['draft-revisions', 'client-updates'], cached: snapshot, frames: {
    send: (frame: HostRequest) => { frames.push(structuredClone(frame)); return true }, close: () => undefined },
    session: { session: 'synthetic-paired-session', hostId } })
  cleanup.push(() => client.close())
  const reply = (frame: HostRequest) => internal.receive(JSON.stringify({ v: 1, id: frame.id, ok: true, result: snapshot }))
  return { client, frames, reply }
}
const gatedProviderCommands: { name: string; command: AgentCommand }[] = [
  ...(['connect', 'disconnect', 'refresh', 'update-client'] as const).map(type => ({ name: type, command: { type, provider: 'muse' as const } })),
  { name: 'create Muse project', command: { type: 'create-project', provider: 'muse', title: 'Synthetic project' } },
  { name: 'queue Muse client update', command: { type: 'queue-client-updates', providers: ['muse'] } },
  { name: 'queue mixed client updates', command: { type: 'queue-client-updates', providers: ['codex', 'muse'] } },
  { name: 'cancel Muse client update', command: { type: 'cancel-client-updates', providers: ['muse'] } },
  { name: 'cancel mixed client updates', command: { type: 'cancel-client-updates', providers: ['muse', 'codex'] } },
  { name: 'Muse default provider', command: { type: 'configure', patch: { provider: 'muse' } } },
  { name: 'Muse enabled provider', command: { type: 'configure', patch: { enabledProviders: ['codex', 'muse'] } } },
  { name: 'Muse disconnected provider', command: { type: 'configure', patch: { disconnectedProviders: ['muse'] } } },
  { name: 'native Muse default model', command: { type: 'configure', patch: { defaultModelId: 'native-muse' } } },
  { name: 'native Muse new-thread default', command: { type: 'configure', patch: { newThreadModelId: 'native-muse' } } },
  { name: 'scoped Muse new-thread default', command: { type: 'configure', patch: { newThreadModelId: publicProviderEntityId('muse', 'model', 'scoped-muse') } } },
  { name: 'unscoped Muse model reference', command: { type: 'create-thread', title: 'Synthetic thread', projectId: 'ordinary-project', modelId: 'scoped-muse' } },
  { name: 'native Muse model creation', command: { type: 'create-thread', title: 'Synthetic thread', projectId: 'ordinary-project', modelId: 'native-muse' } },
  { name: 'scoped Muse model creation', command: { type: 'create-thread', title: 'Synthetic thread', projectId: 'ordinary-project', modelId: publicProviderEntityId('muse', 'model', 'scoped-muse') } },
  { name: 'native Muse project creation', command: { type: 'create-thread', title: 'Synthetic thread', projectId: 'native-muse-project', modelId: 'codex-model' } },
  { name: 'scoped Muse project creation', command: { type: 'create-thread', title: 'Synthetic thread', projectId: publicProviderEntityId('muse', 'project', 'scoped-muse-project'), modelId: 'codex-model' } },
  { name: 'unscoped Muse project reference', command: { type: 'select-project', projectId: 'scoped-muse-project' } },
]
it.each(gatedProviderCommands)('refuses direct paired-host $name before writing any remote command with Muse off', async ({ command }) => {
  const f = pairedOwlSocket()
  await expect(f.client.command(command)).rejects.toThrow('Muse is available in Sotto Owl')
  expect(f.frames).toEqual([])
})
it.each([
  { name: 'ordinary provider action', command: { type: 'refresh', provider: 'codex' } },
  { name: 'ordinary client update', command: { type: 'queue-client-updates', providers: ['codex', 'claude'] } },
  { name: 'ordinary new-thread default', command: { type: 'configure', patch: { newThreadModelId: 'codex-model' } } },
] satisfies { name: string; command: AgentCommand }[])('keeps direct $name available while Muse is off', async ({ command }) => {
  const f = pairedOwlSocket()
  const answer = f.client.command(command)
  await vi.waitFor(() => expect(f.frames).toHaveLength(1))
  expect(f.frames[0]).toMatchObject({ op: 'command', command })
  f.reply(f.frames[0]!); await answer
})
it('allows an explicit Muse provider command when the immutable gate is on', async () => {
  const f = pairedOwlSocket(true), command: AgentCommand = { type: 'refresh', provider: 'muse' }
  const answer = f.client.command(command)
  await vi.waitFor(() => expect(f.frames).toHaveLength(1))
  expect(f.frames[0]).toMatchObject({ op: 'command', command })
  f.reply(f.frames[0]!); await answer
})
