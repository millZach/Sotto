// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatcherService, watcherGuidancePrefix, WATCHER_GUIDANCE_SUFFIX } from '../../src/main/agents/watcher'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { applyAgentThreadDetailDelta, isAgentThreadDetailDelta } from '../../src/shared/agentThreadDetail'
import type { AgentThreadDetail, AgentThreadDetailUpdate } from '../../src/shared/agents'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  const services: WatcherService[] = [], tools: WatcherToolServer[] = []
  const make = (control = f.control) => {
    const service = new WatcherService({ directory: f.root, host: workspace.host, control, limit: () => 4, historyEnabled: () => true })
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
        const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))
        beforeWriter.push(saved.watcher.requests.find((request: { rootUserMessageId: string }) => request.rootUserMessageId === command.messageId)?.displayPrompt)
      }
      return execute(command)
    })
    const request = await f.send(original)
    expect(f.control.threadDetail(f.target.threadId)!.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(original)
    expect(f.control.get().host.threads.find(thread => thread.id === f.target.threadId)!.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(original)
    const native = f.native().messages.find(message => message.id === request.rootUserMessageId)!
    expect(native.text).toContain(`${original}\n\n${watcherGuidancePrefix(request.id, f.target.hostId)}`)
    expect(native.text.endsWith(WATCHER_GUIDANCE_SUFFIX)).toBe(true)
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
    const original = `Quoted original 😃\n\n${watcherGuidancePrefix(request.id, f.target.hostId)}${WATCHER_GUIDANCE_SUFFIX}`
    const draftId = randomUUID()
    expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.target.threadId, draftId, text: original })).error).toBeNull()
    await f.finish()
    await expect.poll(() => f.service.state().requests.find(item => item.id === request.id)?.userFollowups?.find(item => item.draftId === draftId)?.messageId).toBeTruthy()
    await expect.poll(() => f.control.shell().followups?.some(item => item.draftId === draftId)).toBe(false)
    const followup = f.service.state().requests.find(item => item.id === request.id)!.userFollowups!.find(item => item.draftId === draftId)!
    const native = f.native().messages.find(message => message.id === followup.messageId)!
    expect(native.text.startsWith(original + '\n\n')).toBe(true)
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
    const nativeUser = f.native().messages.find(message => message.id === request.rootUserMessageId)!, wire = nativeUser.text
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

  it('restores and retires proven conversations while old unverified desktop history stays raw and phone legacy behavior stays explicit', async () => {
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
    // The older absent-proof branch is deliberately not guessed on desktop.
    await restored.updateWatcher(record => { delete record.requests.find(item => item.id === request.id)!.displayPrompt })
    expect(restored.threadDetail(f.target.threadId)!.messages.find(message => message.id === request.rootUserMessageId)?.text).toBe(wire)
    // Phone's existing exact-ID/request-prefix/suffix behavior is tested on its actual current conversation.
    const current = service.state().current!.target.threadId
    const currentText = 'Synthetic current legacy original'
    expect((await restored.commandShell({ type: 'manual-send', threadId: current, draftId: randomUUID(), text: currentText })).error).toBeNull()
    await restored.commandShell({ type: 'observe-threads', threadIds: [current] })
    const currentRequest = service.state().requests.at(-1)!
    await restored.updateWatcher(record => { record.requests.find(item => item.id === currentRequest.id)!.displayPrompt!.wireDigest = '0'.repeat(64) })
    const phone = new WatcherPhoneService(restored, service)
    const edited = restored.threadDetail(current)!.messages.find(message => message.id === currentRequest.rootUserMessageId)!.text
    expect(edited).toContain(watcherGuidancePrefix(currentRequest.id, restored.hostId()!))
    expect(phone.state(false).conversation.messages.find(message => message.id === currentRequest.rootUserMessageId)?.text).toBe(edited)
    await restored.updateWatcher(record => { delete record.requests.find(item => item.id === currentRequest.id)!.displayPrompt })
    expect(restored.threadDetail(current)!.messages.find(message => message.id === currentRequest.rootUserMessageId)!.text).toContain(watcherGuidancePrefix(currentRequest.id, restored.hostId()!))
    expect(phone.state(false).conversation.messages.find(message => message.id === currentRequest.rootUserMessageId)?.text).toBe(currentText)
  })
})
