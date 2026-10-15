// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { HANDOVER_CLOSE } from '../../src/main/agents/watcherHandover'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentHostCommand } from '../../src/main/agents/host'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

/**
 * Watcher's handover after a provider change (ADR-0073, #1026), over the fake Codex and Claude providers: the room offers
 * it only when the replaced conversation said something, and only the draft the user chose to continue with carries it,
 * ahead of the user's words in the new Watcher's first message. Every copy shows the two apart by the recorded
 * provenance; the provider gets them as one message, so no turn is spent on an acknowledgement.
 */
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture(options: { readonly history?: boolean } = {}) {
  const history = options.history ?? true
  const workspace = await workspaceFixture(undefined, { history })
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => history } })
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, limit: () => 4, historyEnabled: () => history })
  const tools = new WatcherToolServer(service); workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); await f.dispose(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' }); await f.control.commandShell({ type: 'connect', provider: 'claude' })
  await service.recover()
  const model = (provider: 'codex' | 'claude') => f.control.shell().host.models.find(item => item.providerId === provider)!
  expect(await service.open({ provider: 'codex', modelId: model('codex').id })).toMatchObject({ status: 'ok' })
  const first = service.state().current!.target
  const nativeOf = (provider: 'codex' | 'claude', threadId: string) =>
    workspace.adapters[provider].state.threads.find(thread => thread.id === workspace.registry.byThread(threadId)!.sessionId)!
  const refresh = async (provider: 'codex' | 'claude') => { workspace.adapters[provider].emit(); await f.control.commandShell({ type: 'refresh', provider }) }
  const send = async (threadId: string, text: string, draftId = randomUUID()) => {
    const result = await f.control.commandShell({ type: 'manual-send', threadId, draftId, text })
    await f.control.commandShell({ type: 'observe-threads', threadIds: [threadId] })
    return result
  }
  /** One finished exchange in the first Watcher: the user's words, then Codex's reply. */
  const exchange = async (text: string, reply: string) => {
    expect((await send(first.threadId, text)).error).toBeNull()
    const native = nativeOf('codex', first.threadId)
    native.messages.push({ id: randomUUID(), role: 'assistant', text: reply, createdAt: new Date().toISOString() })
    native.status = 'idle'; native.lastTurn = { id: randomUUID(), status: 'completed' }
    await refresh('codex')
  }
  const toClaude = async () => {
    expect(await service.open({ provider: 'claude', modelId: model('claude').id })).toMatchObject({ status: 'ok', state: { current: { provider: 'claude' } } })
    return service.state().current!.target
  }
  const sends = (provider: 'codex' | 'claude') => workspace.adapters[provider].commands.filter((command): command is Extract<AgentHostCommand, { type: 'send' }> => command.type === 'send')
  return { ...f, workspace, service, first, nativeOf, refresh, send, exchange, toClaude, sends }
}

describe('Watcher’s handover after a provider change', () => {
  it('is offered only after a provider change from a conversation with history', async () => {
    const f = await fixture()
    // No provider change yet: nothing is offered.
    expect(f.service.state().handover).toBeNull()
    // A conversation that said nothing has nothing to hand over.
    await f.toClaude()
    expect(f.service.state().handover).toBeNull()
    expect(f.service.readHandover()).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
  })

  it('sends the handover ahead of the first message when the user continues, as one message, and shows the two apart', async () => {
    const f = await fixture()
    await f.exchange('Keep an eye on the release notes thread.', 'Watching Release notes. Nothing needs you yet.')
    const next = await f.toClaude()
    const offer = f.service.state().handover
    expect(offer).toMatchObject({ source: f.first, provider: 'codex', counts: { total: 2, carried: 2, historyKept: true, answered: true } })
    // The words are read only on request, and say they are context, not a request.
    const read = f.service.readHandover()
    if (read.status !== 'ok') throw new Error(read.message)
    expect(read.text).toContain('The history below is context, not a new request.')
    expect(read.text).toContain('Keep an eye on the release notes thread.')
    expect(read.text.endsWith(HANDOVER_CLOSE)).toBe(true)
    // Continue: the draft the user sends is named first, then sent through the composer's own send.
    const draftId = randomUUID()
    expect(f.service.continueWithHandover({ draftId })).toMatchObject({ status: 'ok' })
    expect((await f.send(next.threadId, 'Carry on, and tell me when it lands.', draftId)).error).toBeNull()
    const [sent] = f.sends('claude')
    expect(f.sends('claude')).toHaveLength(1)
    expect(sent!.text.startsWith(read.text)).toBe(true)
    expect(sent!.text.endsWith('\n\nCarry on, and tell me when it lands.')).toBe(true)
    // Recorded as provenance on the request it started, with no words in the record.
    const request = f.service.state().requests.find(item => item.rootUserMessageId === sent!.messageId)!
    expect(request.handover).toMatchObject({ source: f.first, provider: 'codex', prefixLength: read.text.length + 2, counts: { carried: 2 } })
    expect(JSON.stringify(request)).not.toContain('release notes')
    // Every copy shows the user's words, with the handover beside them as Sotto's.
    const shown = f.control.threadDetail(next.threadId)!.messages.find(message => message.id === sent!.messageId)!
    expect(shown.text).toBe('Carry on, and tell me when it lands.')
    expect(shown.handover).toEqual({ text: read.text, provider: 'codex', counts: offer!.counts })
    const phone = new WatcherPhoneService(f.control, f.service).state(false)
    // The phone's conversation shows the user's words alone; it draws no handover yet.
    expect(phone.conversation.messages.find(message => message.id === sent!.messageId)?.text).toBe('Carry on, and tell me when it lands.')
    // The offer is spent: it is not offered again, and the next message goes as typed.
    expect(f.service.state().handover).toBeNull()
    const native = f.nativeOf('claude', next.threadId)
    native.status = 'idle'; native.lastTurn = { id: randomUUID(), status: 'completed' }
    await f.refresh('claude')
    expect((await f.send(next.threadId, 'Thanks.')).error).toBeNull()
    expect(f.sends('claude').at(-1)!.text).toBe('Thanks.')
  })

  it('sends nothing when the offer is put away, and the first message goes as typed', async () => {
    const f = await fixture()
    await f.exchange('Watch the footer links thread.', 'Watching Footer links.')
    const next = await f.toClaude()
    expect(f.service.state().handover).not.toBeNull()
    expect(f.service.dismissHandover()).toMatchObject({ status: 'ok', state: { handover: null } })
    expect(f.sends('claude')).toHaveLength(0)
    expect(f.service.continueWithHandover({ draftId: randomUUID() })).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
    expect((await f.send(next.threadId, 'Start fresh.')).error).toBeNull()
    expect(f.sends('claude').map(command => command.text)).toEqual(['Start fresh.'])
    expect(f.service.state().requests.at(-1)!.handover).toBeUndefined()
  })

  it('goes only with the draft the user continued with; any other first message begins without it', async () => {
    const f = await fixture()
    await f.exchange('Check the visual gate.', 'It flakes on the third run.')
    const next = await f.toClaude()
    const chosen = randomUUID()
    expect(f.service.continueWithHandover({ draftId: chosen })).toMatchObject({ status: 'ok' })
    // A different draft, as a send from the phone would be: no handover, and the offer goes.
    expect((await f.send(next.threadId, 'Something else first.')).error).toBeNull()
    expect(f.sends('claude').map(command => command.text)).toEqual(['Something else first.'])
    expect(f.service.state().handover).toBeNull()
    const native = f.nativeOf('claude', next.threadId)
    native.status = 'idle'; native.lastTurn = { id: randomUUID(), status: 'completed' }
    await f.refresh('claude')
    // The draft the user chose to continue with is refused rather than sent without the handover, and a retry goes bare.
    expect((await f.send(next.threadId, 'Carry on.', chosen)).error).toMatch(/^Another message reached the new Watcher first/u)
    expect(f.sends('claude')).toHaveLength(1)
    expect((await f.send(next.threadId, 'Carry on.', chosen)).error).toBeNull()
    expect(f.sends('claude').map(command => command.text)).toEqual(['Something else first.', 'Carry on.'])
  })

  it('a provider change finished on a second try still offers the handover', async () => {
    const f = await fixture()
    await f.exchange('Watch the footer links thread.', 'Watching Footer links.')
    const claude = f.control.shell().host.models.find(item => item.providerId === 'claude')!
    const original = f.control.commandForWatcherRoom.bind(f.control)
    let failed = false
    const spy = vi.spyOn(f.control, 'commandForWatcherRoom').mockImplementation(async (command, guard) => {
      if (command.type === 'create-thread' && !failed) { failed = true; return { ...f.control.get(), error: 'Claude Code did not start.' } }
      return original(command, guard)
    })
    expect(await f.service.open({ provider: 'claude', modelId: claude.id })).toMatchObject({ status: 'refused', code: 'PROVIDER_UNAVAILABLE' })
    expect(f.service.state().handover).toBeNull()
    expect(await f.service.open({ provider: 'claude', modelId: claude.id })).toMatchObject({ status: 'ok', state: { current: { provider: 'claude' } } })
    spy.mockRestore()
    expect(f.service.state().handover).toMatchObject({ source: f.first, provider: 'codex', counts: { carried: 2 } })
  })

  it('offers nothing for a conversation that said nothing, even when an earlier one did', async () => {
    const f = await fixture()
    await f.exchange('Watch the release.', 'Watching it.')
    await f.toClaude()
    expect(f.service.state().handover).not.toBeNull()
    // Claude's Watcher said nothing before the next change, so there is nothing of its to hand over.
    await f.control.commandShell({ type: 'connect', provider: 'grok' })
    const grok = f.control.shell().host.models.find(item => item.providerId === 'grok')!
    expect(await f.service.open({ provider: 'grok', modelId: grok.id })).toMatchObject({ status: 'ok', state: { current: { provider: 'grok' }, handover: null } })
  })

  it('revives no stopped request: the handover starts a request of its own', async () => {
    const f = await fixture()
    expect((await f.send(f.first.threadId, 'Start the footer fix.')).error).toBeNull()
    const stopped = f.service.state().requests.at(-1)!
    await f.control.commandShell({ type: 'interrupt', threadId: f.first.threadId })
    const native = f.nativeOf('codex', f.first.threadId)
    native.status = 'idle'; native.lastTurn = { id: randomUUID(), status: 'interrupted' }
    await f.refresh('codex')
    expect(f.service.state().requests.find(item => item.id === stopped.id)?.state).toBe('stopped')
    const next = await f.toClaude()
    const draftId = randomUUID()
    expect(f.service.continueWithHandover({ draftId })).toMatchObject({ status: 'ok' })
    expect((await f.send(next.threadId, 'Pick it up from here.', draftId)).error).toBeNull()
    const requests = f.service.state().requests
    expect(requests.find(item => item.id === stopped.id)?.state).toBe('stopped')
    expect(requests.at(-1)).toMatchObject({ watcher: next, state: 'active', handover: { source: f.first } })
    expect(requests.at(-1)!.id).not.toBe(stopped.id)
  })

  it('never replays attachments or tool records, and says what it left out', async () => {
    const f = await fixture()
    await f.exchange('Here is the screenshot.', 'The footer overlaps the links.')
    const native = f.nativeOf('codex', f.first.threadId)
    native.messages.push({ id: randomUUID(), role: 'user', text: 'And this one.', createdAt: new Date().toISOString(),
      attachments: [{ id: 'image-1', name: 'footer.png', mimeType: 'image/png', sizeBytes: 2048 }] })
    const record: AgentActivity = { id: 'read-1', turnId: 'turn-1', sequence: 0, kind: 'command', status: 'completed', title: 'npm test', output: 'All 412 passed' }
    native.activities = [record]
    await f.refresh('codex')
    const next = await f.toClaude()
    const offer = f.service.state().handover!
    expect(offer.counts).toMatchObject({ images: 1, toolRecords: 1, answered: false })
    const draftId = randomUUID()
    f.service.continueWithHandover({ draftId })
    expect((await f.send(next.threadId, 'Go on.', draftId)).error).toBeNull()
    const sent = f.sends('claude')[0]!
    expect(sent.attachments ?? []).toEqual([])
    expect(sent.text).toContain('(This message had 1 image attached. It is not carried.)')
    expect(sent.text).toContain('1 record of its work, such as tool calls and their results')
    expect(sent.text).not.toMatch(/footer\.png|npm test|All 412 passed/)
  })

  it('with Keep local history off, carries what this run kept and says so', async () => {
    const f = await fixture({ history: false })
    await f.exchange('Watch the release.', 'Watching it.')
    const next = await f.toClaude()
    expect(f.service.state().handover?.counts).toMatchObject({ historyKept: false, carried: 2 })
    const draftId = randomUUID()
    f.service.continueWithHandover({ draftId })
    expect((await f.send(next.threadId, 'Continue.', draftId)).error).toBeNull()
    const sent = f.sends('claude')[0]!
    expect(sent.text).toContain('Keep local history is off, so this comes only from what Sotto holds in memory since it last started.')
    expect(f.control.threadDetail(next.threadId)!.messages.find(message => message.id === sent.messageId)).toMatchObject({ text: 'Continue.', handover: { counts: { historyKept: false } } })
  })

  it('a handover of a conversation that began with one carries that conversation’s own words only', async () => {
    const f = await fixture()
    await f.exchange('First Watcher request.', 'First reply.')
    const second = await f.toClaude()
    const draftId = randomUUID()
    f.service.continueWithHandover({ draftId })
    expect((await f.send(second.threadId, 'Second Watcher request.', draftId)).error).toBeNull()
    const native = f.nativeOf('claude', second.threadId)
    native.messages.push({ id: randomUUID(), role: 'assistant', text: 'Second reply.', createdAt: new Date().toISOString() })
    native.status = 'idle'; native.lastTurn = { id: randomUUID(), status: 'completed' }
    await f.refresh('claude')
    await f.control.commandShell({ type: 'connect', provider: 'grok' })
    const grok = f.control.shell().host.models.find(item => item.providerId === 'grok')!
    expect(await f.service.open({ provider: 'grok', modelId: grok.id })).toMatchObject({ status: 'ok' })
    const read = f.service.readHandover()
    if (read.status !== 'ok') throw new Error(read.message)
    expect(read.text).toContain('Second Watcher request.')
    expect(read.text).not.toContain('First Watcher request.')
    expect(read.text.split(HANDOVER_CLOSE)).toHaveLength(2)
  })
})
