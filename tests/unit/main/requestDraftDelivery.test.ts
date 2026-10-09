// @vitest-environment node
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RequestDraftService, requestQuestionsDigest, type RequestDraftOwnerState } from '../../../src/main/agents/requestDrafts'
import { requestDraftQuestions, type RequestDraft } from '../../../src/shared/requestDrafts'
import type { AgentRequest } from '../../../src/shared/agents'
import { questions, target, submittedAnswers, owner, request, draft, directory, disk, registerRequestDraftFixture } from '../../fixtures/requestDrafts'
import { deferred } from '../../fixtures/deferred'

registerRequestDraftFixture()

it.each([undefined, requestQuestionsDigest(questions)])('never applies an old receipt to a newer reused-ID held form (digest %s)', async digest => {
  const oldReceipt = { requestId: target.requestId, ...(digest ? { questionsDigest: digest } : {}) }
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request], completed: [oldReceipt] }
  const service = new RequestDraftService(directory, () => state, async () => {})
  await service.start()
  const changed = { ...target, questions: [{ ...questions[1]!, question: 'New private question' }] }
  state = { ...state, requests: [{ ...request, questions: changed.questions }] }
  await service.save(draft({ target: changed, held: true, selections: { notes: { optionIds: [], other: false, text: 'New private answer' } } }))
  // The thread publishes submitting before the new native write.
  state = { ...state, uncertainRequestIds: [target.requestId] }
  await service.reconcile()
  expect((await disk()).drafts[0]?.selections.notes?.text).toBe('New private answer')
  state = { ...state, connected: false, ready: false, requests: [] }
  const restarted = new RequestDraftService(directory, () => state, async () => {})
  await restarted.start(); await restarted.reconcile()
  expect((await restarted.get(changed))?.held).toBe(true)
})

it('binds acceptance to the exact same-definition attempt, retaining newer holds and legacy receipts', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const service = new RequestDraftService(directory, () => state, async () => {})
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'first', submittedAnswers)
  await service.check(target)
  await service.save(draft({ revision: 3, held: true }))
  await service.bindDecision(target, 'second', submittedAnswers)
  const receipt = { requestId: target.requestId, questionsDigest: requestQuestionsDigest(questions) }
  state = { ...state, completed: [receipt, { ...receipt, decisionId: 'first' }] }
  await service.reconcile()
  expect((await disk()).drafts[0]).toMatchObject({ revision: 3, held: true, decisionId: 'second' })
  state = { ...state, completed: [...state.completed!, { ...receipt, decisionId: 'second' }] }
  await service.reconcile()
  expect((await disk()).drafts).toEqual([])
})

it('does not attach a delayed old answer to newer held text, or accept renderer-invented delivery identity', async () => {
  const state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const service = new RequestDraftService(directory, () => state, async () => {})
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'delayed-old-command', { ...submittedAnswers, notes: { optionIds: [], text: 'Old text' } })
  expect((await disk()).drafts[0]).not.toHaveProperty('decisionId')
  await expect(service.save(draft({ held: true, revision: 2, decisionId: 'forged-receipt' }))).rejects.toThrow('owned by main')
  await service.bindDecision(target, 'actual-command', submittedAnswers)
  expect((await disk()).drafts[0]?.decisionId).toBe('actual-command')
})

it('preserves a final queued edit to a redefined form and rejects stale discard without mutating either form', async () => {
  let state: RequestDraftOwnerState | undefined = { connected: true, ready: true, requests: [request] }
  const service = new RequestDraftService(directory, () => state, async () => {})
  await service.start(); await service.save(draft())
  const snapshot = (await service.list(owner))[0]!
  state = { connected: true, ready: true, requests: [{ ...request, questions: [{ ...questions[1]!, question: 'Changed' }] }] }
  const latest = draft({ revision: 2, selections: { notes: { optionIds: [], other: false, text: 'Final queued edit' } } })
  await service.save(latest); await service.reconcile()
  await expect(service.discard({ target, revision: snapshot.revision })).rejects.toThrow('newer')
  expect((await disk()).drafts).toEqual([latest])
  state = undefined
  expect(await service.list(owner)).toEqual([])
  expect(await service.get(target)).toBeNull()
  await expect(service.discard({ target, revision: 2 })).rejects.toThrow('owner is unavailable')
  expect((await disk()).drafts).toEqual([latest])
})

it('retains held content when explicit discard cannot commit and only reports success after the retry', async () => {
  const state = { connected: true, ready: true, requests: [request] }
  const real = new RequestDraftService(directory, () => state, async () => {})
  await real.start(); await real.save(draft({ held: true }))
  const write = vi.fn().mockRejectedValueOnce(new Error('disk denied')).mockImplementation(async value => { await writeFile(join(directory, 'request-drafts.json'), JSON.stringify(value)) })
  const service = new RequestDraftService(directory, () => state, async () => {}, { write })
  await service.start()
  await expect(service.discard({ target, revision: 1 })).rejects.toThrow('Could not save')
  expect((await service.list(owner))[0]?.held).toBe(true)
  expect((await disk()).drafts).toHaveLength(1)
  expect(await service.discard({ target, revision: 1 })).toBe(true)
  expect(await service.discard({ target, revision: 1 })).toBe(false)
  expect((await disk()).drafts).toEqual([])
})

it('retains legacy choices across restart and checks definition and delivery identity before release or cleanup', async () => {
  const legacy: AgentRequest = { id: 'legacy', kind: 'question', text: 'Choose a destination', options: [{ id: 'coast', label: 'Coast' }, { id: 'hills', label: 'Hills' }] }
  const legacyTarget = { ...target, requestId: legacy.id, questions: requestDraftQuestions(legacy) }
  const retained: RequestDraft = { target: legacyTarget, revision: 1, held: false, selections: { legacy: { optionIds: ['coast'], other: false, text: '' } } }
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [legacy] }
  const service = new RequestDraftService(directory, () => state, async () => {})
  await service.start(); await service.save(retained)
  const refresh = vi.fn(async () => {})
  const restarted = new RequestDraftService(directory, () => state, refresh)
  await restarted.start()
  expect(await restarted.get(legacyTarget)).toEqual(retained)
  await restarted.save({ ...retained, revision: 2, held: true })
  await restarted.bindDecision(legacyTarget, 'old', { legacy: { optionIds: ['hills'] } })
  expect((await restarted.get(legacyTarget))?.decisionId).toBeUndefined()
  await restarted.bindDecision(legacyTarget, 'actual', { legacy: { optionIds: ['coast'] } })
  state = { ...state, requests: [{ ...legacy, options: [{ id: 'coast', label: 'A new meaning' }] }] }
  await expect(restarted.check(legacyTarget)).rejects.toThrow('still unconfirmed')
  expect(refresh).toHaveBeenCalledOnce()
  state = { ...state, requests: [legacy] }
  expect(await restarted.check(legacyTarget)).toMatchObject({ status: 'editable', draft: { revision: 3, held: false } })
  await restarted.save({ ...retained, revision: 4, held: true })
  await restarted.bindDecision(legacyTarget, 'retry', { legacy: { optionIds: ['coast'] } })
  const receipt = { requestId: legacy.id, questionsDigest: requestQuestionsDigest(legacyTarget.questions) }
  state = { ...state, requests: [], completed: [{ ...receipt, decisionId: 'actual' }] }
  await restarted.reconcile()
  expect((await restarted.get(legacyTarget))?.decisionId).toBe('retry')
  state = { ...state, completed: [{ ...receipt, decisionId: 'retry' }] }
  await restarted.reconcile()
  expect(await restarted.get(legacyTarget)).toBeNull()
})

it('returns explicit acceptance for the exact retired held revision', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const service = new RequestDraftService(directory, () => state, async () => {
    state = { connected: false, ready: true, requests: [], completed: [{ requestId: target.requestId,
      decisionId: 'accepted-attempt', questionsDigest: requestQuestionsDigest(questions) }] }
  })
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'accepted-attempt', submittedAnswers)
  expect(await service.check(target)).toEqual({ status: 'accepted', decisionId: 'accepted-attempt', revision: 1 })
  expect(await service.get(target)).toBeNull()
  expect((await disk()).drafts).toEqual([])
})

it('reports exact acceptance when refresh publication already reconciled the captured hold', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const service: RequestDraftService = new RequestDraftService(directory, () => state, async () => {
    state = { connected: false, ready: true, requests: [], completed: [{ requestId: target.requestId,
      decisionId: 'published-attempt', questionsDigest: requestQuestionsDigest(questions) }] }
    await service.reconcile()
    expect(await service.get(target)).toBeNull()
  })
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'published-attempt', submittedAnswers)
  await expect(service.check(target)).resolves.toEqual({ status: 'accepted', decisionId: 'published-attempt', revision: 1 })
  expect((await disk()).drafts).toEqual([])
})

it.each([false, true])('a delayed Check preserves a newer saved revision (held %s)', async held => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }

  const { promise: started, resolve: begin } = deferred<void>()
  const { promise: gate, resolve: finish } = deferred<void>()
  const refresh = vi.fn(async () => {})
  refresh.mockImplementationOnce(async () => { begin(); await gate })
  const service = new RequestDraftService(directory, () => state, refresh)
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'older-attempt', submittedAnswers)
  const checking = service.check(target)
  const rejection = expect(checking).rejects.toThrow('newer answer draft')
  try {
    await started
    await service.check(target)
    await service.save(draft({ revision: 3, held }))
    if (held) await service.bindDecision(target, 'newer-attempt', submittedAnswers)
    const newer = await service.get(target)
    state = { ...state, completed: [{ requestId: target.requestId, decisionId: 'older-attempt',
      questionsDigest: requestQuestionsDigest(questions) }] }
    finish()
    await rejection
    expect(await service.get(target)).toEqual(newer)
    expect((await disk()).drafts).toEqual([newer])
  } finally { finish(); await checking.catch(() => {}) }
})

it('reports already retired acceptance before Check and after restart without another native read', async () => {
  let state: RequestDraftOwnerState | undefined = { connected: true, ready: true, requests: [request] }
  const refresh = vi.fn(async () => {})
  const service = new RequestDraftService(directory, () => state, refresh)
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'background-accepted', submittedAnswers)
  state = { connected: true, ready: true, requests: [request],
    completed: [{ requestId: target.requestId, decisionId: 'background-accepted', questionsDigest: requestQuestionsDigest(questions) }] }
  await service.reconcile()
  const accepted = { status: 'accepted', decisionId: 'background-accepted', revision: 1 }
  await expect(service.check(target)).resolves.toEqual(accepted)
  expect(refresh).not.toHaveBeenCalled()
  state = undefined
  const restarted = new RequestDraftService(directory, () => state, refresh)
  await restarted.start()
  expect(await restarted.status(target)).toEqual(accepted)
  expect(await restarted.check(target)).toEqual(accepted)
  expect(refresh).not.toHaveBeenCalled()
  const contents = await readFile(join(directory, 'request-drafts.json'), 'utf8')
  for (const words of ['Destination?', 'A quiet beach', 'Keep this unsent', 'Coast', 'Notes?']) expect(contents).not.toContain(words)
  expect(JSON.parse(contents)).toEqual({ version: 2, drafts: [], retirements: [{ owner, requestId: target.requestId,
    questionsDigest: requestQuestionsDigest(questions), decisionId: 'background-accepted', revision: 1 }] })
})

it('isolates retired thread status by owner, provider, request and form, and prefers a newer draft', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const service = new RequestDraftService(directory, () => state, async () => {})
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'isolated', submittedAnswers)
  state = { ...state, completed: [{ requestId: target.requestId, decisionId: 'isolated', questionsDigest: requestQuestionsDigest(questions) }] }
  await service.reconcile()
  for (const other of [{ ...target, ownerId: 'other' },
    { ...target, providerId: 'claude' as const }, { ...target, requestId: 'other' },
    { ...target, questions: [{ ...questions[1]!, question: 'Another form' }] }]) {
    expect(await service.status(other)).toEqual({ status: 'missing' })
  }
  await expect(service.save(draft())).rejects.toThrow('already accepted')
  const newer = draft({ revision: 2, selections: { notes: { optionIds: [], other: false, text: 'Newer local edit' } } })
  await service.save(newer)
  expect(await service.status(target)).toEqual({ status: 'draft', draft: newer })
  expect(await service.check(target)).toEqual({ status: 'editable', draft: newer })
  expect(await service.get(target)).toEqual(newer)
})

it('keeps held text and emits no accepted status or notification when atomic retirement fails', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const seed = new RequestDraftService(directory, () => state, async () => {})
  await seed.start(); await seed.save(draft({ held: true }))
  await seed.bindDecision(target, 'atomic-accepted', submittedAnswers)
  const before = await readFile(join(directory, 'request-drafts.json'), 'utf8')
  const write = vi.fn().mockRejectedValueOnce(new Error('disk denied')).mockImplementation(async value => {
    await writeFile(join(directory, 'request-drafts.json'), JSON.stringify(value))
  })
  const service = new RequestDraftService(directory, () => state, async () => {}, { write })
  await service.start()
  const changed = vi.fn(); service.onChanged(changed)
  state = { connected: false, ready: true, requests: [], completed: [{ requestId: target.requestId,
    decisionId: 'atomic-accepted', questionsDigest: requestQuestionsDigest(questions) }] }
  await expect(service.reconcile()).rejects.toThrow('Could not save')
  expect(await service.status(target)).toEqual({ status: 'draft', draft: { ...draft({ held: true }), decisionId: 'atomic-accepted' } })
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(before)
  expect(changed).not.toHaveBeenCalled()
  await service.reconcile()
  expect(await service.status(target)).toEqual({ status: 'accepted', decisionId: 'atomic-accepted', revision: 1 })
  expect(changed).toHaveBeenCalledExactlyOnceWith(owner)
  expect(write).toHaveBeenCalledTimes(2)
  expect(write.mock.calls[1]![0]).toMatchObject({ drafts: [], retirements: [{ decisionId: 'atomic-accepted' }] })
})

it('bounds retirement metadata at 512 and never treats an evicted or unrelated form as accepted', async () => {
  const drafts = Array.from({ length: 513 }, (_, index) => draft({ target: { ...target, requestId: `request-${index}` },
    held: true, decisionId: `attempt-${index}` }))
  await writeFile(join(directory, 'request-drafts.json'), JSON.stringify({ version: 1, drafts }))
  const state: RequestDraftOwnerState = { connected: false, ready: true, requests: [], completed: drafts.map(item => ({
    requestId: item.target.requestId, decisionId: item.decisionId!, questionsDigest: requestQuestionsDigest(questions) })) }
  const write = vi.fn(async value => { await writeFile(join(directory, 'request-drafts.json'), JSON.stringify(value)) })
  const service = new RequestDraftService(directory, () => state, async () => {}, { write })
  await service.start(); await service.reconcile()
  expect(write).toHaveBeenCalledOnce()
  const saved = JSON.parse(await readFile(join(directory, 'request-drafts.json'), 'utf8'))
  expect(saved.drafts).toEqual([]); expect(saved.retirements).toHaveLength(512)
  expect(await service.status(drafts[0]!.target)).toEqual({ status: 'missing' })
  expect(await service.status(drafts[512]!.target)).toEqual({ status: 'accepted', decisionId: 'attempt-512', revision: 1 })
  await expect(service.check(drafts[0]!.target)).rejects.toThrow('still unconfirmed')
  expect(await service.status({ ...drafts[512]!.target, ownerId: 'other' })).toEqual({ status: 'missing' })
})

it('rejects a delayed save that would recreate a retired revision', async () => {
  const state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request], completed: [] }
  const service = new RequestDraftService(directory, () => state, async () => {})
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'accepted-before-save', submittedAnswers)
  const lookup = { ...state, completed: [{ requestId: target.requestId, decisionId: 'accepted-before-save',
    questionsDigest: requestQuestionsDigest(questions) }] }
  const restarted = new RequestDraftService(directory, () => lookup, async () => {})
  await restarted.start(); await restarted.reconcile()
  await expect(restarted.save(draft())).rejects.toThrow('already accepted')
  expect((await disk()).drafts).toEqual([])
})

it('passes the captured held decision into the native refresh', async () => {
  const refresh = vi.fn(async () => {})
  const service = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [request] }), refresh)
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'captured-for-refresh', submittedAnswers)
  await service.check(target)
  expect(refresh).toHaveBeenCalledExactlyOnceWith(target, 'captured-for-refresh')
})

it('reads legacy v1 drafts without inventing retirement status or rewriting storage', async () => {
  const contents = JSON.stringify({ version: 1, drafts: [draft()] })
  await writeFile(join(directory, 'request-drafts.json'), contents)
  const refresh = vi.fn(async () => {})
  const service = new RequestDraftService(directory, () => undefined, refresh)
  await service.start()
  expect(await service.status(target)).toEqual({ status: 'draft', draft: draft() })
  expect(await service.status({ ...target, requestId: 'missing' })).toEqual({ status: 'missing' })
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(contents)
  expect(refresh).not.toHaveBeenCalled()
})

it.each(['digest', 'words', 'duplicate', 'bound'] as const)('preserves malformed retirement storage (%s) verbatim', async invalid => {
  const retirement = { owner, requestId: target.requestId, questionsDigest: requestQuestionsDigest(questions),
    decisionId: 'stored-attempt', revision: 1 }
  const retirements = invalid === 'digest' ? [{ ...retirement, questionsDigest: 'not-a-digest' }]
    : invalid === 'words' ? [{ ...retirement, answer: 'private answer words' }]
      : invalid === 'duplicate' ? [retirement, retirement]
        : Array.from({ length: 513 }, (_, index) => ({ ...retirement, requestId: `request-${index}` }))
  const contents = JSON.stringify({ version: 1, drafts: [draft({ held: true })], retirements })
  await writeFile(join(directory, 'request-drafts.json'), contents)
  const service = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [request] }), async () => {})
  await service.start()
  await expect(service.status(target)).rejects.toThrow('original request-drafts.json is unchanged')
  await expect(service.save(draft({ revision: 2 }))).rejects.toThrow('original request-drafts.json is unchanged')
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(contents)
  expect(await readdir(directory)).toEqual(['request-drafts.json'])
})

it('does not replace a newer accepted retirement with a delayed older Check result', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }

  const { promise: started, resolve: begin } = deferred<void>()
  const { promise: gate, resolve: finish } = deferred<void>()
  const refresh = vi.fn(async () => {})
  refresh.mockImplementationOnce(async () => { begin(); await gate })
  const service = new RequestDraftService(directory, () => state, refresh)
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'old-retirement', submittedAnswers)
  const checking = service.check(target)
  const rejection = expect(checking).rejects.toThrow('newer answer draft')
  try {
    await started
    await service.check(target)
    await service.save(draft({ revision: 3, held: true }))
    await service.bindDecision(target, 'new-retirement', submittedAnswers)
    state = { connected: false, ready: true, requests: [], completed: ['old-retirement', 'new-retirement'].map(decisionId => ({
      requestId: target.requestId, decisionId, questionsDigest: requestQuestionsDigest(questions) })) }
    await service.reconcile()
    const accepted = { status: 'accepted', decisionId: 'new-retirement', revision: 3 }
    expect(await service.status(target)).toEqual(accepted)
    finish(); await rejection
    expect(await service.status(target)).toEqual(accepted)
    expect((await disk()).drafts).toEqual([])
  } finally { finish(); await checking.catch(() => {}) }
})

it.each([false, true])('returns exact acceptance despite a later refresh failure (already retired %s)', async retired => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const failure = new Error('Detail disconnected after acceptance publication')
  const service: RequestDraftService = new RequestDraftService(directory, () => state, async () => {
    state = { connected: false, ready: true, requests: [], completed: [{ requestId: target.requestId,
      decisionId: 'accepted-before-detail-failure', questionsDigest: requestQuestionsDigest(questions) }] }
    if (retired) await service.reconcile()
    throw failure
  })
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'accepted-before-detail-failure', submittedAnswers)
  const accepted = { status: 'accepted', decisionId: 'accepted-before-detail-failure', revision: 1 }
  await expect(service.check(target)).resolves.toEqual(accepted)
  expect(await service.status(target)).toEqual(accepted)
  expect((await disk()).drafts).toEqual([])
})

it('keeps the original refresh failure and held draft without exact acceptance', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const failure = new Error('Original refresh failed')
  const service = new RequestDraftService(directory, () => state, async () => {
    state = { connected: true, ready: true, requests: [request], completed: [{ requestId: target.requestId,
      decisionId: 'another-attempt', questionsDigest: requestQuestionsDigest(questions) }] }
    throw failure
  })
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'still-held', submittedAnswers)
  await expect(service.check(target)).rejects.toBe(failure)
  expect(await service.status(target)).toEqual({ status: 'draft', draft: { ...draft({ held: true }), decisionId: 'still-held' } })
})

it('does not report accepted after refresh failure when the retirement write still fails', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const seed = new RequestDraftService(directory, () => state, async () => {})
  await seed.start(); await seed.save(draft({ held: true }))
  await seed.bindDecision(target, 'not-durable', submittedAnswers)
  const before = await readFile(join(directory, 'request-drafts.json'), 'utf8')
  const write = vi.fn(async () => { throw new Error('disk denied') })
  const service: RequestDraftService = new RequestDraftService(directory, () => state, async () => {
    state = { connected: false, ready: true, requests: [], completed: [{ requestId: target.requestId,
      decisionId: 'not-durable', questionsDigest: requestQuestionsDigest(questions) }] }
    await service.reconcile()
    throw new Error('Detail disconnected')
  }, { write })
  await service.start()
  const changed = vi.fn(); service.onChanged(changed)
  await expect(service.check(target)).rejects.toThrow('Could not save')
  expect(await service.status(target)).toEqual({ status: 'draft', draft: { ...draft({ held: true }), decisionId: 'not-durable' } })
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(before)
  expect(changed).not.toHaveBeenCalled()
})
