// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import { UsageService } from '../../src/main/agents/usageService'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { startSocketServer } from '../../src/host/socketServer'
import { watcherPhoneResultSchema, watcherPhoneSendResultSchema, watcherPhoneStateSchema } from '../../src/shared/watcherPhone'
import { hostReceiptSchema } from '../../src/shared/hostProtocol'
import { WATCHER_STOP_ALL_PREVIEW_LIMIT } from '../../src/shared/watcherRoom'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { rawPeer } from '../fixtures/rawHostPeer'
import { deferred } from '../fixtures/deferred'
import { PIXEL_PNG } from '../fixtures/stagedImages'
import { watcherRequestLine, watcherRequestNote } from '../../src/main/agents/watcherRequestNote'

const GIB = 1024 ** 3
/** This computer as its host facts read it: busy, with memory to spare (#1032). */
const MACHINE_REPORT = { facts: { observedAt: new Date().toISOString(), os: { family: 'linux' as const, name: 'Omarchy', version: null }, architecture: 'x64',
  totalMemoryBytes: 64 * GIB, freeMemoryBytes: null, logicalCpuCount: 24 }, runningThreads: 0, placedNotStarted: 0,
  get load() { const at = new Date().toISOString(); return { observedAt: at, windowMs: 2_000, cpuBusyPercent: 93, loadAverage: null, availableMemoryBytes: 41 * GIB,
    windowStartAvailableMemoryBytes: 41 * GIB, memoryPressurePercent: null } } }
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
/** `steers`: Watcher's provider takes a steer into its running turn, as Codex and Claude Code do and Grok Build does not. */
/** `writingClock`: the monotonic clock the listener times a phone's Watcher window on. */
async function fixture(phoneFeature = true, usageEnabled = false, steers = false, machines = false, writingClock?: () => number, files = false) {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  if (steers) workspace.adapters.codex.state.capabilities.steer = true
  const usage = usageEnabled ? new UsageService({ directory: workspace.root, host: workspace.host,
    acceptedPromptIdentities: identities => workspace.host.recordedUserMessages(identities) }) : undefined
  usage?.start()
  let canAnswer = false
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, ...(usage ? { usage } : {}), ...(files ? { attachAnyFile: true } : {}), authority: { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
      mayGrant: client => ({ allowed: client.transport === 'ipc' || canAnswer, reason: 'paired-client' }) } } })
  const watcher = new WatcherService({ directory: workspace.root, host: workspace.host, control: f.control, historyEnabled: () => true,
    ...machines ? { crossMachine: true, machineFacts: async () => MACHINE_REPORT, workerMachine: () => 'this-computer' as const } : {} })
  const tools = new WatcherToolServer(watcher); workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { watcher.close(); await tools.close(); f.control.dispose(); await f.control.closed(); usage?.close(); await workspace.stop() })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await watcher.recover()
  const model = f.control.shell().host.models.find(row => row.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(row => row.providerId === 'codex')!
  expect(await watcher.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const target = watcher.state().current!.target
  const phone = new WatcherPhoneService(f.control, watcher, machines)
  const service = new LocalHostService({ control: f.control, ...(phoneFeature ? { watcherPhone: phone } : {}), ...(files ? { fileStaging: true } : {}) })
  const pairing = new PairedClients(workspace.root); await pairing.load()
  const server = await startSocketServer({ service, pairing, admin: false, mayAnswer: () => canAnswer, ...writingClock ? { watcherWritingClock: writingClock } : {} })
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
  return { ...f, workspace, watcher, phone, target, service, pairing, server, pair, native, finish, start, usage,
    canAnswer: (value: boolean) => { canAnswer = value }, send: (clientId: string, draftId = randomUUID(), text = 'Synthetic phone request', delivery?: 'steer') => ({ op: 'watcher-phone-send',
      request: { origin: { kind: 'phone', hostId: target.hostId, clientId }, target, draftId, text, ...(delivery ? { delivery } : {}) } }) }
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
  expect(watcherPhoneResultSchema.parse(read.result)).toMatchObject({ status: 'ok', state: { current: { target: f.target }, inFlight: 0, inFlightLimit: 8 } })
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
  expect(f.control.watcherRecord().requests.at(-1)?.phoneOrigin).toEqual(packet.request.origin)
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
  // Saved before display proofs, so it carries none.
  await f.control.updateWatcher(record => { delete record.requests.find(request => request.id === older.id)!.displayPrompt })
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

it('counts accepted paired phone instructions as user prompts while keeping actual Watcher operations separate', async () => {
  const f = await fixture(true, true), peer = await f.pair()
  const text = 'Synthetic private phone instruction', packet = f.send(peer.paired.clientId, randomUUID(), text)
  expect(await peer.call('phone-user', packet)).toMatchObject({ ok: true, result: { status: 'ok' } })
  expect(f.control.watcherRecord().requests.at(-1)?.phoneOrigin).toEqual(packet.request.origin)
  expect(f.phone.state(false).conversation.messages.some(message => message.text === text)).toBe(true)
  expect(f.native(f.target.threadId).messages.filter(message => message.role === 'user')).toHaveLength(1)
  expect((await f.usage!.read()).activity!.totals.prompts).toEqual({ user: 1, watcher: 0, wakeUp: 0, total: 1, steered: 0 })
  expect(await peer.call('same-phone-draft', packet)).toMatchObject({ ok: true, result: { status: 'ok' } })
  expect(f.native(f.target.threadId).messages.filter(message => message.role === 'user')).toHaveLength(1)
  expect((await f.usage!.read()).activity!.totals.prompts.total).toBe(1)

  const worker = await f.start()
  expect((await f.usage!.read()).activity!.totals.prompts).toEqual({ user: 1, watcher: 1, wakeUp: 0, total: 2, steered: 0 })
  await f.finish(worker.threadId)
  expect(await f.watcher.invoke(f.target.threadId, 'send_to_thread', { target: worker,
    requestId: f.watcher.state().requests.at(-1)!.id, retryKey: randomUUID(), text: 'Synthetic private Watcher follow-up', delivery: 'now' }))
    .toMatchObject({ status: 'ok' })
  expect((await f.usage!.read()).activity!.totals.prompts).toEqual({ user: 1, watcher: 2, wakeUp: 0, total: 3, steered: 0 })

  const ordinary = f.control.shell().host.threads.find(thread => thread.providerId === 'codex'
    && thread.id !== worker.threadId && thread.id !== f.target.threadId)!
  expect((await f.control.commandShell({ type: 'manual-send', threadId: ordinary.id,
    draftId: randomUUID(), text: 'Synthetic private desktop instruction' })).error).toBeNull()
  const read = await f.usage!.read()
  expect(read).toMatchObject({ status: 'ready', persistence: 'saved' })
  expect(read.activity!.totals.prompts).toEqual({ user: 2, watcher: 2, wakeUp: 0, total: 4, steered: 0 })
  const db = new DatabaseSync(join(f.workspace.root, 'usage.sqlite'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT * FROM prompt_rows').all()
    expect(rows).toHaveLength(4)
    expect(JSON.stringify(rows)).not.toContain('Synthetic private')
    expect(rows.filter(row => row.thread_id === f.target.threadId)).toMatchObject([{ kind: 'user', model_id: ordinary.modelId }])
  } finally { db.close() }
})

it('does not attach an old receipt to an assistant reply after a later user instruction', async () => {
  const f = await fixture(), peer = await f.pair(); await peer.call('first', f.send(peer.paired.clientId)); await f.start()
  const firstRequest = f.watcher.state().requests.at(-1)!.id
  await f.finish(f.target.threadId); await peer.call('second', f.send(peer.paired.clientId, randomUUID(), 'Synthetic later instruction'))
  f.native(f.target.threadId).messages.push({ id: 'later-reply', role: 'assistant', text: 'Synthetic later reply', createdAt: new Date(Date.now() + 1_000).toISOString() })
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.phone.state(false).receiptGroups.find(row => row.requestId === firstRequest)?.replyMessageId).toBeNull()
})

it('uses the computer default even when the phone cannot answer and queues behind Watcher’s card without answering it', async () => {
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
  const queued = f.send(peer.paired.clientId)
  expect(await peer.call('queued-send', queued)).toMatchObject({ ok: true, result: { status: 'ok' } })
  expect(f.control.watcherFollowups(f.target.threadId)).toEqual([expect.objectContaining({ draftId: queued.request.draftId, text: queued.request.text, status: 'queued' })])
  expect(f.native(f.target.threadId).requests).toEqual([{ id: 'watcher-question', kind: 'question', text: 'Synthetic question', options: [] }])
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

it.each([
  { kind: 'permission' as const, answer: 'Deny', approved: false },
  { kind: 'question' as const, answer: 'Synthetic explicit phone answer' },
])('delivers an explicit phone $kind answer after desktop recovery without releasing the set-aside prompt', async choice => {
  const f = await fixture(), peer = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  await f.finish(worker.threadId)
  const original = { type: 'manual-send' as const, threadId: worker.threadId, draftId: randomUUID(), text: 'Synthetic unconfirmed phone-worker prompt' }
  const adapter = f.workspace.adapters.codex, execute = adapter.execute.bind(adapter)
  const spy = vi.spyOn(adapter, 'execute').mockImplementation(async command => {
    if (command.type === 'send' && command.text === original.text) {
      adapter.commands.push(structuredClone(command))
      return { accepted: false, uncertain: true, error: 'Synthetic lost send acknowledgement' }
    }
    return execute(command)
  })
  try { await f.control.commandShell(original) } finally { spy.mockRestore() }
  const oldDelivery = () => f.control.shell().deliveries?.find(item => item.threadId === worker.threadId && item.draftId === original.draftId)
  expect(oldDelivery()).toMatchObject({ status: 'uncertain' })
  expect((await f.control.commandShell({ type: 'set-aside-send', threadId: worker.threadId, draftId: original.draftId })).error).toBeNull()
  const requestId = randomUUID(), otherId = randomUUID()
  f.native(worker.threadId).requests = [
    { id: requestId, kind: choice.kind, text: 'Synthetic pending worker card', options: [] },
    { id: otherId, kind: 'question', text: 'Synthetic other worker card', options: [] },
  ]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const answer = { op: 'watcher-phone-answer', request: { target: worker, command: { type: 'answer', threadId: worker.threadId,
    requestId, answer: choice.answer, ...('approved' in choice ? { approved: choice.approved } : {}) } } }
  const answers = () => adapter.commands.filter(command => command.type === 'answer')
  expect(f.phone.state(false).needsYou).toEqual(expect.arrayContaining([expect.objectContaining({ target: worker, request: expect.objectContaining({ id: requestId }), mayAnswer: false })]))
  expect(await peer.call('not-granted', answer)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(answers()).toHaveLength(0)
  f.canAnswer(true)
  expect(f.phone.state(true).needsYou).toEqual(expect.arrayContaining([expect.objectContaining({ target: worker, request: expect.objectContaining({ id: requestId }), mayAnswer: true })]))
  expect(await peer.call('explicit-answer', answer)).toMatchObject({ ok: true, result: { status: 'ok' } })
  expect(answers()).toEqual([expect.objectContaining({ threadId: f.native(worker.threadId).id, requestId, answer: choice.answer,
    ...('approved' in choice ? { approved: choice.approved } : {}) })])
  expect(f.native(worker.threadId).requests.map(request => request.id)).toEqual([otherId])
  f.canAnswer(false)
  expect(await peer.call('revoked', { ...answer, request: { ...answer.request, command: { ...answer.request.command, requestId: otherId, answer: 'Synthetic later answer' } } }))
    .toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(answers()).toHaveLength(1)
  expect(f.native(worker.threadId).requests.map(request => request.id)).toEqual([otherId])
  expect(oldDelivery()).toMatchObject({ status: 'uncertain', setAside: true })
  expect(oldDelivery()?.updatesResumed).not.toBe(true)
  const watch = f.watcher.state().standingWatches!.find(row => row.target.threadId === worker.threadId)!
  expect(await f.watcher.invoke(f.target.threadId, 'send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target: worker,
    text: 'Synthetic forbidden automatic continuation', delivery: 'now' })).toMatchObject({ status: 'refused' })
  await f.control.commandShell(original)
  expect(adapter.commands.filter(command => command.type === 'send' && command.text === original.text)).toHaveLength(1)
})

it('holds Watcher behind a phone direct send and binds Stop all previews to the exact user and ownership', async () => {
  const f = await fixture(), peer = await f.pair(), other = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  const preview = await peer.call('preview', { op: 'watcher-phone-prepare-stop-all' })
  const confirmationId = (preview.result as { confirmationId: string }).confirmationId
  expect(preview).toMatchObject({ ok: true, result: { targets: [{ ...worker, title: 'Synthetic worker', provider: 'codex' }] } })
  expect(await other.call('stolen', { op: 'watcher-phone-stop-all', confirmationId })).toMatchObject({ ok: true, result: { status: 'refused', code: 'TARGET_CHANGED' } })
  await f.finish(worker.threadId)
  expect(await peer.call('direct', { op: 'command', command: { type: 'manual-send', threadId: worker.threadId, draftId: randomUUID(), text: 'Synthetic direct user input' } })).toMatchObject({ ok: true })
  // The thread stays watched; while the user's own turn runs, Watcher may only steer it, and Stop all leaves it be.
  expect(f.watcher.state().requests.at(-1)?.participants[0]?.state).toBe('participating')
  const watch = f.watcher.state().standingWatches!.find(row => row.target.threadId === worker.threadId)!
  expect(f.phone.state(false).watchedThreads.find(row => row.target.threadId === worker.threadId)).toMatchObject({ watched: true, paused: true })
  for (const delivery of ['now', 'queue']) {
    expect(await f.watcher.invoke(f.target.threadId, 'send_to_thread', { requestId: watch.id, retryKey: randomUUID(),
      target: worker, delivery, text: 'Synthetic automatic follow-up' })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
  }
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


it('keeps standing watches through stopped and closed requests until explicit unwatch', async () => {
  const f = await fixture(), peer = await f.pair(['watcher-phone', 'watcher-phone-stop-all', 'watcher-phone-manage'])
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  const watched = () => f.phone.state(false).watchedThreads.find(row => row.target.threadId === worker.threadId)!.watched
  expect(watched()).toBe(true)
  const preview = await peer.call('preview', { op: 'watcher-phone-prepare-stop-all' })
  await peer.call('stop', { op: 'watcher-phone-stop-all', confirmationId: (preview.result as { confirmationId: string }).confirmationId })
  expect(f.watcher.state().requests.at(-1)?.state).toBe('stopped')
  expect(watched()).toBe(true)
  const shell = await peer.call('after-stop', { op: 'shell' })
  expect((shell.result as { host: { threads: { id: string; watchedByWatcher?: boolean }[] } }).host.threads.find(row => row.id === worker.threadId)?.watchedByWatcher).toBe(true)
  await f.control.updateWatcher(record => { const request = record.requests.at(-1)!; request.state = 'closed'; request.closedAt = new Date().toISOString() })
  expect(watched()).toBe(true)
  expect(await f.watcher.unwatchThread({ target: worker })).toMatchObject({ status: 'ok' })
  expect(watched()).toBe(false)
})

it('shows a phone from before standing watches only the threads a request watches, as it always counted them', async () => {
  const f = await fixture(), old = await f.pair(), current = await f.pair(['watcher-phone', 'watcher-phone-stop-all', 'watcher-phone-manage'])
  await old.call('send', f.send(old.paired.clientId))
  // Watcher started one thread for the request, which keeps its standing watch; another only takes part in the request.
  const standing = await f.start(), requestOnly = await f.start()
  await f.control.updateWatcher(record => { record.watches = (record.watches ?? []).filter(watch => watch.target.threadId !== requestOnly.threadId) })
  type Page = { standingWatches?: unknown; watchedThreads: { target: { threadId: string }; watched: boolean; paused?: boolean }[] }
  const page = async (peer: typeof old, id: string) => ((await peer.call(id, { op: 'watcher-phone-read' })).result as { state: Page }).state
  const shell = async (peer: typeof old, id: string) => ((await peer.call(id, { op: 'shell' })).result as { watcher: Page; host: { threads: { id: string; watchedByWatcher?: boolean }[] } })
  const oldPage = await page(old, 'old-read'), oldShell = await shell(old, 'old-shell')
  for (const seen of [oldPage, oldShell.watcher]) {
    expect(seen.standingWatches).toBeUndefined()
    expect(seen.watchedThreads.map(row => [row.target.threadId, row.watched, row.paused])).toEqual([[requestOnly.threadId, true, undefined]])
  }
  expect(oldShell.host.threads.find(row => row.id === standing.threadId)?.watchedByWatcher).toBe(false)
  expect(oldShell.host.threads.find(row => row.id === requestOnly.threadId)?.watchedByWatcher).toBe(true)
  // A phone that negotiated management sees both, and the standing watch.
  const currentPage = await page(current, 'current-read')
  expect(currentPage.standingWatches).toEqual([expect.objectContaining({ target: standing })])
  expect(currentPage.watchedThreads.map(row => [row.target.threadId, row.watched]).sort()).toEqual([[requestOnly.threadId, true], [standing.threadId, true]].sort())
  expect((await shell(current, 'current-shell')).host.threads.find(row => row.id === standing.threadId)?.watchedByWatcher).toBe(true)
})

it('marks a thread taking part in an active request watched in the room, the phone page and the phone shell alike', async () => {
  const f = await fixture(), peer = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  // As on a paired host without standing watches: the thread takes part in the request and has no watch of its own.
  await f.control.updateWatcher(record => { record.watches = (record.watches ?? []).filter(watch => watch.target.threadId !== worker.threadId) })
  expect(f.watcher.state().standingWatches?.some(watch => watch.target.threadId === worker.threadId)).toBe(false)
  const room = () => f.watcher.state().watchedThreads.find(row => row.target.threadId === worker.threadId)
  const page = () => f.phone.state(false).watchedThreads.find(row => row.target.threadId === worker.threadId)
  const shell = async (id: string) => ((await peer.call(id, { op: 'shell' })).result as { host: { threads: { id: string; watchedByWatcher?: boolean }[] } })
    .host.threads.find(row => row.id === worker.threadId)?.watchedByWatcher
  expect(room()).toMatchObject({ watched: true, paused: false })
  expect(page()).toMatchObject({ watched: true, takenOver: false })
  expect(await shell('request-only')).toBe(true)
  f.native(worker.threadId).requests = [{ id: 'request-only-card', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.phone.state(false).needsYou.some(row => row.target.threadId === worker.threadId)).toBe(true)
  f.native(worker.threadId).requests = []
  // The user's own send takes over a thread watched only through a request: it leaves Watched on every surface.
  await f.finish(worker.threadId)
  expect(await peer.call('direct', { op: 'command', command: { type: 'manual-send', threadId: worker.threadId, draftId: randomUUID(), text: 'Synthetic direct user input' } })).toMatchObject({ ok: true })
  expect(room()?.watched).toBe(false)
  expect(page()).toMatchObject({ watched: false, takenOver: true })
  expect(await shell('taken-over')).toBe(false)
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


it('negotiates Watcher management separately and replays outcomes without undoing newer choices', async () => {
  const f = await fixture(), old = await f.pair(), peer = await f.pair(['watcher-phone', 'watcher-phone-manage'])
  expect(peer.hello).toMatchObject({ ok: true, result: { features: expect.arrayContaining(['watcher-phone-manage']) } })
  f.workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const change = { op: 'watcher-phone-set-permission', request: { runtimeMode: 'auto-accept-edits' } }
  expect(await old.call('old-mode', change)).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(await peer.call('mode-denied', change)).toMatchObject({ ok: true, result: { status: 'refused', code: 'PERMISSION_TOO_WIDE' } })
  expect(f.watcher.state().runtimeMode).toBe('approval-required')
  f.canAnswer(true)
  expect(await peer.call('mode', change)).toMatchObject({ ok: true, result: { status: 'ok', state: { runtimeMode: 'auto-accept-edits', current: { runtimeMode: 'auto-accept-edits' } } } })
  f.canAnswer(false)
  expect(await peer.call('narrow', { op: 'watcher-phone-set-permission', request: { runtimeMode: 'approval-required' } })).toMatchObject({ ok: true, result: { status: 'ok' } })
  peer.messages.splice(peer.messages.findIndex(message => message.id === 'mode'), 1)
  expect(await peer.call('mode', change)).toMatchObject({ ok: true, result: { status: 'ok', state: { runtimeMode: 'approval-required' } } })
  peer.messages.splice(peer.messages.findIndex(message => message.id === 'mode'), 1)
  expect(await peer.call('mode', { ...change, request: { runtimeMode: 'auto' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(hostReceiptSchema.parse((await peer.call('mode-receipt', { op: 'receipt', commandId: 'mode' })).result)).toMatchObject({ status: 'completed', watcherManage: { status: 'ok' } })
  expect(await peer.call('full-denied', { ...change, request: { runtimeMode: 'full-access' } })).toMatchObject({ ok: true, result: { status: 'refused', code: 'PERMISSION_TOO_WIDE' } })
  expect(await peer.call('grant', { op: 'watcher-phone-set-permission', request: { runtimeMode: 'always' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  const watch = { op: 'watcher-phone-watch', request: { target: worker } }
  expect(await old.call('old-watch', watch)).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(await peer.call('watch', watch)).toMatchObject({ ok: true, result: { status: 'ok', state: { standingWatches: expect.arrayContaining([expect.objectContaining({ target: worker })]) } } })
  expect(f.phone.state(false).watchedThreads.find(row => row.target.threadId === worker.threadId)?.watched).toBe(true)
  f.native(worker.threadId).requests = [{ id: 'unwatched-card', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.phone.state(false).needsYou.some(row => row.target.threadId === worker.threadId)).toBe(true)
  expect(await peer.call('unwatch', { op: 'watcher-phone-unwatch', request: { target: worker } })).toMatchObject({ ok: true, result: { status: 'ok' } })
  expect(f.phone.state(false).watchedThreads.find(row => row.target.threadId === worker.threadId)?.watched).toBe(false)
  expect(f.phone.state(false).needsYou.some(row => row.target.threadId === worker.threadId)).toBe(false)
  peer.messages.splice(peer.messages.findIndex(message => message.id === 'watch'), 1)
  await peer.call('watch', watch)
  expect(f.phone.state(false).standingWatches?.some(row => row.target.threadId === worker.threadId)).toBe(false)
  const shell = await peer.call('watch-shell', { op: 'shell' })
  expect((shell.result as { host: { threads: { id: string; watchedByWatcher?: boolean }[] } }).host.threads.find(row => row.id === worker.threadId)?.watchedByWatcher).toBe(false)
})

it('keeps own-change metadata attached to the Watcher reply in the phone projection', async () => {
  const f = await fixture(), peer = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); await f.finish(f.target.threadId)
  const ownChange = { replyMessageId: 'changed-reply', turnId: 'changed-turn', files: ['src/example.ts'], fileCount: 1, reason: null, source: 'provider-file-change' as const }
  f.native(f.target.threadId).messages.push({ id: ownChange.replyMessageId, role: 'assistant', text: 'Changed a file.', createdAt: new Date().toISOString(), watcherOwnChange: ownChange })
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.phone.state(false).ownChanges).toContainEqual(ownChange)
})

it('shows a Watcher reply without the reason line its own-change line shows, on the desktop and the phone alike', async () => {
  const f = await fixture(), peer = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); await f.finish(f.target.threadId)
  const reason = 'A one-word typo is smaller than briefing a thread.'
  const ownChange = { replyMessageId: 'reasoned-reply', turnId: 'reasoned-turn', files: ['src/example.ts'], fileCount: 1, reason, source: 'provider-file-change' as const }
  f.native(f.target.threadId).messages.push({ id: ownChange.replyMessageId, role: 'assistant', text: `I fixed the typo myself.\n\nWatcher change reason: ${reason}`,
    createdAt: new Date().toISOString(), watcherOwnChange: ownChange })
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  // The room's pane and Copy read the coordinator's detail; the phone reads its projection of it.
  expect(f.control.threadDetail(f.target.threadId)?.messages.find(message => message.id === ownChange.replyMessageId)?.text).toBe('I fixed the typo myself.')
  const phone = f.phone.state(false)
  expect(phone.conversation.messages.find(message => message.id === ownChange.replyMessageId)?.text).toBe('I fixed the typo myself.')
  expect(phone.ownChanges).toContainEqual(ownChange)
  expect(f.watcher.state().ownChanges).toContainEqual(ownChange)
  // The provider's own history keeps what Watcher wrote.
  expect(f.native(f.target.threadId).messages.at(-1)?.text).toContain('Watcher change reason: ')
})

it('rechecks phone permission authority after an await before the native writer', async () => {
  const f = await fixture(), peer = await f.pair(['watcher-phone', 'watcher-phone-manage'])
  f.workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  f.canAnswer(true)
  const entered = deferred<void>(), proceed = deferred<void>()
  const original = f.control.commandForWatcherRoom.bind(f.control)
  const spy = vi.spyOn(f.control, 'commandForWatcherRoom').mockImplementation(async (command, guard) => {
    entered.resolve(); await proceed.promise; guard?.(); return original(command, guard)
  })
  const before = f.workspace.adapters.codex.commands.length
  const pending = peer.call('revoked-mode', { op: 'watcher-phone-set-permission', request: { runtimeMode: 'full-access' } })
  await entered.promise; f.canAnswer(false); proceed.resolve()
  expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(f.watcher.state().runtimeMode).toBe('approval-required')
  expect(f.workspace.adapters.codex.commands).toHaveLength(before)
  spy.mockRestore()
})

// Steering Watcher from the phone (#1229, Zach's pick B): Send steers into Watcher's running turn, or the message goes next.
const STEER = ['watcher-phone', 'watcher-phone-stop-all', 'watcher-phone-manage', 'watcher-phone-steer']
type Fixture = Awaited<ReturnType<typeof fixture>>
/** Ends a thread's turn, as its provider reports a finished one. */
async function settle(f: Fixture, threadId: string) {
  const thread = f.native(threadId); thread.status = 'idle'; thread.lastTurn = { id: thread.lastTurn?.id ?? randomUUID(), status: 'completed' }
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
}
/**
 * Watcher's provider takes a steer as its running turn's newest user message, as a real one does; this fake's own steer
 * ends the turn instead. `refuse` makes the next steer find the turn already over, so the provider takes nothing.
 */
function takeSteers(f: Fixture) {
  const codex = f.workspace.adapters.codex, execute = codex.execute.bind(codex)
  const options = { refuse: false }
  vi.spyOn(codex, 'execute').mockImplementation(async command => {
    if (command.type !== 'steer') return execute(command)
    codex.commands.push(structuredClone(command))
    const master = codex.state.threads.find(thread => thread.id === command.threadId)!
    if (options.refuse) {
      options.refuse = false
      master.status = 'idle'; master.lastTurn = { id: master.lastTurn?.id ?? randomUUID(), status: 'completed' }
      codex.emit()
      return { accepted: false, error: 'There is no running turn to steer.' }
    }
    master.messages.push({ id: command.messageId, commandId: command.commandId, role: 'user', text: command.text, createdAt: new Date().toISOString() })
    master.lastUserMessageId = command.messageId
    codex.emit()
    return { accepted: true }
  })
  return options
}
/** Sotto's news of a watched thread's question, sent to Watcher; Watcher's turn on it then runs. */
async function startNews(f: Fixture) {
  const model = f.control.shell().host.models.find(row => row.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(row => row.providerId === 'codex')!
  const watched = { hostId: f.target.hostId, threadId: randomUUID() }
  expect((await f.control.commandShell({ type: 'create-thread', threadId: watched.threadId, projectId: project.id, modelId: model.id,
    title: 'Synthetic watched worker', runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
  await f.control.commandShell({ type: 'manual-send', threadId: watched.threadId, draftId: randomUUID(), text: 'Synthetic existing turn' })
  await settle(f, watched.threadId)
  expect(await f.watcher.watchThread({ target: watched })).toMatchObject({ status: 'ok' })
  f.native(watched.threadId).requests = [{ id: 'synthetic-card', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(f.watcher.state().news?.some(event => event.kind === 'needs-user')).toBe(true), { timeout: 30_000 })
  const event = f.watcher.state().news!.find(item => item.kind === 'needs-user')!
  const master = f.native(f.target.threadId)
  master.lastUserMessageId = master.messages.findLast(message => message.role === 'user')?.id
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await f.control.deliverWakeUp(f.target.threadId, { source: 'watcher', watcher: f.watcher.state().current!.target, events: [event], omitted: 0 }, { tool: false })
  // The news turn has started: the provider runs it, and Watcher has recorded the wake-up as what it last sent. A wake-up
  // still on its way already reads as Watcher's turn (`watcherWakeUpTurn`), and a steer then meets that send in flight:
  // refused while the provider has yet to start the turn, or joined to the request of the newest message before it (#1322).
  await vi.waitFor(() => {
    expect(f.control.watcherPhoneTurn(f.target.threadId).running).toBe(true)
    expect(f.watcher.lastSendWasWakeUp(f.target.threadId)).toBe(true)
  }, { timeout: 30_000 })
}
const lastSteer = (f: Fixture) => {
  const steer = f.workspace.adapters.codex.commands.findLast(command => command.type === 'steer')
  if (steer?.type !== 'steer') throw new Error('Nothing was steered')
  return steer
}

it('steers a phone message into Watcher’s running turn under the request it answers, and under one of its own during news (#1229)', async () => {
  const f = await fixture(true, false, true), peer = await f.pair(STEER), clientId = peer.paired.clientId
  expect(peer.hello).toMatchObject({ ok: true, result: { features: expect.arrayContaining(['watcher-phone-steer']) } })
  takeSteers(f)
  expect(await peer.call('ask', f.send(clientId))).toMatchObject({ ok: true, result: { status: 'ok', state: { current: { status: 'running', steers: true }, followups: [] } } })
  const asked = f.watcher.state().requests.at(-1)!, requests = f.watcher.state().requests.length
  const draftId = randomUUID(), text = 'Synthetic phone steer: and the release notes'
  expect(await peer.call('steer', f.send(clientId, draftId, text, 'steer'))).toMatchObject({ ok: true, result: { status: 'ok', draftId, state: { followups: [] } } })
  const steer = lastSteer(f)
  // Part of the request the turn answers: no note of its own, and no new request.
  expect(steer).toMatchObject({ text, threadId: f.workspace.registry.byThread(f.target.threadId)!.sessionId })
  expect(f.watcher.state().requests).toHaveLength(requests)
  expect(f.watcher.state().requests.find(request => request.id === asked.id)!.userFollowups).toContainEqual({ draftId, messageId: steer.messageId })
  // The same draft again is that steer, never a second one.
  const steers = f.workspace.adapters.codex.commands.filter(command => command.type === 'steer').length
  expect(await peer.call('steer-again', f.send(clientId, draftId, text, 'steer'))).toMatchObject({ ok: true, result: { status: 'ok' } })
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'steer')).toHaveLength(steers)

  // Into a turn Sotto's news started, the steer opens a request of its own, from this phone, with its request line.
  await settle(f, f.target.threadId)
  await startNews(f)
  const newsText = 'Synthetic phone steer: watch that thread again'
  expect(await peer.call('news-steer', f.send(clientId, randomUUID(), newsText, 'steer'))).toMatchObject({ ok: true, result: { status: 'ok' } })
  const second = lastSteer(f)
  const opened = f.control.watcherRecord().requests.find(request => request.rootUserMessageId === second.messageId)!
  expect(opened).toMatchObject({ state: 'active', participants: [], phoneOrigin: { kind: 'phone', hostId: f.target.hostId, clientId } })
  expect(second.text).toBe(newsText + watcherRequestLine(watcherRequestNote(opened.id, f.control.hostId()!)))
  // The phone shows the words alone.
  await vi.waitFor(() => expect(f.phone.state(false).conversation.messages.find(message => message.id === second.messageId)?.text).toBe(newsText))
})

// Photos for Watcher from the phone (October 23, 2026): staged as a thread's are, sent with the words or alone.
it('sends a phone’s photos to Watcher with or without words, now or next, and lets the phone draw them back', async () => {
  const f = await fixture(), peer = await f.pair(STEER), clientId = peer.paired.clientId
  f.workspace.adapters.codex.state.models[0]!.supportsImages = true
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(peer.hello).toMatchObject({ ok: true, result: { features: expect.arrayContaining(['watcher-phone-photos', 'attachment-staging']) } })
  const stage = async (name: string) => (await peer.call('stage-' + name, { op: 'stage-attachment',
    image: { name, mimeType: 'image/png', data: PIXEL_PNG.toString('base64') } })).result as { id: string; digest: string }
  const photo = await stage('Photo 1.png')
  const withPhotos = (draftId: ReturnType<typeof randomUUID>, text: string, images: unknown[], delivery?: 'steer') => {
    const packet = f.send(clientId, draftId, text, delivery)
    return { ...packet, request: { ...packet.request, images } }
  }
  // Neither words nor photos is nothing to send.
  expect(await peer.call('empty', f.send(clientId, randomUUID(), ' '))).toMatchObject({ ok: false, error: { code: 'invalid_request' } })

  // A photo alone, to Watcher at rest: it reaches Watcher's provider by its handle.
  const draftId = randomUUID()
  expect(await peer.call('photo', withPhotos(draftId, '', [photo]))).toMatchObject({ ok: true, result: { status: 'ok', draftId } })
  expect(f.workspace.adapters.codex.commands.findLast(command => command.type === 'send')).toMatchObject({
    attachments: [expect.objectContaining({ id: photo.id, digest: photo.digest })] })
  // The phone's page marks the photo on the user's message, and the phone reads it back through Watcher alone.
  const message = f.phone.state(false).conversation.messages.findLast(row => row.role === 'user')!
  expect(message.attachments).toEqual([expect.objectContaining({ id: photo.id, name: 'Photo 1.png', preview: { available: true } })])
  const preview = { op: 'watcher-phone-preview', request: { target: f.target, messageId: message.id, attachmentId: photo.id } }
  expect(await peer.call('preview', preview)).toMatchObject({ ok: true, result: { dataUrl: `data:image/png;base64,${PIXEL_PNG.toString('base64')}` } })
  expect(await peer.call('hidden-preview', { op: 'preview', request: { threadId: f.target.threadId, messageId: message.id, attachmentId: photo.id } }))
    .toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(await peer.call('other-watcher', { ...preview, request: { ...preview.request, target: { ...f.target, threadId: randomUUID() } } }))
    .toMatchObject({ ok: true, result: null })

  // While Watcher works, words and a photo go next together when its provider takes no steer.
  const second = await stage('Photo 2.png'), nextDraft = randomUUID(), nextText = 'Synthetic phone words with a photo'
  expect(await peer.call('next', withPhotos(nextDraft, nextText, [second], 'steer'))).toMatchObject({ ok: true, result: { status: 'ok',
    state: { followups: [{ draftId: nextDraft, text: nextText, status: 'queued' }] } } })
  expect(f.control.shell().followups).toContainEqual(expect.objectContaining({ draftId: nextDraft, text: nextText,
    attachments: [expect.objectContaining({ id: second.id, digest: second.digest })] }))
})

// Files for Watcher from the phone (ADR-0131, October 28 amendment): staged as a thread's reply's are, named in `images`.
it('sends a phone’s staged file to Watcher only where the host keeps files, and refuses one elsewhere', async () => {
  const f = await fixture(true, false, false, false, undefined, true), peer = await f.pair(STEER), clientId = peer.paired.clientId
  expect(peer.hello).toMatchObject({ ok: true, result: { features: expect.arrayContaining(['watcher-phone-files', 'file-staging']) } })
  const bytes = Buffer.from('Synthetic shared notes'), digest = createHash('sha256').update(bytes).digest('hex')
  const staged = await peer.call('stage-file', { op: 'stage-file-part', part: { uploadId: randomUUID(), index: 0, count: 1, name: 'notes.txt',
    mimeType: 'text/plain', sizeBytes: bytes.length, digest, data: bytes.toString('base64') } })
  const handle = staged.result as { id: string; digest: string }
  expect(handle).toMatchObject({ digest })
  const packet = f.send(clientId, randomUUID(), 'Read this')
  expect(await peer.call('file', { ...packet, request: { ...packet.request, images: [handle] } })).toMatchObject({ ok: true, result: { status: 'ok' } })
  expect(f.workspace.adapters.codex.commands.findLast(command => command.type === 'send')).toMatchObject({
    attachments: [expect.objectContaining({ id: handle.id, digest })] })

  // A host that keeps no files neither offers it nor takes a file's handle.
  const without = await fixture(), old = await without.pair(STEER)
  expect((old.hello.result as { features: string[] }).features).not.toContain('watcher-phone-files')
  const refused = without.send(old.paired.clientId, randomUUID(), 'Read this')
  expect(await old.call('refused', { ...refused, request: { ...refused.request, images: [{ ...handle, name: 'notes.txt', mimeType: 'text/plain', sizeBytes: bytes.length }] } }))
    .toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})

it('queues a phone message to go next when Watcher’s provider takes no steer, shows it on the page and removes it (#1229)', async () => {
  const f = await fixture(), peer = await f.pair(STEER), clientId = peer.paired.clientId
  await peer.call('ask', f.send(clientId))
  const sends = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'send' || command.type === 'steer').length
  const before = sends(), draftId = randomUUID(), text = 'Synthetic phone message for after this turn'
  const queued = await peer.call('queue', f.send(clientId, draftId, text, 'steer'))
  expect(queued).toMatchObject({ ok: true, result: { status: 'ok', draftId, state: { current: { steers: false }, followups: [{ draftId, text, status: 'queued' }] } } })
  expect(sends()).toBe(before)
  // Desktop and phone see the same queue; the desktop shows no banner for the phone's message.
  const itemId = (queued.result as { state: { followups: { itemId: string }[] } }).state.followups[0]!.itemId
  expect(f.control.shell().followups).toContainEqual(expect.objectContaining({ id: itemId, draftId, text }))
  expect(f.control.shell().error).toBeNull()
  // An older phone may not remove it, nor ask for a steer.
  const old = await f.pair(['watcher-phone', 'watcher-phone-stop-all', 'watcher-phone-manage'])
  const remove = { op: 'watcher-phone-remove-followup', request: { target: f.target, itemId } }
  expect(await old.call('old-remove', remove)).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(await old.call('old-steer', f.send(old.paired.clientId, randomUUID(), text, 'steer'))).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  // A queue the computer could not save is said in plain words, never the file system's.
  const store = Reflect.get(f.control, 'followupStore') as { edit: (...args: unknown[]) => Promise<void> }
  vi.spyOn(store, 'edit').mockRejectedValueOnce(Object.assign(new Error('EPERM: operation not permitted, rename \'C:\\synthetic\\followups.json.tmp\''), { code: 'EPERM', syscall: 'rename' }))
  const failed = await peer.call('remove-fails', remove)
  expect(failed).toMatchObject({ ok: true, result: { status: 'refused', message: 'Your message wasn’t removed. It’s still waiting for Watcher. Try again.' } })
  expect(JSON.stringify(failed)).not.toContain('EPERM')
  expect(f.control.shell().error).toBeNull()
  expect(await peer.call('remove', remove)).toMatchObject({ ok: true, result: { status: 'ok', state: { followups: [] } } })
  expect(f.control.shell().followups ?? []).toEqual([])
  expect(hostReceiptSchema.parse((await peer.call('remove-receipt', { op: 'receipt', commandId: 'remove' })).result)).toMatchObject({ status: 'completed', watcherManage: { status: 'ok' } })
  // Removing it again, or after it went, removes nothing more.
  expect(await peer.call('remove-again', remove)).toMatchObject({ ok: true, result: { status: 'ok' } })

  // One that waits goes as its own turn once Watcher's turn ends, under a request of its own.
  const nextDraft = randomUUID(), nextText = 'Synthetic phone message that goes next'
  expect(await peer.call('next', f.send(clientId, nextDraft, nextText, 'steer'))).toMatchObject({ ok: true, result: { status: 'ok' } })
  const asked = f.watcher.state().requests.at(-1)!
  await settle(f, f.target.threadId)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.text === nextText)).toBe(true), { timeout: 30_000 })
  const delivered = f.workspace.adapters.codex.commands.find(command => command.type === 'send' && command.text === nextText)!
  if (delivered.type !== 'send') throw new Error('The message was not sent')
  const own = f.control.watcherRecord().requests.find(request => request.rootUserMessageId === delivered.messageId)!
  // Its request is the phone's, as one its own send opened would be.
  expect(own).toMatchObject({ state: 'active', phoneOrigin: { kind: 'phone', hostId: f.target.hostId, clientId } })
  expect(own.id).not.toBe(asked.id)
  // The queue lets the item go once the provider has acknowledged it, which can come after the adapter has the words.
  await vi.waitFor(() => expect(f.phone.state(false, true, true).followups).toEqual([]), { timeout: 30_000 })
  await vi.waitFor(() => expect(f.phone.state(false).draftDeliveries).toContainEqual({ draftId: nextDraft, status: 'accepted' }))
  // The desktop's window is never sent the phone's client ID, with its queue or with Watcher's requests.
  expect(JSON.stringify(f.watcher.state())).not.toContain(clientId)
  expect(JSON.stringify(f.control.shell().followups ?? [])).not.toContain(clientId)
})

it('answers a phone that negotiated management but not steering with the page it knows (#1229)', async () => {
  const f = await fixture(true, false, true), old = await f.pair(['watcher-phone', 'watcher-phone-stop-all', 'watcher-phone-manage'])
  const managed = await old.call('old-permission', { op: 'watcher-phone-set-permission', request: { runtimeMode: 'approval-required' } })
  expect(managed).toMatchObject({ ok: true, result: { status: 'ok' } })
  // Without what goes next or whether Watcher steers, which an older phone's strict page refuses.
  const state = (managed.result as { state: { followups?: unknown; current: { steers?: unknown } } }).state
  expect(state.followups).toBeUndefined()
  expect(state.current.steers).toBeUndefined()
})

it('reports a phone’s queued message as queued whatever the desktop’s banner says, and sends nothing once that phone is unpaired (#1229)', async () => {
  const f = await fixture(), peer = await f.pair(STEER), clientId = peer.paired.clientId
  await peer.call('ask', f.send(clientId))
  // An older error on the desktop's banner is the desktop's: the phone hears what became of its own message.
  ;(Reflect.get(f.control, 'state') as { error: string | null }).error = 'Synthetic older desktop error'
  const draftId = randomUUID(), text = 'Synthetic phone message whose phone is unpaired before it goes'
  expect(await peer.call('queue', f.send(clientId, draftId, text, 'steer'))).toMatchObject({ ok: true, result: { status: 'ok', draftId,
    state: { followups: [{ draftId, text, status: 'queued' }] } } })
  expect(f.control.shell().error).toBe('Synthetic older desktop error')
  // The same message again is that one, and still reported as queued.
  expect(await peer.call('queue-again', f.send(clientId, draftId, text, 'steer'))).toMatchObject({ ok: true, result: { status: 'ok', draftId } })
  expect(f.control.shell().followups?.filter(item => item.draftId === draftId)).toHaveLength(1)
  // The phone is unpaired before Watcher's turn ends: its message is not sent.
  await f.pairing.revoke(clientId)
  await settle(f, f.target.threadId)
  await vi.waitFor(() => expect(f.control.shell().followups?.find(item => item.draftId === draftId)?.status).toBe('failed'), { timeout: 30_000 })
  expect(f.workspace.adapters.codex.commands.some(command => 'text' in command && command.text.startsWith(text))).toBe(false)
})

it('sends a phone message next, once, when Watcher’s turn ends before its steer lands (#1229)', async () => {
  const f = await fixture(true, false, true), peer = await f.pair(STEER), clientId = peer.paired.clientId
  const steering = takeSteers(f)
  await peer.call('ask', f.send(clientId))
  steering.refuse = true
  const draftId = randomUUID(), text = 'Synthetic phone steer that comes too late'
  const result = await peer.call('late', f.send(clientId, draftId, text, 'steer'))
  expect(result).toMatchObject({ ok: true, result: { status: 'ok', draftId } })
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'steer' && command.text === text)).toHaveLength(1)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.text === text)).toHaveLength(1), { timeout: 30_000 })
  await vi.waitFor(() => expect(f.phone.state(false, true, true).followups).toEqual([]))
  expect(f.workspace.adapters.codex.commands.filter(command => 'text' in command && command.text === text)).toHaveLength(2)
})

it('refuses a send without a steer while Watcher works, saying why, and keeps an older phone’s page as it was (#1229)', async () => {
  const f = await fixture(true, false, true), old = await f.pair(), clientId = old.paired.clientId
  await old.call('ask', f.send(clientId))
  const before = f.workspace.adapters.codex.commands.length
  expect(await old.call('busy', f.send(clientId, randomUUID(), 'Synthetic second phone request'))).toMatchObject({ ok: true, result: {
    status: 'refused', code: 'THREAD_BUSY', message: 'Watcher is working, so your message wasn’t sent. Your words are kept on the phone. Send them again when it finishes.' } })
  expect(f.workspace.adapters.codex.commands).toHaveLength(before)
  const read = watcherPhoneResultSchema.parse((await old.call('read', { op: 'watcher-phone-read' })).result)
  if (read.status !== 'ok') throw new Error('The page was not read')
  expect(read.state.followups).toBeUndefined()
  expect(read.state.current?.steers).toBeUndefined()
  expect(f.control.shell().error).toBeNull()
})

it('sends the machines line only to a phone that accepts it, where Work across machines is on, and reads it afresh only when asked (#1032)', async () => {
  const MACHINES = [...STEER, 'watcher-phone-machines']
  // Without Work across machines, the feature is not offered and a fresh read is refused.
  const off = await fixture(), plain = await off.pair(MACHINES)
  expect((plain.hello.result as { features: string[] }).features).not.toContain('watcher-phone-machines')
  expect((plain.hello.result as { shell: { watcher: { machines?: unknown } } }).shell.watcher.machines).toBeUndefined()
  expect(await plain.call('fresh', { op: 'watcher-phone-read', machines: true })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })

  const f = await fixture(true, false, false, true), phone = await f.pair(MACHINES), older = await f.pair(STEER)
  expect(phone.hello).toMatchObject({ ok: true, result: { features: expect.arrayContaining(['watcher-phone-machines']) } })
  // Before any read, This computer stands alone with its count and nothing of its load.
  expect((phone.hello.result as { shell: { watcher: unknown } }).shell.watcher).toMatchObject({ machines: { readAt: null,
    rows: [{ hostId: f.target.hostId, name: 'This computer', thisComputer: true, connected: true, working: 0, cpuState: null, memoryState: null, unknownWhy: null }] } })
  // An iPhone that did not accept it is sent none, and may not ask for a fresh read.
  expect((older.hello.result as { shell: { watcher: { machines?: unknown } } }).shell.watcher.machines).toBeUndefined()
  expect(await older.call('older-fresh', { op: 'watcher-phone-read', machines: true })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  // An ordinary read does not read the machines; a fresh one does, and every page after it carries that read.
  const ordinary = watcherPhoneResultSchema.parse((await phone.call('read', { op: 'watcher-phone-read' })).result)
  expect(ordinary).toMatchObject({ status: 'ok', state: { machines: { readAt: null } } })
  const fresh = watcherPhoneResultSchema.parse((await phone.call('fresh', { op: 'watcher-phone-read', machines: true })).result)
  if (fresh.status !== 'ok') throw new Error('The page was not read')
  expect(fresh.state.machines?.readAt).toEqual(expect.any(String))
  expect(fresh.state.machines?.rows).toEqual([expect.objectContaining({ name: 'This computer', cpuState: 'busy', memoryState: 'enough', system: 'Omarchy (Linux)',
    logicalCpuCount: 24, cpuBusyPercent: 93, windowMs: 2_000, availableMemoryBytes: 41 * GIB, totalMemoryBytes: 64 * GIB, isDefault: true, unknownWhy: null, threads: [] })])
  expect(watcherPhoneResultSchema.parse((await phone.call('again', { op: 'watcher-phone-read' })).result)).toMatchObject({ state: { machines: { readAt: fresh.state.machines!.readAt } } })
})

it('pushes a phone no shell whose only news is when Watcher\'s page was read, and pushes the next change whole', async () => {
  const f = await fixture(), peer = await f.pair()
  type Pushed = { state: { watcher?: { observedAt: string }; clientCapabilities?: { mayAnswer: boolean } } }
  const shells = () => peer.messages.filter(message => message.event === 'shell') as unknown as Pushed[]
  // A publish reads the shell once, as it sends, so a read means the listener has handled it.
  const reads = vi.spyOn(f.service, 'shell')
  // Each publish reads Watcher's page a second later, as a phone's publishes come while the computer works.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
  try {
    const publish = async () => {
      const before = reads.mock.calls.length
      vi.setSystemTime(Date.now() + 1_000)
      await f.control.commandShell({ type: 'refresh', provider: 'codex' })
      await expect.poll(() => reads.mock.calls.length).toBeGreaterThan(before)
    }
    // An answer to a request made after a publish comes behind any shell that publish wrote, on the same socket. This read
    // moves nothing the listener remembers for the phone, so a shell missing once it is answered was never written.
    let asked = 0
    const received = () => peer.call(`after-${++asked}`, { op: 'events', afterSeq: 0, threadId: f.target.threadId })
    await publish()
    await expect.poll(() => shells()).toHaveLength(1)
    await publish(); await publish(); await received()
    expect(shells()).toHaveLength(1)
    // The phone may answer now: its shell says so, with the page as read then.
    f.canAnswer(true)
    await publish()
    await expect.poll(() => shells()).toHaveLength(2)
    const [first, second] = shells()
    expect(second!.state.clientCapabilities).toEqual({ mayAnswer: true })
    expect(() => watcherPhoneStateSchema.parse(second!.state.watcher)).not.toThrow()
    expect(Date.parse(second!.state.watcher!.observedAt)).toBeGreaterThan(Date.parse(first!.state.watcher!.observedAt))
    // A page the phone was answered with replaces the one its last shell carried, so the next shell goes though it repeats.
    expect(await peer.call('read', { op: 'watcher-phone-read' })).toMatchObject({ ok: true, result: { status: 'ok' } })
    await publish()
    await expect.poll(() => shells()).toHaveLength(3)
    await publish(); await received()
    expect(shells()).toHaveLength(3)
  } finally { vi.useRealTimers() }
})

/**
 * Watcher writing its reply changes its page with every word, and its page rides on every shell a phone with Watcher is
 * pushed. Before October 28, 2026 that sent the phone its whole shell with every publish while Watcher wrote, about twenty
 * a second, and the iPhone read each one whole and drew Watcher's page again.
 */
describe('a phone while Watcher writes its reply', () => {
  type Pushed = { state: { watcher?: { working: boolean; conversation: { messages: { id: string; text: string }[] } }; clientCapabilities?: { mayAnswer: boolean } } }
  type Phone = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['pair']>>
  /** Watcher writing on phones paired before it starts, with the listener's window timed on `clock.at`. */
  async function writing(phones = 1) {
    const clock = { at: 0 }
    const f = await fixture(true, false, false, false, () => clock.at)
    const paired: Phone[] = []
    for (let index = 0; index < phones; index++) paired.push(await f.pair())
    await paired[0]!.call('send', f.send(paired[0]!.paired.clientId))
    const native = f.native(f.target.threadId)
    const reply = { id: 'synthetic-streamed-reply', role: 'assistant' as const, text: 'Synthetic', createdAt: new Date().toISOString() }
    const shells = (phone: Phone) => phone.messages.filter(message => message.event === 'shell') as unknown as Pushed[]
    const latest = (phone: Phone) => shells(phone).at(-1)?.state
    const shown = (phone: Phone) => latest(phone)?.watcher?.conversation.messages.find(message => message.id === reply.id)?.text
    // A publish reads the shell once, as it sends, and an answer to a later request comes behind any shell it wrote.
    const reads = vi.spyOn(f.service, 'shell')
    let asked = 0
    /** Watcher's page holds what it wrote, a publish since has been read, and every phone has been sent what it carried. */
    const published = async () => {
      await expect.poll(() => f.phone.state(false).conversation.messages.find(message => message.id === reply.id)?.text).toBe(reply.text)
      const before = reads.mock.calls.length
      await f.control.commandShell({ type: 'refresh', provider: 'codex' })
      await expect.poll(() => reads.mock.calls.length).toBeGreaterThan(before)
      for (const phone of paired) await phone.call(`after-${++asked}`, { op: 'events', afterSeq: 0, threadId: f.target.threadId })
    }
    const write = async (words: string) => { reply.text += words; f.workspace.adapters.codex.emit(); await published() }
    native.status = 'running'; native.messages.push(reply); f.workspace.adapters.codex.emit()
    // Watcher working is news of its own, so it goes at once.
    for (const phone of paired) await expect.poll(() => latest(phone)?.watcher?.working).toBe(true)
    await published()
    return { f, clock, phones: paired, native, reply, shown, latest, write }
  }

  it('is pushed Watcher\'s newest words once a window has passed since its last shell, and not before', async () => {
    const { clock, phones, reply, shown, write } = await writing(2)
    const sent = reply.text
    // Before, every publish went: each of these was a shell to each phone.
    await write(' one'); clock.at = 249; await write(' two')
    for (const phone of phones) expect(shown(phone)).not.toBe(reply.text)
    for (const phone of phones) expect([undefined, sent]).toContain(shown(phone))
    // The window closes 250 ms after the last shell, and a publish then goes with the newest words, to both phones.
    clock.at = 250; await write(' three')
    for (const phone of phones) expect(shown(phone)).toBe(reply.text)
    // Words written in the next window wait for it, and go once it has closed with nothing more published.
    await write(' four')
    for (const phone of phones) expect(shown(phone)).not.toBe(reply.text)
    clock.at = 500
    for (const phone of phones) await expect.poll(() => shown(phone)).toBe(reply.text)
  })

  it('is pushed anything else at once, with the newest words', async () => {
    // The window never closes here, so only news other than Watcher's words reaches the phone.
    const { f, phones: [phone], native, reply, shown, latest, write } = await writing()
    await write(' one')
    expect(shown(phone!)).not.toBe(reply.text)
    // Watcher finishing goes at once and carries what it wrote.
    native.status = 'idle'; f.workspace.adapters.codex.emit()
    await expect.poll(() => latest(phone!)?.watcher?.working).toBe(false)
    expect(shown(phone!)).toBe(reply.text)
    // So do Watcher starting again and a change to the phone's own standing.
    native.status = 'running'; f.workspace.adapters.codex.emit()
    await expect.poll(() => latest(phone!)?.watcher?.working).toBe(true)
    await write(' two')
    expect(shown(phone!)).not.toBe(reply.text)
    f.canAnswer(true); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
    await expect.poll(() => latest(phone!)?.clientCapabilities?.mayAnswer).toBe(true)
    expect(shown(phone!)).toBe(reply.text)
  })
})

it('knows the threads Watcher started from an index of its record, for the phone’s machines line (#1032)', async () => {
  const f = await fixture(), peer = await f.pair()
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  expect(f.watcher.startedByWatcher(worker.hostId, worker.threadId)).toBe(true)
  expect(f.watcher.startedByWatcher(f.target.hostId, f.target.threadId)).toBe(false)
  expect(f.watcher.startedByWatcher(worker.hostId, 'another-thread')).toBe(false)
  // A change to something attribution does not read keeps the index: no walk of Watcher's history.
  const walks = vi.spyOn(f.watcher as unknown as { indexWatcherStarts: (record: unknown) => unknown }, 'indexWatcherStarts')
  const before = f.control.watcherRecordView()
  await f.control.updateWatcher(next => { next.lastRuntimeMode = next.lastRuntimeMode === 'auto' ? 'approval-required' : 'auto' })
  expect(f.control.watcherRecordView()).not.toBe(before)
  expect(f.watcher.startedByWatcher(worker.hostId, worker.threadId)).toBe(true)
  // Another start is read on its own, from where the index left off.
  await f.finish(worker.threadId); await f.finish(f.target.threadId)
  await peer.call('second', f.send(peer.paired.clientId)); const second = await f.start()
  expect(f.watcher.startedByWatcher(second.hostId, second.threadId)).toBe(true)
  expect(walks).not.toHaveBeenCalled()
})

it('keeps the machines line on the page Stop all answers with, which the iPhone takes whole (#1032)', async () => {
  const f = await fixture(true, false, false, true), peer = await f.pair([...STEER, 'watcher-phone-machines'])
  await peer.call('send', f.send(peer.paired.clientId)); const worker = await f.start()
  const preview = await peer.call('preview', { op: 'watcher-phone-prepare-stop-all' })
  const confirmationId = (preview.result as { confirmationId: string }).confirmationId
  const stopped = await peer.call('stop', { op: 'watcher-phone-stop-all', confirmationId })
  expect(stopped).toMatchObject({ ok: true, result: { status: 'ok', results: [{ target: worker, status: 'stopped' }],
    state: { machines: { rows: [expect.objectContaining({ name: 'This computer', thisComputer: true })] } } } })
})
