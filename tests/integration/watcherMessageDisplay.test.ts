// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { watcherDisplayPrompt } from '../../src/main/agents/watcherMessageDisplay'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { applyAgentThreadDetailDelta, isAgentThreadDetailDelta } from '../../src/shared/agentThreadDetail'
import type { AgentThreadDetail, AgentThreadDetailUpdate } from '../../src/shared/agents'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { savedWatcherRecord } from '../fixtures/savedWatcher'

vi.mock('node:crypto', async importActual => {
  const actual = await importActual<typeof import('node:crypto')>()
  return { ...actual, createHash: vi.fn((...args: Parameters<typeof actual.createHash>) => {
    const hash = actual.createHash(...args)
    vi.spyOn(hash, 'update')
    return hash
  }) }
})

/** The routing footer main appended to a user Send before the request note, with an empty project list. */
const legacyFooter = (requestId: string, hostId: string) =>
  `\n\n[Sotto Watcher request: ${requestId}. Local host: ${hostId}. Use this requestId for sotto_threads mutations. Known project IDs: . Call list_projects for choices.]`
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  const services: WatcherService[] = [], tools: WatcherToolServer[] = []
  const make = (control = f.control) => {
    const service = new WatcherService({ directory: f.root, host: workspace.host, control, historyEnabled: () => true })
    const server = new WatcherToolServer(service); workspace.host.useWatcherTools(server)
    services.push(service); tools.push(server)
    return service
  }
  cleanups.push(async () => {
    for (const service of services) service.close()
    for (const server of tools) await server.close()
    await f.dispose(); await workspace.stop()
  })
  const service = make()
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const target = service.state().current!.target
  const native = () => workspace.adapters.codex.state.threads.find(thread => thread.id === workspace.registry.byThread(target.threadId)!.sessionId)!
  const send = async (text: string) => {
    const result = await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text })
    expect(result.error).toBeNull()
    await f.control.commandShell({ type: 'observe-threads', threadIds: [target.threadId] })
    return service.state().requests.at(-1)!
  }
  const refresh = async () => { workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' }) }
  const finish = async () => { native().status = 'idle'; native().lastTurn = { id: randomUUID(), status: 'completed' }; await refresh() }
  return { ...f, workspace, service, model, target, native, send, refresh, finish, make }
}

describe('real Watcher user message display', () => {
  it('shows only the original owned user message while native input and durable history keep its complete context', async () => {
    const f = await fixture(), original = 'Inspect Ω 😃\nKeep this second line.'
    const beforeWriter: unknown[] = []
    const execute = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
    vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
      if (command.type === 'send') {
        const saved = (await savedWatcherRecord<{ requests: { rootUserMessageId: string; displayPrompt?: unknown }[] }>(f.root))!
        beforeWriter.push(saved.requests.find(request => request.rootUserMessageId === command.messageId)?.displayPrompt)
      }
      return execute(command)
    })
    const request = await f.send(original)
    expect(f.control.threadDetail(f.target.threadId)!.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(original)
    expect(f.control.get().host.threads.find(thread => thread.id === f.target.threadId)!.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(original)
    const native = f.native().messages.find(message => message.id === request.rootUserMessageId)!
    // Sent as typed: the request travels in the note beside it, and the proof records that nothing was added.
    expect(native.text).toBe(original)
    const proof = { originalLength: original.length, wireDigest: createHash('sha256').update(native.text).digest('hex') }
    expect(request.displayPrompt).toEqual(proof); expect(beforeWriter).toEqual([proof])
    expect(JSON.stringify(request)).not.toContain(original)
    await f.workspace.host.flush()
    const db = new DatabaseSync(join(f.root, 'threads.sqlite'), { readOnly: true })
    try { expect(db.prepare('SELECT text FROM messages WHERE thread_id=? AND message_id=?').get(f.target.threadId, native.id)?.text).toBe(native.text) }
    finally { db.close() }
  })

  it('keeps a queued original literal footer on desktop and phone without stripping it twice', async () => {
    const f = await fixture(), request = await f.send('Synthetic root')
    const original = `Quoted original 😃${legacyFooter(request.id, f.target.hostId)}`
    const draftId = randomUUID()
    expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.target.threadId, draftId, text: original })).error).toBeNull()
    await f.finish()
    await expect.poll(() => f.service.state().requests.find(item => item.id === request.id)?.userFollowups?.find(item => item.draftId === draftId)?.messageId).toBeTruthy()
    await expect.poll(() => f.control.shell().followups?.some(item => item.draftId === draftId)).toBe(false)
    const followup = f.service.state().requests.find(item => item.id === request.id)!.userFollowups!.find(item => item.draftId === draftId)!
    const native = f.native().messages.find(message => message.id === followup.messageId)!
    expect(native.text).toBe(original)
    expect(followup.displayPrompt).toEqual({ originalLength: original.length, wireDigest: createHash('sha256').update(native.text).digest('hex') })
    expect(f.control.threadDetail(f.target.threadId)!.messages.find(message => message.id === followup.messageId)?.text).toBe(original)
    const phone = new WatcherPhoneService(f.control, f.service)
    expect(phone.state(false).conversation.messages.find(message => message.id === followup.messageId)?.text).toBe(original)
    expect(JSON.stringify(phone.state(false))).not.toContain('displayPrompt')
    expect(JSON.stringify(phone.state(false))).not.toContain('wireDigest')
  })

  it('diffs presented bases through assistant appends, invalidated proofs, replacements and resets', async () => {
    const f = await fixture(), original = 'Synthetic original', request = await f.send(original)
    let held: AgentThreadDetail = f.control.threadDetail(f.target.threadId)!
    const updates: AgentThreadDetailUpdate[] = [], invalid: AgentThreadDetailUpdate[] = []
    const off = f.control.subscribeThreadDetail(update => {
      if (update.threadId !== f.target.threadId) return
      updates.push(update)
      if (isAgentThreadDetailDelta(update)) {
        const next = applyAgentThreadDetailDelta(held, update)
        if (next === null) invalid.push(update); else held = next
      } else held = update
    })
    cleanups.push(async () => off())
    // A message an earlier build sent with the footer, and proved: the projection is its exact original boundary.
    const nativeUser = f.native().messages.find(message => message.id === request.rootUserMessageId)!, wire = original + legacyFooter(request.id, f.target.hostId)
    nativeUser.text = wire
    await f.control.updateWatcher(record => { record.requests.find(item => item.id === request.id)!.displayPrompt = watcherDisplayPrompt(original, wire) })
    await f.refresh()
    f.native().messages.push({ id: 'streaming-reply', role: 'assistant', text: 'Hello', createdAt: new Date().toISOString() })
    await f.refresh(); updates.length = 0
    f.native().messages.find(message => message.id === 'streaming-reply')!.text += ' there'
    await f.refresh()
    expect(updates.some(update => isAgentThreadDetailDelta(update) && update.messageDeltas.some(delta => 'appendText' in delta && delta.id === 'streaming-reply' && delta.appendText === ' there'))).toBe(true)
    expect(held.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(original)
    const beforeRevision = held.revision
    nativeUser.text = 's' + wire.slice(1) // Same native length, different digest; do not silently keep the old projection.
    await f.refresh()
    expect(held.revision).toBeGreaterThan(beforeRevision)
    expect(held.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(nativeUser.text)
    nativeUser.text = wire; await f.refresh()
    expect(held.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(original)
    f.native().messages = f.native().messages.filter(message => message.id !== request.rootUserMessageId)
    updates.length = 0; await f.refresh()
    expect(updates.some(update => !isAgentThreadDetailDelta(update))).toBe(true)
    expect(held.messages.map(message => message.id)).toEqual(['streaming-reply'])
    f.native().messages.unshift(nativeUser); await f.refresh()
    expect(held.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(original)
    expect(invalid).toEqual([])
    expect(f.native().messages[0]!.text).toBe(wire)
  })

  it('releases retired history text on public close and verifies fresh wire on offscreen reads and reopen', async () => {
    const f = await fixture(), original = 'Synthetic retained original', request = await f.send(original)
    const wire = f.native().messages.find(message => message.id === request.rootUserMessageId)!.text
    await f.finish(); await f.control.commandShell({ type: 'connect', provider: 'claude' })
    const nextModel = f.control.shell().host.models.find(model => model.providerId === 'claude')!
    expect(await f.service.open({ provider: 'claude', modelId: nextModel.id })).toMatchObject({ status: 'ok' })
    expect(f.control.watcherSnapshot().threads.find(thread => thread.id === f.target.threadId)?.kind).toBe('watcher-history')
    const ordinary = f.control.shell().host.threads.find(thread => thread.kind !== 'watcher' && thread.kind !== 'watcher-history')!
    expect(ordinary).toBeTruthy()
    expect((await f.control.commandShell({ type: 'select-thread', threadId: ordinary.id })).error).toBeNull()
    expect(f.control.shell().deliveries?.some(delivery => delivery.status !== 'accepted')).toBeFalsy()
    expect(f.control.shell().followups?.length ?? 0).toBe(0)
    await f.control.commandShell({ type: 'observe-threads', threadIds: [f.target.threadId] })
    vi.mocked(createHash).mockClear()
    const verifications = () => vi.mocked(createHash).mock.results.filter(result => result.type === 'return'
      && vi.mocked(result.value.update).mock.calls.some(([input]) => input === wire)).length
    const detailText = () => f.control.threadDetail(f.target.threadId)!.messages.find(message => message.id === request.rootUserMessageId)?.text
    const stateText = () => f.control.get().host.threads.find(thread => thread.id === f.target.threadId)!.messages.find(message => message.id === request.rootUserMessageId)?.text
    expect(detailText()).toBe(original)
    const warm = verifications()
    for (let chunk = 0; chunk < 3; chunk++) {
      const native = f.native()
      if (chunk === 0) native.messages.push({ id: 'retired-reply', role: 'assistant', text: 'Reply', createdAt: new Date().toISOString() })
      else native.messages.find(message => message.id === 'retired-reply')!.text += ' more'
      await f.refresh()
      expect(detailText()).toBe(original)
    }
    expect(verifications()).toBe(warm)
    // No detail subscriber: closing still releases the memo rather than waiting for a provider frame.
    await f.control.commandShell({ type: 'observe-threads', threadIds: [] })
    expect((await f.control.commandShell({ type: 'load-earlier-messages', threadId: f.target.threadId })).error).toBeNull()
    expect(stateText()).toBe(original)
    expect(verifications()).toBe(warm + 1)
    expect(detailText()).toBe(original)
    const afterTransientDetail = verifications()
    expect(afterTransientDetail).toBeGreaterThan(warm + 1)
    expect(stateText()).toBe(original)
    expect(verifications()).toBe(afterTransientDetail + 1)
    await f.control.commandShell({ type: 'observe-threads', threadIds: [f.target.threadId] })
    const beforeReopen = verifications()
    expect(detailText()).toBe(original)
    expect(verifications()).toBe(beforeReopen + 1)
    expect(detailText()).toBe(original)
    expect(verifications()).toBe(beforeReopen + 1)
    expect(f.control.watcherRecord().requests.find(item => item.id === request.id)!.displayPrompt).toEqual(request.displayPrompt)
    expect(f.native().messages.find(message => message.id === request.rootUserMessageId)!.text).toBe(wire)
    await f.workspace.host.flush()
    const db = new DatabaseSync(join(f.root, 'threads.sqlite'), { readOnly: true })
    try { expect(db.prepare('SELECT text FROM messages WHERE thread_id=? AND message_id=?').get(f.target.threadId, request.rootUserMessageId)?.text).toBe(wire) }
    finally { db.close() }
  })

  it('restores and retires proven conversations, hides an unproven legacy footer and never second-guesses a stale proof', async () => {
    const f = await fixture(), original = 'Synthetic restored original', request = await f.send(original)
    const wire = f.native().messages.find(message => message.id === request.rootUserMessageId)!.text
    await f.finish(); await f.control.commandShell({ type: 'connect', provider: 'claude' })
    const nextModel = f.control.shell().host.models.find(model => model.providerId === 'claude')!
    expect(await f.service.open({ provider: 'claude', modelId: nextModel.id })).toMatchObject({ status: 'ok' })
    expect(f.service.state().history.some(identity => identity.target.threadId === f.target.threadId)).toBe(true)
    expect(f.control.watcherSnapshot().threads.find(thread => thread.id === f.target.threadId)?.kind).toBe('watcher-history')
    expect(f.control.threadDetail(f.target.threadId)!.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(original)
    f.service.close(); f.control.dispose(); await f.control.closed()
    const restored = f.create(), service = f.make(restored)
    await restored.start(); await restored.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
    await restored.commandShell({ type: 'observe-threads', threadIds: [f.target.threadId] })
    expect(restored.watcherRecord().requests.find(item => item.id === request.id)!.displayPrompt).toEqual(request.displayPrompt)
    expect(restored.threadDetail(f.target.threadId)!.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(original)
    // A message saved before display proofs, with the footer main appended for its own request, shows as typed too
    // (Zach, October 14, 2026: the footer is omitted everywhere user-facing).
    expect(wire).toBe(original)
    const nativeOf = (provider: 'codex' | 'claude', threadId: string) => f.workspace.adapters[provider].state.threads.find(thread => thread.id === f.workspace.registry.byThread(threadId)!.sessionId)!
    const refresh = async (provider: 'codex' | 'claude') => { f.workspace.adapters[provider].emit(); await restored.commandShell({ type: 'refresh', provider }) }
    nativeOf('codex', f.target.threadId).messages.find(message => message.id === request.rootUserMessageId)!.text = original + legacyFooter(request.id, restored.hostId()!)
    await restored.updateWatcher(record => { delete record.requests.find(item => item.id === request.id)!.displayPrompt })
    await refresh('codex')
    expect(restored.threadDetail(f.target.threadId)!.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(original)
    // On the current conversation, a proof that no longer matches is never second-guessed; without one, the footer comes off.
    const current = service.state().current!.target.threadId
    const currentText = 'Synthetic current legacy original'
    expect((await restored.commandShell({ type: 'manual-send', threadId: current, draftId: randomUUID(), text: currentText })).error).toBeNull()
    await restored.commandShell({ type: 'observe-threads', threadIds: [current] })
    const currentRequest = service.state().requests.at(-1)!
    const footed = currentText + legacyFooter(currentRequest.id, restored.hostId()!)
    nativeOf('claude', current).messages.find(message => message.id === currentRequest.rootUserMessageId)!.text = footed
    await restored.updateWatcher(record => { record.requests.find(item => item.id === currentRequest.id)!.displayPrompt!.wireDigest = '0'.repeat(64) })
    await refresh('claude')
    const phone = new WatcherPhoneService(restored, service)
    expect(restored.threadDetail(current)!.messages.find(message => message.id === currentRequest.rootUserMessageId)!.text).toBe(footed)
    expect(phone.state(false).conversation.messages.find(message => message.id === currentRequest.rootUserMessageId)?.text).toBe(footed)
    await restored.updateWatcher(record => { delete record.requests.find(item => item.id === currentRequest.id)!.displayPrompt })
    await refresh('claude')
    expect(restored.threadDetail(current)!.messages.find(message => message.id === currentRequest.rootUserMessageId)!.text).toBe(currentText)
    expect(phone.state(false).conversation.messages.find(message => message.id === currentRequest.rootUserMessageId)?.text).toBe(currentText)
  })
})
