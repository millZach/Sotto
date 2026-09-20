import { describe, expect, it, vi } from 'vitest'
import { RequestAnswerStore } from '../../../../src/renderer/src/agents/requests/requestAnswers'
import { requestDraftSchema, type RequestDraft, type RequestDraftBridge, type RequestDraftTarget } from '../../../../src/shared/requestDrafts'
const target: RequestDraftTarget = { kind: 'thread', ownerId: 'thread', providerId: 'codex', requestId: 'req', questions: [
  { id: 'q', question: 'Notes', options: [], allowFreeText: true, multiSelect: false },
] }
const selection = (text: string) => ({ text, optionIds: [], other: false })
const draft = (text: string, revision = 1, held = false): RequestDraft => requestDraftSchema.parse({ target, selections: { q: selection(text) }, revision, held })
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function bridge(): RequestDraftBridge { return { list: vi.fn(async () => []), discard: vi.fn(async () => false), get: vi.fn(async () => null), save: vi.fn(async value => value), check: vi.fn(async () => null) } }

describe('request draft renderer ordering', () => {
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
    api.check = vi.fn(async () => draft('Held', 4))
    await store.release('thread', 'req')
    expect(store.get('thread', 'req')).toMatchObject({ phase: 'idle', revision: 4 })
  })

  it('does not mistake a successful delivery check of an older draft for saving newer local text', async () => {
    const api = bridge(); api.get = vi.fn(async () => draft('Older saved text'))
    api.save = vi.fn().mockRejectedValue(new Error('Disk unavailable'))
    api.check = vi.fn(async () => draft('Older saved text'))
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
