// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'
import { wrapAgentBridge } from '../../../src/renderer/src/agents/agentStateCatalogs'
import type { AgentState, AgentStateBroadcast, AgentThreadsBroadcast, AgentWireBridge } from '../../../src/shared/agents'
import { threadsStateFixture } from '../../fixtures/agentState'
import { deferred } from '../../fixtures/deferred'

function harness(get?: () => Promise<AgentState>) {
  const broadcaster = new AgentStateBroadcaster({ streamingPublishCost: true })
  let raw!: (state: AgentStateBroadcast) => void
  const delivered: AgentState[] = []
  const getFn = vi.fn(get ?? (async () => { broadcaster.resetThreadDelivery(); return structuredClone(shell) }))
  const command = vi.fn<AgentWireBridge['command']>()
  const bridge = { get: getFn, command, onState: (listener: typeof raw) => { raw = listener; return () => undefined } } as unknown as AgentWireBridge
  const wrapped = wrapAgentBridge(bridge)
  const off = wrapped.onState(state => delivered.push(state))
  const shell = threadsStateFixture({ threads: [{ id: 'a', summary: { messageCount: 1, activityCount: 0, lastAssistant: { id: 'm', text: 'First', createdAt: 'today' } } }, { id: 'b' }], topLevel: { activeThreadId: 'a', notice: 'Initial' } })
  const send = (edit?: (payload: AgentStateBroadcast) => void): void => { broadcaster.send(shell, payload => { const wire = structuredClone(payload); edit?.(wire); raw(wire); return true }) }
  return { broadcaster, shell, send, raw: (state: AgentStateBroadcast) => raw(state), get: getFn, command, wrapped, delivered, off }
}

describe('page thread shell recovery', () => {
  it('reconstructs warm whole states and isolates raw cache, consumers and retained states', () => {
    const h = harness()
    h.send()
    h.delivered[0]!.host.threads[0]!.summary!.lastAssistant!.text = 'Consumer edit'
    h.send()
    expect(h.delivered[1]!.host.threads).toEqual(h.shell.host.threads)
    h.delivered[0]!.host.threads[1]!.title = 'Retained edit'
    expect(h.delivered[1]!.host.threads[1]!.title).not.toBe('Retained edit')
    h.shell.host.threads.reverse()
    h.shell.activeThreadId = 'b'
    h.shell.globalLaneBusy = true
    h.shell.notice = 'New facts'
    h.send()
    expect(h.delivered.at(-1)).toEqual(h.shell)
    expect(h.get).not.toHaveBeenCalled()
  })

  it.each(['base', 'body', 'revision', 'duplicate'])('recovers atomically from a missing %s and converges on a full broadcast', async missing => {
    const h = harness()
    h.send()
    h.shell.host.threads[0]!.title = 'Update'
    h.send(payload => {
      const e = payload.host.threads as AgentThreadsBroadcast
      if (missing === 'base') e.baseRevision = 900
      if (missing === 'body') e.changed = []
      if (missing === 'revision') e.changed[0]!.revision++
      if (missing === 'duplicate') e.roster.push(e.roster[0]!)
    })
    expect(h.delivered).toHaveLength(1)
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(h.delivered).toHaveLength(2))
    h.send()
    expect(h.delivered.at(-1)!.host.threads).toEqual(h.shell.host.threads)
  })

  it('does not let delayed unversioned get overwrite a newer complete or warm state', async () => {
    const pending = deferred<AgentState>()
    const h = harness(() => pending.promise)
    h.send(payload => { (payload.host.threads as AgentThreadsBroadcast).baseRevision = 999 })
    const old = structuredClone(h.shell)
    h.broadcaster.resetThreadDelivery()
    h.shell.notice = 'Newer full'
    h.send()
    h.shell.notice = 'Newer warm'
    h.send()
    pending.resolve(old)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(h.delivered.map(s => s.notice)).toEqual(['Newer full', 'Newer warm'])
  })

  it('bounds failed gets by incoming broadcasts and stops delivery after unsubscribe', async () => {
    const pending = deferred<AgentState>()
    const h = harness(() => pending.promise)
    h.send(payload => { (payload.host.threads as AgentThreadsBroadcast).baseRevision = 999 })
    h.off()
    pending.resolve(h.shell)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(h.delivered).toEqual([])
    expect(h.get).toHaveBeenCalledTimes(1)
    const fail = harness(async () => { throw new Error('offline') })
    fail.send(payload => { (payload.host.threads as AgentThreadsBroadcast).baseRevision = 999 })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(fail.get).toHaveBeenCalledTimes(1)
    fail.send()
    await vi.waitFor(() => expect(fail.get).toHaveBeenCalledTimes(2))
    expect(fail.delivered).toEqual([])
  })

  it('keeps command outcome and own draft facts while recovery is overtaken', async () => {
    const pending = deferred<AgentState>()
    const h = harness(() => pending.promise)
    h.send()
    h.send(payload => { (payload.host.threads as AgentThreadsBroadcast).baseRevision = 999 })
    const old = structuredClone(h.shell)
    const own = structuredClone(h.shell)
    own.notice = 'Own command outcome'
    own.threadDraftPersistence = [{ threadId: 'a', draftId: 'aaaaaaaa-0000-4000-8000-000000000000', status: 'saved' }]
    h.command.mockResolvedValue(h.broadcaster.encodeReceipt(own))
    const reply = h.wrapped.command({ type: 'select-thread', threadId: 'b' })
    await expect(reply).resolves.toMatchObject({ notice: 'Own command outcome', threadDraftPersistence: own.threadDraftPersistence })
    pending.resolve(old)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(h.delivered).toHaveLength(1)
    h.broadcaster.resetThreadDelivery()
    h.shell.notice = 'Newest'
    h.send()
    expect(h.delivered.at(-1)!.notice).toBe('Newest')
  })

  it('recovers thread and catalog misses independently without dropping other shell facts', async () => {
    const h = harness()
    h.send()
    h.shell.host.models = [...h.shell.host.models, { id: 'next', name: 'Next', provider: 'codex', ready: true }]
    h.send(payload => { payload.host.models = { revision: payload.host.models.revision, omitted: true } })
    await vi.waitFor(() => expect(h.delivered).toHaveLength(2))
    expect(h.get).toHaveBeenCalledTimes(1)
    h.send()
    h.shell.host.threads[0]!.finishedUnread = true
    h.shell.host.threads[0]!.requests.push({ id: 'approval', kind: 'permission', text: 'Run command?', options: [] })
    h.shell.activeThreadId = 'b'
    h.shell.globalLaneBusy = true
    h.send(payload => { (payload.host.threads as AgentThreadsBroadcast).changed = [] })
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(h.delivered.at(-1)!.globalLaneBusy).toBe(true))
    h.send()
    expect(h.delivered.at(-1)).toEqual(h.shell)
  })

  it('gives a newer unresolved broadcast one bounded attempt after an overtaken get', async () => {
    const first = deferred<AgentState>(), second = deferred<AgentState>()
    const h = harness(vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise))
    h.send(payload => { (payload.host.threads as AgentThreadsBroadcast).baseRevision = 999 })
    const old = structuredClone(h.shell)
    h.shell.notice = 'Newer missing base'
    h.send()
    first.resolve(old)
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2))
    expect(h.delivered).toEqual([])
    second.resolve(structuredClone(h.shell))
    await vi.waitFor(() => expect(h.delivered.at(-1)!.notice).toBe('Newer missing base'))
  })
})
