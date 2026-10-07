// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import type { AgentRequest } from '../../src/shared/agents'

const questions = [{ id: 'q', question: 'Which color?', options: [], multiSelect: false, allowFreeText: true }]
const request: AgentRequest = { id: 'question', kind: 'question', text: '', options: [], questions, delivery: 'uncertain' }
const target = { threadId: 'workshop', providerId: 'claude' as const, requestId: request.id, questionsDigest: requestQuestionsDigest(questions) }

it('validates every exact answer Check identity and current authority before any native read', async () => {
  const f = await draftHandoffFixture()
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request })
    const refresh = vi.fn(async () => f.host.snapshot())
    Object.assign(f.host, { refreshThread: refresh })
    for (const changed of [{ threadId: 'missing' }, { providerId: 'grok' as const }, { requestId: 'other' }, { questionsDigest: 'a'.repeat(64) }]) {
      await expect(f.control.checkRequestAnswer({ ...target, ...changed }, desktopWindowClient())).rejects.toThrow()
    }
    await expect(f.control.checkRequestAnswer(target, { clientId: 'paired-without-authority', user: 'User', transport: 'socket' })).rejects.toThrow()
    expect(refresh).not.toHaveBeenCalled()
    await f.control.checkRequestAnswer(target, desktopWindowClient())
    expect(refresh).toHaveBeenCalledWith(target.threadId, { retryUncertainAnswers: true, retryUncertainAnswerId: request.id })
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([])
  } finally { await f.close() }
})

it('rejects a native form replacement during Check without sending or releasing its answer reservation', async () => {
  const f = await draftHandoffFixture()
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
    await f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: '', questionAnswers: { q: { optionIds: [], text: 'Blue' } } })
    const snapshot = await f.host.snapshot()
    snapshot.threads.find(thread => thread.id === target.threadId)!.requests = [{ ...request, delivery: undefined, answerRetryReady: true,
      questions: [{ ...questions[0]!, question: 'Different question?' }] }]
    Object.assign(f.host, { refreshThread: vi.fn(async () => snapshot) })
    await expect(f.control.checkRequestAnswer(target, desktopWindowClient())).rejects.toThrow('original question changed')
    expect(f.control.requestAnswerRecovery(target.threadId, 'claude').uncertainRequestIds).toEqual([request.id])
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([])
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['answer', 'send'] as const)('orders Check after a new %s answer has crossed its persistence and native boundary', async route => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined
  let answer: Promise<unknown> | undefined, checked: Promise<void> | undefined
  try {
    if (route === 'send') await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined, answerRetryReady: true } })
    if (route === 'send') {
      await f.command({ type: 'select-thread', threadId: target.threadId })
      expect(await f.command({ type: 'compose', text: 'Blue' })).toMatchObject({ draftThreadId: target.threadId, draftRequestId: request.id, error: null })
    }
    const refresh = vi.fn(async () => f.host.snapshot())
    Object.assign(f.host, { refreshThread: refresh })
    const control = f.control as unknown as { persist(): Promise<void> }
    const persist = control.persist.bind(control)
    let entered: () => void = () => undefined
    const reserved = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await blocked; await persist() })
    answer = route === 'send' ? f.command({ type: 'send' })
      : f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: '', questionAnswers: { q: { optionIds: [], text: 'Blue' } } })
    await reserved
    refresh.mockClear()
    checked = f.control.checkRequestAnswer(target, desktopWindowClient())
    void checked.catch(() => undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(refresh).not.toHaveBeenCalled()
    release(); expect(await answer).toMatchObject({ error: null })
    await expect(checked).rejects.toThrow('original question changed')
    expect(f.attempts.filter(command => command.type === 'answer')).toHaveLength(1)
    expect((await f.disk()).outbox).toEqual([])
  } finally { release(); await Promise.allSettled([answer, checked]); vi.restoreAllMocks(); await f.close() }
})
