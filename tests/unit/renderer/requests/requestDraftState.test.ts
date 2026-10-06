import { describe, expect, it, vi } from 'vitest'
import { requestAnswerOwnerKey, RequestAnswerStore } from '../../../../src/renderer/src/agents/requests/requestAnswers'
import { requestDraftSchema, type RequestDraft, type RequestDraftBridge, type RequestDraftCheckResult, type RequestDraftTarget } from '../../../../src/shared/requestDrafts'

it('does not restore a pruned answer when an old submit completes after its request ID is reused', async () => {
  const store = new RequestAnswerStore(() => undefined)
  let finish!: (value: { error: null }) => void
  const old = store.submit('thread', 'reused', null, () => new Promise(resolve => { finish = resolve }))
  store.prune('thread', [])
  await store.submit('thread', 'reused', null, async () => ({ error: 'Try again' }))
  finish({ error: null })
  await old
  expect(store.get('thread', 'reused')).toMatchObject({ phase: 'failed', error: 'Try again' })
  store.prune('thread', [])
  expect(store.get('thread', 'reused').phase).toBe('idle')
})
const target: RequestDraftTarget = { kind: 'thread', ownerId: 'thread', providerId: 'codex', requestId: 'req', questions: [
  { id: 'q', question: 'Notes', options: [], allowFreeText: true, multiSelect: false },
] }
const selection = (text: string) => ({ text, optionIds: [], other: false })
const draft = (text: string, revision = 1, held = false): RequestDraft => requestDraftSchema.parse({ target, selections: { q: selection(text) }, revision, held })
function gate<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function bridge(): RequestDraftBridge {
  const api: RequestDraftBridge = { list: vi.fn(async () => []), discard: vi.fn(async () => false), get: vi.fn(async () => null),
    status: vi.fn(async target => { const draft = await api.get(target); return draft ? { status: 'draft' as const, draft } : { status: 'missing' as const } }),
    save: vi.fn(async value => value), check: vi.fn(async () => ({ status: 'editable' as const, draft: null })) }
  return api
}

describe('request draft renderer ordering', () => {
  it.each(['release', 'submit'] as const)('does not save or replay an accepted answer returned by a %s check', async operation => {
    const api = bridge(), store = new RequestAnswerStore(() => api)
    api.get = vi.fn(async () => draft('Already delivered', operation === 'release' ? 3 : 2, operation === 'release'))
    api.check = vi.fn(async () => ({ status: 'accepted' as const, decisionId: 'accepted-attempt', revision: 3 }))
    await store.connect('thread', 'req', target)
    const send = vi.fn(async () => ({ error: 'The provider did not confirm this answer.' }))
    if (operation === 'release') await store.release('thread', 'req')
    else await store.submit('thread', 'req', null, send)
    expect(store.get('thread', 'req')).toMatchObject({ phase: 'sent', revision: 3, save: 'saved', error: null, saveError: null })
    expect(api.save).toHaveBeenCalledTimes(operation === 'release' ? 0 : 1)
    for (const [saved] of vi.mocked(api.save).mock.calls) expect(saved.held).toBe(true)
    expect(await store.flushForReload()).toBe(true)
    await store.submit('thread', 'req', null, send)
    expect(send).toHaveBeenCalledTimes(operation === 'release' ? 0 : 1)
    expect(api.save).toHaveBeenCalledTimes(operation === 'release' ? 0 : 1)
  })

  it('preserves a newer unsaved local edit when Check only accepts an older revision', async () => {
    const api = bridge(), store = new RequestAnswerStore(() => api)
    api.get = vi.fn(async () => draft('Older delivered text'))
    api.save = vi.fn().mockRejectedValue(new Error('Disk unavailable'))
    await store.connect('thread', 'req', target)
    store.select('thread', 'req', 'q', selection('New unsent text'))
    await vi.waitFor(() => expect(store.get('thread', 'req').save).toBe('unsaved'))
    const send = vi.fn(async () => ({ error: null }))
    await store.submit('thread', 'req', null, send)
    const revision = store.get('thread', 'req').revision
    vi.mocked(api.save).mockClear()
    api.check = vi.fn(async () => ({ status: 'accepted' as const, decisionId: 'older-attempt', revision: 1 }))
    await store.release('thread', 'req')
    expect(store.get('thread', 'req')).toMatchObject({ phase: 'idle', revision, save: 'unsaved', selections: { q: selection('New unsent text') } })
    expect(store.canReload()).toBe(false)
    expect(api.save).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps newer local content when an earlier Check fails after another Check releases it', async () => {
    const api = bridge(), store = new RequestAnswerStore(() => api), olderCheck = gate<RequestDraftCheckResult>()
    api.get = vi.fn(async () => draft('Held old text', 3, true))
    api.check = vi.fn().mockReturnValueOnce(olderCheck.promise).mockResolvedValue({ status: 'editable', draft: draft('Held old text', 4) })
    await store.connect('thread', 'req', target)
    const old = store.release('thread', 'req')
    await vi.waitFor(() => expect(api.check).toHaveBeenCalledOnce())
    await store.release('thread', 'req')
    store.select('thread', 'req', 'q', selection('Newest local text'))
    await store.flush('thread', 'req')
    const revision = store.get('thread', 'req').revision
    olderCheck.reject(new Error('That Check was superseded.'))
    await old
    expect(store.get('thread', 'req')).toMatchObject({ phase: 'idle', revision, save: 'saved',
      selections: { q: selection('Newest local text') }, saveError: null })
  })

  it.each(['accepted', 'editable', 'error'] as const)('ignores a delayed %s Check reply after a newer revision starts sending', async outcome => {
    const api = bridge(), store = new RequestAnswerStore(() => api), oldCheck = gate<RequestDraftCheckResult>(), delivery = gate<{ error: null }>()
    api.get = vi.fn(async () => draft('Old held text', 3, true))
    api.check = vi.fn().mockReturnValueOnce(oldCheck.promise).mockResolvedValue({ status: 'editable', draft: draft('Old held text', 4) })
    await store.connect('thread', 'req', target)
    const checking = store.release('thread', 'req')
    await vi.waitFor(() => expect(api.check).toHaveBeenCalledOnce())
    await store.release('thread', 'req')
    store.select('thread', 'req', 'q', selection('New answer being sent'))
    await store.flush('thread', 'req')
    const send = vi.fn(() => delivery.promise)
    const sending = store.submit('thread', 'req', null, send)
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    const revision = store.get('thread', 'req').revision, saves = vi.mocked(api.save).mock.calls.length
    if (outcome === 'error') oldCheck.reject(new Error('Old Check failed.'))
    else oldCheck.resolve(outcome === 'accepted' ? { status: 'accepted', decisionId: 'old-attempt', revision: 3 }
      : { status: 'editable', draft: draft('Old held text', 4) })
    await checking
    expect(store.get('thread', 'req')).toMatchObject({ phase: 'sending', revision, save: 'saved', saveError: null,
      selections: { q: selection('New answer being sent') } })
    expect(api.save).toHaveBeenCalledTimes(saves)
    delivery.resolve({ error: null })
    await sending
    expect(store.get('thread', 'req').phase).toBe('sent')
  })

  it('retires an accepted form when the same request ID changes questions and returns without an empty snapshot', async () => {
    const api = bridge(), store = new RequestAnswerStore(() => api)
    const first = { id: target.requestId, kind: 'question' as const, text: 'Notes', options: [], questions: target.questions }
    const replacement = { ...first, questions: [{ ...target.questions[0]!, question: 'Different notes' }] }
    const replacementTarget = { ...target, questions: replacement.questions }
    const firstOwner = requestAnswerOwnerKey(target.ownerId, first, target)
    const replacementOwner = requestAnswerOwnerKey(target.ownerId, replacement, target)
    await store.connect(firstOwner, target.requestId, target)
    await store.submit(firstOwner, target.requestId, null, async () => ({ error: null }))
    expect(store.get(firstOwner, target.requestId).phase).toBe('sent')
    store.prune(target.ownerId, [first])
    await store.connect(firstOwner, target.requestId, target)
    expect(store.get(firstOwner, target.requestId).phase).toBe('sent')
    expect(api.get).toHaveBeenCalledOnce()
    store.prune(target.ownerId, [replacement])
    await store.connect(replacementOwner, target.requestId, replacementTarget)
    store.prune(target.ownerId, [first])
    await store.connect(firstOwner, target.requestId, target)
    expect(store.get(firstOwner, target.requestId)).toMatchObject({ phase: 'idle', selections: {} })
  })

  it('retires a departed structured answer only after main confirms it is gone, before reconnecting a reused ID', async () => {
    const api = bridge(), store = new RequestAnswerStore(() => api)
    const request = { id: target.requestId, kind: 'question' as const, text: 'Notes', options: [], questions: target.questions }
    const ownerId = requestAnswerOwnerKey(target.ownerId, request, target)
    await store.connect(ownerId, target.requestId, target)
    await store.submit(ownerId, target.requestId, null, async () => ({ error: null }))
    expect(store.get(ownerId, target.requestId).phase).toBe('sent')
    const retirement = gate<RequestDraft | null>()
    api.get = vi.fn().mockReturnValueOnce(retirement.promise).mockResolvedValue(null)
    store.prune(target.ownerId, [])
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())
    const reconnect = store.connect(ownerId, target.requestId, target)
    retirement.resolve(null)
    await reconnect
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(store.get(ownerId, target.requestId)).toMatchObject({ phase: 'idle', selections: {} })
  })

  it('does not apply an old bound submit result to a newly reconnected request', async () => {
    const api = bridge(), store = new RequestAnswerStore(() => api), delivery = gate<{ error: null }>()
    await store.connect('thread', 'req', target)
    const old = store.submit('thread', 'req', null, () => delivery.promise)
    await vi.waitFor(() => expect(store.get('thread', 'req').save).toBe('saved'))
    store.prune('thread', [])
    await store.connect('thread', 'req', target)
    expect(store.get('thread', 'req').phase).toBe('idle')
    delivery.resolve({ error: null })
    await old
    expect(store.get('thread', 'req').phase).toBe('idle')
  })

  it('retires a removed owner after its delayed submit settles without a newer draft revision', async () => {
    const api = bridge(), store = new RequestAnswerStore(() => api), delivery = gate<{ error: null }>(), retirement = gate<RequestDraft | null>()
    await store.connect('thread', 'req', target)
    const sending = store.submit('thread', 'req', null, () => delivery.promise)
    await vi.waitFor(() => expect(store.get('thread', 'req').save).toBe('saved'))
    api.get = vi.fn(() => retirement.promise)
    store.prune('thread', [])
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())
    delivery.resolve({ error: null })
    await sending
    expect(store.get('thread', 'req').phase).toBe('sent')
    retirement.resolve(null)
    await vi.waitFor(() => expect(store.get('thread', 'req').phase).toBe('idle'))
  })

  it.each(['submit', 'release'] as const)('ignores a retired binding when a delayed %s check resolves or fails', async operation => {
    for (const fails of [false, true]) {
      const api = bridge(), store = new RequestAnswerStore(() => api), checking = gate<RequestDraftCheckResult>()
      await store.connect('thread', 'req', target)
      api.check = vi.fn(() => checking.promise)
      if (operation === 'release') await store.submit('thread', 'req', null, async () => ({ error: null }))
      const old = operation === 'release' ? store.release('thread', 'req') : store.submit('thread', 'req', null, async () => ({ error: 'Old refusal' }))
      await vi.waitFor(() => expect(api.check).toHaveBeenCalledOnce())
      store.prune('thread', [])
      await store.connect('thread', 'req', target)
      store.select('thread', 'req', 'q', selection('New request text'))
      await store.flush('thread', 'req')
      if (fails) checking.reject(new Error('Old check failed')); else checking.resolve({ status: 'accepted', decisionId: 'old-attempt', revision: 1 })
      await old
      expect(store.get('thread', 'req')).toMatchObject({ phase: 'idle', error: null, saveError: null, selections: { q: selection('New request text') } })
    }
  })

  it('keeps departed structured drafts when main still retains them or a newer edit has no save acknowledgement', async () => {
    const api = bridge(), store = new RequestAnswerStore(() => api)
    api.get = vi.fn(async () => draft('Kept in main', 2, true))
    await store.connect('thread', 'req', target)
    store.prune('thread', [])
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    expect(store.get('thread', 'req').phase).toBe('unconfirmed')
    api.check = vi.fn(async () => ({ status: 'editable' as const, draft: draft('Kept in main', 2) }))
    await store.release('thread', 'req')
    const reading = gate<RequestDraft | null>()
    api.get = vi.fn(() => reading.promise)
    store.prune('thread', [])
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())
    api.save = vi.fn().mockRejectedValue(new Error('Disk unavailable'))
    store.select('thread', 'req', 'q', selection('Unsaved newer text'))
    await vi.waitFor(() => expect(store.get('thread', 'req').save).toBe('unsaved'))
    const reconnect = store.connect('thread', 'req', target)
    reading.resolve(null)
    await reconnect
    expect(store.get('thread', 'req').selections.q?.text).toBe('Unsaved newer text')
    expect(store.canReload()).toBe(false)
  })

  it.each([false, true])('does not rewrite a saved answer restored after a failed initial read (held=%s)', async held => {
    const api = bridge()
    const restored = { ...draft('Saved in main', 5, held), ...(held ? { decisionId: 'main-owned-decision' } : {}) }
    api.get = vi.fn().mockRejectedValueOnce(new Error('Disconnected bridge')).mockResolvedValue(restored)
    api.save = vi.fn().mockRejectedValue(new Error('Must not rewrite restored content'))
    const store = new RequestAnswerStore(() => api)
    await store.connect('thread', 'req', target)
    expect(store.canReload()).toBe(false)
    expect(await store.flushForReload()).toBe(true)
    expect(api.save).not.toHaveBeenCalled()
    expect(store.get('thread', 'req')).toMatchObject({ save: 'saved', phase: held ? 'unconfirmed' : 'idle', selections: restored.selections })
  })

  it('waits for the newest answer edit while reload is saving an older revision', async () => {
    const first = gate<RequestDraft>(), second = gate<RequestDraft>(), api = bridge(), saves: RequestDraft[] = []
    api.save = vi.fn(input => { saves.push(input); return saves.length === 1 ? first.promise : second.promise })
    const store = new RequestAnswerStore(() => api); await store.connect('thread', 'req', target)
    store.select('thread', 'req', 'q', selection('Older'))
    await vi.waitFor(() => expect(saves).toHaveLength(1))
    let finished = false
    const reloading = store.flushForReload().then(saved => { finished = true; return saved })
    store.select('thread', 'req', 'q', selection('Newest'))
    first.resolve(saves[0]!)
    await vi.waitFor(() => expect(saves).toHaveLength(2))
    expect(finished).toBe(false)
    second.resolve(saves[1]!)
    expect(await reloading).toBe(true)
    expect(store.get('thread', 'req').selections.q?.text).toBe('Newest')
  })

  it('does not rewrite saved answers that main may already have retired', async () => {
    const api = bridge(), store = new RequestAnswerStore(() => api)
    await store.connect('thread', 'req', target)
    store.select('thread', 'req', 'q', selection('Already saved'))
    await vi.waitFor(() => expect(store.get('thread', 'req').save).toBe('saved'))
    vi.mocked(api.save).mockClear()
    store.prune('thread', [])
    expect(await store.flushForReload()).toBe(true)
    expect(api.save).not.toHaveBeenCalled()
  })

  it('retries a failed answer save after its request leaves the live set before reload', async () => {
    const api = bridge(); api.save = vi.fn().mockRejectedValueOnce(new Error('Disk unavailable')).mockImplementation(async value => value)
    const store = new RequestAnswerStore(() => api); await store.connect('thread', 'req', target)
    store.select('thread', 'req', 'q', selection('Keep this closed question answer'))
    await vi.waitFor(() => expect(store.get('thread', 'req').save).toBe('unsaved'))
    store.prune('thread', [])
    expect(await store.flushForReload()).toBe(true)
    expect(api.save).toHaveBeenLastCalledWith(expect.objectContaining({ selections: { q: selection('Keep this closed question answer') }, held: false }))
  })

  it('keeps local text written after an initial load failure when retry restores an older draft', async () => {
    const api = bridge(); api.get = vi.fn().mockRejectedValueOnce(new Error('Disconnected bridge')).mockResolvedValue(draft('Old saved text', 5))
    const store = new RequestAnswerStore(() => api)
    await store.connect('thread', 'req', target)
    expect(store.get('thread', 'req').save).toBe('unsaved')
    store.select('thread', 'req', 'q', selection('New text after failed load'))
    await vi.waitFor(() => expect(store.get('thread', 'req').save).toBe('saved'))
    expect(store.get('thread', 'req')).toMatchObject({ selections: { q: selection('New text after failed load') }, revision: 6 })
  })

  it('protects newer local text from a delayed restore and advances the durable revision', async () => {
    const restore = gate<RequestDraft | null>(), api = bridge(); api.get = () => restore.promise
    const store = new RequestAnswerStore(() => api)
    const loading = store.connect('thread', 'req', target)
    store.select('thread', 'req', 'q', selection('New local edit'))
    restore.resolve(draft('Older saved text', 8)); await loading; await store.flush('thread', 'req')
    expect(store.get('thread', 'req')).toMatchObject({ selections: { q: selection('New local edit') }, revision: 9, save: 'saved' })
  })

  it('does not let an older acknowledgement mark newer typing saved', async () => {
    const first = gate<RequestDraft>(), second = gate<RequestDraft>(), api = bridge()
    const saves: RequestDraft[] = []
    api.save = vi.fn(input => { saves.push(input); return saves.length === 1 ? first.promise : second.promise })
    const store = new RequestAnswerStore(() => api); await store.connect('thread', 'req', target)
    store.select('thread', 'req', 'q', selection('Older'))
    await vi.waitFor(() => expect(saves).toHaveLength(1))
    store.select('thread', 'req', 'q', selection('Newer'))
    first.resolve(saves[0]!); await vi.waitFor(() => expect(saves).toHaveLength(2))
    expect(store.get('thread', 'req')).toMatchObject({ selections: { q: selection('Newer') }, save: 'saving' })
    expect(store.canReload()).toBe(false)
    second.resolve(saves[1]!); await vi.waitFor(() => expect(store.get('thread', 'req').save).toBe('saved'))
    expect(store.canReload()).toBe(true)
  })

  it('retains failed saves for retry, rejects invalid local text honestly, and does not autosend', async () => {
    const api = bridge(); api.save = vi.fn().mockRejectedValueOnce(new Error('Disk unavailable')).mockImplementation(async value => value)
    const store = new RequestAnswerStore(() => api); await store.connect('thread', 'req', target)
    store.select('thread', 'req', 'q', selection('Keep me'))
    await vi.waitFor(() => expect(store.get('thread', 'req')).toMatchObject({ save: 'unsaved', saveError: 'Disk unavailable' }))
    expect(store.canReload()).toBe(false)
    await store.flush('thread', 'req')
    expect(store.canReload()).toBe(true)
    expect(store.get('thread', 'req')).toMatchObject({ save: 'saved', selections: { q: selection('Keep me') } })
    store.select('thread', 'req', 'q', selection('x'.repeat(24001)))
    await vi.waitFor(() => expect(store.get('thread', 'req')).toMatchObject({ save: 'unsaved' }))
    expect(store.get('thread', 'req').saveError).toContain('24,000')
  })

  it('holds instead of delivering when the pre-send save fails; reloads an interrupted attempt without replay', async () => {
    const api = bridge(); api.save = vi.fn().mockRejectedValue(new Error('Disk unavailable'))
    const store = new RequestAnswerStore(() => api); await store.connect('thread', 'req', target)
    const send = vi.fn(async () => ({ error: null }))
    await store.submit('thread', 'req', null, send)
    expect(store.get('thread', 'req').phase).toBe('unconfirmed')
    expect(store.get('thread', 'req').error).toContain('was not sent')
    expect(send).not.toHaveBeenCalled()
    api.get = vi.fn(async () => draft('Was being sent', 4, true))
    const restarted = new RequestAnswerStore(() => api); await restarted.connect('thread', 'req', target)
    await restarted.submit('thread', 'req', null, send)
    expect(restarted.get('thread', 'req')).toMatchObject({ phase: 'unconfirmed', selections: { q: selection('Was being sent') } })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not prune durable records on empty renderer snapshots or clear a hold on a stale check', async () => {
    const api = bridge(); api.get = vi.fn(async () => draft('Held', 3, true)); api.check = vi.fn().mockRejectedValue(new Error('Still uncertain'))
    const store = new RequestAnswerStore(() => api); await store.connect('thread', 'req', target)
    store.prune('thread', [])
    await store.release('thread', 'req')
    expect(store.get('thread', 'req')).toMatchObject({ phase: 'unconfirmed', saveError: 'Still uncertain' })
    api.check = vi.fn(async () => ({ status: 'editable' as const, draft: draft('Held', 4) }))
    await store.release('thread', 'req')
    expect(store.get('thread', 'req')).toMatchObject({ phase: 'idle', revision: 4 })
  })

  it('does not mistake a successful delivery check of an older draft for saving newer local text', async () => {
    const api = bridge(); api.get = vi.fn(async () => draft('Older saved text'))
    api.save = vi.fn().mockRejectedValue(new Error('Disk unavailable'))
    api.check = vi.fn(async () => ({ status: 'editable' as const, draft: draft('Older saved text') }))
    const store = new RequestAnswerStore(() => api); await store.connect('thread', 'req', target)
    store.select('thread', 'req', 'q', selection('Newer local text'))
    await vi.waitFor(() => expect(store.get('thread', 'req').save).toBe('unsaved'))
    const send = vi.fn(async () => ({ error: null }))
    await store.submit('thread', 'req', null, send)
    await store.release('thread', 'req')
    expect(store.get('thread', 'req')).toMatchObject({ phase: 'idle', save: 'unsaved', selections: { q: selection('Newer local text') } })
    api.save = vi.fn(async value => value)
    await store.flush('thread', 'req')
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ selections: { q: selection('Newer local text') }, held: false }))
    expect(store.get('thread', 'req').save).toBe('saved')
    expect(send).not.toHaveBeenCalled()
  })
})
