import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentCommandSchema, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import { ThreadDraftStore, UNCONFIRMED_SUBMISSION, queueAdmissionOpen, submissionStatus } from '../../../src/renderer/src/agents/threadDraftStore'

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
  threadDraftPersistence: [{ threadId: save.threadId, draftId: save.draftId, status: 'saved' }],
  ...patch,
})

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ThreadDraftStore revisions and saves', () => {
  it.each(['receipt', 'delivery', 'queue'] as const)('retires a recovered alias on exact %s ownership without a renderer submission', evidence => {
    const store = new ThreadDraftStore(heldCommand().command, 250, uuids())
    store.edit('source', { text: 'A'.repeat(60_000) })
    store.submit('source', 1)
    store.edit('source', { text: 'B'.repeat(60_000) })
    store.carryRefusedCreation('source', 'project')
    store.restoreRefusedCreation('target', 'project')
    const [first, overflow] = store.submissions()
    const draft = store.draft('target')
    const at = new Date().toISOString()
    const receipt = { threadId: 'target', draftId: draft.draftId }
    // A voice send uses main's saved composer directly; failure or another revision proves no ownership.
    store.receive(baseState({ deliveries: [{ ...receipt, status: 'failed', createdAt: at, updatedAt: at }] }))
    store.receive(baseState({ deliveredDrafts: [{ ...receipt, draftId: 'another-revision' }] }))
    expect(store.submissions().map(item => item.draftId)).toEqual([first!.draftId, overflow!.draftId])
    store.receive(baseState(evidence === 'receipt' ? { deliveredDrafts: [receipt] }
      : evidence === 'queue' ? { followupReceipts: [receipt] }
      : { deliveries: [{ ...receipt, status: 'accepted', createdAt: at, updatedAt: at }] }))
    expect(store.submissions().map(item => item.draftId)).toEqual([overflow!.draftId])
    expect(store.retry('target', first!.draftId, 3)).toBeNull()
    store.restore('target', overflow!.draftId)
    expect(store.draft('target').text).toBe('B'.repeat(60_000))
  })

  it.each(['receipt', 'delivery', 'queue'] as const)('retires recovered content when its restored revision has %s ownership', evidence => {
    const store = new ThreadDraftStore(heldCommand().command, 250, uuids())
    const images = Array.from({ length: 8 }, (_, index) => ({ id: `shot-${index}`, name: `shot-${index}.png`, mimeType: 'image/png' as const, sizeBytes: 8, digest: 'e'.repeat(64) }))
    store.edit('source', { text: 'First prompt', attachments: images })
    store.submit('source', 1)
    store.edit('source', { text: 'Newer prompt', attachments: [{ ...images[0]!, id: 'newer' }] })
    store.carryRefusedCreation('source', 'project')
    store.restoreRefusedCreation('target', 'project')
    const [first, overflow] = store.submissions()
    const sent = store.submit('target', 2)!
    store.receive(baseState())
    expect(store.submissions().map(item => item.draftId)).toEqual([sent.draftId, overflow!.draftId])
    expect(store.retry('target', first!.draftId, 3)).toBeNull()
    store.resolve('target', sent.draftId, 'Nothing was sent.', true)
    expect(store.submissions().find(item => item.draftId === sent.draftId)).toMatchObject({ text: 'First prompt', notSent: true })
    const at = new Date().toISOString()
    const receipt = { threadId: 'target', draftId: sent.draftId }
    store.receive(baseState(evidence === 'receipt' ? { deliveredDrafts: [receipt] }
      : evidence === 'queue' ? { followupReceipts: [receipt] }
      : { deliveries: [{ ...receipt, status: 'accepted', createdAt: at, updatedAt: at }] }))
    expect(store.submissions()).toHaveLength(1)
    expect(store.submissions()[0]).toMatchObject({ draftId: overflow!.draftId, text: 'Newer prompt', notSent: true })
    expect(store.retry('target', first!.draftId, 4)).toBeNull()
    store.restore('target', overflow!.draftId)
    expect(store.draft('target')).toMatchObject({ text: 'Newer prompt', attachments: [{ ...images[0]!, id: 'newer' }] })
  })

  it.each(['count', 'bytes', 'text'] as const)('retains separate, valid recovery revisions when their combined %s exceeds a limit', reason => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    const images = (count: number, prefix: string, sizeBytes = 8) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`, name: `${prefix}-${index}.png`, mimeType: 'image/png' as const, sizeBytes, digest: 'e'.repeat(64) }))
    const first = { text: reason === 'text' ? 'A'.repeat(60_000) : 'First prompt', attachments: reason === 'count' ? images(8, 'first') : reason === 'bytes' ? images(2, 'first', 6 * 1024 * 1024) : [] }
    const second = { text: reason === 'text' ? 'B'.repeat(60_000) : 'Newer prompt', attachments: reason === 'count' ? images(1, 'second') : reason === 'bytes' ? images(2, 'second', 6 * 1024 * 1024) : [] }
    store.edit('source', first)
    store.submit('source', 1)
    store.edit('source', second)
    store.carryRefusedCreation('source', 'project')
    store.restoreRefusedCreation('target', 'project')
    expect(store.draft('target')).toMatchObject(first)
    const retained = store.submissions().filter(item => item.threadId === 'target')
    expect(retained.every(item => item.error === 'This prompt was kept after a new thread was refused. Use Restore prompt to bring it back. Nothing was sent.')).toBe(true)
    expect(retained).toHaveLength(2)
    expect(retained[0]).toMatchObject(first)
    expect(retained[1]).toMatchObject(second)
    expect(retained.every(item => item.notSent)).toBe(true)
    expect(retained.every(item => agentCommandSchema.safeParse({ type: 'manual-send', threadId: 'target', text: item.text, attachments: item.attachments, skills: item.skills, files: item.files, draftId: item.draftId }).success)).toBe(true)
    store.flush('target')
    expect(held.saves().filter(save => save.threadId === 'target').every(save => agentCommandSchema.safeParse(save).success)).toBe(true)
    // State reception and another send must not silently discard or automatically restore overflow.
    store.receive(baseState())
    store.submit('target', 2)
    store.receive(baseState())
    expect(store.draft('target').text).toBe('')
    expect(store.submissions().filter(item => item.threadId === 'target')).toHaveLength(2)
    store.restore('target', retained[1]!.draftId)
    expect(store.draft('target')).toMatchObject(second)
    store.restore('target', store.submissions().find(item => item.threadId === 'target' && item.text === first.text)!.draftId)
    expect(store.draft('target')).toMatchObject(first)
  })

  it('retains a late staged screenshot separately when recovered screenshots fill the composer', () => {
    const store = new ThreadDraftStore(heldCommand().command, 250, uuids())
    const images = Array.from({ length: 8 }, (_, index) => ({ id: `shot-${index}`, name: `shot-${index}.png`, mimeType: 'image/png' as const, sizeBytes: 8, digest: 'e'.repeat(64) }))
    store.edit('source', { text: 'First prompt', attachments: images })
    store.submit('source', 1)
    const endRead = store.beginScreenshotRead('source')
    store.carryRefusedCreation('source', 'project')
    store.restoreRefusedCreation('target', 'project')
    const late = { ...images[0]!, id: 'late', name: 'late.png' }
    store.addLateScreenshots('source', [late], { imagesSupported: true })
    endRead()
    expect(store.draft('target').attachments).toEqual(images)
    const retained = store.submissions().filter(item => item.threadId === 'target')
    expect(retained).toHaveLength(2)
    expect(retained[1]!.attachments).toEqual([late])
    store.restore('target', retained[1]!.draftId)
    expect(store.draft('target').attachments).toEqual([late])
    expect(store.screenshotReads('target').pending).toBe(0)
  })

  it.each([1, 2])('updates retained recovery content when %s late images partly fit the restored draft', count => {
    const store = new ThreadDraftStore(heldCommand().command, 250, uuids())
    const images = Array.from({ length: 7 }, (_, index) => ({ id: `shot-${index}`, name: `shot-${index}.png`, mimeType: 'image/png' as const, sizeBytes: 8, digest: 'e'.repeat(64) }))
    store.edit('source', { text: 'A'.repeat(60_000), attachments: images })
    store.submit('source', 1)
    store.edit('source', { text: 'B'.repeat(60_000) })
    store.carryRefusedCreation('source', 'project')
    store.restoreRefusedCreation('target', 'project')
    const late = Array.from({ length: count }, (_, index) => ({ ...images[0]!, id: `late-${index}`, name: `late-${index}.png` }))
    store.addLateScreenshots('source', late, { imagesSupported: true })
    const retained = store.submissions().filter(item => item.threadId === 'target')
    expect(retained).toHaveLength(count === 1 ? 2 : 3)
    expect(retained[0]!.attachments).toEqual([...images, late[0]!])
    if (count === 2) expect(retained[2]!.attachments).toEqual([late[1]!])
    store.restore('target', retained[1]!.draftId)
    store.restore('target', retained[0]!.draftId)
    expect(store.draft('target').attachments).toEqual([...images, late[0]!])
  })

  it('recovers a second refused creation without duplicating its restored and submitted revision', () => {
    const store = new ThreadDraftStore(heldCommand().command, 250, uuids())
    const images = Array.from({ length: 8 }, (_, index) => ({ id: `shot-${index}`, name: `shot-${index}.png`, mimeType: 'image/png' as const, sizeBytes: 8, digest: 'e'.repeat(64) }))
    store.edit('source', { text: 'First prompt', attachments: images })
    store.submit('source', 1)
    store.edit('source', { text: 'Newer prompt', attachments: [{ ...images[0]!, id: 'newer' }] })
    store.carryRefusedCreation('source', 'project')
    store.restoreRefusedCreation('intermediate', 'project')
    store.submit('intermediate', 2)
    store.carryRefusedCreation('intermediate', 'project')
    store.restoreRefusedCreation('target', 'project')
    expect(store.draft('target').text).toBe('First prompt')
    expect(store.submissions().filter(item => item.threadId === 'target').map(item => item.text)).toEqual(['First prompt', 'Newer prompt'])
  })

  it('recovers an unconfirmed creation into itself without duplicating content or redirecting its reads', () => {
    const store = new ThreadDraftStore(heldCommand().command, 250, uuids())
    const image = { id: 'shot', name: 'Screenshot.png', mimeType: 'image/png' as const, sizeBytes: 8, digest: 'e'.repeat(64) }
    store.edit('thread', { text: 'Keep this prompt.', attachments: [image] })
    const endRead = store.beginScreenshotRead('thread')
    store.carryRefusedCreation('thread', 'project')
    store.restoreRefusedCreation('thread', 'project')
    expect(store.draft('thread')).toMatchObject({ text: 'Keep this prompt.', attachments: [image] })
    expect(store.screenshotReads('thread').pending).toBe(1)
    endRead()
    expect(store.screenshotReads('thread').pending).toBe(0)
  })

  it('saves a text edit beside an 8 MiB screenshot with the handle alone, no image bytes (ADR-0031)', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    const screenshot = { id: 'shot', name: 'Screenshot.png', mimeType: 'image/png' as const, sizeBytes: 8 * 1024 * 1024, digest: 'e'.repeat(64) }
    store.edit('thread', { text: 'Look', attachments: [screenshot] })
    store.edit('thread', { text: 'Look at this' })
    vi.advanceTimersByTime(250)
    const [save] = held.saves()
    expect(save).toMatchObject({ text: 'Look at this', attachments: [screenshot] })
    // What crosses IPC is the command as it stands: a few hundred bytes, whatever the image weighs.
    expect(JSON.stringify(save).length).toBeLessThan(1024)
  })
  it('allows reload only after the latest revisions have durability evidence', async () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'first' })
    const reloading = store.flushForReload()
    store.edit('thread', { text: 'latest' })
    held.calls[0]!.resolve(published(held.saves()[0]!))
    await vi.waitFor(() => expect(held.saves()).toHaveLength(2))
    held.calls[1]!.resolve(published(held.saves()[1]!))
    expect(await reloading).toBe(true)
    expect(store.draft('thread').text).toBe('latest')
  })

  it('blocks reload when a draft save fails and permits a successful retry', async () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'keep this' })
    const failed = store.flushForReload()
    held.calls[0]!.resolve(null)
    expect(await failed).toBe(false)
    expect(store.draft('thread').text).toBe('keep this')
    const retry = store.flushForReload()
    held.calls[1]!.resolve(published(held.saves()[1]!))
    expect(await retry).toBe(true)
  })

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
    store.receive(published(save, { threadDraftPersistence: [{ threadId: save.threadId, draftId: save.draftId, status: 'saving' }] }))
    expect(store.snapshot('thread').save).toBe('saving')
    held.calls[0]!.resolve(published(save, { error: 'Could not save this thread draft.', threadDraftPersistence: [{ threadId: save.threadId, draftId: save.draftId, status: 'unsaved' }] }))
    await vi.runAllTimersAsync()
    expect(store.snapshot('thread')).toMatchObject({ save: 'unsaved', saveError: expect.stringContaining('Save again') })
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
    expect(store.snapshot('thread')).toMatchObject({ save: 'unsaved', saveError: expect.stringContaining('Save again') })
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

  it('requires explicit evidence even when a returned or adopted state has no global error', async () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'Unconfirmed' }); store.flush('thread')
    const state = published(held.saves()[0]!, { threadDraftPersistence: undefined })
    held.calls[0]!.resolve(state)
    await Promise.resolve(); await Promise.resolve()
    expect(store.snapshot('thread').save).toBe('unsaved')
    const fresh = new ThreadDraftStore(held.command)
    fresh.receive(state)
    expect(fresh.snapshot('thread').save).toBe('unsaved')
    fresh.flush('thread', true)
    expect(held.saves()).toHaveLength(2)
  })

  it('keeps exact published confirmation when an older failed IPC reply arrives later', async () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'Persisted by another write' }); store.flush('thread')
    const save = held.saves()[0]!
    store.receive(published(save, { error: 'Unrelated error still present' }))
    expect(store.snapshot('thread').save).toBe('saved')
    held.calls[0]!.resolve(published(save, { threadDraftPersistence: [{ threadId: save.threadId, draftId: save.draftId, status: 'unsaved' }] }))
    await Promise.resolve(); await Promise.resolve()
    expect(store.snapshot('thread')).toMatchObject({ save: 'saved', saveError: null })
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
    store.receive(baseState({ threadDrafts: [{ threadId: 'thread', draftId, text: 'after restart', attachments: [], requestId: null, updatedAt: new Date().toISOString() }], threadDraftPersistence: [{ threadId: 'thread', draftId, status: 'saved' }] }))
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
  it('saves nothing around a send main saves itself, and records the emptied composer once the send resolves', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: '  Ship it  ' })
    const draft = store.submit('thread', 12, 'send', 'main')
    expect(store.submissions()).toEqual([expect.objectContaining({ threadId: 'thread', draftId: draft!.draftId, text: 'Ship it', submittedAt: 12, resolved: false })])
    // The press empties the composer under a revision of its own.
    expect(store.draft('thread')).toMatchObject({ text: '', attachments: [] })
    expect(store.draft('thread').draftId).not.toBe(draft!.draftId)
    // The manual-send carries the revision and main saves it as it admits it: no save of the sent revision
    // goes first, and none of the empty one lands while the send is on its way.
    vi.advanceTimersByTime(5_000)
    expect(held.saves()).toEqual([])
    store.resolve('thread', draft!.draftId, null)
    vi.advanceTimersByTime(250)
    expect(held.saves()).toEqual([expect.objectContaining({ draftId: store.draft('thread').draftId, text: '', attachments: [] })])
    expect(store.submit('empty', 1)).toBeNull()
  })

  it('waits for every send of the thread before recording its emptied composer', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'first' })
    const first = store.submit('thread', 1, 'send', 'main')!
    store.edit('thread', { text: 'second' })
    vi.advanceTimersByTime(100)
    const second = store.submit('thread', 2, 'queue', 'main')!
    store.resolve('thread', first.draftId, null)
    vi.advanceTimersByTime(1_000)
    // The typing between the two was dropped with its debounce: the queue command carries it.
    expect(held.saves()).toEqual([])
    store.resolve('thread', second.draftId, null)
    vi.advanceTimersByTime(250)
    expect(held.saves()).toEqual([expect.objectContaining({ text: '' })])
  })

  it('records the emptied composer when a save of the sent revision was still running at the press', async () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'Ship it' })
    vi.advanceTimersByTime(250)
    // The debounced save of the revision about to be sent is still on its way when Enter is pressed.
    expect(held.saves()).toEqual([expect.objectContaining({ text: 'Ship it' })])
    const sent = store.submit('thread', 1, 'send', 'main')!
    held.calls[0]!.resolve(published(held.saves()[0]!))
    await vi.advanceTimersByTimeAsync(0)
    store.resolve('thread', sent.draftId, null)
    vi.advanceTimersByTime(250)
    expect(held.saves()).toEqual([expect.objectContaining({ text: 'Ship it' }), expect.objectContaining({ draftId: store.draft('thread').draftId, text: '' })])
  })

  it('records the emptied composer when the queue owned a queued prompt before its reply came back', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'Queue me' })
    const queued = store.submit('thread', 1, 'queue', 'main')!
    // Main publishes while it saves the queue: the queue owning the revision retires the submission here.
    store.receive(baseState({ followups: [{ threadId: 'thread', draftId: queued.draftId }] as AgentState['followups'] }))
    expect(store.submissions()).toEqual([])
    store.resolve('thread', queued.draftId, null)
    vi.advanceTimersByTime(250)
    // Without it, main would keep whatever older revision of the prompt the debounce last saved.
    expect(held.saves()).toEqual([expect.objectContaining({ draftId: store.draft('thread').draftId, text: '' })])
  })

  it('saves nothing in front of a retried send, and records the emptied composer once it resolves', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'Refuse me' })
    const sent = store.submit('thread', 0, 'send', 'main')!
    store.resolve('thread', sent.draftId, 'The provider rejected this action.')
    store.receive(baseState({ deliveries: [{ threadId: 'thread', draftId: sent.draftId, status: 'failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }))
    expect(store.draft('thread').text).toBe('Refuse me')
    vi.advanceTimersByTime(250)
    const before = held.saves().length
    store.retry('thread', sent.draftId, 5)
    vi.advanceTimersByTime(5_000)
    expect(held.saves()).toHaveLength(before)
    store.resolve('thread', sent.draftId, null)
    vi.advanceTimersByTime(250)
    expect(held.saves().slice(before)).toEqual([expect.objectContaining({ draftId: store.draft('thread').draftId, text: '' })])
  })

  it('saves an answer before it goes, as main keeps no draft for one', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'Yes', requestId: 'question' })
    const answer = store.submit('thread', 3, 'send', 'window')!
    expect(held.saves()).toEqual([expect.objectContaining({ draftId: answer.draftId, text: 'Yes', requestId: 'question' })])
    vi.advanceTimersByTime(250)
    expect(held.saves()).toHaveLength(2)
    expect(held.saves()[1]).toMatchObject({ draftId: store.draft('thread').draftId, text: '' })
  })

  it('empties the composer on the press and leaves later typing alone when the send is accepted', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'first prompt' })
    const sent = store.submit('thread', 0)!
    expect(store.draft('thread').text).toBe('')
    // The state that still carries the sent revision cannot put it back: the empty revision is newer.
    const admitted: SaveCommand = { type: 'save-thread-draft', threadId: 'thread', draftId: sent.draftId, text: sent.text, requestId: null }
    store.receive(published(admitted, { deliveries: [{ threadId: 'thread', draftId: sent.draftId, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }))
    expect(store.draft('thread').text).toBe('')
    store.edit('thread', { text: 'written while sending' })
    store.receive(baseState({ deliveredDrafts: [{ threadId: 'thread', draftId: sent.draftId }], deliveries: [{ threadId: 'thread', draftId: sent.draftId, status: 'accepted', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }))
    expect(store.draft('thread').text).toBe('written while sending')
  })

  it('brings a refused prompt back to an empty composer, and offers it back when newer text is in the way', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    const refused = (draftId: string): AgentState => baseState({ deliveries: [{ threadId: 'thread', draftId, status: 'failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] })
    store.edit('thread', { text: 'Refuse me' })
    const sent = store.submit('thread', 0)!
    store.resolve('thread', sent.draftId, 'The provider rejected this action.')
    // An error in the reply is not the evidence; the delivery record is what says nothing was sent.
    expect(store.draft('thread').text).toBe('')
    store.receive(refused(sent.draftId))
    expect(store.draft('thread').text).toBe('Refuse me')
    expect(store.draft('thread').draftId).toBe(store.submissions()[0]!.restoredAs)
    // Sending it again is the same revision, and the composer holding it back empties again.
    const again = store.retry('thread', sent.draftId, 5)!
    expect(again).toMatchObject({ draftId: sent.draftId, text: 'Refuse me', submittedAt: 5, resolved: false, error: null })
    expect(store.draft('thread').text).toBe('')

    const busy = new ThreadDraftStore(heldCommand().command, 250, uuids())
    busy.edit('thread', { text: 'Refuse me too' })
    const rejected = busy.submit('thread', 0)!
    busy.edit('thread', { text: 'A newer thought' })
    busy.resolve('thread', rejected.draftId, 'The provider rejected this action.')
    busy.receive(refused(rejected.draftId))
    expect(busy.draft('thread').text).toBe('A newer thought')
    expect(busy.submissions()[0]!.restoredAs).toBeUndefined()
    busy.restore('thread', rejected.draftId)
    expect(busy.draft('thread').text).toBe('Refuse me too')
  })

  it('leaves an unanswered send in its pending message rather than writing it back over the composer', () => {
    const store = new ThreadDraftStore(heldCommand().command, 250, uuids())
    store.edit('thread', { text: 'May have gone' })
    const sent = store.submit('thread', 0)!
    store.resolve('thread', sent.draftId, UNCONFIRMED_SUBMISSION.send)
    expect(store.draft('thread').text).toBe('')
    expect(store.submissions()[0]).toMatchObject({ resolved: true, text: 'May have gone' })
    expect(store.submissions()[0]!.restoredAs).toBeUndefined()
  })

  it('leaves an unanswered queue admission in its row rather than writing it back over the composer', () => {
    const store = new ThreadDraftStore(heldCommand().command, 250, uuids())
    store.edit('thread', { text: 'May be queued' })
    const queued = store.submit('thread', 0, 'queue')!
    store.resolve('thread', queued.draftId, UNCONFIRMED_SUBMISSION.queue)
    expect(submissionStatus(store.submissions()[0]!, baseState())).toEqual({ status: 'uncertain', visible: true })
    // The next published state re-derives every status; an unconfirmed admission is still not a refusal.
    store.receive(baseState())
    expect(store.draft('thread').text).toBe('')
    expect(store.submissions()[0]).toMatchObject({ resolved: true, text: 'May be queued' })
    expect(store.submissions()[0]!.restoredAs).toBeUndefined()
    // A refusal main did answer is what brings the prompt back.
    store.resolve('thread', queued.draftId, 'The queue is closed.')
    expect(store.draft('thread').text).toBe('May be queued')
  })

  it('derives pending message status from the delivery record, not from the command result', () => {
    const submission = { threadId: 'thread', draftId: '33333333-3333-4333-8333-333333333333', text: 'hi', attachments: [], skills: [], mode: 'send' as const, submittedAt: 0, startedAt: new Date().toISOString(), resolved: false, error: null }
    const at = new Date().toISOString()
    const delivery = (status: 'queued' | 'submitting' | 'failed' | 'uncertain' | 'accepted', messageId?: string) => [{ threadId: 'thread', draftId: submission.draftId, status, createdAt: at, updatedAt: at, ...(messageId ? { messageId } : {}) }]
    expect(submissionStatus(submission, baseState())).toEqual({ status: 'queued', visible: true })
    expect(submissionStatus({ ...submission, resolved: true }, baseState())).toEqual({ status: 'uncertain', visible: true })
    expect(submissionStatus({ ...submission, resolved: true, error: 'Sotto could not confirm this send.' }, baseState())).toEqual({ status: 'uncertain', visible: true })
    expect(submissionStatus({ ...submission, resolved: true, notSent: true }, baseState())).toEqual({ status: 'failed', visible: true })
    expect(submissionStatus(submission, baseState({ deliveries: delivery('failed') }))).toEqual({ status: 'failed', visible: true })
    expect(submissionStatus({ ...submission, resolved: true }, baseState({ deliveries: delivery('uncertain') }))).toEqual({ status: 'uncertain', visible: true })
    expect(submissionStatus(submission, baseState({ deliveries: delivery('submitting') }))).toEqual({ status: 'submitting', visible: true })
    expect(submissionStatus(submission, baseState({ deliveries: delivery('accepted', 'message-1') }))).toEqual({ status: 'accepted', visible: true })
    const echoed = baseState({ deliveries: delivery('accepted', 'message-1') })
    echoed.host.threads[0]!.messages = [{ id: 'message-1', role: 'user', text: 'hi', createdAt: at }]
    expect(submissionStatus(submission, echoed)).toEqual({ status: 'accepted', visible: false })
  })
})

describe('ThreadDraftStore skills and follow-up queue ownership', () => {
  const deploy = { name: 'deploy', path: 'C:/skills/deploy/SKILL.md' }

  it('saves selected skills with the revision and adopts them back from published state', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'Run $deploy', skills: [deploy] })
    vi.advanceTimersByTime(250)
    const save = held.saves()[0]!
    expect(save).toMatchObject({ text: 'Run $deploy', skills: [deploy] })
    const restarted = new ThreadDraftStore(held.command, 250, uuids())
    restarted.receive(baseState({ threadDrafts: [{ threadId: 'thread', draftId: save.draftId, text: save.text, attachments: [], skills: [deploy], requestId: null, updatedAt: new Date().toISOString() }] }))
    expect(restarted.draft('thread')).toMatchObject({ draftId: save.draftId, skills: [deploy] })
  })

  it('clears only the exact revision the queue owns, which is not a delivery', () => {
    const held = heldCommand()
    const store = new ThreadDraftStore(held.command, 250, uuids())
    store.edit('thread', { text: 'Queue me' })
    const queued = store.submit('thread', 1, 'queue')!
    // The transcript echoes it from the press, and the composer is already empty behind it.
    expect(submissionStatus(store.submissions()[0]!, baseState())).toEqual({ status: 'queued', visible: true })
    expect(store.draft('thread').text).toBe('')
    expect(queueAdmissionOpen(store.submissions()[0]!, baseState())).toBe(true)
    store.receive(baseState())
    expect(store.submissions()).toHaveLength(1)

    store.edit('thread', { text: 'Newer typing' })
    const receipt = baseState({ followupReceipts: [{ threadId: 'thread', draftId: queued.draftId }] })
    store.receive(receipt)
    expect(store.draft('thread').text).toBe('Newer typing')
    expect(store.submissions()).toHaveLength(0)
    // A manual send that main queued instead is not a delivery the transcript waits on.
    expect(submissionStatus({ threadId: 'thread', draftId: queued.draftId, mode: 'send', text: 'Queue me', attachments: [], skills: [], submittedAt: 1, startedAt: new Date().toISOString(), resolved: true, error: null }, receipt).visible).toBe(false)
    expect(receipt.deliveredDrafts).toEqual([])

    const exact = new ThreadDraftStore(held.command, 250, uuids())
    exact.edit('thread', { text: 'Queue me exactly' })
    const owned = exact.submit('thread', 1, 'queue')!
    const at = new Date().toISOString()
    exact.receive(baseState({ followups: [{ id: '00000000-0000-4000-8000-00000000abcd', threadId: 'thread', draftId: owned.draftId, text: owned.text, attachments: [], createdAt: at, updatedAt: at, status: 'queued' }] }))
    expect(exact.draft('thread').text).toBe('')
    expect(exact.submissions()).toHaveLength(0)
  })

  it('reports a rejected queue admission as failed and puts the prompt back in the composer', () => {
    const store = new ThreadDraftStore(heldCommand().command, 250, uuids())
    store.edit('thread', { text: 'Queue me' })
    const draft = store.submit('thread', 1, 'queue')!
    expect(store.draft('thread').text).toBe('')
    store.resolve('thread', draft.draftId, 'Could not save this follow-up.')
    expect(submissionStatus(store.submissions()[0]!, baseState())).toEqual({ status: 'failed', visible: true })
    store.receive(baseState())
    expect(store.submissions()).toHaveLength(1)
    expect(store.draft('thread').text).toBe('Queue me')
    expect(store.draft('thread').draftId).toBe(store.submissions()[0]!.restoredAs)
  })
})

describe('screenshots read for a draft', () => {
  const image = (id: string, bytes = 3) => ({ id, name: `${id}.png`, mimeType: 'image/png' as const, sizeBytes: bytes, digest: 'a'.repeat(64) })
  it('counts reads until each one says its screenshots were handed on, once', () => {
    const store = new ThreadDraftStore(vi.fn(async () => null))
    const first = store.beginScreenshotRead('thread')
    const second = store.beginScreenshotRead('thread')
    expect(store.screenshotReads('thread').pending).toBe(2)
    expect(store.screenshotReads('other').pending).toBe(0)
    first(); first()
    expect(store.screenshotReads('thread').pending).toBe(1)
    second()
    expect(store.screenshotReads('thread')).toEqual({ pending: 0, problem: null })
  })
  it('adds late screenshots that fit to the draft as it is now, and names the ones that do not', () => {
    const store = new ThreadDraftStore(vi.fn(async () => null))
    store.edit('thread', { text: 'Typed meanwhile', attachments: Array.from({ length: 7 }, (_, index) => image(`kept-${index}`)) })
    store.addLateScreenshots('thread', [image('late-a'), image('late-b'), image('late-c')], { imagesSupported: true })
    expect(store.draft('thread').text).toBe('Typed meanwhile')
    expect(store.draft('thread').attachments.map(item => item.id)).toEqual([...Array.from({ length: 7 }, (_, index) => `kept-${index}`), 'late-a'])
    expect(store.screenshotReads('thread').problem).toBe('2 screenshots added before you moved to another thread did not fit in this draft and were not added. Remove an attachment and add them again.')
    // The next read starts clean.
    store.beginScreenshotRead('thread')()
    expect(store.screenshotReads('thread').problem).toBeNull()
  })
  it('says so when the one late screenshot does not fit', () => {
    const store = new ThreadDraftStore(vi.fn(async () => null))
    store.edit('thread', { attachments: Array.from({ length: 8 }, (_, index) => image(`kept-${index}`)) })
    const before = store.draft('thread')
    store.addLateScreenshots('thread', [image('late')], { imagesSupported: true })
    expect(store.draft('thread')).toBe(before)
    expect(store.screenshotReads('thread').problem).toBe('A screenshot added before you moved to another thread did not fit in this draft and was not added. Remove an attachment and add it again.')
  })
  it('adds no late screenshot to a draft that now answers a question, or on a model that does not read them', () => {
    const store = new ThreadDraftStore(vi.fn(async () => null))
    store.edit('thread', { text: 'My answer', requestId: 'question' })
    const answering = store.draft('thread')
    store.addLateScreenshots('thread', [image('late')], { imagesSupported: true })
    expect(store.draft('thread')).toBe(answering)
    expect(store.screenshotReads('thread').problem).toBe('A screenshot added before you moved to another thread was not added, because this draft now answers a question.')
    store.edit('other', { text: 'Plain' })
    const plain = store.draft('other')
    store.addLateScreenshots('other', [image('late-a'), image('late-b')], { imagesSupported: false })
    expect(store.draft('other')).toBe(plain)
    expect(store.screenshotReads('other').problem).toBe("2 screenshots added before you moved to another thread were not added, because this thread's model does not read screenshots.")
  })
  it('adds the screenshots read before one that failed, and names the failure', () => {
    const store = new ThreadDraftStore(vi.fn(async () => null))
    store.addLateScreenshots('thread', [image('first')], { imagesSupported: true, failure: 'Could not add second.png, so it was not attached. Try adding it again.' })
    expect(store.draft('thread').attachments.map(item => item.id)).toEqual(['first'])
    expect(store.screenshotReads('thread').problem).toBe('Could not add second.png, so it was not attached. Try adding it again.')
  })
  it('clears the screenshot problem when the draft next changes or is sent', () => {
    const store = new ThreadDraftStore(vi.fn(async () => null))
    store.edit('thread', { attachments: Array.from({ length: 8 }, (_, index) => image(`kept-${index}`)) })
    store.addLateScreenshots('thread', [image('late')], { imagesSupported: true })
    expect(store.screenshotReads('thread').problem).not.toBeNull()
    store.edit('thread', { text: 'Seen it' })
    expect(store.screenshotReads('thread')).toEqual({ pending: 0, problem: null })
    store.addLateScreenshots('thread', [image('late')], { imagesSupported: true })
    expect(store.screenshotReads('thread').problem).not.toBeNull()
    store.submit('thread', 1)
    expect(store.screenshotReads('thread').problem).toBeNull()
  })
})

describe('ThreadDraftStore.place', () => {
  it.each(['before', 'after'] as const)('keeps the placed draft when the creation snapshot commits %s the save reply', async order => {
    const { command, calls, saves } = heldCommand()
    const store = new ThreadDraftStore(command, 250, uuids())
    const text = 'The leftover prompt.'
    // Creation published this shell before the save, but React can still be rendering it
    // when the save promise settles. Only the later shell shows the placed revision.
    const creation = baseState({ activeThreadId: 'thread' })
    const placed = store.place('thread', { text, attachments: [] })
    const revision = store.draft('thread').draftId
    const saved = published(saves().at(-1)!, { activeThreadId: 'thread' })
    if (order === 'before') store.receive(creation)
    calls.at(-1)!.resolve(saved)
    await expect(placed).resolves.toBe('saved')
    expect(store.snapshot('thread').save).toBe('saved')
    if (order === 'after') store.receive(creation)
    expect(store.draft('thread')).toMatchObject({ draftId: revision, text })
    store.receive(saved)
    expect(store.draft('thread')).toMatchObject({ draftId: revision, text })
    // Once the snapshot stream has shown this revision, a later external clear wins.
    store.receive(baseState({ activeThreadId: 'thread' }))
    expect(store.draft('thread').text).toBe('')
  })

  const leftover = (text: string, attachments: AgentState['draftAttachments'] = []) => ({ text, attachments: attachments ?? [] })

  it('puts a leftover draft after what the composer holds and resolves saved only once main saved it', async () => {
    const { command, calls, saves } = heldCommand()
    const store = new ThreadDraftStore(command, 250, uuids())
    store.edit('thread', { text: 'Already typed.' })
    const placed = store.place('thread', leftover('The leftover prompt.'))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.draft('thread').text).toBe('Already typed.\n\nThe leftover prompt.')
    const save = saves().at(-1)!
    expect(save.text).toBe('Already typed.\n\nThe leftover prompt.')
    calls.at(-1)!.resolve(published(save))
    await expect(placed).resolves.toBe('saved')
  })

  it('resolves unsaved and keeps the composer’s copy when the save is not confirmed', async () => {
    const { command, calls } = heldCommand()
    const store = new ThreadDraftStore(command, 250, uuids())
    const placed = store.place('thread', leftover('The leftover prompt.'))
    await vi.advanceTimersByTimeAsync(0)
    calls.at(-1)!.resolve(null)
    await expect(placed).resolves.toBe('unsaved')
    expect(store.draft('thread').text).toBe('The leftover prompt.')
  })

  it('adds nothing twice when the same draft is placed again, and still reports the save', async () => {
    const { command, calls, saves } = heldCommand()
    const store = new ThreadDraftStore(command, 250, uuids())
    const shot = { id: 'shot', name: 'footer.png', mimeType: 'image/png' as const, sizeBytes: 8, digest: 'e'.repeat(64) }
    const first = store.place('thread', leftover('The leftover prompt.', [shot]))
    await vi.advanceTimersByTimeAsync(0)
    calls.at(-1)!.resolve(null)
    await expect(first).resolves.toBe('unsaved')
    // A retry after the refused save, a refused creation brought back or the same unused thread reused.
    const again = store.place('thread', leftover('The leftover prompt.', [shot]))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.draft('thread')).toMatchObject({ text: 'The leftover prompt.', attachments: [shot] })
    calls.at(-1)!.resolve(published(saves().at(-1)!))
    await expect(again).resolves.toBe('saved')
    const saveCount = saves().length
    await expect(store.place('thread', leftover('The leftover prompt.', [shot]))).resolves.toBe('saved')
    expect(saves()).toHaveLength(saveCount)
    expect(store.draft('thread').text).toBe('The leftover prompt.')
  })

  it('saves typing that lands while the placed draft is saving, in the same call', async () => {
    const { command, calls, saves } = heldCommand()
    const store = new ThreadDraftStore(command, 250, uuids())
    const placed = store.place('thread', leftover('The leftover prompt.'))
    await vi.advanceTimersByTimeAsync(0)
    const first = saves().at(-1)!
    store.edit('thread', { text: 'The leftover prompt. And one more line.' })
    calls.at(-1)!.resolve(published(first))
    await vi.advanceTimersByTimeAsync(0)
    const second = saves().at(-1)!
    expect(second.text).toBe('The leftover prompt. And one more line.')
    calls.at(-1)!.resolve(published(second))
    await expect(placed).resolves.toBe('saved')
  })

  it('writes nothing when the two together pass one prompt’s limit', async () => {
    const { command, saves } = heldCommand()
    const store = new ThreadDraftStore(command, 250, uuids())
    store.edit('thread', { text: 'A'.repeat(60_000) })
    const before = store.draft('thread')
    await expect(store.place('thread', leftover('B'.repeat(60_000)))).resolves.toBe('too-long')
    expect(store.draft('thread')).toBe(before)
    expect(saves()).toHaveLength(0)
  })
})
