// @vitest-environment node
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RequestDraftService, requestQuestionsDigest, type RequestDraftOwnerState } from '../../../src/main/agents/requestDrafts'
import { questions, target, submittedAnswers, owner, request, draft, directory, disk, registerRequestDraftFixture } from '../../fixtures/requestDrafts'

registerRequestDraftFixture()

it('migrates original v1 only on a successful v2 commit and preserves a failed first write', async () => {
  const contents = JSON.stringify({ version: 1, drafts: [draft()] })
  await writeFile(join(directory, 'request-drafts.json'), contents)
  const write = vi.fn().mockRejectedValueOnce(new Error('disk denied')).mockImplementation(async value => {
    await writeFile(join(directory, 'request-drafts.json'), JSON.stringify(value))
  })
  const service = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [request] }), async () => {}, { write })
  await service.start()
  expect(await service.status(target)).toEqual({ status: 'draft', draft: draft() })
  expect(write).not.toHaveBeenCalled()
  await expect(service.save(draft({ revision: 2 }))).rejects.toThrow('Could not save')
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(contents)
  expect(await service.status(target)).toEqual({ status: 'draft', draft: draft() })
  await service.save(draft({ revision: 2 }))
  expect(JSON.parse(await readFile(join(directory, 'request-drafts.json'), 'utf8'))).toEqual({
    version: 2, drafts: [draft({ revision: 2 })], retirements: [],
  })
  const restarted = new RequestDraftService(directory, () => undefined, async () => {})
  await restarted.start()
  expect(await restarted.status(target)).toEqual({ status: 'draft', draft: draft({ revision: 2 }) })
  expect(await readdir(directory)).toEqual(['request-drafts.json'])
})

it.each([1, 2])('preserves strictly validated retirement records from version %s through a v2 write and restart', async version => {
  const retirement = { owner, requestId: target.requestId, questionsDigest: requestQuestionsDigest(questions),
    decisionId: 'accepted-before-upgrade', revision: 1 }
  const contents = JSON.stringify({ version, drafts: [], retirements: [retirement] })
  await writeFile(join(directory, 'request-drafts.json'), contents)
  const service = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [request] }), async () => {})
  await service.start()
  expect(await service.status(target)).toEqual({ status: 'accepted', decisionId: retirement.decisionId, revision: 1 })
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(contents)
  await service.save(draft({ revision: 2 }))
  expect(JSON.parse(await readFile(join(directory, 'request-drafts.json'), 'utf8'))).toEqual({
    version: 2, drafts: [draft({ revision: 2 })], retirements: [retirement],
  })
  const restarted = new RequestDraftService(directory, () => undefined, async () => {})
  await restarted.start()
  expect(await restarted.status(target)).toEqual({ status: 'draft', draft: draft({ revision: 2 }) })
})

it.each([
  { version: 2, drafts: [] },
  { version: 2, drafts: [], retirements: null },
  { version: 3, drafts: [], retirements: [] },
  { version: 1, drafts: [], unknown: true },
])('refuses malformed or unsupported storage without falling back to empty drafts (%j)', async invalid => {
  const contents = JSON.stringify(invalid)
  await writeFile(join(directory, 'request-drafts.json'), contents)
  const service = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [request] }), async () => {})
  await service.start()
  await expect(service.status(target)).rejects.toThrow('original request-drafts.json is unchanged')
  await expect(service.save(draft())).rejects.toThrow('original request-drafts.json is unchanged')
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(contents)
  expect(await readdir(directory)).toEqual(['request-drafts.json'])
})

it.each([['delivery', false], ['delivery', true], ['answerRetryReady', false], ['answerRetryReady', true]] as const)(
  'requires a fresh Check across retired native re-offer (%s, fresh retry readiness %s)', async (flag, retryReady) => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const refresh = vi.fn(async () => {
    state = { ...state, requests: [{ ...request, ...(retryReady ? { answerRetryReady: true as const } : {}) }], uncertainRequestIds: [] }
  })
  const service = new RequestDraftService(directory, () => state, refresh)
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'historical-attempt', submittedAnswers)
  state = { ...state, requests: [], completed: [{ requestId: target.requestId, decisionId: 'historical-attempt',
    questionsDigest: requestQuestionsDigest(questions) }] }
  await service.reconcile()
  state = { ...state, requests: [{ ...request, ...(flag === 'delivery' ? { delivery: 'uncertain' as const } : { answerRetryReady: true as const }) }] }
  expect(await service.status(target)).toEqual({ status: 'unconfirmed', revision: 1 })
  const editable = { target, revision: 2, selections: {}, held: false }
  expect(await service.check(target)).toEqual({ status: 'editable', draft: editable })
  expect(refresh).toHaveBeenCalledExactlyOnceWith(target, undefined)
  expect(await service.status(target)).toEqual({ status: 'draft', draft: editable })
  const saved = JSON.parse(await readFile(join(directory, 'request-drafts.json'), 'utf8'))
  expect(saved.drafts).toEqual([editable]); expect(saved.retirements[0]).toMatchObject({ decisionId: 'historical-attempt', revision: 1 })
  await expect(service.save(draft())).rejects.toThrow('already accepted')
})

it.each(['delivery', 'answerRetryReady'] as const)('does not retire a bound hold from old completed proof at native re-offer (%s)', async flag => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const refresh = vi.fn(async () => { state = { ...state, requests: [{ ...request, answerRetryReady: true }], uncertainRequestIds: [] } })
  const service = new RequestDraftService(directory, () => state, refresh)
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'old-completed', submittedAnswers)
  state = { ...state, requests: [{ ...request, ...(flag === 'delivery' ? { delivery: 'uncertain' as const } : { answerRetryReady: true as const }) }],
    completed: [{ requestId: target.requestId, decisionId: 'old-completed', questionsDigest: requestQuestionsDigest(questions) }] }
  await service.reconcile()
  expect(await service.get(target)).toEqual({ ...draft({ held: true }), decisionId: 'old-completed' })
  expect(await service.check(target)).toEqual({ status: 'editable', draft: draft({ revision: 2 }) })
  expect(refresh).toHaveBeenCalledExactlyOnceWith(target, 'old-completed')
  expect((await disk()).drafts).toEqual([draft({ revision: 2 })])
})

it.each(['delivery', 'answerRetryReady'] as const)('keeps re-offered hold when flags appear during a failed refresh (%s)', async flag => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const failure = new Error('Fresh native Check failed')
  const service: RequestDraftService = new RequestDraftService(directory, () => state, async () => {
    state = { ...state, requests: [{ ...request, ...(flag === 'delivery' ? { delivery: 'uncertain' as const } : { answerRetryReady: true as const }) }],
      completed: [{ requestId: target.requestId, decisionId: 'historical', questionsDigest: requestQuestionsDigest(questions) }] }
    await service.reconcile()
    throw failure
  })
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'historical', submittedAnswers)
  await expect(service.check(target)).rejects.toBe(failure)
  expect(await service.status(target)).toEqual({ status: 'draft', draft: { ...draft({ held: true }), decisionId: 'historical' } })
})

it('does not satisfy a re-offer from historical retirement after its fresh Check disconnects', async () => {
  let state: RequestDraftOwnerState | undefined = { connected: true, ready: true, requests: [request] }
  const failure = new Error('Native Check disconnected')
  const refresh = vi.fn(async () => { state = undefined; throw failure })
  const service = new RequestDraftService(directory, () => state, refresh)
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'historical', submittedAnswers)
  state = { connected: true, ready: true, requests: [], completed: [{ requestId: target.requestId,
    decisionId: 'historical', questionsDigest: requestQuestionsDigest(questions) }] }
  await service.reconcile()
  state = { ...state, requests: [{ ...request, delivery: 'uncertain' }] }
  await expect(service.check(target)).rejects.toBe(failure)
  expect(refresh).toHaveBeenCalledExactlyOnceWith(target, undefined)
  expect((await disk()).drafts).toEqual([])
})

it('keeps retired re-offer unconfirmed when a successful read still reports native uncertainty', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const refresh = vi.fn(async () => {})
  const service = new RequestDraftService(directory, () => state, refresh)
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'historical', submittedAnswers)
  state = { ...state, requests: [], completed: [{ requestId: target.requestId, decisionId: 'historical', questionsDigest: requestQuestionsDigest(questions) }] }
  await service.reconcile()
  state = { ...state, requests: [{ ...request, delivery: 'uncertain' }] }
  await expect(service.check(target)).rejects.toThrow('still unconfirmed')
  expect(refresh).toHaveBeenCalledExactlyOnceWith(target, undefined)
  expect(await service.status(target)).toEqual({ status: 'unconfirmed', revision: 1 })
  expect((await disk()).drafts).toEqual([])
})

it('preserves retired floor and unconfirmed status when saving the fresh blank form fails', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const seed = new RequestDraftService(directory, () => state, async () => {})
  await seed.start(); await seed.save(draft({ held: true }))
  await seed.bindDecision(target, 'historical', submittedAnswers)
  state = { ...state, requests: [], completed: [{ requestId: target.requestId, decisionId: 'historical', questionsDigest: requestQuestionsDigest(questions) }] }
  await seed.reconcile()
  state = { ...state, requests: [{ ...request, delivery: 'uncertain' }] }
  const before = await readFile(join(directory, 'request-drafts.json'), 'utf8')
  const service = new RequestDraftService(directory, () => state, async () => {
    state = { ...state, requests: [{ ...request, answerRetryReady: true }] }
  }, { write: async () => { throw new Error('disk denied') } })
  await service.start()
  const changed = vi.fn(); service.onChanged(changed)
  await expect(service.check(target)).rejects.toThrow('Could not save')
  expect(await service.status(target)).toEqual({ status: 'unconfirmed', revision: 1 })
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(before)
  expect(changed).not.toHaveBeenCalled()
})

it('preserves a newer saved edit while a retired re-offer Check awaits its fresh read', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  let begin!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { begin = resolve })
  const gate = new Promise<void>(resolve => { finish = resolve })
  const service = new RequestDraftService(directory, () => state, async () => {
    begin(); await gate
    state = { ...state, requests: [{ ...request, answerRetryReady: true }] }
  })
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'historical', submittedAnswers)
  state = { ...state, requests: [], completed: [{ requestId: target.requestId, decisionId: 'historical', questionsDigest: requestQuestionsDigest(questions) }] }
  await service.reconcile()
  state = { ...state, requests: [{ ...request, delivery: 'uncertain' }] }
  const checking = service.check(target)
  const rejection = expect(checking).rejects.toThrow('newer answer draft')
  try {
    await started
    const newer = draft({ revision: 2, selections: { notes: { optionIds: [], other: false, text: 'Newer local edit' } } })
    await service.save(newer)
    finish(); await rejection
    expect(await service.status(target)).toEqual({ status: 'draft', draft: newer })
    expect((await disk()).drafts).toEqual([newer])
  } finally { finish(); await checking.catch(() => {}) }
})

it('does not apply another native form retry flag to the historical exact retirement', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const refresh = vi.fn(async () => {})
  const service = new RequestDraftService(directory, () => state, refresh)
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'historical', submittedAnswers)
  state = { ...state, requests: [], completed: [{ requestId: target.requestId, decisionId: 'historical', questionsDigest: requestQuestionsDigest(questions) }] }
  await service.reconcile()
  state = { ...state, requests: [{ ...request, questions: [{ ...questions[1]!, question: 'A different request form' }], delivery: 'uncertain' }] }
  const accepted = { status: 'accepted', decisionId: 'historical', revision: 1 }
  expect(await service.status(target)).toEqual(accepted)
  expect(await service.check(target)).toEqual(accepted)
  expect(refresh).not.toHaveBeenCalled()
})

it.each([[false, false], [true, false], [false, true], [true, true]])(
  'confirms an uncertain held attempt that completes during Check (retired %s, read failed %s)', async (retired, failed) => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const failure = new Error('Native read ended after the same answer completed')
  const refresh = vi.fn(async () => {
    state = { connected: !failed, ready: true, requests: [], completed: [{ requestId: target.requestId,
      decisionId: 'pending-at-check', questionsDigest: requestQuestionsDigest(questions) }] }
    if (retired) await service.reconcile()
    if (failed) throw failure
  })
  const service = new RequestDraftService(directory, () => state, refresh)
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'pending-at-check', submittedAnswers)
  state = { ...state, requests: [{ ...request, delivery: 'uncertain' }], uncertainRequestIds: [request.id] }
  const accepted = { status: 'accepted', decisionId: 'pending-at-check', revision: 1 }
  await expect(service.check(target)).resolves.toEqual(accepted)
  expect(refresh).toHaveBeenCalledExactlyOnceWith(target, 'pending-at-check')
  expect(await service.status(target)).toEqual(accepted)
  expect((await disk()).drafts).toEqual([])
})

it.each([false, true])('does not let newly discovered historical proof retire a still-offered re-ask (retry marker %s)', async retryReady => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const service = new RequestDraftService(directory, () => state, async () => {
    state = { ...state, requests: [{ ...request, ...(retryReady ? { answerRetryReady: true } : {}) }],
      completed: [{ requestId: request.id, decisionId: 'historical-found-during-check', questionsDigest: requestQuestionsDigest(questions) }] }
  })
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'historical-found-during-check', submittedAnswers)
  state = { ...state, requests: [{ ...request, delivery: 'uncertain' }] }
  await expect(service.check(target)).resolves.toEqual({ status: 'editable', draft: draft({ revision: 2 }) })
  expect(await disk()).toMatchObject({ retirements: [] })
})

it.each(['known-proof', 'retry-ready'] as const)('keeps the historical %s boundary when its re-ask disappears during Check', async boundary => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const completed = [{ requestId: request.id, decisionId: 'historical', questionsDigest: requestQuestionsDigest(questions) }]
  const service = new RequestDraftService(directory, () => state, async () => {
    state = { ...state, requests: [], completed }
  })
  await service.start(); await service.save(draft({ held: true }))
  await service.bindDecision(target, 'historical', submittedAnswers)
  state = { ...state, requests: [{ ...request, ...(boundary === 'retry-ready' ? { answerRetryReady: true } : { delivery: 'uncertain' as const }) }],
    ...(boundary === 'known-proof' ? { completed } : {}) }
  await expect(service.check(target)).rejects.toThrow('still unconfirmed')
  expect((await disk()).drafts).toEqual([{ ...draft({ held: true }), decisionId: 'historical' }])
  expect(await disk()).toMatchObject({ retirements: [] })
})
