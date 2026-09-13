// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestDraftService, requestQuestionsDigest, type RequestDraftOwnerState } from '../../../src/main/agents/requestDrafts'
import { requestDraftSchema, type RequestDraft, type RequestDraftTarget } from '../../../src/shared/requestDrafts'
import type { AgentRequest } from '../../../src/shared/agents'

const questions = [
  { id: 'choice', question: 'Destination?', multiSelect: true, allowFreeText: true, options: [{ id: 'coast', label: 'Coast' }, { id: 'hills', label: 'Hills' }] },
  { id: 'notes', question: 'Notes?', multiSelect: false, allowFreeText: true, options: [] },
]
const target: RequestDraftTarget = { kind: 'thread', ownerId: 'owner', providerId: 'codex', requestId: 'request', questions }
const request: AgentRequest = { id: target.requestId, kind: 'question', text: 'Native context', options: [], questions }
const draft = (patch: Partial<RequestDraft> = {}): RequestDraft => requestDraftSchema.parse({ target, revision: 1, held: false,
  selections: { choice: { optionIds: ['coast'], other: true, text: 'A quiet beach' }, notes: { optionIds: [], other: false, text: 'Keep this unsent' } }, ...patch })
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-request-drafts-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const disk = async (): Promise<{ drafts: RequestDraft[] }> => JSON.parse(await readFile(join(directory, 'request-drafts.json'), 'utf8'))

describe('request-owned atomic drafts', () => {
  it('keeps threaded and personal answers, multiple requests and separate providers across restart, independently of composer/history', async () => {
    const state = { connected: true, ready: true, requests: [request, { ...request, id: 'second' }] }
    const service = new RequestDraftService(directory, () => state, async () => {})
    await service.start()
    const targets: RequestDraftTarget[] = [target, { ...target, kind: 'personal' }, { ...target, providerId: 'claude' }, { ...target, requestId: 'second' }, { ...target, ownerId: 'other' }]
    await writeFile(join(directory, 'composer.json'), 'a separate composer')
    for (const [index, target] of targets.entries()) await service.save(draft({ target, revision: index + 1 }))
    const restarted = new RequestDraftService(directory, () => ({ ...state, connected: false, requests: [] }), async () => {})
    await restarted.start(); await restarted.reconcile()
    for (const [index, target] of targets.entries()) expect(await restarted.get(target)).toEqual(draft({ target, revision: index + 1 }))
    expect(await readFile(join(directory, 'composer.json'), 'utf8')).toBe('a separate composer')
    expect((await disk()).drafts).toHaveLength(5)
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
    expect(await restarted.check(target)).toMatchObject({ held: false, revision: 2 })
  })

  it('cleans accepted held revisions on startup without a live snapshot; a newer editing revision survives', async () => {
    let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request] }
    const service = new RequestDraftService(directory, () => state, async () => {})
    await service.start(); await service.save(draft({ held: true }))
    const accepted = { requestId: target.requestId, questionsDigest: requestQuestionsDigest(questions) }
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

  it('removes only observed completed held requests, never another request or a reused ID with different questions', async () => {
    let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [request, { ...request, id: 'second' }] }
    const service = new RequestDraftService(directory, () => state, async () => {})
    await service.start(); await service.save(draft({ held: true })); await service.save(draft({ target: { ...target, requestId: 'second' } }))
    state = { ...state, requests: [{ ...request, id: 'second' }] }; await service.reconcile()
    expect(await service.get(target)).toBeNull()
    expect(await service.get({ ...target, requestId: 'second' })).not.toBeNull()
    await expect(service.save(draft({ held: true, revision: 2 }))).rejects.toThrow('no longer available')
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
    await expect(service.save(draft())).rejects.toThrow('original request-drafts.json is unchanged')
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
})
