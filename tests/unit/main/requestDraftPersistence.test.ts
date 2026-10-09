// @vitest-environment node
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RequestDraftService, requestQuestionsDigest, type RequestDraftOwnerState } from '../../../src/main/agents/requestDrafts'
import { type RequestDraftTarget } from '../../../src/shared/requestDrafts'
import { questions, target, submittedAnswers, owner, request, draft, directory, disk, registerRequestDraftFixture } from '../../fixtures/requestDrafts'

registerRequestDraftFixture()

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
