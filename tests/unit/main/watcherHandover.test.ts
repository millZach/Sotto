// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentHostSnapshot, AgentMessage, AgentThread, HandoverCounts } from '../../../src/shared/agents'
import type { WatcherIdentity, WatcherRequest } from '../../../src/shared/watcher'
import { HANDOVER_CLOSE, handoverPrefix, watcherHandoverProvenance, watcherHandoversShown, watcherMessageAsShown } from '../../../src/main/agents/watcherHandover'
import { watcherRequestLine, watcherRequestNote } from '../../../src/main/agents/watcherRequestNote'

/**
 * Watcher's handover as every copy shows it (ADR-0073, #1026): the first message's recorded characters come off as the
 * handover, checked against their digest, and an earlier conversation is handed over as its pane showed it.
 */
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const REQUEST = '2b8f3c1d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const at = '2026-10-15T12:00:00.000Z'
const source: WatcherIdentity = { target: { hostId: HOST, threadId: 'watcher-old' }, projectId: 'workshop', provider: 'codex', creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at }
const counts: HandoverCounts = { total: 2, carried: 2, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: true }
const prefix = handoverPrefix('This is a handover from another Sotto thread.\n\nThe user, 2026-10-15 11:00 UTC:\nWatch the footer.')

function request(patch: Partial<WatcherRequest> = {}): WatcherRequest {
  return { id: REQUEST, watcher: { hostId: HOST, threadId: 'watcher-new' }, rootUserMessageId: 'first', state: 'active', createdAt: at, closedAt: null, participants: [],
    handover: watcherHandoverProvenance(prefix, source, counts), ...patch }
}
function snapshot(messages: AgentMessage[], kind: AgentThread['kind'] | null = 'watcher'): AgentHostSnapshot {
  return { connected: true, name: 'Codex', version: 'test', capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
    models: [], projects: [], threads: [{ id: 'watcher-new', ...(kind === null ? {} : { kind }), title: 'Watcher', projectId: 'workshop', modelId: 'claude:sonnet', status: 'idle', requests: [], messages }] }
}

describe('a handover as every copy shows it', () => {
  it('shows the user’s words with the handover beside them, by the recorded length and digest', () => {
    const shown = watcherHandoversShown(snapshot([{ id: 'first', role: 'user', text: `${prefix}Carry on.`, createdAt: at }]), [request()])
    expect(shown.threads[0]!.messages[0]).toEqual({ id: 'first', role: 'user', text: 'Carry on.', createdAt: at,
      handover: { text: prefix.trimEnd(), provider: 'codex', counts } })
    expect(prefix.trimEnd().endsWith(HANDOVER_CLOSE)).toBe(true)
    expect(request().handover).toMatchObject({ prefixLength: prefix.length, prefixDigest: createHash('sha256').update(prefix).digest('hex') })
  })

  it('shows a message whole when its words no longer match the record, or it started no recorded request', () => {
    const changed = `x${prefix.slice(1)}Carry on.`
    expect(watcherHandoversShown(snapshot([{ id: 'first', role: 'user', text: changed, createdAt: at }]), [request()]).threads[0]!.messages[0]!.text).toBe(changed)
    const other = snapshot([{ id: 'second', role: 'user', text: `${prefix}Carry on.`, createdAt: at }])
    expect(watcherHandoversShown(other, [request()])).toBe(other)
    // Only Watcher's own conversations are read.
    const ordinary = snapshot([{ id: 'first', role: 'user', text: `${prefix}Carry on.`, createdAt: at }], null)
    expect(watcherHandoversShown(ordinary, [request()])).toBe(ordinary)
  })

  it('keeps showing it once the conversation is Watcher history', () => {
    const shown = watcherHandoversShown(snapshot([{ id: 'first', role: 'user', text: `${prefix}Carry on.`, createdAt: at }], 'watcher-history'), [request()])
    expect(shown.threads[0]!.messages[0]).toMatchObject({ text: 'Carry on.', handover: { provider: 'codex' } })
  })
})

describe('an earlier conversation, handed over as its pane showed it', () => {
  it('carries a reply without the reason line its own-change line shows', () => {
    const reply: AgentMessage = { id: 'reply', role: 'assistant', text: 'Fixed the footer.\nWatcher change reason: A typo is smaller than a brief.', createdAt: at,
      watcherOwnChange: { replyMessageId: 'reply', turnId: 'turn', files: ['README.md'], fileCount: 1, reason: 'A typo is smaller than a brief.', source: 'provider-file-change' } }
    expect(watcherMessageAsShown(HOST, 'watcher-new', reply, []).text).toBe('Fixed the footer.')
  })

  it('carries the user’s words alone: no handover it began with, and no line Sotto put after them', () => {
    const first: AgentMessage = { id: 'first', role: 'user', text: `${prefix}Carry on.`, createdAt: at }
    const carried = watcherMessageAsShown(HOST, 'watcher-new', first, [request()])
    expect(carried.text).toBe('Carry on.')
    expect(carried.handover).toBeUndefined()
    const grok: AgentMessage = { id: 'first', role: 'user', text: `Carry on.${watcherRequestLine(watcherRequestNote(REQUEST, HOST))}`, createdAt: at }
    expect(watcherMessageAsShown(HOST, 'watcher-new', grok, [request({ handover: undefined })]).text).toBe('Carry on.')
  })
})
