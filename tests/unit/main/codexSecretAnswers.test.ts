// @vitest-environment node
// A Codex question marked `isSecret` (#2153): the mark reaches every client as `secret`, and a secret answer's words
// are never saved. Codex 0.166.0's own client masks such an answer while it is typed and shows dots in its history.
// Fake values only.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { answerRequest, pendingRequest } from '../../../src/main/agents/codexRequests'
import { RequestDraftService } from '../../../src/main/agents/requestDrafts'
import { agentRequestSchema, answerImageCarrier, type AgentRequest } from '../../../src/shared/agents'
import { protocolAgentStateSchema } from '../../../src/shared/hostProtocol'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { RequestDraftOwner } from '../../../src/shared/requestDrafts'

const FAKE = 'fake-secret-123'
/** The issue's payload, as Codex's app-server writes a ToolRequestUserInputQuestion. */
const issuePayload = { threadId: 'fixture', questions: [{ id: 'q', header: 'Test', question: 'Enter a fake test secret', isSecret: true, isOther: true, options: null }] }
/** The shape Codex's own request_user_input tool can produce: options are required, and isOther is forced true. */
const toolPayload = { threadId: 'fixture', questions: [{ id: 'q', header: 'Token', question: 'Paste the fake token', isSecret: true, isOther: true,
  options: [{ label: 'Skip for now', description: 'Go on without it.' }] }] }
const secretQuestion = { id: 'q', header: 'Test', question: 'Enter a fake test secret', options: [], multiSelect: false, allowFreeText: true, prose: true as const, secret: true as const }
const plainQuestion = { id: 'name', question: 'What should it be called?', options: [], multiSelect: false, allowFreeText: true, prose: true as const }
const secretRequest: AgentRequest = { id: 'rpc:1', kind: 'question', text: 'Enter a fake test secret', options: [], questions: [plainQuestion, secretQuestion], skippable: true }
const owner: RequestDraftOwner = { kind: 'thread', ownerId: 'thread-a', providerId: 'codex' }

describe('a Codex question marked secret', () => {
  it.each([['the issue payload', issuePayload], ['the tool payload', toolPayload]])('keeps the mark on the normalized question: %s', (_name, payload) => {
    const pending = pendingRequest(1, 'item/tool/requestUserInput', payload, 'fixture')!
    expect(pending.request.questions![0]).toMatchObject({ id: 'q', allowFreeText: true, prose: true, secret: true })
  })

  it('marks nothing when Codex says false, as it does for every ordinary question', () => {
    const pending = pendingRequest(1, 'item/tool/requestUserInput', { ...toolPayload, questions: [{ ...toolPayload.questions[0]!, isSecret: false }] }, 'fixture')!
    expect(pending.request.questions![0]).not.toHaveProperty('secret')
  })

  it('still sends the answer back to Codex in its own shape, the value only there', () => {
    const pending = pendingRequest(1, 'item/tool/requestUserInput', issuePayload, 'fixture')!
    expect(answerRequest(pending, '', undefined, { q: { optionIds: [], text: FAKE } })).toEqual({ answers: { q: { answers: [FAKE] } } })
  })

  it('keeps the mark through the shared request schema, which every host and client reads', () => {
    const parsed = agentRequestSchema.parse(JSON.parse(JSON.stringify(secretRequest)))
    expect(parsed.questions![1]!.secret).toBe(true)
    expect(parsed.questions![0]).not.toHaveProperty('secret')
  })

  it('crosses host protocol v1 in a shell, as a paired desktop reads it', () => {
    const state = emptyDesktopState('22222222-2222-4222-8222-222222222222')
    state.host.threads = [{ id: 'child', projectId: 'project', title: 'Task', modelId: '', providerId: 'codex', status: 'idle', messages: [], requests: [secretRequest] }]
    const wire = protocolAgentStateSchema.parse(JSON.parse(JSON.stringify(state)))
    expect(wire.host.threads[0]!.requests[0]!.questions!.map(question => question.secret)).toEqual([undefined, true])
  })

  it('never carries an answer’s images (ADR-0176)', () => {
    expect(answerImageCarrier(secretRequest)?.id).toBe('name')
    expect(answerImageCarrier({ questions: [secretQuestion] })).toBeUndefined()
  })
})

describe('a secret answer in main’s request drafts', () => {
  let directory = ''
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = '' })
  async function service() {
    directory = await mkdtemp(join(tmpdir(), 'sotto-2153-'))
    const drafts = new RequestDraftService(directory, () => ({ connected: true, ready: true, requests: [secretRequest] }), async () => {})
    await drafts.start()
    return drafts
  }
  const target = { ...owner, requestId: secretRequest.id, questions: secretRequest.questions! }
  const selections = { name: { optionIds: [], other: false, text: 'Kestrel' }, q: { optionIds: [], other: false, text: FAKE } }
  const written = (): Promise<string> => readFile(join(directory, 'request-drafts.json'), 'utf8').catch(() => '')

  it('is never written to request-drafts.json, while the other answers are', async () => {
    const drafts = await service()
    const saved = await drafts.save({ target, revision: 1, held: false, selections })
    expect(saved.selections.q).toEqual({ optionIds: [], other: false, text: '' })
    expect(await written()).not.toContain(FAKE)
    expect(await written()).toContain('Kestrel')
  })

  it('still binds a held answer to its delivery, compared without the secret words', async () => {
    const drafts = await service()
    await drafts.save({ target, revision: 1, held: true, selections })
    await drafts.bindDecision(target, 'decision-1', { name: { optionIds: [], text: 'Kestrel' }, q: { optionIds: [], text: FAKE } })
    expect((await drafts.get(target))?.decisionId).toBe('decision-1')
    expect(await written()).not.toContain(FAKE)
  })

  it('binds no held answer whose other words differ', async () => {
    const drafts = await service()
    await drafts.save({ target, revision: 1, held: true, selections })
    await drafts.bindDecision(target, 'decision-1', { name: { optionIds: [], text: 'Merlin' }, q: { optionIds: [], text: FAKE } })
    expect((await drafts.get(target))?.decisionId).toBeUndefined()
  })
})
