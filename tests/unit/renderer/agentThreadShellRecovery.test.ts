// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'
import { wrapAgentBridge } from '../../../src/renderer/src/agents/agentStateCatalogs'
import type { AgentState, AgentStateBroadcast, AgentThreadsBroadcast, AgentWireBridge } from '../../../src/shared/agents'
import { threadsStateFixture } from '../../fixtures/agentState'
import { deferred } from '../../fixtures/deferred'

function transport() {
  const broadcaster = new AgentStateBroadcaster({ streamingPublishCost: true })
  const state = threadsStateFixture({ threads: [{ id: 'a', title: 'Initial' }, { id: 'b' }], topLevel: { activeThreadId: 'a' } })
  const listeners = new Set<(state: AgentStateBroadcast) => void>()
  const command = vi.fn<AgentWireBridge['command']>()
  const get = vi.fn(async (): Promise<AgentState> => {
    broadcaster.resetThreadDelivery()
    return structuredClone(state)
  })
  const page = () => wrapAgentBridge({
    get, command,
    onState: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } as AgentWireBridge)
  const send = (): AgentStateBroadcast => {
    let wire!: AgentStateBroadcast
    broadcaster.send(state, payload => {
      wire = structuredClone(payload)
      for (const listener of listeners) listener(wire)
      return true
    })
    return wire
  }
  return { broadcaster, state, listeners, command, get, page, send }
}

describe('thread shell page lifecycle and command ordering', () => {
  it.each([[true, true], [true, false], [false, true], [false, false]])('recovers around a successful worktree preview, command first: %s, read first: %s', async (commandFirst, readFirst) => {
    const h = transport(), page = h.page(), delivered: AgentState[] = [], order: string[] = []
    h.state.notice = 'Old shell'
    page.onState(state => { delivered.push(state); if (state.notice === 'Current shell') order.push('shell') })
    h.send()
    h.state.host.threads[0]!.title = 'Latest'
    h.state.notice = 'Current shell'
    h.broadcaster.send(h.state, () => true)
    const held = deferred<AgentState>(), command = deferred<Awaited<ReturnType<AgentWireBridge['command']>>>()
    h.get.mockImplementationOnce(() => { h.broadcaster.resetThreadDelivery(); return held.promise })
    h.command.mockReturnValue(command.promise)
    let answer: ReturnType<typeof page.command>
    if (commandFirst) { answer = page.command({ type: 'preview-reclaim-thread-worktree', threadId: 'a' }); h.send() }
    else { h.send(); answer = page.command({ type: 'preview-reclaim-thread-worktree', threadId: 'a' }) }
    if (readFirst) {
      held.resolve(structuredClone(h.state))
      for (let i = 0; i < 12; i++) await Promise.resolve()
      // A read begun after the command began is current evidence and need not wait for it.
      expect(delivered.map(state => state.notice)).toEqual(commandFirst ? ['Old shell', 'Current shell'] : ['Old shell'])
    }
    const own = h.broadcaster.encodeReceipt(h.state)
    own.notice = 'Own preview outcome'
    own.worktreeReclaimPreview = { path: 'C:/synthetic-worktree', branch: 'main', dirty: false, ignored: [], items: [], repositories: [], untracked: [] }
    command.resolve(own)
    expect(await answer!).toMatchObject({ notice: own.notice, worktreeReclaimPreview: own.worktreeReclaimPreview })
    order.push('receipt')
    if (!readFirst) held.resolve(structuredClone(h.state))
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(delivered.map(state => state.notice)).toEqual(['Old shell', 'Current shell'])
    expect(delivered.at(-1)?.host.threads[0]?.title).toBe('Latest')
    expect(h.get).toHaveBeenCalledTimes(commandFirst && readFirst ? 1 : 2)
    expect(order).toEqual(commandFirst && readFirst ? ['shell', 'receipt'] : ['receipt', 'shell'])
  })
  it.each(['fresh read', 'new full'] as const)('makes %s progress while another command stays pending', async progress => {
    const h = transport(), page = h.page(), delivered: AgentState[] = []
    page.onState(state => delivered.push(state))
    h.send()
    h.state.host.threads[0]!.title = 'Latest'
    h.broadcaster.send(h.state, () => true)
    const held = deferred<AgentState>()
    h.get.mockImplementationOnce(() => { h.broadcaster.resetThreadDelivery(); return held.promise })
    h.send()
    const first = deferred<Awaited<ReturnType<AgentWireBridge['command']>>>(), second = deferred<Awaited<ReturnType<AgentWireBridge['command']>>>()
    h.command.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const firstAnswer = page.command({ type: 'preview-reclaim-thread-worktree', threadId: 'a' })
    const secondAnswer = page.command({ type: 'preview-reclaim-thread-worktree', threadId: 'b' })
    first.resolve(h.broadcaster.encodeReceipt(h.state))
    await firstAnswer
    if (progress === 'new full') h.send()
    held.resolve(structuredClone(h.state))
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(delivered.at(-1)?.host.threads[0]?.title).toBe('Latest')
    expect(h.get).toHaveBeenCalledTimes(progress === 'fresh read' ? 2 : 1)
    const own = h.broadcaster.encodeReceipt(h.state)
    own.notice = 'Second command outcome'
    second.resolve(own)
    expect((await secondAnswer).notice).toBe(own.notice)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(h.get).toHaveBeenCalledTimes(progress === 'fresh read' ? 2 : 1)
  })
  it.each(['newer full', 'newer receipt', 'unsubscribe', 'failed fresh read'] as const)('fences a fresh rejection read after %s', async outcome => {
    const h = transport(), page = h.page(), delivered: AgentState[] = []
    h.state.notice = 'Before command'
    const off = page.onState(state => delivered.push(state))
    h.send()
    h.state.host.models = [...h.state.host.models, { id: 'new-model', name: 'New model', provider: 'codex', ready: true }]
    h.broadcaster.send(h.state, () => true)
    h.broadcaster.resetThreadDelivery()
    const original = deferred<AgentState>(), originalState = structuredClone(h.state)
    h.get.mockImplementationOnce(() => { h.broadcaster.resetThreadDelivery(); return original.promise })
    h.send()
    h.state.activeThreadId = 'b'; h.state.notice = 'Successful command'
    h.command.mockResolvedValueOnce(h.broadcaster.encodeReceipt(h.state))
    await page.command({ type: 'select-thread', threadId: 'b' })
    const fresh = deferred<AgentState>(), older = structuredClone(h.state)
    h.get.mockImplementationOnce(() => { h.broadcaster.resetThreadDelivery(); return fresh.promise })
    h.command.mockRejectedValueOnce(new Error('Host disconnected'))
    await expect(page.command({ type: 'refresh' })).rejects.toThrow('Host disconnected')
    original.resolve(originalState)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(h.get).toHaveBeenCalledTimes(3)
    if (outcome === 'unsubscribe') off()
    else if (outcome === 'newer full') { h.state.notice = 'Newest push'; h.send() }
    else if (outcome === 'newer receipt') {
      h.state.notice = 'Newest receipt'; h.state.activeThreadId = 'a'
      h.state.host.models = [...h.state.host.models, { id: 'latest-model', name: 'Latest model', provider: 'codex', ready: true }]
      h.command.mockResolvedValueOnce(h.broadcaster.encodeReceipt(h.state))
      expect((await page.command({ type: 'select-thread', threadId: 'a' })).notice).toBe('Newest receipt')
    }
    if (outcome === 'failed fresh read') fresh.reject(new Error('Read failed'))
    else fresh.resolve(older)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(delivered.map(state => state.notice)).toEqual(outcome === 'newer full' ? ['Before command', 'Newest push'] : outcome === 'newer receipt' ? ['Before command', 'Newest receipt'] : ['Before command'])
    expect(h.get).toHaveBeenCalledTimes(outcome === 'newer receipt' ? 5 : 3)
    h.send()
    if (outcome !== 'unsubscribe') expect(delivered.at(-1)).toEqual(h.state)
    else expect(delivered).toHaveLength(1)
    expect(h.get).toHaveBeenCalledTimes(outcome === 'newer receipt' ? 5 : 3)
  })
  it.each([[true, false], [false, false], [true, true], [false, true]])('reads fresh after receipt recovery, read finished: %s, queued old broadcast: %s', async (finishFirst, queueRaw) => {
    const h = transport(), page = h.page(), delivered: AgentState[] = []
    h.state.notice = 'Before command'
    page.onState(state => delivered.push(state))
    h.send()
    h.state.host.models = [...h.state.host.models, { id: 'new-model', name: 'New model', provider: 'codex', ready: true }]
    h.broadcaster.send(h.state, () => true) // The page missed this catalog delivery.
    h.broadcaster.resetThreadDelivery()
    const before = structuredClone(h.state), held = deferred<AgentState>()
    h.get.mockImplementationOnce(() => { h.broadcaster.resetThreadDelivery(); return held.promise })
    h.send() // Whole threads are available, but the omitted catalog is unresolved.
    if (queueRaw) { h.broadcaster.resetThreadDelivery(); h.send() }
    h.state.activeThreadId = 'b'
    h.state.notice = 'Newer successful command'
    h.command.mockResolvedValueOnce(h.broadcaster.encodeReceipt(h.state))
    expect((await page.command({ type: 'select-thread', threadId: 'b' })).notice).toBe(h.state.notice)
    expect(h.get).toHaveBeenCalledTimes(2)
    if (finishFirst) { held.resolve(before); for (let i = 0; i < 12; i++) await Promise.resolve() }
    h.command.mockRejectedValueOnce(new Error('Host disconnected'))
    await expect(page.command({ type: 'refresh' })).rejects.toThrow('Host disconnected')
    if (!finishFirst) held.resolve(before)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(h.get).toHaveBeenCalledTimes(3)
    expect(delivered.map(state => state.notice)).toEqual(['Before command', 'Newer successful command'])
    expect(delivered.at(-1)?.activeThreadId).toBe('b')
  })
  it.each([true, false])('recovers after a rejected command, rejection before held read settles: %s', async rejectFirst => {
    const h = transport()
    h.broadcaster.send(h.state, () => true)
    const held = deferred<AgentState>()
    h.get.mockImplementationOnce(() => { h.broadcaster.resetThreadDelivery(); return held.promise })
    const page = h.page(), delivered: AgentState[] = []
    page.onState(state => delivered.push(state))
    h.send()
    const command = deferred<Awaited<ReturnType<AgentWireBridge['command']>>>()
    h.command.mockReturnValue(command.promise)
    const rejected = expect(page.command({ type: 'refresh' })).rejects.toThrow('Host disconnected')
    if (!rejectFirst) {
      held.resolve(structuredClone(h.state))
      for (let i = 0; i < 12; i++) await Promise.resolve()
      expect(delivered).toEqual([])
    }
    command.reject(new Error('Host disconnected'))
    await rejected
    if (rejectFirst) held.resolve(structuredClone(h.state))
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(delivered).toEqual([h.state])
    expect(h.get).toHaveBeenCalledTimes(2)
    h.send()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(delivered.at(-1)).toEqual(h.state)
    // The fresh command-failure read cannot label its catalog with the old envelope's revision.
    // The next broadcast's independent catalog miss recovers once, then the following push is warm.
    expect(h.get).toHaveBeenCalledTimes(3)
    h.send()
    expect(h.get).toHaveBeenCalledTimes(3)
  })
  it.each(['newer push', 'unsubscribe', 'failed read'] as const)('bounds rejected-command recovery after %s', async mode => {
    const h = transport()
    h.broadcaster.send(h.state, () => true)
    const held = deferred<AgentState>()
    h.get.mockImplementationOnce(() => { h.broadcaster.resetThreadDelivery(); return held.promise })
    const page = h.page(), delivered: AgentState[] = []
    const off = page.onState(state => delivered.push(state))
    h.send()
    const command = deferred<Awaited<ReturnType<AgentWireBridge['command']>>>()
    h.command.mockReturnValue(command.promise)
    const rejected = expect(page.command({ type: 'refresh' })).rejects.toThrow('Host disconnected')
    const changeCatalog = (): void => { h.state.host.models = [...h.state.host.models, { id: 'new-model', name: 'New model', provider: 'codex', ready: true }] }
    if (mode === 'newer push') { h.state.host.threads[0]!.title = 'Latest'; changeCatalog(); h.send() }
    else if (mode === 'unsubscribe') off()
    else h.get.mockImplementationOnce(() => { h.broadcaster.resetThreadDelivery(); return Promise.reject(new Error('Read failed')) })
    command.reject(new Error('Host disconnected'))
    await rejected
    held.resolve(structuredClone(h.state))
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(delivered).toEqual(mode === 'newer push' ? [h.state] : [])
    expect(h.get).toHaveBeenCalledTimes(mode === 'failed read' ? 2 : 1)
    if (mode === 'failed read') { changeCatalog(); h.send(); expect(delivered.at(-1)).toEqual(h.state); expect(h.get).toHaveBeenCalledTimes(2) }
  })
  it('does not mistake a second fresh subscription for a newer broadcast during recovery', async () => {
    const h = transport()
    h.broadcaster.send(h.state, () => true)
    const page = h.page(), first = deferred<AgentState>(), second = deferred<AgentState>()
    page.onState(state => first.resolve(state))
    page.onState(state => second.resolve(state))
    h.send()
    expect(await first.promise).toEqual(h.state)
    expect(await second.promise).toEqual(h.state)
  })
  it('recovers a fresh page from a warm omission and makes the next push complete', async () => {
    const h = transport()
    const first: AgentState[] = []
    const off = h.page().onState(state => first.push(state))
    h.send()
    off()
    const recovered = deferred<AgentState>()
    const reload: AgentState[] = []
    h.page().onState(state => { reload.push(state); recovered.resolve(state) })
    const warm = h.send().host.threads as AgentThreadsBroadcast
    expect(warm.changed).toEqual([])
    expect(warm.baseRevision).not.toBeNull()
    expect(await recovered.promise).toEqual(h.state)
    expect(h.get).toHaveBeenCalledTimes(1)
    const complete = h.send().host.threads as AgentThreadsBroadcast
    expect(complete.baseRevision).toBeNull()
    expect(complete.changed.map(body => body.thread.id)).toEqual(['a', 'b'])
    h.state.host.threads[0]!.finishedUnread = true
    h.state.activeThreadId = 'b'
    h.send()
    expect(reload.at(-1)).toEqual(h.state)
    expect(first).toHaveLength(1)
    expect(h.get).toHaveBeenCalledTimes(1)
  })

  it('isolates two subscriptions from consumer and retained raw thread mutations', () => {
    const h = transport()
    const page = h.page()
    const first: AgentState[] = [], second: AgentState[] = []
    page.onState(state => {
      first.push(state)
      state.host.threads[0]!.title = 'Consumer changed this'
      state.host.threads[0]!.requests.push({ id: 'consumer', kind: 'permission', text: 'Consumer request', options: [] })
    })
    page.onState(state => second.push(state))
    h.listeners.add(raw => {
      const threads = raw.host.threads as AgentThreadsBroadcast
      for (const body of threads.changed) body.thread.title = 'Raw listener changed this'
    })
    h.send()
    expect(second[0]!.host.threads).toEqual(h.state.host.threads)
    second[0]!.host.threads[1]!.title = 'Retained consumer changed this'
    h.send()
    expect(second[1]!.host.threads).toEqual(h.state.host.threads)
    expect(first[0]!.host.threads[1]!.title).toBe(h.state.host.threads[1]!.title)
    expect(h.get).not.toHaveBeenCalled()
  })

  it('keeps a command begun before recovery intact when it completes during a held get', async () => {
    const h = transport()
    const page = h.page()
    const delivered: AgentState[] = []
    page.onState(state => delivered.push(state))
    h.send()
    const command = deferred<Awaited<ReturnType<AgentWireBridge['command']>>>()
    h.command.mockReturnValue(command.promise)
    const answer = page.command({ type: 'select-thread', threadId: 'b' })
    const recovery = deferred<AgentState>()
    h.get.mockImplementationOnce(() => { h.broadcaster.resetThreadDelivery(); return recovery.promise })
    const old = structuredClone(h.state)
    // This subscriber did not receive the prior successful push: its first warm shell must recover.
    const cold: AgentState[] = []
    page.onState(state => cold.push(state))
    h.send()
    expect(h.get).toHaveBeenCalledTimes(1)
    const own = structuredClone(h.state)
    own.notice = 'Selection saved'
    own.activeThreadId = 'b'
    own.threadDraftPersistence = [{ threadId: 'b', draftId: 'aaaaaaaa-0000-4000-8000-000000000000', status: 'saved' }]
    h.state.activeThreadId = 'b'
    command.resolve(h.broadcaster.encodeReceipt(own))
    expect(await answer).toMatchObject({ notice: own.notice, activeThreadId: 'b', threadDraftPersistence: own.threadDraftPersistence })
    recovery.resolve(old)
    await recovery.promise
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(cold).toEqual([h.state])
    h.state.activeThreadId = 'b'
    h.state.notice = 'Newer broadcast'
    h.state.host.threads[1]!.finishedUnread = true
    h.send()
    expect(cold.at(-1)).toEqual(h.state)
    expect(delivered.at(-1)).toEqual(h.state)
    expect(h.get).toHaveBeenCalledTimes(2)
  })

  it('keeps receipt evidence and newer thread state when catalog recovery finishes late', async () => {
    const h = transport()
    const page = h.page()
    const delivered: AgentState[] = []
    page.onState(state => delivered.push(state))
    h.send()
    h.state.host.models = [...h.state.host.models, { id: 'new-model', name: 'New model', provider: 'codex', ready: true }]
    const own = structuredClone(h.state)
    own.notice = 'Draft saved'
    own.threadDraftPersistence = [{ threadId: 'a', draftId: 'aaaaaaaa-0000-4000-8000-000000000000', status: 'saved' }]
    const recovery = deferred<AgentState>(), started = deferred<void>()
    h.get.mockImplementation(() => { h.broadcaster.resetThreadDelivery(); started.resolve(); return recovery.promise })
    h.command.mockResolvedValue(h.broadcaster.encodeReceipt(own))
    const answer = page.command({ type: 'refresh' })
    await started.promise
    h.state.host.threads[0]!.title = 'Newest thread'
    h.state.host.threads[0]!.requests.push({ id: 'new-question', kind: 'question', text: 'Which option?', options: [] })
    h.state.globalLaneBusy = true
    h.state.notice = 'Newest broadcast'
    h.send()
    recovery.resolve(own)
    const reply = await answer
    expect(reply.notice).toBe('Draft saved')
    expect(reply.threadDraftPersistence).toEqual(own.threadDraftPersistence)
    expect(reply.host.threads).toEqual(own.host.threads)
    expect(reply.host.models).toEqual(h.state.host.models)
    h.send()
    expect(delivered.at(-1)).toEqual(h.state)
    expect(delivered.map(state => state.notice)).not.toContain('Draft saved')
    expect(h.get).toHaveBeenCalledTimes(1)
  })
})
