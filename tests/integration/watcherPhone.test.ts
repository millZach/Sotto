// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { startSocketServer } from '../../src/host/socketServer'
import { watcherPhoneResultSchema, watcherPhoneSendResultSchema } from '../../src/shared/watcherPhone'
import { hostReceiptSchema } from '../../src/shared/hostProtocol'
import { WATCHER_STOP_ALL_PREVIEW_LIMIT } from '../../src/shared/watcherRoom'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { rawPeer } from '../fixtures/rawHostPeer'
import { deferred } from '../fixtures/deferred'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(phoneFeature = true) {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  let canAnswer = false
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, authority: { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
      mayGrant: client => ({ allowed: client.transport === 'ipc' || canAnswer, reason: 'paired-client' }) } } })
  const watcher = new WatcherService({ directory: workspace.root, host: workspace.host, control: f.control, limit: () => 4, historyEnabled: () => true })
  const tools = new WatcherToolServer(watcher); workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { watcher.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await watcher.recover()
  const model = f.control.shell().host.models.find(row => row.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(row => row.providerId === 'codex')!
  expect(await watcher.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const target = watcher.state().current!.target
  const phone = new WatcherPhoneService(f.control, watcher)
  const service = new LocalHostService({ control: f.control, ...(phoneFeature ? { watcherPhone: phone } : {}) })
  const pairing = new PairedClients(workspace.root); await pairing.load()
  const server = await startSocketServer({ service, pairing, admin: false, mayAnswer: () => canAnswer })
  cleanups.push(() => server.close())
  const pair = async (accepts: string[] = ['watcher-phone', 'watcher-phone-stop-all']) => {
    const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Synthetic phone')
    const session = pairing.signSession(paired.clientId, Date.now())
    const peer = await rawPeer(server.descriptor.port, session); cleanups.push(async () => peer.frames.close())
    const hello = await peer.call('hello', { op: 'hello', accepts })
    return { ...peer, paired, hello }
  }
  const native = (threadId: string) => workspace.adapters.codex.state.threads.find(row => row.id === workspace.registry.byThread(threadId)!.sessionId)!
  const finish = async (threadId: string) => { native(threadId).status = 'idle'; workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' }) }
  const start = async () => {
    const result = await watcher.invoke(target.threadId, 'start_thread', { requestId: watcher.state().requests.at(-1)!.id,
      retryKey: randomUUID(), project: { hostId: target.hostId, projectId: project.id }, modelId: model.id,
      title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic worker request' }) as { status: string; target: typeof target }
    expect(result.status).toBe('ok'); return result.target
  }
  return { ...f, workspace, watcher, phone, target, service, pairing, server, pair, native, finish, start,
    canAnswer: (value: boolean) => { canAnswer = value }, send: (clientId: string, draftId = randomUUID(), text = 'Synthetic phone request') => ({ op: 'watcher-phone-send',
      request: { origin: { kind: 'phone', hostId: target.hostId, clientId }, target, draftId, text } }) }
}

it('offers phone Watcher only on its desktop listener and leaves old phones ordinary workers without misleading master rows or events', async () => {
  const f = await fixture(), old = await f.pair([]), current = await f.pair()
  expect(old.hello).toMatchObject({ ok: true, result: { features: expect.arrayContaining(['watcher-phone', 'watcher-phone-stop-all']) } })
  const oldShell = (old.hello.result as { shell: { watcher?: unknown; host: { threads: { id: string }[] } } }).shell
  expect(oldShell.watcher).toBeUndefined(); expect(oldShell.host.threads.some(row => row.id === f.target.threadId)).toBe(false)
  expect((old.hello.result as { shell: { host: { projects: { id: string }[] } } }).shell.host.projects.some(project => project.id === f.watcher.state().current!.projectId)).toBe(false)
  expect(await old.call('no-opt', { op: 'watcher-phone-read' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(await old.call('hidden-detail', { op: 'detail', threadId: f.target.threadId })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  const read = await current.call('read', { op: 'watcher-phone-read' })
  expect(watcherPhoneResultSchema.parse(read.result)).toMatchObject({ status: 'ok', state: { current: { target: f.target }, inFlightLimit: 4 } })
  const admin = await startSocketServer({ service: f.service, pairing: f.pairing }); cleanups.push(() => admin.close())
  expect(admin.descriptor.features).not.toContain('watcher-phone')
  const stable = await fixture(false), stablePhone = await stable.pair()
  expect(stable.server.descriptor.features).not.toContain('watcher-phone')
  expect(await stablePhone.call('stable-read', { op: 'watcher-phone-read' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(stable.watcher.state().current).not.toBeNull()
})

it('admits a paired phone origin without Can answer, keeps the computer defaults, deduplicates its exact draft and refuses forged or retired origins', async () => {
  const f = await fixture(), peer = await f.pair(), packet = f.send(peer.paired.clientId)
  const sent = await peer.call('send', packet)
  expect(watcherPhoneSendResultSchema.parse(sent.result)).toMatchObject({ status: 'ok' })
  expect(f.watcher.state().requests.at(-1)?.phoneOrigin).toEqual(packet.request.origin)
  expect(f.phone.state(false).conversation.messages[0]?.text).toBe(packet.request.text)
  // The provider receives the phone's words as typed; the request rides beside them.
  expect(f.native(f.target.threadId).messages[0]?.text).toBe(packet.request.text)
  expect(f.workspace.adapters.codex.commands.findLast(row => row.type === 'send')).toMatchObject({ text: packet.request.text,
    watcherRequestNote: expect.stringContaining(f.watcher.state().requests.at(-1)!.id) })
  expect(await peer.call('receipt', { op: 'receipt', commandId: 'send' })).toMatchObject({ ok: true, result: { status: 'completed' } })
  expect(f.phone.state(false).draftDeliveries).toEqual(expect.arrayContaining([{ draftId: packet.request.draftId, status: 'accepted' }]))
  const roots = f.watcher.state().requests.length
  expect(await peer.call('send-again', packet)).toMatchObject({ ok: true, result: { status: 'ok' } })
  expect(f.watcher.state().requests).toHaveLength(roots)
  const worker = await f.start(); expect(f.workspace.adapters.codex.commands.findLast(row => row.type === 'create-thread')).toMatchObject({ runtimeMode: 'approval-required' })
  expect(await peer.call('forged', f.send('another-phone'))).toMatchObject({ ok: true, result: { status: 'refused', code: 'INVALID_INPUT' } })
  expect(await peer.call('wrong-host', { ...packet, request: { ...packet.request, origin: { ...packet.request.origin, hostId: randomUUID() } } })).toMatchObject({ ok: true, result: { status: 'refused' } })
  expect(await peer.call('retired', { ...packet, request: { ...packet.request, target: worker } })).toMatchObject({ ok: true, result: { status: 'refused', code: 'TARGET_CHANGED' } })
  expect(await peer.call('generic', { op: 'command', command: { type: 'manual-send', threadId: f.target.threadId, text: 'Synthetic forged generic' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
})

it('shows phone instructions as typed: without the footer main once appended, and with a note the user typed', async () => {
  const f = await fixture(), peer = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); await f.finish(f.target.threadId)
  const older = f.watcher.state().requests.at(-1)!
  // An instruction saved before the request note, with the footer main appended for its own request.
  const footer = `\n\n[Sotto Watcher request: ${older.id}. Local host: ${f.target.hostId}. Use this requestId for sotto_threads mutations. `
    + `Known project IDs: native:claude:project:${randomUUID()}. Call list_projects for choices.]`
  const typed = 'Synthetic older phone instruction'
  f.native(f.target.threadId).messages.find(row => row.id === older.rootUserMessageId)!.text = typed + footer
  // A later instruction in which the user typed an example note of their own.
  const example = `Explain this example:\n\n[Sotto Watcher request: ${randomUUID()}. Local host: ${f.target.hostId}. Use this requestId for sotto_threads changes made for this message.]`
  await peer.call('send-example', f.send(peer.paired.clientId, randomUUID(), example)); await f.finish(f.target.threadId)
  const later = f.watcher.state().requests.at(-1)!
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const text = (id: string) => f.phone.state(false).conversation.messages.find(row => row.id === id)?.text
  await vi.waitFor(() => expect(text(older.rootUserMessageId)).toBe(typed))
  expect(text(later.rootUserMessageId)).toBe(example)
  const read = await peer.call('read', { op: 'watcher-phone-read' })
  expect(watcherPhoneResultSchema.parse(read.result)).toMatchObject({ status: 'ok', state: { conversation: { messages: expect.arrayContaining([
    expect.objectContaining({ id: older.rootUserMessageId, text: typed }), expect.objectContaining({ id: later.rootUserMessageId, text: example })]) } } })
  expect(JSON.stringify(read.result)).not.toContain('Use this requestId for sotto_threads mutations')
})
it('does not attach an old receipt to an assistant reply after a later user instruction', async () => {
  const f = await fixture(), peer = await f.pair(); await peer.call('first', f.send(peer.paired.clientId)); await f.start()
  const firstRequest = f.watcher.state().requests.at(-1)!.id
  await f.finish(f.target.threadId); await peer.call('second', f.send(peer.paired.clientId, randomUUID(), 'Synthetic later instruction'))
  f.native(f.target.threadId).messages.push({ id: 'later-reply', role: 'assistant', text: 'Synthetic later reply', createdAt: new Date(Date.now() + 1_000).toISOString() })
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.phone.state(false).receiptGroups.find(row => row.requestId === firstRequest)?.replyMessageId).toBeNull()
})

it('uses the computer default even when the phone cannot answer and refuses a Watcher send that would answer a card', async () => {
  const f = await fixture(), peer = await f.pair()
  f.workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits']
  f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: 'auto-accept-edits' } })
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await peer.call('send', f.send(peer.paired.clientId)); await f.start()
  expect(f.workspace.adapters.codex.commands.findLast(row => row.type === 'create-thread')).toMatchObject({ runtimeMode: 'auto-accept-edits' })
  f.native(f.target.threadId).requests = [{ id: 'watcher-question', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const before = f.workspace.adapters.codex.commands.length
  expect(await peer.call('blocked-send', f.send(peer.paired.clientId))).toMatchObject({ ok: true, result: { status: 'refused' } })
  expect(f.workspace.adapters.codex.commands).toHaveLength(before)
})

it('projects grouped replies with one row per thread and keeps remote owning cards separate from the ordinary local list', async () => {
  const f = await fixture(), peer = await f.pair(); await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  await f.finish(worker.threadId)
  await f.watcher.invoke(f.target.threadId, 'send_to_thread', { target: worker, requestId: f.watcher.state().requests.at(-1)!.id,
    retryKey: randomUUID(), text: 'Synthetic follow-up', delivery: 'now' })
  const reply = { id: 'reply', role: 'assistant' as const, text: 'Synthetic receipt reply', createdAt: '2026-10-11T10:00:00.000Z' }
  f.native(f.target.threadId).messages[0]!.createdAt = '2026-10-11T09:59:00.000Z'
  f.native(f.target.threadId).messages.push(reply)
  await f.control.updateWatcher(record => { for (const operation of record.operations) operation.createdAt = '2026-10-11T10:00:01.000Z' })
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const page = f.phone.state(false)
  expect(page.receiptGroups).toHaveLength(1)
  expect(page.receiptGroups[0]).toMatchObject({ replyMessageId: 'reply', rows: [{ target: worker, action: 'send' }] })
  const remoteId = randomUUID(), remoteTarget = { hostId: remoteId, threadId: 'remote-worker' }
  const remoteSnapshot = { ...f.control.watcherSnapshot(), hostId: remoteId, threads: [{ ...f.control.watcherSnapshot().threads.find(row => row.id === worker.threadId)!,
    id: remoteTarget.threadId, hostId: remoteId, providerId: 'claude' as const, title: 'Forge worker', requests: [{ id: 'remote-question', kind: 'question' as const, text: 'Synthetic remote question', options: [] }] }] }
  f.watcher.useRemoteHosts({ hosts: () => [{ hostId: remoteId, reads: false, control: false, connected: true, permissionCeiling: 'approval-required' as const }], snapshot: () => remoteSnapshot,
    read: async () => null, control: async () => null, subscribe: () => () => undefined })
  await f.control.updateWatcher(record => { record.requests.at(-1)!.participants.push({ target: remoteTarget, requestId: record.requests.at(-1)!.id,
    startedBy: 'user', generation: 0, state: 'participating', promptCount: 0 }) })
  expect(f.phone.state(true).needsYou).toMatchObject([{ target: remoteTarget, provider: 'claude', mayAnswer: false }])
  const shell = await peer.call('local-list', { op: 'shell' })
  expect((shell.result as { host: { threads: { id: string }[] } }).host.threads.some(row => row.id === remoteTarget.threadId)).toBe(false)
})

it('projects worker cards inside Watcher and routes the user answer to the worker under freshly checked Can answer without takeover', async () => {
  const f = await fixture(), peer = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  f.native(worker.threadId).requests = [{ id: 'native-permission', kind: 'permission', text: 'Synthetic worker permission', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.phone.state(false).needsYou).toMatchObject([{ target: worker, provider: 'codex', mayAnswer: false }])
  const answer = { op: 'watcher-phone-answer', request: { target: worker, command: { type: 'answer', threadId: worker.threadId,
    requestId: 'native-permission', answer: 'Allow', approved: true } } }
  expect(await peer.call('denied', answer)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(f.native(worker.threadId).requests).toHaveLength(1)
  f.canAnswer(true)
  expect(await peer.call('allowed', answer)).toMatchObject({ ok: true, result: { status: 'ok' } })
  expect(f.workspace.adapters.codex.commands.findLast(row => row.type === 'answer')).toMatchObject({ threadId: f.native(worker.threadId).id, requestId: 'native-permission', approved: true })
  expect(f.watcher.state().requests.at(-1)?.participants[0]?.state).toBe('participating')
  expect(await peer.call('stale', answer)).toMatchObject({ ok: false, error: { code: 'stale_request' } })
})

it('fences a phone direct send as takeover and binds Stop all previews to the exact user and ownership', async () => {
  const f = await fixture(), peer = await f.pair(), other = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  const preview = await peer.call('preview', { op: 'watcher-phone-prepare-stop-all' })
  const confirmationId = (preview.result as { confirmationId: string }).confirmationId
  expect(preview).toMatchObject({ ok: true, result: { targets: [{ ...worker, title: 'Synthetic worker', provider: 'codex' }] } })
  expect(await other.call('stolen', { op: 'watcher-phone-stop-all', confirmationId })).toMatchObject({ ok: true, result: { status: 'refused', code: 'TARGET_CHANGED' } })
  await f.finish(worker.threadId)
  expect(await peer.call('direct', { op: 'command', command: { type: 'manual-send', threadId: worker.threadId, draftId: randomUUID(), text: 'Synthetic direct user input' } })).toMatchObject({ ok: true })
  expect(f.watcher.state().requests.at(-1)?.participants[0]?.state).toBe('taken-over')
  expect(await peer.call('changed', { op: 'watcher-phone-stop-all', confirmationId })).toMatchObject({ ok: true, result: { status: 'refused', code: 'TARGET_CHANGED' } })
  await f.finish(f.target.threadId); await peer.call('second-send', f.send(peer.paired.clientId)); const eligible = await f.start()
  const latest = await peer.call('latest', { op: 'watcher-phone-prepare-stop-all' })
  const id = (latest.result as { confirmationId: string }).confirmationId
  expect(await peer.call('stop', { op: 'watcher-phone-stop-all', confirmationId: id })).toMatchObject({ ok: true, result: { status: 'ok', results: [{ target: eligible, status: 'stopped' }] } })
  expect(await peer.call('consumed', { op: 'watcher-phone-stop-all', confirmationId: id })).toMatchObject({ ok: true, result: { status: 'refused' } })
})

it('rechecks the phone policy at the worker writer after an allowed card waits in the lane', async () => {
  const f = await fixture(), peer = await f.pair(); await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  f.native(worker.threadId).requests = [{ id: 'permission', kind: 'permission', text: 'Synthetic request', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' }); f.canAnswer(true)
  const barrier = deferred<void>(), original = f.workspace.host.execute.bind(f.workspace.host)
  const entered = deferred<void>()
  vi.spyOn(f.workspace.host, 'execute').mockImplementation(async (command, ...rest) => {
    if (command.type === 'answer') { entered.resolve(); await barrier.promise }
    return original(command, ...rest)
  })
  const pending = peer.call('answer', { op: 'watcher-phone-answer', request: { target: worker,
    command: { type: 'answer', threadId: worker.threadId, requestId: 'permission', answer: 'Allow', approved: true } } })
  await entered.promise; f.canAnswer(false); barrier.resolve()
  expect(await pending).toMatchObject({ ok: false })
  expect(f.workspace.adapters.codex.commands.filter(row => row.type === 'answer')).toHaveLength(0)
})


it('fences phone instructions at admission and dispatch while Watcher changes provider', async () => {
  const f = await fixture(), peer = await f.pair()
  await f.control.commandShell({ type: 'connect', provider: 'claude' })
  const model = f.control.shell().host.models.find(row => row.providerId === 'claude')!
  const entered = deferred<void>(), release = deferred<void>()
  const original = f.control.commandForWatcherRoom.bind(f.control)
  vi.spyOn(f.control, 'commandForWatcherRoom').mockImplementation(async command => {
    if (command.type === 'create-project' && command.provider === 'claude') { entered.resolve(); await release.promise }
    return original(command)
  })
  const changing = f.watcher.open({ provider: 'claude', modelId: model.id })
  try {
    await entered.promise
    const admitted = vi.spyOn(f.control, 'commandFromWatcherPhone')
    expect(await peer.call('during-change', f.send(peer.paired.clientId))).toMatchObject({ ok: true, result: { status: 'refused' } })
    expect(admitted).not.toHaveBeenCalled()
    // Exercise dispatch independently: even a command already tagged with a phone origin must refuse.
    const packet = f.send(peer.paired.clientId)
    const late = await f.control.commandFromWatcherPhone({ type: 'send', draft: {
      threadId: f.target.threadId, draftId: packet.request.draftId, text: packet.request.text, attachments: [],
      binding: { requestId: null, questionsDigest: null } } }, { phoneOrigin: { ...packet.request.origin, kind: 'phone' }, guard: () => undefined },
    { clientId: peer.paired.clientId, transport: 'socket', user: 'synthetic-user', selectedThreadId: f.target.threadId })
    expect(late.error).toContain('provider change')
    expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'send')).toHaveLength(0)
  } finally { release.resolve(); await changing }
})


it('reconciles a lost Stop all reply from a client-bound receipt with partial results and no repeated stop', async () => {
  const f = await fixture(), peer = await f.pair(), other = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); const first = await f.start(), second = await f.start()
  const preview = await peer.call('preview', { op: 'watcher-phone-prepare-stop-all' })
  const packet = { op: 'watcher-phone-stop-all', confirmationId: (preview.result as { confirmationId: string }).confirmationId }
  const entered = deferred<void>(), release = deferred<void>(), original = f.workspace.host.execute.bind(f.workspace.host)
  vi.spyOn(f.workspace.host, 'execute').mockImplementation(async (command, ...rest) => {
    if (command.type === 'interrupt' && command.threadId === first.threadId) { entered.resolve(); await release.promise }
    if (command.type === 'interrupt' && command.threadId === second.threadId) throw new Error('Synthetic stop unavailable')
    return original(command, ...rest)
  })
  const resumed = await rawPeer(f.server.descriptor.port, f.pairing.signSession(peer.paired.clientId, Date.now()))
  cleanups.push(async () => resumed.frames.close())
  await resumed.call('hello', { op: 'hello', accepts: ['watcher-phone', 'watcher-phone-stop-all'] })
  const pending = peer.call('lost-stop', packet)
  try {
    await entered.promise
    expect(await resumed.call('pending-receipt', { op: 'receipt', commandId: 'lost-stop' })).toMatchObject({ ok: true, result: { status: 'pending' } })
    expect(await other.call('private-receipt', { op: 'receipt', commandId: 'lost-stop' })).toMatchObject({ ok: true, result: { status: 'unknown' } })
  } finally { release.resolve() }
  const completed = await pending
  expect(completed).toMatchObject({ ok: true, result: { status: 'ok', results: expect.arrayContaining([
    expect.objectContaining({ target: first, status: 'stopped' }), expect.objectContaining({ target: second, status: 'uncertain' })]) } })
  // Discard the acknowledgement and close its connection; recover through the same pairing.
  peer.messages.splice(peer.messages.findIndex(message => message.id === 'lost-stop'), 1); peer.frames.close()
  const result = completed.result as { results: unknown[] }
  const recovered = await resumed.call('completed-receipt', { op: 'receipt', commandId: 'lost-stop' })
  expect(hostReceiptSchema.parse(recovered.result)).toMatchObject({ status: 'completed', watcherStop: { status: 'ok', results: result.results } })
  const before = f.workspace.adapters.codex.commands.filter(command => command.type === 'interrupt').length
  expect(await resumed.call('lost-stop', packet)).toMatchObject({ ok: true, result: { status: 'ok', results: result.results } })
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'interrupt')).toHaveLength(before)
  resumed.messages.splice(resumed.messages.findIndex(message => message.id === 'lost-stop'), 1)
  expect(await resumed.call('lost-stop', { ...packet, confirmationId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})


it('marks workers watched only for active requests belonging to the current host-qualified Watcher', async () => {
  const f = await fixture(), peer = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  const watched = () => f.phone.state(false).watchedThreads.find(row => row.target.threadId === worker.threadId)!.watched
  expect(watched()).toBe(true)
  const preview = await peer.call('preview', { op: 'watcher-phone-prepare-stop-all' })
  await peer.call('stop', { op: 'watcher-phone-stop-all', confirmationId: (preview.result as { confirmationId: string }).confirmationId })
  expect(f.watcher.state().requests.at(-1)?.state).toBe('stopped')
  expect(watched()).toBe(false)
  const shell = await peer.call('after-stop', { op: 'shell' })
  expect((shell.result as { host: { threads: { id: string; watchedByWatcher?: boolean }[] } }).host.threads.find(row => row.id === worker.threadId)?.watchedByWatcher).toBe(false)
  // Historical participation remains retained, including a host-local ID collision with another master.
  await f.control.updateWatcher(record => { const request = record.requests.at(-1)!; request.state = 'active'; request.closedAt = null; request.watcher.hostId = randomUUID() })
  expect(watched()).toBe(false)
  await f.control.updateWatcher(record => { const request = record.requests.at(-1)!; request.watcher = f.target; request.state = 'closed'; request.closedAt = new Date().toISOString() })
  expect(watched()).toBe(false)
  await f.control.updateWatcher(record => { const request = record.requests.at(-1)!; request.state = 'active'; request.closedAt = null })
  expect(watched()).toBe(true)
})

it('keeps a phone Stop all preview valid when another phone opens many previews', async () => {
  const f = await fixture(), first = await f.pair(), other = await f.pair()
  await first.call('send', f.send(first.paired.clientId)); const worker = await f.start()
  const preview = await first.call('preview', { op: 'watcher-phone-prepare-stop-all' })
  expect(preview).toMatchObject({ ok: true, result: { status: 'ok' } })
  const otherOldest = await other.call('other-oldest', { op: 'watcher-phone-prepare-stop-all' })
  for (let index = 0; index < WATCHER_STOP_ALL_PREVIEW_LIMIT * 5; index++) {
    expect(await other.call(`preview-${index}`, { op: 'watcher-phone-prepare-stop-all' })).toMatchObject({ ok: true, result: { status: 'ok' } })
  }
  const retained = (f.watcher as unknown as { confirmations: ReadonlyMap<string, unknown> }).confirmations
  expect(retained.size).toBe(WATCHER_STOP_ALL_PREVIEW_LIMIT + 1)
  expect(await other.call('replaced', { op: 'watcher-phone-stop-all', confirmationId: (otherOldest.result as { confirmationId: string }).confirmationId }))
    .toMatchObject({ ok: true, result: { status: 'refused', code: 'TARGET_CHANGED', message: expect.stringContaining('replaced by a newer one') } })
  const confirmationId = (preview.result as { confirmationId: string }).confirmationId
  expect(await other.call('stolen', { op: 'watcher-phone-stop-all', confirmationId })).toMatchObject({ ok: true, result: { status: 'refused', code: 'TARGET_CHANGED' } })
  expect(await f.watcher.stopAll(confirmationId)).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
  expect(await first.call('stop', { op: 'watcher-phone-stop-all', confirmationId: (preview.result as { confirmationId: string }).confirmationId }))
    .toMatchObject({ ok: true, result: { status: 'ok', results: [{ target: worker, status: 'stopped' }] } })
  // Expiration releases each client's retained previews.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
  try {
    expect(f.watcher.prepareStopAll()).toMatchObject({ status: 'ok' })
    expect(await other.call('after-expiry', { op: 'watcher-phone-prepare-stop-all' })).toMatchObject({ ok: true, result: { status: 'ok' } })
    expect(retained.size).toBe(2)
  } finally { clock.mockRestore() }
})

it.each(['existing', 'newest'])('keeps the desktop room\'s %s Stop all preview usable when a phone opens many previews', async choice => {
  const f = await fixture(), peer = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  const existing = f.watcher.prepareStopAll()
  if (existing.status !== 'ok') throw new Error('desktop preview refused')
  let phonePreview
  // Cross the former shared cap as well as the per-client cap.
  for (let index = 0; index < 80; index++) phonePreview = await peer.call(`preview-${index}`, { op: 'watcher-phone-prepare-stop-all' })
  const newest = f.watcher.prepareStopAll()
  expect(newest).toMatchObject({ status: 'ok' })
  if (newest.status !== 'ok') throw new Error('new desktop preview refused')
  expect(phonePreview).toMatchObject({ ok: true, result: { status: 'ok' } })
  const phoneConfirmationId = (phonePreview!.result as { confirmationId: string }).confirmationId
  expect(await f.watcher.stopAll(phoneConfirmationId)).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
  expect(await peer.call('desktop-preview', { op: 'watcher-phone-stop-all', confirmationId: existing.confirmationId }))
    .toMatchObject({ ok: true, result: { status: 'refused', code: 'TARGET_CHANGED' } })
  const retained = (f.watcher as unknown as { confirmations: ReadonlyMap<string, unknown> }).confirmations
  expect(retained.size).toBe(WATCHER_STOP_ALL_PREVIEW_LIMIT + 2)
  expect(retained.has(phoneConfirmationId)).toBe(true)
  expect(await f.watcher.stopAll(choice === 'existing' ? existing.confirmationId : newest.confirmationId))
    .toMatchObject({ status: 'ok', results: [{ target: worker, status: 'stopped' }] })
  expect(f.workspace.adapters.codex.commands.filter(row => row.type === 'interrupt')).toHaveLength(1)
})

it('replays a phone worker answer after reconnect without answering again or requiring a new grant', async () => {
  const f = await fixture(), peer = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  f.native(worker.threadId).requests = [{ id: 'permission', kind: 'permission', text: 'Synthetic worker permission', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' }); f.canAnswer(true)
  const answer = { op: 'watcher-phone-answer', request: { target: worker, command: { type: 'answer', threadId: worker.threadId,
    requestId: 'permission', answer: 'Allow', approved: true } } }
  expect(await peer.call('ans-1', answer)).toMatchObject({ ok: true, result: { status: 'ok' } })
  expect(f.phone.state(true).needsYou.some(card => card.request.id === 'permission')).toBe(false)
  peer.messages.splice(peer.messages.findIndex(message => message.id === 'ans-1'), 1); peer.frames.close()
  const resumed = await rawPeer(f.server.descriptor.port, f.pairing.signSession(peer.paired.clientId, Date.now()))
  cleanups.push(async () => resumed.frames.close())
  await resumed.call('hello', { op: 'hello', accepts: ['watcher-phone'] })
  expect(await resumed.call('receipt', { op: 'receipt', commandId: 'ans-1' })).toMatchObject({ ok: true, result: { status: 'completed', answerDelivered: true } })
  expect(await resumed.call('ans-1', answer)).toMatchObject({ ok: true, result: { status: 'ok' } })
  resumed.messages.splice(resumed.messages.findIndex(message => message.id === 'ans-1'), 1); f.canAnswer(false)
  // An unrelated error in the fresh shell cannot change the original answer's successful outcome.
  await f.control.commandShell({ type: 'manual-send', threadId: 'missing-thread', text: 'Synthetic unknown thread' })
  expect(f.control.shell().error).toBeTruthy()
  expect(await resumed.call('ans-1', answer)).toMatchObject({ ok: true, result: { status: 'ok' } })
  for (const changed of [
    { ...answer, request: { ...answer.request, command: { ...answer.request.command, approved: false } } },
    { ...answer, request: { ...answer.request, target: { ...worker, hostId: randomUUID() } } },
  ]) {
    resumed.messages.splice(resumed.messages.findIndex(message => message.id === 'ans-1'), 1)
    expect(await resumed.call('ans-1', changed)).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  }
  const other = await f.pair()
  expect(await other.call('receipt', { op: 'receipt', commandId: 'ans-1' })).toMatchObject({ ok: true, result: { status: 'unknown' } })
  expect(await other.call('ans-1', answer)).toMatchObject({ ok: false, error: { code: 'stale_request' } })
  f.native(worker.threadId).requests = [{ id: 'new-permission', kind: 'permission', text: 'Synthetic later permission', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(await resumed.call('ans-new', { ...answer, request: { ...answer.request, command: { ...answer.request.command, requestId: 'new-permission' } } }))
    .toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(f.native(worker.threadId).requests).toHaveLength(1)
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'answer')).toHaveLength(1)
})
