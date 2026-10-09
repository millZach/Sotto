// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RequestDraftService, requestQuestionsDigest } from '../../../src/main/agents/requestDrafts'
import { type RequestDraft, type RequestDraftTarget } from '../../../src/shared/requestDrafts'
import { questions, target, owner, request, draft, directory, disk, registerRequestDraftFixture } from '../../fixtures/requestDrafts'

registerRequestDraftFixture()

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
