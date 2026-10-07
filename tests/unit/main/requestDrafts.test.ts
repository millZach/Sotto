// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestDraftService, requestQuestionsDigest, type RequestDraftOwnerState } from '../../../src/main/agents/requestDrafts'
import { requestDraftQuestions, requestDraftSchema, type RequestDraft, type RequestDraftTarget } from '../../../src/shared/requestDrafts'
import type { AgentRequest } from '../../../src/shared/agents'

const questions = [
  { id: 'choice', question: 'Destination?', multiSelect: true, allowFreeText: true, options: [{ id: 'coast', label: 'Coast' }, { id: 'hills', label: 'Hills' }] },
  { id: 'notes', question: 'Notes?', multiSelect: false, allowFreeText: true, options: [] },
]
const target: RequestDraftTarget = { kind: 'thread', ownerId: 'owner', providerId: 'codex', requestId: 'request', questions }
const submittedAnswers = { choice: { optionIds: ['coast'], text: 'A quiet beach' }, notes: { optionIds: [], text: 'Keep this unsent' } }
const owner = { kind: target.kind, ownerId: target.ownerId, providerId: target.providerId }
const request: AgentRequest = { id: target.requestId, kind: 'question', text: 'Native context', options: [], questions }
const draft = (patch: Partial<RequestDraft> = {}): RequestDraft => requestDraftSchema.parse({ target, revision: 1, held: false,
  selections: { choice: { optionIds: ['coast'], other: true, text: 'A quiet beach' }, notes: { optionIds: [], other: false, text: 'Keep this unsent' } }, ...patch })
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-request-drafts-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const disk = async (): Promise<{ drafts: RequestDraft[] }> => JSON.parse(await readFile(join(directory, 'request-drafts.json'), 'utf8'))

it('publishes only owner identities after a durable write, never failed writes or unsubscribed listeners', async () => {
  let releaseWrite: () => void = () => undefined
  let startedWrite: () => void = () => undefined
  const started = new Promise<void>(resolve => { startedWrite = resolve })
  const gate = new Promise<void>(resolve => { releaseWrite = resolve })
  const write = vi.fn(async (value: unknown) => {
    startedWrite()
    await gate
    await writeFile(join(directory, 'request-drafts.json'), JSON.stringify(value))
  })
  const service = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [request] }), async () => {}, { write })
  await service.start()
  const changed = vi.fn()
  const off = service.onChanged(changed)
  const saving = service.save(draft())
  await started
  expect(changed).not.toHaveBeenCalled()
  releaseWrite()
  await saving
  expect((await disk()).drafts).toEqual([draft()])
  expect(changed).toHaveBeenCalledExactlyOnceWith(owner)
  expect(JSON.stringify(changed.mock.calls)).not.toContain('A quiet beach')
  expect(JSON.stringify(changed.mock.calls)).not.toContain('questions')
  changed.mockClear()
  await service.save(draft())
  await service.reconcile()
  expect(changed).not.toHaveBeenCalled()
  write.mockRejectedValueOnce(new Error('Synthetic disk write refused'))
  await expect(service.save(draft({ revision: 2 }))).rejects.toThrow('Could not save')
  expect(changed).not.toHaveBeenCalled()
  expect((await disk()).drafts).toEqual([draft()])
  off()
  await service.save(draft({ revision: 2 }))
  expect(changed).not.toHaveBeenCalled()
  expect((await disk()).drafts[0]?.revision).toBe(2)
})

it('publishes each changed owner once when accepted holds are retired and ignores untouched owners', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const service = new RequestDraftService(directory, () => state, async () => {})
  await service.start()
  const otherTarget = { ...target, ownerId: 'other-owner' }
  const untouchedTarget = { ...target, ownerId: 'untouched-owner' }
  await service.save(draft({ held: true }))
  await service.bindDecision(target, 'first-attempt', submittedAnswers)
  await service.save(draft({ target: otherTarget, held: true }))
  await service.bindDecision(otherTarget, 'other-attempt', submittedAnswers)
  await service.save(draft({ target: untouchedTarget }))
  const changed = vi.fn()
  service.onChanged(changed)
  state = { ...state, requests: [], completed: ['first-attempt', 'other-attempt'].map(decisionId => ({
    decisionId, requestId: target.requestId, questionsDigest: requestQuestionsDigest(questions),
  })) }
  await service.reconcile()
  expect(changed.mock.calls.map(([value]) => value)).toEqual([owner, { ...owner, ownerId: otherTarget.ownerId }])
  expect((await disk()).drafts).toEqual([draft({ target: untouchedTarget })])
  changed.mockClear()
  await service.reconcile()
  expect(changed).not.toHaveBeenCalled()
})

it('retains the first queued edit when the provider closes the question before its first save', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const service = new RequestDraftService(directory, () => state, async () => {})
  await service.start()
  expect(await service.get(target)).toBeNull()
  state = { ...state, requests: [] }
  await service.save(draft())
  const restarted = new RequestDraftService(directory, () => state, async () => {})
  await restarted.start()
  expect(await restarted.list(owner)).toEqual([draft()])
  await expect(restarted.save(draft({ revision: 2, held: true }))).rejects.toThrow('Reconnect and check')
  expect((await disk()).drafts).toEqual([draft()])
})

describe('request-owned atomic drafts', () => {
  it('keeps threaded answers, multiple requests and separate providers across restart, independently of composer/history', async () => {
    const state = { connected: true, ready: true, requests: [request, { ...request, id: 'second' }] }
    const service = new RequestDraftService(directory, () => state, async () => {})
    await service.start()
    const targets: RequestDraftTarget[] = [target, { ...target, providerId: 'claude' }, { ...target, requestId: 'second' }, { ...target, ownerId: 'other' }]
    await writeFile(join(directory, 'composer.json'), 'a separate composer')
    for (const [index, target] of targets.entries()) await service.save(draft({ target, revision: index + 1 }))
    const restarted = new RequestDraftService(directory, () => ({ ...state, connected: false, requests: [] }), async () => {})
    await restarted.start(); await restarted.reconcile()
    for (const [index, target] of targets.entries()) expect(await restarted.get(target)).toEqual(draft({ target, revision: index + 1 }))
    expect(await readFile(join(directory, 'composer.json'), 'utf8')).toBe('a separate composer')
    expect((await disk()).drafts).toHaveLength(4)
  })

  it('retains restored and in-flight drafts through empty disconnected/loading/reconnect snapshots; releases only after a fresh main read', async () => {
    let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
    const service = new RequestDraftService(directory, () => state, async () => {})
    await service.start(); await service.save(draft({ held: true }))
    state = { connected: false, ready: true, requests: [] }
    const refresh = vi.fn(async () => { state = { connected: true, ready: true, requests: [{ ...request, delivery: 'uncertain' }] } })
    const restarted = new RequestDraftService(directory, () => state, refresh)
    await restarted.start()
    for (const next of [state, { ...state, connected: true, ready: false }, { ...state, connected: true, ready: true }]) {
      state = next; await restarted.reconcile(); expect((await restarted.get(target))?.held).toBe(true)
    }
    await expect(restarted.check(target)).rejects.toThrow('still unconfirmed')
    expect(refresh).toHaveBeenCalledTimes(1)
    refresh.mockImplementation(async () => { state = { connected: true, ready: true, requests: [request], uncertainRequestIds: ['request'] } })
    await expect(restarted.check(target)).rejects.toThrow('still unconfirmed')
    refresh.mockImplementation(async () => { state = { connected: true, ready: true, requests: [request] } })
    expect(await restarted.check(target)).toMatchObject({ status: 'editable', draft: { held: false, revision: 2 } })
  })

  it('cleans accepted held revisions on startup without a live snapshot; a newer editing revision survives', async () => {
    let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
    const service = new RequestDraftService(directory, () => state, async () => {})
    await service.start(); await service.save(draft({ held: true }))
    await service.bindDecision(target, 'attempt-1', submittedAnswers)
    const accepted = { requestId: target.requestId, questionsDigest: requestQuestionsDigest(questions), decisionId: 'attempt-1' }
    state = { connected: false, ready: false, requests: [], completed: [accepted] }
    const restarted = new RequestDraftService(directory, () => state, async () => {})
    await restarted.start(); await restarted.reconcile()
    expect(await restarted.get(target)).toBeNull()
    expect((await disk()).drafts).toEqual([])
    state = { connected: true, ready: true, requests: [request] }
    await service.check(target)
    await service.save(draft({ revision: 3, selections: { notes: { optionIds: [], other: false, text: 'Newer local edit' } } }))
    state = { ...state, connected: false, requests: [], completed: [accepted] }
    const newer = new RequestDraftService(directory, () => state, async () => {})
    await newer.start(); await newer.reconcile()
    expect((await newer.get(target))?.selections.notes?.text).toBe('Newer local edit')
  })

  it('retains observed disappeared held requests and a reused ID with different questions', async () => {
    let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request, { ...request, id: 'second' }] }
    const service = new RequestDraftService(directory, () => state, async () => {})
    await service.start(); await service.save(draft({ held: true })); await service.save(draft({ target: { ...target, requestId: 'second' } }))
    state = { ...state, requests: [{ ...request, id: 'second' }] }; await service.reconcile()
    expect((await service.get(target))?.held).toBe(true)
    expect(await service.get({ ...target, requestId: 'second' })).not.toBeNull()
    await expect(service.save(draft({ held: true, revision: 2 }))).rejects.toThrow('Reconnect and check')
    const changed = { ...target, questions: [{ ...questions[1]!, question: 'An entirely new question' }] }
    state = { ...state, requests: [{ ...request, questions: changed.questions }] }
    expect(await service.get(changed)).toBeNull()
    await service.save(draft({ target: changed, selections: {} }))
    expect((await service.get(changed))?.selections).toEqual({})
  })

  it('rejects foreign questions/options, duplicate identities, unknown owners, stale revisions and held edits', async () => {
    const service = new RequestDraftService(directory, owner => owner.ownerId === 'owner' && owner.providerId === 'codex'
      ? { connected: true, ready: true, requests: [request] } : undefined, async () => {})
    await service.start()
    for (const selections of [ { alien: { optionIds: [], other: false, text: '' } }, { choice: { optionIds: ['alien'], other: false, text: '' } } ]) {
      expect(() => service.save({ ...draft(), selections })).toThrow()
    }
    expect(() => service.save({ ...draft(), target: { ...target, questions: [questions[0]!, questions[0]!] } })).toThrow()
    await expect(service.save(draft({ target: { ...target, ownerId: 'unknown' } }))).rejects.toThrow('no longer available')
    await expect(service.save(draft({ target: { ...target, providerId: 'grok' } }))).rejects.toThrow('no longer available')
    await service.save(draft({ revision: 4 }))
    await expect(service.save(draft({ revision: 3 }))).rejects.toThrow('newer answer')
    await expect(service.save(draft({ revision: 4, selections: {} }))).rejects.toThrow('newer answer')
    await service.save(draft({ revision: 5, held: true }))
    await expect(service.save(draft({ revision: 6 }))).rejects.toThrow('Check this answer')
    await expect(service.save(draft({ revision: 6, held: true, selections: {} }))).rejects.toThrow('held revision')
  })

  it.each(['{ broken', JSON.stringify({ version: 1, drafts: [{ ...draft(), selections: { wrong: { optionIds: [], other: false, text: 'private' } } }] }),
    JSON.stringify({ version: 1, drafts: [draft(), draft()] })])('preserves invalid storage verbatim without creating plaintext backups', async contents => {
    await writeFile(join(directory, 'request-drafts.json'), contents)
    const service = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [request] }), async () => {})
    await service.start()
    await expect(service.get(target)).rejects.toThrow('original request-drafts.json is unchanged')
    await expect(service.list(owner)).rejects.toThrow('original request-drafts.json is unchanged')
    await expect(service.discard({ target, revision: 1 })).rejects.toThrow('original request-drafts.json is unchanged')
    await expect(service.save(draft())).rejects.toThrow('original request-drafts.json is unchanged')
    await expect(service.privacyChanged(false)).rejects.toThrow('original request-drafts.json is unchanged')
    expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(contents)
    expect(await readdir(directory)).toEqual(['request-drafts.json'])
  })

  it('reports failed atomic saves honestly, retains last durable revision and retries without poisoning subsequent writes', async () => {
    const state = { connected: true, ready: true, requests: [request] }
    const real = new RequestDraftService(directory, () => state, async () => {})
    await real.start(); await real.save(draft())
    const write = vi.fn().mockRejectedValueOnce(new Error('disk denied')).mockImplementation(async value => { await writeFile(join(directory, 'request-drafts.json'), JSON.stringify(value)) })
    const service = new RequestDraftService(directory, () => state, async () => {}, { write })
    await service.start()
    await expect(service.save(draft({ revision: 2 }))).rejects.toThrow('Could not save')
    expect((await service.get(target))?.revision).toBe(1)
    expect((await disk()).drafts[0]?.revision).toBe(1)
    expect(await service.save(draft({ revision: 2 }))).toMatchObject({ revision: 2 })
    expect((await disk()).drafts[0]?.revision).toBe(2)
  })

  it('loads a repaired file on restart and removes only its own abandoned atomic copies', async () => {
    const state = { connected: false, ready: false, requests: [] }
    await writeFile(join(directory, 'request-drafts.json'), '{broken')
    const service = new RequestDraftService(directory, () => state, async () => {})
    await service.start(); await expect(service.get(target)).rejects.toThrow('could not be read')
    await writeFile(join(directory, 'request-drafts.json'), JSON.stringify({ version: 1, drafts: [draft()] }))
    const abandoned = 'request-drafts.json.tmp-123-12345678-1234-1234-1234-123456789012'
    const unrelated = 'request-drafts.json.tmp-user-recovery'
    await writeFile(join(directory, abandoned), 'previously submitted private text')
    await writeFile(join(directory, unrelated), 'user-owned recovery')
    const restarted = new RequestDraftService(directory, () => state, async () => {})
    await restarted.start()
    expect(await restarted.get(target)).toEqual(draft())
    expect(await readdir(directory)).not.toContain(abandoned)
    expect(await readFile(join(directory, unrelated), 'utf8')).toBe('user-owned recovery')
  })
})

it('retains old and redefined forms across native shutdown and lists only the exact known owner', async () => {
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
  const lookup = (owner: RequestDraftTarget | { ownerId: string; providerId: string; kind: string }) =>
    owner.ownerId === target.ownerId && owner.providerId === target.providerId && owner.kind === target.kind ? state : undefined
  const service = new RequestDraftService(directory, lookup, async () => {})
  await service.start(); await service.save(draft())
  const changed = { ...target, questions: [{ ...questions[1]!, question: 'A different form' }] }
  state = { ...state, requests: [{ ...request, questions: changed.questions }] }
  await service.reconcile()
  expect((await disk()).drafts).toHaveLength(1)
  await service.save(draft({ target: changed, selections: { notes: { optionIds: [], other: false, text: 'Second form' } } }))
  state = { connected: false, ready: false, requests: [] }
  const refresh = vi.fn()
  const restarted = new RequestDraftService(directory, lookup, refresh)
  await restarted.start(); await restarted.reconcile()
  expect(await restarted.list(owner)).toEqual([draft(), draft({ target: changed, selections: { notes: { optionIds: [], other: false, text: 'Second form' } } })])
  state = { connected: true, ready: true, requests: [] }
  await restarted.reconcile()
  expect(await restarted.list(owner)).toHaveLength(2)
  expect(await restarted.list({ ...owner, ownerId: 'foreign' })).toEqual([])
  expect(await restarted.list({ ...owner, providerId: 'claude' })).toEqual([])
  expect(refresh).not.toHaveBeenCalled()
  await expect(restarted.discard({ target, revision: 2 })).rejects.toThrow('newer')
  expect(await restarted.discard({ target, revision: 1 })).toBe(true)
  expect((await disk()).drafts).toEqual([draft({ target: changed, selections: { notes: { optionIds: [], other: false, text: 'Second form' } } })])
})

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

it('retains legacy personal drafts while thread answers recover and rejects personal commands', async () => {
  const legacy = draft({ target: { ...target, kind: 'personal', ownerId: 'saved-chat' }, held: true, decisionId: 'old-personal-attempt' })
  const original = JSON.stringify({ version: 1, drafts: [legacy, draft()] })
  await writeFile(join(directory, 'request-drafts.json'), original)
  const service = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [request],
    completed: [{ requestId: legacy.target.requestId, questionsDigest: requestQuestionsDigest(legacy.target.questions), decisionId: 'old-personal-attempt' }],
  }), async () => {})
  await service.start(); await service.privacyChanged(true); await service.reconcile()
  expect(await service.list(owner)).toEqual([draft()])
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(original)
  expect(() => service.list({ kind: 'personal', ownerId: legacy.target.ownerId, providerId: legacy.target.providerId })).toThrow('Standalone chats')
  expect(() => service.get(legacy.target)).toThrow('Standalone chats')
  expect(() => service.status(legacy.target)).toThrow('Standalone chats')
  expect(() => service.save(legacy)).toThrow('Standalone chats')
  expect(() => service.bindDecision(legacy.target, 'new-attempt', {})).toThrow('Standalone chats')
  await expect(service.check(legacy.target)).rejects.toThrow('Standalone chats')
  expect(() => service.discard({ target: legacy.target, revision: 1 })).toThrow('Standalone chats')
  await service.save(draft({ revision: 2 }))
  expect((await disk()).drafts).toContainEqual(legacy)
  expect(await service.get(target)).toEqual(draft({ revision: 2 }))
})

it('removes retired submitted answer forms when history is off and keeps unsent forms and thread recovery', async () => {
  const personal = (providerId: RequestDraftTarget['providerId'], requestId: string, patch: Partial<RequestDraft>) => draft({
    ...patch, target: { ...target, kind: 'personal', providerId, ownerId: 'saved-chat', requestId },
  })
  const submitted = (['codex', 'claude', 'grok'] as const).flatMap(provider => [
    personal(provider, 'submitting', { held: true }),
    personal(provider, 'accepted', { held: true, decisionId: `${provider}-accepted` }),
    personal(provider, 'uncertain', { held: true, decisionId: `${provider}-uncertain` }),
    personal(provider, 'bound-without-held', { held: false, decisionId: `${provider}-bound` }),
  ])
  const unsent = personal('codex', 'unsent', { held: false })
  const pendingThread = draft({ target: { ...target, requestId: 'pending-thread' }, held: true, decisionId: 'thread-attempt' })
  const kept = [unsent, draft(), pendingThread]
  await writeFile(join(directory, 'request-drafts.json'), JSON.stringify({ version: 1, drafts: [...submitted, ...kept] }))
  const refresh = vi.fn()
  const state = { connected: true, ready: true, requests: [request] }
  const service = new RequestDraftService(directory, item => item.kind === 'thread' ? state : undefined, refresh)
  await service.start(); await service.privacyChanged(false)
  expect((await disk()).drafts).toEqual(kept)
  expect(await service.list(owner)).toEqual([draft(), pendingThread])
  expect(refresh).not.toHaveBeenCalled()
  await service.save(draft({ revision: 2 }))
  const restarted = new RequestDraftService(directory, () => state, refresh)
  await restarted.start(); await restarted.privacyChanged(true); await restarted.reconcile()
  expect((await disk()).drafts).toEqual([unsent, pendingThread, draft({ revision: 2 })])
  expect(await restarted.get(target)).toEqual(draft({ revision: 2 }))
})

it('retains submitted copies on a failed privacy write and retries without losing newer thread edits', async () => {
  const legacy = draft({ target: { ...target, kind: 'personal', ownerId: 'saved-chat' }, held: true, decisionId: 'personal-attempt' })
  const original = JSON.stringify({ version: 1, drafts: [legacy, draft()] })
  await writeFile(join(directory, 'request-drafts.json'), original)
  const write = vi.fn().mockRejectedValueOnce(new Error('disk denied'))
    .mockImplementation(async value => { await writeFile(join(directory, 'request-drafts.json'), JSON.stringify(value)) })
  const service = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [request] }), async () => {}, { write })
  await service.start(); await service.privacyChanged(true)
  expect(write).not.toHaveBeenCalled()
  await expect(service.privacyChanged(false)).rejects.toThrow('retired submitted answers could not be removed')
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(original)
  await service.save(draft({ revision: 2 }))
  expect((await disk()).drafts).toContainEqual(legacy)
  await service.privacyChanged(false)
  expect((await disk()).drafts).toEqual([draft({ revision: 2 })])
  await service.privacyChanged(false)
  expect(write).toHaveBeenCalledTimes(3)
})

it('serializes history-off cleanup with queued thread saves', async () => {
  const legacy = draft({ target: { ...target, kind: 'personal', ownerId: 'saved-chat' }, held: true })
  await writeFile(join(directory, 'request-drafts.json'), JSON.stringify({ version: 1, drafts: [legacy, draft()] }))
  const service = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [request] }), async () => {})
  await service.start()
  const first = service.save(draft({ revision: 2 }))
  const cleanup = service.privacyChanged(false)
  const last = service.save(draft({ revision: 3 }))
  await Promise.all([first, cleanup, last])
  expect((await disk()).drafts).toEqual([draft({ revision: 3 })])
  expect(await service.get(target)).toEqual(draft({ revision: 3 }))
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
  let begin!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { begin = resolve })
  const gate = new Promise<void>(resolve => { finish = resolve })
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
  let begin!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { begin = resolve })
  const gate = new Promise<void>(resolve => { finish = resolve })
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

it('cleans legacy submitted personal words without losing v2 thread acceptance metadata', async () => {
  const retirement = { owner, requestId: target.requestId, questionsDigest: requestQuestionsDigest(questions),
    decisionId: 'accepted-thread', revision: 3 }
  const personal = draft({ target: { ...target, kind: 'personal', ownerId: 'retired-chat', requestId: 'retired-request' },
    held: true, decisionId: 'retired-personal', selections: { notes: { optionIds: [], other: false, text: 'Retired submitted private words' } } })
  const original = JSON.stringify({ version: 2, drafts: [personal], retirements: [retirement] })
  await writeFile(join(directory, 'request-drafts.json'), original)
  const lookup = vi.fn(() => ({ connected: true, ready: true, requests: [],
    completed: [{ requestId: personal.target.requestId, questionsDigest: requestQuestionsDigest(personal.target.questions), decisionId: 'retired-personal' }] }))
  const refresh = vi.fn(async () => {})
  const service = new RequestDraftService(directory, lookup, refresh)
  await service.start(); await service.reconcile()
  expect(await readFile(join(directory, 'request-drafts.json'), 'utf8')).toBe(original)
  expect(lookup).not.toHaveBeenCalled()
  await service.privacyChanged(false)
  const cleaned = await readFile(join(directory, 'request-drafts.json'), 'utf8')
  expect(JSON.parse(cleaned)).toEqual({ version: 2, drafts: [], retirements: [retirement] })
  expect(cleaned).not.toContain('Retired submitted private words')
  expect(await service.status(target)).toEqual({ status: 'accepted', decisionId: retirement.decisionId, revision: retirement.revision })
  await expect(service.check({ ...personal.target })).rejects.toThrow('Standalone chats')
  expect(refresh).not.toHaveBeenCalled()
  const restarted = new RequestDraftService(directory, () => undefined, refresh)
  await restarted.start()
  expect(await restarted.status(target)).toEqual({ status: 'accepted', decisionId: retirement.decisionId, revision: retirement.revision })
})
