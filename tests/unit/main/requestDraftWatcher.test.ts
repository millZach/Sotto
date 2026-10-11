// @vitest-environment node
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RequestDraftService, requestQuestionsDigest } from '../../../src/main/agents/requestDrafts'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { directory, draft, owner, questions, request, registerRequestDraftFixture, target } from '../../fixtures/requestDrafts'

registerRequestDraftFixture()
const watcherOwner = { ...owner, ownerId: 'watcher' }
const watcherTarget = { ...target, ...watcherOwner }
const dormant = draft({ target: watcherTarget, held: true, decisionId: 'watcher-held' })
const retirement = (ownerId: string, requestId: string) => ({ owner: { ...owner, ownerId }, requestId,
  questionsDigest: requestQuestionsDigest(questions), decisionId: `accepted-${requestId}`, revision: 1 })
const preserveOwner = (item: typeof owner) => item.ownerId === 'watcher'
const completed = { connected: true, ready: true, requests: [], completed: [{ requestId: target.requestId,
  decisionId: 'ordinary-new', questionsDigest: requestQuestionsDigest(questions) }] }

it.each([false, true])('keeps ordinary retirement capacity while protecting dormant Watcher records (%s)', async stable => {
  const parked = stable ? Array.from({ length: 512 }, (_, i) => retirement('watcher', `watcher-${i}`)) : []
  const ordinary = Array.from({ length: 512 }, (_, i) => retirement(owner.ownerId, `ordinary-${i}`))
  const path = join(directory, 'request-drafts.json')
  await writeFile(path, JSON.stringify({ version: 2, drafts: [dormant, draft({ held: true, decisionId: 'ordinary-new' })],
    retirements: [...parked, ...ordinary] }))
  const service = new RequestDraftService(directory, item => item.ownerId === 'watcher' ? undefined : completed,
    async () => {}, undefined, stable ? preserveOwner : undefined)
  await service.start()
  await service.reconcile()
  const saved = JSON.parse(await readFile(path, 'utf8'))
  expect(saved.drafts).toEqual([dormant])
  expect(saved.retirements.filter((item: ReturnType<typeof retirement>) => item.owner.ownerId === 'watcher')).toEqual(parked)
  expect(saved.retirements.filter((item: ReturnType<typeof retirement>) => item.owner.ownerId === owner.ownerId)).toEqual([
    ...ordinary.slice(1), { ...retirement(owner.ownerId, target.requestId), decisionId: 'ordinary-new' },
  ])
  expect(await service.heldThreadAnswers()).toEqual(stable ? [] : [dormant])
  if (stable) expect(await service.status(watcherTarget)).toEqual({ status: 'missing' })
  const owl = new RequestDraftService(directory, () => completed, async () => {})
  await owl.start()
  expect(await owl.get(watcherTarget)).toEqual(dormant)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)
})

it('prunes ordinary abandoned answer copies while retaining dormant Watcher copies and malformed bytes', async () => {
  const copy = 'request-drafts.json.tmp-123-12345678-1234-1234-1234-123456789abc'
  const malformed = copy.replace('tmp-123-', 'tmp-124-')
  const ordinaryCopy = copy.replace('tmp-123-', 'tmp-125-')
  const record = retirement('watcher', 'old')
  const unreadable = '{"drafts":[{"target":{"ownerId":"watcher"}},'
  await writeFile(join(directory, 'request-drafts.json'), JSON.stringify({ version: 2, drafts: [dormant], retirements: [record] }))
  await writeFile(join(directory, copy), JSON.stringify({ version: 2, drafts: [dormant, draft()], retirements: [record, retirement(owner.ownerId, 'ordinary')] }))
  await writeFile(join(directory, malformed), unreadable)
  await writeFile(join(directory, ordinaryCopy), '{"ownerId":"ordinary",')
  const stable = new RequestDraftService(directory, () => undefined, async () => {}, undefined, preserveOwner)
  await stable.start()
  expect(JSON.parse(await readFile(join(directory, copy), 'utf8'))).toEqual({ version: 2, drafts: [dormant], retirements: [record] })
  expect(await readFile(join(directory, malformed), 'utf8')).toBe(unreadable)
  expect((await readdir(directory)).sort()).toEqual(['request-drafts.json', copy, malformed].sort())
  const owl = new RequestDraftService(directory, () => completed, async () => {})
  await owl.start()
  expect(await owl.get(watcherTarget)).toEqual(dormant)
  expect(await readdir(directory)).toEqual(['request-drafts.json'])
})

it('remembers remote Watcher answer owners through disconnected stable startup and ordinary retirement', async () => {
  const remoteOwner = { ...watcherOwner, ownerId: hostEntityKey('00000000-0000-4000-8000-000000000099', 'watcher') }
  const remoteTarget = { ...watcherTarget, ...remoteOwner }
  const remoteDraft = draft({ target: remoteTarget, held: true, decisionId: 'remote-held' })
  const parked = retirement(remoteOwner.ownerId, 'remote-accepted')
  const ordinary = Array.from({ length: 512 }, (_, i) => retirement(owner.ownerId, `ordinary-${i}`))
  const path = join(directory, 'request-drafts.json')
  await writeFile(path, JSON.stringify({ version: 2, drafts: [remoteDraft], retirements: [parked, ...ordinary] }))
  const owl = new RequestDraftService(directory, item => item.ownerId === remoteOwner.ownerId
    ? { ...completed, watcher: true } : { ...completed, requests: [request] }, async () => {})
  await owl.start()
  await owl.reconcile()
  expect(JSON.parse(await readFile(path, 'utf8')).watcherOwners).toEqual([remoteOwner])
  await owl.save(draft({ held: true }))
  const saved = JSON.parse(await readFile(path, 'utf8'))
  expect(saved.watcherOwners).toEqual([remoteOwner])
  // A crashed snapshot carries its own classification too, independent of a live socket.
  const copy = 'request-drafts.json.tmp-123-12345678-1234-1234-1234-123456789abc'
  await writeFile(join(directory, copy), JSON.stringify(saved))
  const stable = new RequestDraftService(directory, item => item.ownerId === remoteOwner.ownerId ? undefined : completed,
    async () => {}, undefined, () => false)
  await stable.start()
  expect(await stable.get(remoteTarget)).toBeNull()
  expect(await stable.status(remoteTarget)).toEqual({ status: 'missing' })
  expect(await stable.heldThreadAnswers()).toEqual([])
  await stable.bindDecision(target, 'ordinary-new', { choice: { optionIds: ['coast'], text: 'A quiet beach' },
    notes: { optionIds: [], text: 'Keep this unsent' } })
  await stable.reconcile()
  const final = JSON.parse(await readFile(path, 'utf8'))
  expect(final.drafts).toEqual([remoteDraft])
  expect(final.retirements[0]).toEqual(parked)
  expect(final.retirements).toHaveLength(513)
  expect(final.watcherOwners).toEqual(saved.watcherOwners)
  expect(JSON.parse(await readFile(join(directory, copy), 'utf8'))).toEqual({ version: 2, drafts: [remoteDraft],
    retirements: [parked], watcherOwners: [remoteOwner] })
  const reopened = new RequestDraftService(directory, () => completed, async () => {})
  await reopened.start()
  expect(await reopened.get(remoteTarget)).toEqual(remoteDraft)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(final)
})

it.each([false, true])('protects a legacy Owl offline owner before its first metadata migration (Owl saves first: %s)', async owlSavesFirst => {
  const remoteOwner = { ...owner, ownerId: hostEntityKey('11111111-1111-4111-8111-111111111111', 'legacy-watcher') }
  const remoteDraft = draft({ target: { ...target, ...remoteOwner }, held: true, decisionId: 'legacy-held' })
  const parked = { ...retirement(remoteOwner.ownerId, 'legacy-accepted'), owner: remoteOwner }
  const ordinary = Array.from({ length: 511 }, (_, i) => retirement(owner.ownerId, 'ordinary-' + i))
  const original = { version: 2, drafts: [remoteDraft, draft({ held: true, decisionId: 'ordinary-new' }),
    draft({ target: { ...target, requestId: 'second' }, held: true, decisionId: 'second-new' })], retirements: [parked, ...ordinary] }
  const path = join(directory, 'request-drafts.json')
  const copy = join(directory, 'request-drafts.json.tmp-123-12345678-1234-1234-1234-123456789abc')
  await writeFile(path, JSON.stringify(original))
  await writeFile(copy, JSON.stringify(original))
  let connected = false
  const classify = (item: typeof owner): boolean | undefined => item.ownerId === remoteOwner.ownerId ? connected ? true : undefined : false
  const lookup = (item: typeof owner) => item.ownerId === remoteOwner.ownerId ? connected ? { ...completed, watcher: true } : undefined
    : { ...completed, completed: [...completed.completed, { requestId: 'second', decisionId: 'second-new', questionsDigest: requestQuestionsDigest(questions) }] }
  const unsent = draft({ target: { ...target, requestId: 'new-local-unsent' } })
  if (owlSavesFirst) {
    const firstOwl = new RequestDraftService(directory, lookup, async () => {})
    await firstOwl.start()
    await firstOwl.save(unsent)
    expect(JSON.parse(await readFile(path, 'utf8')).unclassifiedOwners).toEqual([remoteOwner])
    // Owl owns abandoned-copy cleanup as before; recreate the legacy crash snapshot for stable.
    await writeFile(copy, JSON.stringify(original))
  }
  const stable = new RequestDraftService(directory, lookup, async () => {}, undefined, classify)
  await stable.start()
  expect(JSON.parse(await readFile(copy, 'utf8'))).toEqual({ ...original, drafts: [remoteDraft], retirements: [parked] })
  expect((await stable.heldThreadAnswers()).map(item => item.target.ownerId)).toEqual([owner.ownerId, owner.ownerId])
  await stable.reconcile()
  const saved = JSON.parse(await readFile(path, 'utf8'))
  expect(saved.drafts).toEqual(owlSavesFirst ? [remoteDraft, unsent] : [remoteDraft])
  expect(saved.retirements.filter((item: ReturnType<typeof retirement>) => item.owner.ownerId === remoteOwner.ownerId)).toEqual([parked])
  expect(saved.retirements.filter((item: ReturnType<typeof retirement>) => item.owner.ownerId === owner.ownerId)).toHaveLength(512)
  expect(saved.unclassifiedOwners).toEqual([remoteOwner])
  const restarted = new RequestDraftService(directory, lookup, async () => {}, undefined, classify)
  await restarted.start()
  expect(await restarted.heldThreadAnswers()).toEqual([])
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)
  connected = true
  await restarted.reconcile()
  const learned = JSON.parse(await readFile(path, 'utf8'))
  expect(learned.watcherOwners).toEqual([remoteOwner])
  expect(learned).not.toHaveProperty('unclassifiedOwners')
  expect(learned.drafts).toEqual(saved.drafts)
  expect(learned.retirements).toEqual(saved.retirements)
  const owl = new RequestDraftService(directory, lookup, async () => {})
  await owl.start()
  expect(await owl.get(remoteDraft.target)).toEqual(remoteDraft)
})

it('removes malformed ordinary copies carrying an empty ownership marker', async () => {
  const copy = join(directory, 'request-drafts.json.tmp-123-12345678-1234-1234-1234-123456789abc')
  const contents = JSON.stringify({ version: 2, drafts: [draft()], retirements: [], watcherOwners: [] }).slice(0, -1)
  await writeFile(copy, contents)
  const stable = new RequestDraftService(directory, () => completed, async () => {}, undefined, () => false)
  await stable.start()
  expect(await readdir(directory)).not.toContain(copy.split(/[\\/]/u).at(-1))
})
