// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PairedClients } from '../../src/main/agents/pairing'
import type { HostService } from '../../src/main/agents/hostService'
import { startSocketServer } from '../../src/host/socketServer'
import { parsePublicProviderEntityId, threadProviderOf, type AgentState } from '../../src/shared/agents'
import { OPENCODE_EVERYWHERE, openCodeEverywhere } from '../fixtures/openCodeEverywhere'
import { rawPeer } from '../fixtures/rawHostPeer'

/**
 * Everything a host sends a client whose hello does not accept `provider-opencode` (#1107, ADR-0087): its shell, events,
 * details, Watcher's phone state and operations, and a desktop's Watcher reads and projection, from a host whose state names
 * OpenCode in every field. None of it names OpenCode, and a request that names an OpenCode thread or project is refused
 * before the host acts on it.
 */
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })
const { hostId, opencodeThread, codexThread, opencodeProject, codexProject, zen, codexModel } = OPENCODE_EVERYWHERE
const at = '2026-10-17T00:00:00.000Z'
const counts = { total: 1, carried: 1, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: false }
const watcherThread = 'watcher-thread'
const target = (threadId: string) => ({ hostId, threadId })
/** Whether a value names OpenCode anywhere. The host's feature list names `provider-opencode` to every client, by design. */
const named = (value: unknown): boolean => /opencode/iu.test(JSON.stringify(value).replaceAll('"provider-opencode"', '').replaceAll('"opencode-sign-in"', ''))

/** Watcher's phone state with an OpenCode thread in every list it keeps. */
function phoneState() {
  const row = (threadId: string, provider: string) => ({ target: target(threadId), title: `${provider} work`, provider, status: 'idle', connected: true, watched: true, takenOver: false, backgroundWorkCount: 0 })
  const receipt = (threadId: string, provider: string) => ({ operationId: '00000000-0000-4000-8000-0000000000a1', target: target(threadId), title: 'Work', provider, action: 'send', deliveryState: 'accepted', createdAt: at, updatedAt: at })
  return { hostId, current: { target: target(watcherThread), provider: 'codex', modelId: codexModel, reasoningEffort: null, status: 'idle', connected: true },
    conversation: { messages: [], earlierAvailable: false, revision: 1 },
    standingWatches: [{ id: '00000000-0000-4000-8000-0000000000b1', target: target(opencodeThread), createdAt: at, generation: 1 }],
    receiptGroups: [{ replyMessageId: null, requestId: '00000000-0000-4000-8000-0000000000c1', rows: [receipt(opencodeThread, 'opencode'), receipt(codexThread, 'codex')] }],
    watchedThreads: [row(opencodeThread, 'opencode'), row(codexThread, 'codex')],
    needsYou: [{ target: target(opencodeThread), title: 'OpenCode work', provider: 'opencode', request: { id: 'q', kind: 'question', title: 'Which?' }, connected: true, mayAnswer: false }],
    inFlight: 0, inFlightLimit: 4, working: false, recoveryNotice: null, observedAt: at }
}

/** A host service over that state: it answers every read with OpenCode in it and records each request it acts on. */
function service() {
  const state: AgentState = openCodeEverywhere()
  const acted: string[] = []
  const listeners = new Set<(value: AgentState) => void>()
  const handover = { text: 'From before', provider: 'opencode', counts }
  const phone = {
    currentThreadId: () => watcherThread,
    // The listener says whether a phone is still paired; this fake queues nothing for Watcher, so it asks nothing.
    useAdmission: () => () => undefined,
    state: () => phoneState(),
    get: () => ({ status: 'ok', state: phoneState() }),
    manage: async (action: string) => { acted.push(`phone-${action}`); return { status: 'ok' } },
    send: async (request: { draftId: string }) => { acted.push('phone-send'); return { status: 'ok', draftId: request.draftId, state: phoneState() } },
    prepareStop: () => ({ status: 'ok', confirmationId: '00000000-0000-4000-8000-0000000000d1', expiresAt: at,
      targets: [{ hostId, threadId: opencodeThread, title: 'OpenCode work', provider: 'opencode' }, { hostId, threadId: codexThread, title: 'Codex work', provider: 'codex' }] }),
    stop: async () => { acted.push('phone-stop-all'); return { status: 'ok', state: phoneState(), results: [
      { target: target(opencodeThread), status: 'uncertain', message: 'The stop was not confirmed. Reconnect and check this thread.' },
      { target: target(codexThread), status: 'stopped', message: 'Stopped.' }] } },
  }
  const value = {
    shell: () => state, state: () => state, subscribe: (listener: (next: AgentState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    threadProvider: (threadId: string) => { const thread = state.host.threads.find(item => item.id === threadId); return thread ? threadProviderOf(thread) : threadId.startsWith('opencode') ? 'opencode' : undefined },
    projectProvider: (projectId: string) => state.host.projects.find(item => item.id === projectId)?.providerId ?? parsePublicProviderEntityId(projectId)?.provider,
    threadKind: (threadId: string) => threadId === watcherThread ? 'watcher' : 'project',
    events: () => [{ seq: 1, threadId: codexThread, event: { kind: 'message-added', at, message: { id: 'first', role: 'user', text: 'Carry on', createdAt: at, handover } } },
      { seq: 2, threadId: opencodeThread, event: { kind: 'message-added', at, message: { id: 'second', role: 'user', text: 'On OpenCode', createdAt: at } } }],
    threadDetail: (threadId: string) => ({ threadId, revision: 1, messages: [{ id: 'first', role: 'user', text: 'Carry on', createdAt: at, handover }] }),
    command: async (command: { type: string }) => { if (command.type !== 'observe-threads') acted.push(`command-${command.type}`); return state },
    watcherPhone: phone,
    supportsWatcherReads: true, supportsWatcherControl: true,
    watcherRead: async (request: { call?: { name: string } }) => {
      acted.push(`read-${request.call?.name ?? 'scope'}`)
      return { status: 'ok', projects: [{ target: { hostId, projectId: opencodeProject }, title: 'Work', workers: [{ provider: 'opencode', modelId: zen }] },
        { target: { hostId, projectId: codexProject }, title: 'Work', workers: [{ provider: 'codex', modelId: codexModel }] }],
      rows: [{ target: target(opencodeThread), provider: 'opencode', projectId: opencodeProject, waitsOn: [] },
        { target: target(codexThread), provider: 'codex', projectId: codexProject, waitsOn: [{ id: 'q', kind: 'question', label: 'Which?', openTarget: target(opencodeThread) }] }] }
    },
    watcherControl: async (request: { call: { name: string } }) => { acted.push(`control-${request.call.name}`); return { status: 'ok' } },
    watcherProjection: () => ({ hostId, master: identity(), revision: 'r1', observedAt: at, requests: [],
      operations: [{ id: 'op-1', target: target(opencodeThread) }, { id: 'op-2', target: target(codexThread) }],
      evidence: [{ id: 'ev-1', target: target(opencodeThread) }], progress: [{ target: target(opencodeThread), fingerprint: 'a'.repeat(64) }] }),
  }
  return { service: value as unknown as HostService, acted, publish: () => { for (const listener of listeners) listener(state) } }
}
const identity = () => ({ target: { hostId: '00000000-0000-4000-8000-0000000000e1', threadId: 'master-watcher' }, projectId: 'master-project', provider: 'codex',
  creationOperationId: '00000000-0000-4000-8000-0000000000e2', createdAt: at })

async function listen(options: Partial<Parameters<typeof startSocketServer>[0]>, accepts: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-provider-peers-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const pairing = new PairedClients(directory); await pairing.load()
  const host = service()
  const server = await startSocketServer({ service: host.service, pairing, ...options })
  cleanup.push(() => server.close())
  const paired = await pairing.redeem(pairing.issuePairingCode().code, 'An older client')
  const peer = await rawPeer(server.descriptor.port, pairing.signSession(paired.clientId, Date.now()))
  cleanup.push(async () => peer.frames.close())
  const hello = await peer.call('hello', { op: 'hello', afterSeq: 0, accepts })
  expect(hello).toMatchObject({ ok: true })
  return { ...host, peer, hello }
}

it('sends an older phone nothing of OpenCode from its shell, events, details or Watcher’s phone state, and refuses Watcher operations on OpenCode threads', async () => {
  const { peer, acted, publish } = await listen({ admin: false }, ['detail-delta', 'activity-summaries', 'watcher-phone', 'watcher-phone-stop-all', 'watcher-phone-manage'])
  // Every answer it reads, and every push it is sent, names OpenCode nowhere.
  expect((await peer.call('shell', { op: 'shell' })).ok).toBe(true)
  expect(await peer.call('events', { op: 'events', afterSeq: 0 })).toMatchObject({ ok: true })
  expect(await peer.call('detail', { op: 'detail', threadId: codexThread })).toMatchObject({ ok: true })
  expect(await peer.call('phone-read', { op: 'watcher-phone-read' })).toMatchObject({ ok: true, result: { status: 'ok' } })
  // Stop all stops every thread Watcher drives, so its confirmation lists the OpenCode one too, by its title alone.
  expect(await peer.call('prepare', { op: 'watcher-phone-prepare-stop-all' })).toMatchObject({ ok: true, result: { status: 'ok', targets: [
    { hostId, threadId: opencodeThread, title: 'OpenCode work', provider: null }, { hostId, threadId: codexThread, title: 'Codex work', provider: 'codex' }] } })
  expect(await peer.call('watch-codex', { op: 'watcher-phone-watch', request: { target: target(codexThread) } })).toMatchObject({ ok: true })
  // Its result says what became of every thread the confirmation listed, the OpenCode one included, as its confirmation did.
  const stopped = await peer.call('stop-all', { op: 'watcher-phone-stop-all', confirmationId: '00000000-0000-4000-8000-0000000000d1' })
  expect(stopped).toMatchObject({ ok: true, result: { status: 'ok', results: [
    { target: target(opencodeThread), status: 'uncertain', message: 'The stop was not confirmed. Reconnect and check this thread.' },
    { target: target(codexThread), status: 'stopped', message: 'Stopped.' }] } })
  expect(named((stopped.result as { state: unknown }).state)).toBe(false)
  const before = peer.messages.length
  publish()
  await expect.poll(() => peer.messages.slice(before).some(message => message.event === 'shell')).toBe(true)
  // Watching, unwatching, sending to or answering in an OpenCode thread is refused before Watcher hears of it.
  for (const [id, operation] of [
    ['watch', { op: 'watcher-phone-watch', request: { target: target(opencodeThread) } }],
    ['unwatch', { op: 'watcher-phone-unwatch', request: { target: target(opencodeThread) } }],
    ['send', { op: 'watcher-phone-send', request: { origin: { kind: 'phone', hostId, clientId: 'phone' }, target: target(opencodeThread), draftId: '00000000-0000-4000-8000-0000000000f1', text: 'Go on' } }],
    ['answer', { op: 'watcher-phone-answer', request: { target: target(opencodeThread), command: { type: 'answer', threadId: opencodeThread, requestId: 'q', answer: 'Yes' } } }],
  ] as const) expect(await peer.call(id, operation)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(acted).toEqual(['phone-watch', 'phone-stop-all'])
  // Its fixture thread is named for OpenCode, so the two answers that list it by title or target are left out of this check.
  expect(peer.messages.filter(message => message.id !== 'prepare' && message.id !== 'stop-all').filter(named)).toEqual([])
})

it('sends an older desktop no Watcher row, project or projection of OpenCode, and refuses its reads and directions of OpenCode threads before they run', async () => {
  const desktops = { refresh: async () => undefined, has: () => true }
  const { peer, acted, publish } = await listen({ watcherDesktops: desktops }, ['detail-delta', 'watcher-reads', 'watcher-control', 'watcher-standing-watch'])
  const read = (call?: Record<string, unknown>) => ({ op: 'watcher-read', request: { master: identity(), ...(call ? { call } : {}) } })
  // The scope read Watcher keeps, and the projection the next shell carries.
  expect(await peer.call('scope', read())).toMatchObject({ ok: true })
  expect(await peer.call('projects', read({ name: 'list_projects', input: {} }))).toMatchObject({ ok: true })
  const before = peer.messages.length
  publish()
  await expect.poll(() => peer.messages.slice(before).some(message => message.event === 'watcher-state')).toBe(true)
  // A read or a direction that names an OpenCode thread or project is refused, and the host never runs it.
  const mutation = { requestId: '00000000-0000-4000-8000-000000000102', retryKey: '00000000-0000-4000-8000-000000000103' }
  const control = (call: { name: string; input: Record<string, unknown> }) => {
    const action = call.name.split('_')[0] === 'send' ? 'send' : call.name.split('_')[0]
    const operation = { id: '00000000-0000-4000-8000-000000000104', ...mutation, digest: 'b'.repeat(64), action, target: (call.input.target as object | undefined) ?? target('new-thread'),
      generation: 0, deliveryState: 'queued', createdAt: at, updatedAt: at, receiptId: 'receipt', cardId: 'card' }
    return { op: 'watcher-control', request: { master: identity(), request: { id: mutation.requestId, watcher: identity().target, rootUserMessageId: 'root', createdAt: at },
      ceiling: 'approval-required', operation, call } }
  }
  for (const [id, operation] of [
    ['read-thread', read({ name: 'read_thread', input: { target: target(opencodeThread) } })],
    ['list-threads', read({ name: 'list_threads', input: { project: { hostId, projectId: opencodeProject } } })],
    ['working-copies', read({ name: 'list_working_copies', input: { project: { hostId, projectId: opencodeProject } } })],
    ['send', control({ name: 'send_to_thread', input: { ...mutation, target: target(opencodeThread), text: 'Go on', delivery: 'now' } })],
    ['stop', control({ name: 'stop_thread', input: { ...mutation, target: target(opencodeThread) } })],
    ['settle', control({ name: 'settle_thread', input: { ...mutation, target: target(opencodeThread) } })],
    ['start', control({ name: 'start_thread', input: { ...mutation, project: { hostId, projectId: opencodeProject }, modelId: codexModel, title: 'Work', workingCopy: { kind: 'shared' }, firstPrompt: 'Go' } })],
    ['start-model', control({ name: 'start_thread', input: { ...mutation, project: { hostId, projectId: codexProject }, modelId: zen, title: 'Work', workingCopy: { kind: 'shared' }, firstPrompt: 'Go' } })],
  ] as const) expect(await peer.call(id, operation), id).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(acted).toEqual(['read-scope', 'read-list_projects'])
  expect(peer.messages.filter(named)).toEqual([])
})

it('still sends a client that knows OpenCode all of it', async () => {
  const { peer, hello } = await listen({ admin: false }, ['detail-delta', 'watcher-phone', 'provider-opencode'])
  expect(named(hello)).toBe(true)
  expect(await peer.call('phone-read', { op: 'watcher-phone-read' })).toSatisfy(named)
})

it('names each peer the revision of the catalog it was sent, so neither is sent its catalog again on every publish (#1143)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-provider-peers-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const pairing = new PairedClients(directory); await pairing.load()
  const host = service()
  const server = await startSocketServer({ service: host.service, pairing })
  cleanup.push(() => server.close())
  const connect = async (name: string, accepts: string[]) => {
    const paired = await pairing.redeem(pairing.issuePairingCode().code, name)
    const peer = await rawPeer(server.descriptor.port, pairing.signSession(paired.clientId, Date.now()))
    cleanup.push(async () => peer.frames.close())
    const hello = await peer.call('hello', { op: 'hello', afterSeq: 0, accepts })
    return { peer, models: (hello.result as { shell: { host: { models?: { id: string }[]; modelsRevision: number } } }).shell.host }
  }
  const newer = await connect('A newer client', ['model-catalog-revision', 'provider-opencode'])
  const older = await connect('An older client', ['model-catalog-revision'])
  expect(newer.models.models!.map(model => model.id)).toContain(zen)
  expect(older.models.models!.map(model => model.id)).not.toContain(zen)
  const shells = (peer: typeof newer.peer) => peer.messages.filter(message => message.event === 'shell').map(message => (message.state as { host: { models?: unknown; modelsRevision: number } }).host)
  for (let round = 1; round <= 3; round++) {
    host.publish()
    await expect.poll(() => shells(newer.peer).length >= round && shells(older.peer).length >= round).toBe(true)
  }
  // Both lists are unchanged, so each peer keeps the revision its hello named and is never sent its catalog again.
  for (const { peer, models } of [newer, older]) for (const pushed of shells(peer)) {
    expect(pushed.modelsRevision).toBe(models.modelsRevision)
    expect(pushed).not.toHaveProperty('models')
  }
})
