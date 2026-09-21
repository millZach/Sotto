// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'
import { RequestDraftService, requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import { requestDraftQuestions, type RequestDraft, type RequestDraftOwner } from '../../src/shared/requestDrafts'
import type { AgentRequest } from '../../src/shared/agents'
const request: AgentRequest = { id: 'structured', kind: 'question', text: 'Private request context', options: [], questions: [
  { id: 'q', question: 'Private question', options: [], multiSelect: false, allowFreeText: true },
] }
const fixtures: Awaited<ReturnType<typeof draftHandoffFixture>>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close() })
async function fixture() { const f = await draftHandoffFixture(); fixtures.push(f); return f }

it('persists privacy-safe main answer receipts across restart without copying structured answer content', async () => {
  const f = await fixture(); f.setHistory(false)
  f.host.event({ type: 'question', threadId: 'workshop', text: '', request })
  const result = await f.command({ type: 'answer', threadId: 'workshop', requestId: request.id, answer: '', questionAnswers: { q: { optionIds: [], text: 'Private answer' } } })
  expect(result.error).toBeNull()
  const receipt = { requestId: request.id, questionsDigest: requestQuestionsDigest(request.questions!), decisionId: expect.any(String) }
  expect(f.control.requestAnswerRecovery('workshop', 'claude')).toEqual({ uncertainRequestIds: [], completed: [receipt] })
  expect(f.control.requestAnswerRecovery('workshop', 'codex').completed).toEqual([])
  const contents = JSON.stringify((await f.disk()).answeredRequests)
  expect(contents).not.toContain('Private')
  await f.restart()
  expect(f.control.requestAnswerRecovery('workshop', 'claude').completed).toEqual([receipt])
  expect(f.attempts.filter(item => item.type === 'answer')).toHaveLength(1)
})

it('holds main outbox uncertainty through a loading snapshot and fresh read, with no delivery replay', async () => {
  const f = await fixture()
  f.host.event({ type: 'question', threadId: 'workshop', text: '', request })
  vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
  await f.command({ type: 'answer', threadId: 'workshop', requestId: request.id, answer: '', questionAnswers: { q: { optionIds: [], text: 'Hold' } } })
  expect(f.control.requestAnswerRecovery('workshop', 'claude').uncertainRequestIds).toEqual(['structured'])
  const snapshot = await f.host.snapshot()
  snapshot.threads[0]!.requests = []; snapshot.threads[0]!.historyStatus = 'loading'
  vi.spyOn(f.host, 'snapshot').mockResolvedValueOnce(snapshot)
  await f.control.refreshRequestDraft('workshop')
  expect(f.control.requestAnswerRecovery('workshop', 'claude').uncertainRequestIds).toEqual(['structured'])
  expect(f.control.requestAnswerRecovery('workshop', 'claude').completed).toEqual([])
  await f.control.refreshRequestDraft('workshop')
  expect(f.control.requestAnswerRecovery('workshop', 'claude').uncertainRequestIds).toEqual(['structured'])
  expect(f.host.execute).toHaveBeenCalledTimes(1)
})

it('does not complete an answer when another provider is connected but its own provider is disconnected', async () => {
  const f = await fixture()
  f.host.event({ type: 'question', threadId: 'workshop', text: '', request })
  vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
  await f.command({ type: 'answer', threadId: 'workshop', requestId: request.id, answer: '', questionAnswers: { q: { optionIds: [], text: 'Hold' } } })
  const snapshot = await f.host.snapshot()
  snapshot.connected = true
  snapshot.threads[0]!.requests = []; snapshot.threads[0]!.providerId = 'claude'; snapshot.threads[0]!.historyStatus = 'ready'
  snapshot.providers = [
    { id: 'claude', connection: 'disconnected', name: 'Claude', version: '', capabilities: snapshot.capabilities },
    { id: 'grok', connection: 'connected', name: 'Grok', version: '', capabilities: snapshot.capabilities },
  ]
  vi.spyOn(f.host, 'snapshot').mockResolvedValueOnce(snapshot)
  await f.control.refreshRequestDraft('workshop')
  expect(f.control.requestAnswerRecovery('workshop', 'claude')).toEqual({ uncertainRequestIds: ['structured'], completed: [] })
})

it.each([true, false].flatMap(accepted => ['structured', 'legacy'].map(format => ({ accepted, format }))))('binds $format threaded recovery to positive acceptance ($accepted), never disappearance alone', async ({ accepted, format }) => {
  const offered: AgentRequest = format === 'structured' ? request : { id: 'legacy', kind: 'question', text: 'Private choice', options: [{ id: 'Private option', label: 'Private label' }] }
  const selections: RequestDraft['selections'] = format === 'structured' ? { q: { optionIds: [], other: false, text: 'Private held answer' } } : { legacy: { optionIds: ['Private option'], other: false, text: '' } }
  const answer = format === 'structured' ? { answer: '', questionAnswers: { q: { optionIds: [], text: 'Private held answer' } } } : { answer: 'Private option' }
  const f = await draftHandoffFixture((target, id, answers) => drafts!.bindDecision(target, id, answers)); fixtures.push(f)
  f.setHistory(false)
  const owner = { kind: 'thread' as const, ownerId: 'workshop', providerId: 'claude' as const }
  const target = { ...owner, requestId: offered.id, questions: requestDraftQuestions(offered) }
  const lookup = (input: RequestDraftOwner) => {
    if (input.kind !== owner.kind || input.ownerId !== owner.ownerId || input.providerId !== owner.providerId) return undefined
    const state = f.control.get(), thread = state.host.threads.find(t => t.id === owner.ownerId)
    return { connected: state.host.connected, ready: true, requests: thread?.requests ?? [], ...f.control.requestAnswerRecovery(owner.ownerId, owner.providerId) }
  }
  const drafts: RequestDraftService = new RequestDraftService(f.root, lookup, () => f.control.refreshRequestDraft(owner.ownerId))
  await drafts.start()
  f.host.event({ type: 'question', threadId: owner.ownerId, text: '', request: offered })
  await drafts.save({ target, revision: 1, held: true, selections })
  const original = f.host.execute.bind(f.host)
  const execute = vi.spyOn(f.host, 'execute').mockImplementation(async command => {
    expect((await drafts!.list(owner))[0]?.decisionId).toBe(command.commandId)
    if (format === 'legacy') { expect(command).toMatchObject({ answer: 'Private option' }); expect(command).not.toHaveProperty('questionAnswers') }
    // A real host event clears the pending request BEFORE its acknowledgement resolves.
    const result = await original(command)
    return accepted ? result : { accepted: false, uncertain: true }
  })
  await f.command({ type: 'answer', threadId: owner.ownerId, requestId: offered.id, ...answer })
  await drafts.reconcile()
  expect(f.control.get().host.threads[0]!.requests).toEqual([])
  expect(await drafts.list(owner)).toHaveLength(accepted ? 0 : 1)
  const receipts = f.control.requestAnswerRecovery(owner.ownerId, owner.providerId).completed
  expect(receipts).toHaveLength(accepted ? 1 : 0)
  execute.mockRestore()
  await f.restart()
  const recovered = new RequestDraftService(f.root, lookup, () => f.control.refreshRequestDraft(owner.ownerId))
  await recovered.start(); await recovered.reconcile()
  expect(await recovered.list(owner)).toHaveLength(accepted ? 0 : 1)
  expect(f.attempts.filter(command => command.type === 'answer')).toHaveLength(1)
  expect(JSON.stringify((await f.disk()).answeredRequests)).not.toContain('Private')
})
