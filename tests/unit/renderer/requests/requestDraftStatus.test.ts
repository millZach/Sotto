import { describe, expect, it, vi } from 'vitest'
import { RequestAnswerStore } from '../../../../src/renderer/src/agents/requests/requestAnswers'
import { requestDraftKey, type RequestDraft, type RequestDraftBridge, type RequestDraftCheckResult, type RequestDraftOwner, type RequestDraftStatus, type RequestDraftTarget } from '../../../../src/shared/requestDrafts'

const target: RequestDraftTarget = { kind: 'thread', ownerId: 'forge-thread', providerId: 'claude', requestId: 'question', questions: [
  { id: 'notes', question: 'Notes?', options: [], allowFreeText: true, multiSelect: false },
] }
const selection = (text: string) => ({ text, optionIds: [], other: false })
const draft = (revision = 3, held = true, owner = target): RequestDraft => ({ target: owner, revision, held,
  selections: { notes: selection('Original answer') } })
const accepted = (revision = 3): RequestDraftStatus & { status: 'accepted' } => ({ status: 'accepted', revision, decisionId: `attempt-${revision}` })
function gate<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }

function fixture(initial: RequestDraftStatus = { status: 'draft', draft: draft() }) {
  const values = new Map<string, RequestDraftStatus>([[requestDraftKey(target), initial]])
  const listeners = new Set<(owner: RequestDraftOwner) => void>()
  const off = vi.fn()
  const bridge: RequestDraftBridge = {
    list: vi.fn(async () => []), discard: vi.fn(async () => false),
    get: vi.fn(async input => { const status = values.get(requestDraftKey(input)); return status?.status === 'draft' ? status.draft : null }),
    status: vi.fn(async input => values.get(requestDraftKey(input)) ?? { status: 'missing' as const }),
    save: vi.fn(async value => { values.set(requestDraftKey(value.target), { status: 'draft', draft: value }); return value }),
    check: vi.fn(async () => ({ status: 'editable' as const, draft: null })),
    onChanged: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener); off() } }),
  }
  const store = new RequestAnswerStore(() => bridge)
  const change = (input: RequestDraftTarget, status: RequestDraftStatus) => {
    values.set(requestDraftKey(input), status)
    const { kind, ownerId, providerId } = input
    for (const listener of listeners) listener({ kind, ownerId, providerId })
  }
  return { store, bridge, change, values, off }
}

describe('read-only accepted answer status in the renderer', () => {
  it('updates a mounted held revision from its owner change without Check, saving or sending', async () => {
    const f = fixture()
    await f.store.connect('owner', 'question', target)
    expect(f.store.get('owner', 'question').phase).toBe('unconfirmed')
    f.change(target, accepted())
    await vi.waitFor(() => expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'sent', revision: 3, save: 'saved', error: null }))
    expect(f.bridge.get).not.toHaveBeenCalled()
    expect(f.bridge.check).not.toHaveBeenCalled()
    expect(f.bridge.save).not.toHaveBeenCalled()
    const send = vi.fn(async () => ({ error: null }))
    await f.store.submit('owner', 'question', null, send)
    expect(await f.store.flushForReload()).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect(f.bridge.save).not.toHaveBeenCalled()
  })

  it('restores a pristine accepted question after reload from metadata alone', async () => {
    const f = fixture(accepted(8))
    await f.store.connect('owner', 'question', target)
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'sent', revision: 8, selections: {}, save: 'saved' })
    expect(f.bridge.get).not.toHaveBeenCalled()
    expect(f.bridge.check).not.toHaveBeenCalled()
    expect(f.bridge.save).not.toHaveBeenCalled()
  })

  it('detaches departed accepted personal bindings while newer edits and unconfirmed answers keep observing their owner', async () => {
    const f = fixture(), personal = { ...target, kind: 'personal' as const, ownerId: 'chat' }
    for (let i = 0; i < 20; i++) {
      const prior = { ...personal, requestId: `accepted-${i}` }
      f.values.set(requestDraftKey(prior), accepted())
      await f.store.connect('chat', prior.requestId, prior)
      expect(f.store.get('chat', prior.requestId).phase).toBe('sent')
    }
    f.store.prune('chat', [])
    const current = { ...personal, requestId: 'still-unconfirmed' }
    f.values.set(requestDraftKey(current), { status: 'draft', draft: draft(5, true, current) })
    await f.store.connect('chat', current.requestId, current)
    vi.mocked(f.bridge.status).mockClear()
    f.change(current, accepted(3))
    await vi.waitFor(() => expect(f.bridge.status).toHaveBeenCalledOnce())
    expect(f.store.get('chat', current.requestId).phase).toBe('unconfirmed')
    expect(f.off).toHaveBeenCalledTimes(20)
    f.change(current, accepted(5))
    await vi.waitFor(() => expect(f.store.get('chat', current.requestId).phase).toBe('sent'))
    expect(f.off).toHaveBeenCalledTimes(21)
    const editable = { ...personal, requestId: 'new-unsent-edit' }
    f.values.set(requestDraftKey(editable), { status: 'draft', draft: draft(6, false, editable) })
    await f.store.connect('chat', editable.requestId, editable)
    f.store.select('chat', editable.requestId, 'notes', selection('New unsent text'))
    await f.store.flush('chat', editable.requestId)
    vi.mocked(f.bridge.status).mockClear()
    f.change(editable, accepted(6))
    await vi.waitFor(() => expect(f.bridge.status).toHaveBeenCalledOnce())
    expect(f.store.get('chat', editable.requestId)).toMatchObject({ phase: 'idle', revision: 7, selections: { notes: selection('New unsent text') } })
    expect(f.off).toHaveBeenCalledTimes(21)
    f.change(editable, { status: 'missing' })
    await vi.waitFor(() => expect(f.bridge.status).toHaveBeenCalledTimes(2))
    expect(f.bridge.check).not.toHaveBeenCalled()
  })

  it('preserves edits during restore above the accepted revision floor without marking them sent', async () => {
    const f = fixture(), restoring = gate<RequestDraftStatus>()
    vi.mocked(f.bridge.status).mockReturnValue(restoring.promise)
    const load = f.store.connect('owner', 'question', target)
    f.store.select('owner', 'question', 'notes', selection('New local notes'))
    restoring.resolve(accepted(5))
    await load
    await f.store.flush('owner', 'question')
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'idle', revision: 6, save: 'saved', selections: { notes: selection('New local notes') } })
    for (const [saved] of vi.mocked(f.bridge.save).mock.calls) expect(saved).toMatchObject({ revision: 6, held: false, selections: { notes: selection('New local notes') } })
    expect(f.bridge.check).not.toHaveBeenCalled()
  })

  it('does not confirm an unsent edit merely because older acceptance has the same revision number', async () => {
    const f = fixture({ status: 'draft', draft: draft(2, false) })
    vi.mocked(f.bridge.save).mockRejectedValue(new Error('A newer answer is saved in main'))
    await f.store.connect('owner', 'question', target)
    f.store.select('owner', 'question', 'notes', selection('Different unsent text'))
    await vi.waitFor(() => expect(f.store.get('owner', 'question').save).toBe('unsaved'))
    f.change(target, accepted())
    await vi.waitFor(() => expect(f.bridge.status).toHaveBeenCalledTimes(2))
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'idle', revision: 3, save: 'unsaved', selections: { notes: selection('Different unsent text') } })
    expect(f.store.canReload()).toBe(false)
    expect(f.bridge.check).not.toHaveBeenCalled()
  })

  it('keeps acceptance durable when an already queued save fails after proof arrives', async () => {
    const f = fixture(), saving = gate<RequestDraft>()
    await f.store.connect('owner', 'question', target)
    vi.mocked(f.bridge.save).mockReturnValue(saving.promise)
    const flushed = f.store.flush('owner', 'question')
    await vi.waitFor(() => expect(f.bridge.save).toHaveBeenCalledOnce())
    f.change(target, accepted())
    await vi.waitFor(() => expect(f.store.get('owner', 'question').phase).toBe('sent'))
    saving.reject(new Error('The revision was already accepted'))
    expect(await flushed).toBe(true)
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'sent', revision: 3, save: 'saved', saveError: null })
    expect(await f.store.flushForReload()).toBe(true)
    expect(f.bridge.save).toHaveBeenCalledOnce()
  })

  it('rejects a draft restored for a different exact target', async () => {
    const f = fixture()
    vi.mocked(f.bridge.status).mockResolvedValue({ status: 'draft', draft: draft(3, true, { ...target, providerId: 'codex' }) })
    await f.store.connect('owner', 'question', target)
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'idle', save: 'unsaved', selections: {}, saveError: expect.stringContaining('different question') })
    expect(f.bridge.check).not.toHaveBeenCalled()
    expect(f.bridge.save).not.toHaveBeenCalled()
  })

  it('removes an owner-change listener when a departed binding is retired through status', async () => {
    const f = fixture()
    await f.store.connect('owner', 'question', target)
    f.change(target, accepted())
    await vi.waitFor(() => expect(f.store.get('owner', 'question').phase).toBe('sent'))
    f.store.prune(target.ownerId, [])
    await vi.waitFor(() => expect(f.off).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(f.store.get('owner', 'question').phase).toBe('idle'))
    const reads = vi.mocked(f.bridge.status).mock.calls.length
    f.change(target, accepted())
    expect(f.bridge.status).toHaveBeenCalledTimes(reads)
    expect(f.bridge.get).not.toHaveBeenCalled()
    expect(f.bridge.check).not.toHaveBeenCalled()
  })

  it.each(['null', 'error', 'throw'] as const)('does not regress background acceptance when a late command returns %s', async outcome => {
    const f = fixture({ status: 'draft', draft: draft(2, false) }), reply = gate<{ error: string | null } | null>()
    await f.store.connect('owner', 'question', target)
    const send = vi.fn(() => reply.promise)
    const submitting = f.store.submit('owner', 'question', null, send)
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    f.change(target, accepted())
    await vi.waitFor(() => expect(f.store.get('owner', 'question').phase).toBe('sent'))
    if (outcome === 'throw') reply.reject(new Error('Lost command reply'))
    else reply.resolve(outcome === 'null' ? null : { error: 'Could not confirm the command.' })
    await submitting
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'sent', revision: 3, save: 'saved', error: null, saveError: null })
    expect(f.bridge.check).not.toHaveBeenCalled()
    expect(f.bridge.save).toHaveBeenCalledOnce()
  })

  it.each(['draft', 'error'] as const)('ignores a stale initial %s read after a changed-owner read proves acceptance', async outcome => {
    const f = fixture(), initial = gate<RequestDraftStatus>()
    vi.mocked(f.bridge.status).mockReturnValueOnce(initial.promise)
    const loading = f.store.connect('owner', 'question', target)
    f.change(target, accepted(5))
    await vi.waitFor(() => expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'sent', revision: 5, save: 'saved' }))
    if (outcome === 'error') initial.reject(new Error('Old restore failed'))
    else initial.resolve({ status: 'draft', draft: draft(5) })
    await loading
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'sent', revision: 5, save: 'saved', saveError: null })
    expect(f.bridge.check).not.toHaveBeenCalled()
    expect(f.bridge.save).not.toHaveBeenCalled()
  })

  it.each(['editable', 'error'] as const)('ignores a pending Check %s response after the same revision is accepted', async outcome => {
    const f = fixture(), checking = gate<RequestDraftCheckResult>()
    vi.mocked(f.bridge.check).mockReturnValue(checking.promise)
    await f.store.connect('owner', 'question', target)
    const release = f.store.release('owner', 'question')
    await vi.waitFor(() => expect(f.bridge.check).toHaveBeenCalledOnce())
    f.change(target, accepted())
    await vi.waitFor(() => expect(f.store.get('owner', 'question').phase).toBe('sent'))
    if (outcome === 'error') checking.reject(new Error('Old Check failed'))
    else checking.resolve({ status: 'editable', draft: draft(3, false) })
    await release
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'sent', revision: 3, save: 'saved', saveError: null })
    expect(f.bridge.save).not.toHaveBeenCalled()
  })

  it('retains newer local edits and a newer held attempt when older status is accepted', async () => {
    const f = fixture({ status: 'draft', draft: draft(3, false) })
    await f.store.connect('owner', 'question', target)
    f.store.select('owner', 'question', 'notes', selection('New unsent answer'))
    await f.store.flush('owner', 'question')
    f.change(target, accepted())
    await vi.waitFor(() => expect(f.bridge.status).toHaveBeenCalledTimes(2))
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'idle', revision: 4, save: 'saved', selections: { notes: selection('New unsent answer') } })
    const send = vi.fn(async () => null)
    await f.store.submit('owner', 'question', null, send)
    f.change(target, accepted())
    await vi.waitFor(() => expect(f.bridge.status).toHaveBeenCalledTimes(3))
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'unconfirmed', revision: 5, selections: { notes: selection('New unsent answer') } })
    expect(send).toHaveBeenCalledOnce()
    expect(f.bridge.check).not.toHaveBeenCalled()
  })

  it('does not turn missing status into acceptance or release a held answer', async () => {
    const f = fixture()
    await f.store.connect('owner', 'question', target)
    f.change(target, { status: 'missing' })
    await vi.waitFor(() => expect(f.bridge.status).toHaveBeenCalledTimes(2))
    expect(f.store.get('owner', 'question')).toMatchObject({ phase: 'unconfirmed', revision: 3, selections: draft().selections })
    expect(f.bridge.check).not.toHaveBeenCalled()
    expect(f.bridge.save).not.toHaveBeenCalled()
  })

  it('keeps owner, provider, request and question-form acceptance isolated', async () => {
    const f = fixture(), others: RequestDraftTarget[] = [
      { ...target, kind: 'personal' }, { ...target, ownerId: 'other-host-thread' }, { ...target, providerId: 'codex' },
      { ...target, requestId: 'other-question' }, { ...target, questions: [{ ...target.questions[0]!, question: 'Changed notes?' }] },
    ]
    await f.store.connect('owner', 'question', target)
    for (const [i, other] of others.entries()) {
      f.values.set(requestDraftKey(other), { status: 'draft', draft: draft(3, true, other) })
      await f.store.connect(`other-${i}`, other.requestId, other)
    }
    f.change(target, accepted())
    await vi.waitFor(() => expect(f.store.get('owner', 'question').phase).toBe('sent'))
    for (const [i, other] of others.entries()) expect(f.store.get(`other-${i}`, other.requestId).phase).toBe('unconfirmed')
    expect(f.bridge.check).not.toHaveBeenCalled()
    expect(f.bridge.save).not.toHaveBeenCalled()
  })
})
