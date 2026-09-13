import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { ThreadDraftStore, submissionStatus } from '../../../src/renderer/src/agents/threadDraftStore'

type SaveCommand = Extract<AgentCommand, { type: 'save-thread-draft' }>

function baseState(patch: Partial<AgentState> = {}): AgentState {
  return {
    host: { connected: true, name: 'Test', version: '', capabilities: {} as AgentState['host']['capabilities'], models: [], projects: [], threads: [{ id: 'thread', projectId: 'project', title: 'Thread', modelId: 'model', status: 'idle', messages: [], requests: [] }] },
    draft: '', draftThreadId: null, draftRequestId: null, threadDrafts: [], deliveries: [], deliveredDrafts: [], error: null,
    ...patch,
  } as AgentState
}

function uuids(): () => string {
  let next = 0
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
}

/** A command whose save responses the test releases one at a time. */
function heldCommand() {
  const calls: { readonly command: AgentCommand; readonly resolve: (state: AgentState | null) => void; readonly reject: (error: unknown) => void }[] = []
  const command = vi.fn((request: AgentCommand) => new Promise<AgentState | null>((resolve, reject) => { calls.push({ command: request, resolve, reject }) }))
  return { command, calls, saves: () => calls.filter(call => call.command.type === 'save-thread-draft').map(call => call.command as SaveCommand) }
}

const published = (save: SaveCommand, patch: Partial<AgentState> = {}): AgentState => baseState({
  threadDrafts: [{ threadId: save.threadId, draftId: save.draftId, text: save.text, attachments: save.attachments ?? [], requestId: save.requestId ?? null, updatedAt: new Date().toISOString() }],
  ...patch,
})

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ThreadDraftStore revisions and saves', () => {
  it('gives every edit a fresh revision and saves only the latest after the debounce', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'H' })
    const first = store.draft('thread').draftId
    store.edit('thread', { text: 'He' })
    store.edit('thread', { text: 'Hey' })
    expect(store.draft('thread').draftId).not.toBe(first)
    expect(new Set([first, store.draft('thread').draftId]).size).toBe(2)
    expect(held.command).not.toHaveBeenCalled()
    expect(store.snapshot('thread').save).toBe('saving')
    vi.advanceTimersByTime(250)
    expect(held.saves()).toEqual([expect.objectContaining({ threadId: 'thread', text: 'Hey', draftId: store.draft('thread').draftId, requestId: null })])
  })

  it('never lets an older published draft overwrite newer typing', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'first' })
    vi.advanceTimersByTime(250)
    const firstSave = held.saves()[0]!
    store.edit('thread', { text: 'first and second' })
    // The first save's state arrives after the newer edit.
    store.receive(published(firstSave))
    held.calls[0]!.resolve(published(firstSave))
    expect(store.draft('thread').text).toBe('first and second')
    // Even an empty published state from before the edit leaves it alone.
    store.receive(baseState())
    expect(store.draft('thread').text).toBe('first and second')
  })

  it('reports a failed disk save even when state echoes the revision, and saves on explicit retry', async () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'Keep me' })
    vi.advanceTimersByTime(250)
    const save = held.saves()[0]!
    // The controller publishes the draft before persisting it, then reports the persistence error.
    store.receive(published(save))
    expect(store.snapshot('thread').save).toBe('saving')
    held.calls[0]!.resolve(published(save, { error: 'Could not save this thread draft.' }))
    await vi.runAllTimersAsync()
    expect(store.snapshot('thread')).toMatchObject({ save: 'unsaved', saveError: 'Could not save this thread draft.' })
    store.flush('thread', true)
    expect(held.saves()).toHaveLength(2)
    expect(held.saves()[1]!.draftId).toBe(save.draftId)
    held.calls[1]!.resolve(published(save))
    await vi.runAllTimersAsync()
    expect(store.snapshot('thread')).toMatchObject({ save: 'saved', saveError: null })
    expect(store.draft('thread').text).toBe('Keep me')
  })

  it('applies a failed IPC save only to its own revision', async () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'one' })
    vi.advanceTimersByTime(250)
    store.edit('thread', { text: 'one two' })
    held.calls[0]!.reject(new Error('IPC closed'))
    await vi.runAllTimersAsync()
    // The newer revision is being saved by its own debounce, not marked as failed.
    expect(store.snapshot('thread').saveError).toBeNull()
    expect(held.saves().at(-1)!.text).toBe('one two')
    held.calls.at(-1)!.resolve(null)
    await Promise.resolve(); await Promise.resolve()
    expect(store.snapshot('thread')).toMatchObject({ save: 'unsaved', saveError: 'Could not save this draft.' })
    expect(store.draft('thread').text).toBe('one two')
  })

  it('does not mark a newer revision saved when an older save succeeds', async () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'a' })
    vi.advanceTimersByTime(250)
    store.edit('thread', { text: 'ab' })
    held.calls[0]!.resolve(published(held.saves()[0]!))
    await Promise.resolve(); await Promise.resolve()
    expect(store.snapshot('thread').save).toBe('saving')
  })

  it('flushes a pending debounce immediately when the page leaves', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'unsaved when the window closes' })
    store.edit('other', { text: 'another thread' })
    store.flushAll()
    expect(held.saves().map(save => save.text).sort()).toEqual(['another thread', 'unsaved when the window closes'])
    vi.advanceTimersByTime(1_000)
    expect(held.saves()).toHaveLength(2)
  })

  it('restores published drafts per thread for a new window', () => {
    const store = new ThreadDraftStore(vi.fn(), 250, uuids())
    const draftId = '11111111-1111-4111-8111-111111111111'
    store.receive(baseState({ threadDrafts: [{ threadId: 'thread', draftId, text: 'after restart', attachments: [], requestId: null, updatedAt: new Date().toISOString() }] }))
    expect(store.snapshot('thread')).toMatchObject({ draft: { draftId, text: 'after restart' }, save: 'saved' })
    expect(store.draft('other').text).toBe('')
  })

  it('adopts a draft saved elsewhere once its own revision has been observed', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'mine' })
    vi.advanceTimersByTime(250)
    store.receive(published(held.saves()[0]!))
    store.receive(baseState({ threadDrafts: [{ threadId: 'thread', draftId: '22222222-2222-4222-8222-222222222222', text: 'recovered here', attachments: [], requestId: null, updatedAt: new Date().toISOString() }] }))
    expect(store.draft('thread').text).toBe('recovered here')
  })

  it('reads the legacy singleton draft when per-thread drafts are absent', () => {
    const store = new ThreadDraftStore(vi.fn(), 250, uuids())
    store.receive(baseState({ threadDrafts: undefined, draft: 'legacy text', draftThreadId: 'thread' }))
    const first = store.draft('thread')
    expect(first.text).toBe('legacy text')
    store.receive(baseState({ threadDrafts: undefined, draft: 'legacy text', draftThreadId: 'thread' }))
    expect(store.draft('thread').draftId).toBe(first.draftId)
  })
})

describe('ThreadDraftStore sending', () => {
  it('saves the exact revision before recording it as sent', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: '  Ship it  ' })
    const draft = store.submit('thread', 12)
    expect(draft?.draftId).toBe(held.saves()[0]!.draftId)
    expect(store.submissions()).toEqual([expect.objectContaining({ threadId: 'thread', draftId: draft!.draftId, text: 'Ship it', submittedAt: 12, resolved: false })])
    vi.advanceTimersByTime(500)
    expect(held.saves()).toHaveLength(1)
    expect(store.submit('empty', 1)).toBeNull()
  })

  it('clears the composer only for the accepted revision and keeps edits made while it was pending', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'first prompt' })
    const sent = store.submit('thread', 0)!
    store.receive(published(held.saves()[0]!, { deliveries: [{ threadId: 'thread', draftId: sent.draftId, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }))
    store.edit('thread', { text: 'written while sending' })
    store.receive(baseState({ deliveredDrafts: [{ threadId: 'thread', draftId: sent.draftId }], deliveries: [{ threadId: 'thread', draftId: sent.draftId, status: 'accepted', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }))
    expect(store.draft('thread').text).toBe('written while sending')

    const other = new ThreadDraftStore(heldCommand().command, 250, uuids())
    other.edit('thread', { text: 'only prompt' })
    const only = other.submit('thread', 0)!
    other.receive(baseState({ deliveredDrafts: [{ threadId: 'thread', draftId: only.draftId }] }))
    expect(other.draft('thread').text).toBe('')
  })

  it('derives pending message status from the delivery record, not from the command result', () => {
    const submission = { threadId: 'thread', draftId: '33333333-3333-4333-8333-333333333333', text: 'hi', attachments: [], submittedAt: 0, resolved: false, error: null }
    const at = new Date().toISOString()
    const delivery = (status: 'queued' | 'submitting' | 'failed' | 'uncertain' | 'accepted', messageId?: string) => [{ threadId: 'thread', draftId: submission.draftId, status, createdAt: at, updatedAt: at, ...(messageId ? { messageId } : {}) }]
    expect(submissionStatus(submission, baseState())).toEqual({ status: 'queued', visible: true })
    expect(submissionStatus({ ...submission, resolved: true }, baseState())).toEqual({ status: 'failed', visible: true })
    expect(submissionStatus({ ...submission, resolved: true }, baseState({ deliveries: delivery('uncertain') }))).toEqual({ status: 'uncertain', visible: true })
    expect(submissionStatus(submission, baseState({ deliveries: delivery('submitting') }))).toEqual({ status: 'submitting', visible: true })
    expect(submissionStatus(submission, baseState({ deliveries: delivery('accepted', 'message-1') }))).toEqual({ status: 'accepted', visible: true })
    const echoed = baseState({ deliveries: delivery('accepted', 'message-1') })
    echoed.host.threads[0]!.messages = [{ id: 'message-1', role: 'user', text: 'hi', createdAt: at }]
    expect(submissionStatus(submission, echoed)).toEqual({ status: 'accepted', visible: false })
  })
})
