// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RequestDraftService, requestQuestionsDigest, type RequestDraftOwnerState } from '../../src/main/agents/requestDrafts'
import type { codexFixture } from '../fixtures/codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup()
})

async function freshFixture(root?: string) {
  // A desktop restart reloads module counters, while the provider's aliases remain on disk.
  vi.resetModules()
  const { codexFixture } = await import('../fixtures/codexFixture')
  const fixture = await codexFixture(root)
  fixtures.push(fixture)
  // Real app-servers can restart their RPC counter; the fixture's PID base otherwise hides reuse.
  await fixture.script({ requestIdBase: 0 })
  await fixture.host.connect()
  return fixture
}

async function question(fixture: Awaited<ReturnType<typeof codexFixture>>, threadId: string) {
  await fixture.driver.raiseQuestion(threadId, 'Which color?')
  await expect.poll(async () => (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
  return (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)!.requests[0]!
}

async function startThread() {
  const fixture = await freshFixture()
  const threadId = randomUUID()
  await fixture.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Project', path: fixture.root })
  await fixture.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: fixture.projectId,
    modelId: fixture.modelId, title: 'Question' })
  return { fixture, threadId }
}

it('does not restore an old accepted answer onto an identical new question after desktop restart', async () => {
  const { fixture, threadId } = await startThread()
  const original = await question(fixture, threadId)
  const target = { kind: 'thread' as const, providerId: 'codex' as const, ownerId: threadId, requestId: original.id, questions: original.questions! }
  let state: RequestDraftOwnerState = { connected: true, ready: true, requests: [original] }
  const drafts = new RequestDraftService(fixture.root, () => state, async () => {})
  await drafts.start()
  await drafts.save({ target, revision: 1, held: true, selections: { choice: { optionIds: ['Blue'], other: false, text: '' } } })
  const answers = { choice: { optionIds: ['Blue'] } }
  await drafts.bindDecision(target, 'original-decision', answers)
  await expect(fixture.host.execute({ type: 'answer', commandId: 'original-decision', threadId, requestId: original.id,
    answer: '', questionAnswers: answers })).resolves.toEqual({ accepted: true })
  await expect.poll(async () => (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)?.requests.length).toBe(0)
  state = { connected: true, ready: true, requests: [], completed: [{ requestId: original.id,
    decisionId: 'original-decision', questionsDigest: requestQuestionsDigest(original.questions!) }] }
  await drafts.reconcile()
  fixture.host.disconnect(); await fixture.adapter.closed()

  const restarted = await freshFixture(fixture.root)
  await restarted.adapter.refreshThread(threadId)
  const next = await question(restarted, threadId)
  expect(next.questions).toEqual(original.questions)
  expect(next.delivery).not.toBe('uncertain')
  expect(next.id).not.toBe(original.id)
  const nextTarget = { ...target, requestId: next.id }
  const recovered = new RequestDraftService(fixture.root, () => ({ connected: true, ready: true, requests: [next] }), async () => {})
  await recovered.start()
  expect(await recovered.status(nextTarget)).toEqual({ status: 'missing' })
  expect(await recovered.status(target)).toEqual({ status: 'accepted', decisionId: 'original-decision', revision: 1 })
  expect(JSON.parse(await readFile(join(fixture.root, 'request-drafts.json'), 'utf8')).drafts).toEqual([])
  expect((await restarted.driver.requests()).filter(record => record.result?.answers)).toHaveLength(1)
})

it('keeps an unproved legacy numeric request draft recoverable without rebinding or resending it', async () => {
  const { fixture, threadId } = await startThread()
  const original = await question(fixture, threadId)
  const target = { kind: 'thread' as const, providerId: 'codex' as const, ownerId: threadId, requestId: 'rpc:2:1', questions: original.questions! }
  const legacy = { target, revision: 1, held: true, decisionId: 'unproved-legacy-decision',
    selections: { choice: { optionIds: ['Blue'], other: false, text: '' } } }
  await writeFile(join(fixture.root, 'request-drafts.json'), JSON.stringify({ version: 1, drafts: [legacy] }))
  fixture.host.disconnect(); await fixture.adapter.closed()
  const before = (await fixture.driver.requests()).filter(record => record.result?.answers).length

  const restarted = await freshFixture(fixture.root)
  await restarted.adapter.refreshThread(threadId)
  const next = await question(restarted, threadId)
  expect(next.id).not.toBe(target.requestId)
  const recovered = new RequestDraftService(fixture.root, () => ({ connected: true, ready: true, requests: [next] }), async () => {})
  await recovered.start(); await recovered.reconcile()
  expect(await recovered.get(target)).toEqual(legacy)
  await expect(recovered.check(target)).rejects.toThrow('still unconfirmed')
  expect(await recovered.get(target)).toEqual(legacy)
  expect((await restarted.driver.requests()).filter(record => record.result?.answers)).toHaveLength(before)
})
