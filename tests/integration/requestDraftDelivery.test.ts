// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'
import { requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
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
  const receipt = { requestId: request.id, questionsDigest: requestQuestionsDigest(request.questions!) }
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
