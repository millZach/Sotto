// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { HostConnectionError, SocketHostService } from '../../../src/main/agents/socketHostService'
import { RequestDraftService, requestQuestionsDigest } from '../../../src/main/agents/requestDrafts'
import type { AgentRequest } from '../../../src/shared/agents'
import type { HostOperation } from '../../../src/shared/hostProtocol'
import type { RequestDraftTarget } from '../../../src/shared/requestDrafts'
import { hostId } from '../../fixtures/socketHostService'

describe('SocketHostService exact acceptance pushes', () => {
  it('notifies subscribers once when a receipt read recovers acceptance after reconnect, retaining an unrelated shell error', async () => {
    const onPushError = vi.fn(), onPushErrorCleared = vi.fn()
    const client = new SocketHostService({ url: 'http://127.0.0.1:1', token: 'unused', onPushError, onPushErrorCleared })
    Object.assign(client, { features: ['answer-receipts'], cached: emptyDesktopState(hostId) })
    const receive = (value: unknown) => (client as unknown as { receive(text: string): void }).receive(JSON.stringify(value))
    const target = { threadId: 'thread', providerId: 'claude' as const, requestId: 'question', questionsDigest: 'a'.repeat(64) }
    const proof = { ...target, decisionId: 'decision' }
    const receipt = vi.spyOn(client, 'receipt').mockResolvedValue({ status: 'pending' })
    await client.refreshRequestAnswer('decision', target)
    await client.close()
    // The new connection's shell arrives before its background read obtains the missing proof.
    receive({ v: 1, event: 'shell', state: emptyDesktopState(hostId) })
    receive({ v: 1, event: 'error', error: { code: 'too_large', message: 'The thread list on this host is too large to send.' } })
    const notify = vi.fn(() => client.requestAnswerRecovery('thread', 'claude').completed)
    client.subscribe(notify)
    receipt.mockResolvedValue({ status: 'completed', acceptedAnswer: proof })
    await client.refreshRequestAnswer('decision', target)
    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.results[0]?.value).toEqual([{ requestId: 'question', questionsDigest: target.questionsDigest, decisionId: 'decision' }])
    expect(onPushError).toHaveBeenCalledOnce()
    expect(onPushErrorCleared).not.toHaveBeenCalled()
    // Repeated reads and a duplicate push carry no new evidence and do not publish again.
    await client.refreshRequestAnswer('decision', target)
    receive({ v: 1, event: 'answer-receipt', acceptedAnswer: proof })
    expect(notify).toHaveBeenCalledOnce()
    receive({ v: 1, event: 'shell', state: emptyDesktopState(hostId) })
    expect(onPushErrorCleared).toHaveBeenCalledOnce()
  })
  it('keeps an oversized shell error through a matching acceptance push until a fresh shell arrives', async () => {
    const onPushError = vi.fn(), onPushErrorCleared = vi.fn()
    const client = new SocketHostService({ url: 'http://127.0.0.1:1', token: 'unused', onPushError, onPushErrorCleared })
    Object.assign(client, { features: ['answer-receipts'], cached: emptyDesktopState(hostId) })
    const receive = (value: unknown) => (client as unknown as { receive(text: string): void }).receive(JSON.stringify(value))
    const target = { threadId: 'thread', providerId: 'claude' as const, requestId: 'question', questionsDigest: 'a'.repeat(64) }
    vi.spyOn(client, 'receipt').mockResolvedValue({ status: 'pending' })
    await client.refreshRequestAnswer('decision', target)
    receive({ v: 1, event: 'error', error: { code: 'too_large', message: 'The thread list on this host is too large to send.' } })
    const notify = vi.fn(); client.subscribe(notify)
    receive({ v: 1, event: 'answer-receipt', acceptedAnswer: { ...target, decisionId: 'decision' } })
    expect(client.requestAnswerRecovery('thread', 'claude').completed).toHaveLength(1)
    expect(notify).toHaveBeenCalledOnce()
    expect(onPushError).toHaveBeenCalledOnce()
    expect(onPushErrorCleared).not.toHaveBeenCalled()
    receive({ v: 1, event: 'shell', state: emptyDesktopState(hostId) })
    expect(onPushErrorCleared).toHaveBeenCalledOnce()
  })
  it('accepts proof that arrives before its negative receipt reply, without accepting unknown or mismatched targets', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:1', token: 'unused' })
    Object.assign(client, { features: ['answer-receipts'], cached: emptyDesktopState(hostId) })
    const receive = (value: unknown) => (client as unknown as { receive(text: string): void }).receive(JSON.stringify(value))
    const target = { threadId: 'thread', providerId: 'claude' as const, requestId: 'question', questionsDigest: 'a'.repeat(64) }
    const proof = { ...target, decisionId: 'decision' }
    const notify = vi.fn(); client.subscribe(notify)
    vi.spyOn(client, 'receipt').mockImplementation(async () => {
      for (const changed of [{ decisionId: 'unknown' }, { threadId: 'other' }, { providerId: 'codex' },
        { requestId: 'other' }, { questionsDigest: 'b'.repeat(64) }]) {
        receive({ v: 1, event: 'answer-receipt', acceptedAnswer: { ...proof, ...changed } })
        expect(client.requestAnswerRecovery('thread', 'claude').completed).toEqual([])
      }
      receive({ v: 1, event: 'answer-receipt', acceptedAnswer: proof })
      return { status: 'unknown' }
    })
    await client.refreshRequestAnswer('decision', target)
    expect(client.requestAnswerRecovery('thread', 'claude').completed).toEqual([{ requestId: 'question', questionsDigest: target.questionsDigest, decisionId: 'decision' }])
    expect(notify).toHaveBeenCalledTimes(1)
    receive({ v: 1, event: 'answer-receipt', acceptedAnswer: proof })
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('bounds queried targets and refuses a decision being rebound to different questions', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:1', token: 'unused' })
    Object.assign(client, { features: ['answer-receipts'], cached: emptyDesktopState(hostId) })
    const receipt = vi.spyOn(client, 'receipt').mockResolvedValue({ status: 'unknown' })
    const target = { threadId: 'thread', providerId: 'claude' as const, requestId: 'question', questionsDigest: 'a'.repeat(64) }
    for (let i = 0; i < 513; i++) await client.refreshRequestAnswer(String(i), target)
    await client.refreshRequestAnswer('512', { ...target, questionsDigest: 'b'.repeat(64) })
    expect(receipt).toHaveBeenCalledTimes(513)
    const receive = (decisionId: string) => (client as unknown as { receive(text: string): void }).receive(JSON.stringify({ v: 1, event: 'answer-receipt', acceptedAnswer: { ...target, decisionId } }))
    receive('0')
    expect(client.requestAnswerRecovery('thread', 'claude').completed).toEqual([])
    receive('512')
    expect(client.requestAnswerRecovery('thread', 'claude').completed).toHaveLength(1)
  })
})

describe('SocketHostService acknowledged answer receipt failures', () => {
  const questions = [{ id: 'choice', question: 'Which color?', multiSelect: false, allowFreeText: false,
    options: [{ id: 'blue', label: 'Blue' }] }]
  const target: RequestDraftTarget = { kind: 'thread', ownerId: 'thread', providerId: 'claude', requestId: 'question', questions }
  const request: AgentRequest = { id: target.requestId, kind: 'question', text: 'Which color?', options: [], questions }
  const answerTarget = { threadId: target.ownerId, providerId: target.providerId, requestId: target.requestId,
    questionsDigest: requestQuestionsDigest(questions) }
  const answers = { choice: { optionIds: ['blue'] } }
  const failures = ['busy', 'disconnected', 'timeout', 'generation'] as const
  for (const outcome of [null, 'The answer is still unconfirmed. Check before sending it again.']) {
    it.each(failures)(`preserves the acknowledged ${outcome ? 'uncertain' : 'successful'} answer and its durable hold when the receipt read fails with %s`, async failure => {
      const directory = await mkdtemp(join(tmpdir(), 'sotto-socket-answer-'))
      try {
        const client = new SocketHostService({ url: 'http://127.0.0.1:1', token: 'unused', catchUpEvents: false })
        const shell = emptyDesktopState(hostId)
        shell.host.threads = [{ id: target.ownerId, providerId: target.providerId, projectId: 'project', title: 'Thread',
          modelId: 'model', status: 'idle', messages: [], requests: [request] }]
        const acknowledged = { ...shell, error: outcome }
        const call = vi.fn(async (operation: HostOperation) => {
          if (operation.op !== 'command') throw new Error('Only the answer command uses this transport stand-in.')
          return acknowledged
        })
        Object.assign(client, { features: ['answer-receipts'], cached: shell, call })
        const lookup = () => ({ connected: true, ready: true, requests: client.shell().host.threads[0]!.requests,
          ...client.requestAnswerRecovery(target.ownerId, target.providerId) })
        const drafts = new RequestDraftService(directory, lookup, async () => {})
        await drafts.start()
        const held = await drafts.save({ target, revision: 1, held: true,
          selections: { choice: { optionIds: ['blue'], other: false, text: '' } } })
        await drafts.bindDecision(target, 'decision', answers)
        const receipt = vi.spyOn(client, 'receipt').mockImplementationOnce(async () => {
          if (failure === 'generation') { await client.close(); return { status: 'pending' } }
          throw new HostConnectionError(failure === 'timeout' ? 'The host did not answer in time.' : 'Receipt unavailable.',
            failure === 'busy' ? 'busy' : 'disconnected')
        })
        vi.spyOn(client, 'readThreadDetail').mockImplementation(async () => {
          // A fresh shell must not replace the sending command's private uncertainty.
          Object.assign(client, { cached: { ...shell, error: null } })
          return null
        })
        await expect(client.command({ type: 'answer', threadId: target.ownerId, requestId: target.requestId,
          answer: '', questionAnswers: answers, approved: true }, undefined, 'decision')).resolves.toMatchObject({ error: outcome })
        await drafts.reconcile()
        const restarted = new RequestDraftService(directory, lookup, async () => {})
        await restarted.start()
        expect(await restarted.get(target)).toEqual({ ...held, decisionId: 'decision' })
        expect(JSON.parse(await readFile(join(directory, 'request-drafts.json'), 'utf8')).drafts).toEqual([{ ...held, decisionId: 'decision' }])
        expect(client.requestAnswerRecovery(target.ownerId, target.providerId).completed).toEqual([])
        // Recovery reads the original attempt; neither uncertainty nor a failed optional read resends it.
        receipt.mockResolvedValue({ status: 'completed', acceptedAnswer: { ...answerTarget, decisionId: 'decision' } })
        await client.refreshRequestAnswer('decision', answerTarget)
        await restarted.reconcile()
        expect(await restarted.get(target)).toBeNull()
        expect(JSON.parse(await readFile(join(directory, 'request-drafts.json'), 'utf8')).drafts).toEqual([])
        expect(call).toHaveBeenCalledOnce()
      } finally { await rm(directory, { recursive: true, force: true }) }
    })
  }
})
