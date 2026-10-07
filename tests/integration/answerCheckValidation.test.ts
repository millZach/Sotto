// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'
import { PIXEL_PNG } from '../fixtures/stagedImages'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import type { AgentRequest } from '../../src/shared/agents'
import type { ThreadReadPurpose } from '../../src/main/agents/host'

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

it.each(['answer', 'send', 'voice'] as const)('preserves a new %s answer reservation before its persistence and native boundary', async route => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined
  let answer: Promise<unknown> | undefined, checked: Promise<void> | undefined
  try {
    if (route !== 'answer') await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined, answerRetryReady: true } })
    if (route !== 'answer') {
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
    answer = route === 'voice' ? f.command({ type: 'utterance', text: 'send it' }) : route === 'send' ? f.command({ type: 'send' })
      : f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: '', questionAnswers: { q: { optionIds: [], text: 'Blue' } } })
    await reserved
    refresh.mockClear()
    checked = f.control.checkRequestAnswer(target, desktopWindowClient())
    void checked.catch(() => undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(refresh).not.toHaveBeenCalled()
    release(); expect(await answer).toMatchObject({ error: null })
    await expect(checked).rejects.toThrow('still being sent')
    expect(f.attempts.filter(command => command.type === 'answer')).toHaveLength(1)
    expect((await f.disk()).outbox).toEqual([])
  } finally { release(); await Promise.allSettled([answer, checked]); vi.restoreAllMocks(); await f.close() }
})

it.each([['answer', false, 'send it'], ['answer', true, 'send it'], ['send', false, 'send it'], ['send', true, 'send it'],
  ['voice', false, 'send it'], ['voice', true, 'send it'], ['voice', false, 'send it. '], ['voice', true, 'send it. ']] as const)(
  'keeps a queued %s submission owned before its command lane opens (admitted during Check %s, spoken text "%s")', async (route, duringRead, spoken) => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, releaseRead: () => void = () => undefined
  let predecessor: Promise<unknown> | undefined, answering: Promise<unknown> | undefined, checking: Promise<void> | undefined
  try {
    if (route !== 'answer') await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined, answerRetryReady: true } })
    if (route !== 'answer') await f.command({ type: 'select-thread', threadId: target.threadId })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    if (route === 'answer') {
      Object.assign(f.host, { loadEarlierMessages: async () => { entered(); await gate; return f.host.snapshot() } })
      predecessor = f.command({ type: 'load-earlier-messages', threadId: target.threadId })
    } else {
      const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
      vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
      predecessor = f.command({ type: 'compose', text: 'Blue' })
    }
    await started
    let readEntered: () => void = () => undefined
    const reading = new Promise<void>(resolve => { readEntered = resolve })
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    const refresh = vi.fn(async (id: string, purpose?: ThreadReadPurpose) => {
      if (duringRead && id === target.threadId && purpose?.retryUncertainAnswers) { readEntered(); await readGate }
      return f.host.snapshot()
    })
    Object.assign(f.host, { refreshThread: refresh })
    let refused: Promise<unknown> | undefined
    if (duringRead) {
      checking = f.control.checkRequestAnswer(target, desktopWindowClient())
      refused = expect(checking).rejects.toThrow('still being sent')
      await reading
    }
    answering = route === 'voice' ? f.command({ type: 'utterance', text: spoken }) : route === 'send' ? f.command({ type: 'send' })
      : f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: '',
        questionAnswers: { q: { optionIds: [], text: 'Blue' } } })
    if (duringRead) { releaseRead(); await refused }
    else {
      await expect(f.control.checkRequestAnswer(target, desktopWindowClient())).rejects.toThrow('still being sent')
      expect(refresh).not.toHaveBeenCalled()
    }
    expect(f.attempts.filter(command => command.type === 'answer')).toHaveLength(0)
    const other = { ...target, threadId: 'docs', requestId: 'other-question' }
    f.host.event({ type: 'question', threadId: other.threadId, text: '', request: { ...request, id: other.requestId, delivery: undefined } })
    await f.control.checkRequestAnswer(other, desktopWindowClient())
    expect(refresh).toHaveBeenCalledWith(other.threadId, { retryUncertainAnswers: true, retryUncertainAnswerId: other.requestId })
    release(); await predecessor
    expect(await answering).toMatchObject({ error: null })
    expect(f.attempts.filter(command => command.type === 'answer')).toHaveLength(1)
    expect((await f.disk()).outbox).toEqual([])
  } finally { release(); releaseRead(); await Promise.allSettled([predecessor, answering, checking]); vi.restoreAllMocks(); await f.close() }
})

it('keeps unrelated global work, native Checks and direct answers independent of a held Check', async () => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined
  let checking: Promise<void> | undefined
  const pending: Promise<unknown>[] = []
  try {
    const other = { ...target, threadId: 'docs', requestId: 'other-question' }
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request })
    f.host.event({ type: 'question', threadId: other.threadId, text: '', request: { ...request, id: other.requestId, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const refresh = vi.fn(async (id: string) => {
      if (id === target.threadId) { entered(); await blocked }
      return f.host.snapshot()
    })
    Object.assign(f.host, { refreshThread: refresh })
    checking = f.control.checkRequestAnswer(target, desktopWindowClient())
    await started
    const global = f.command({ type: 'compose', text: 'An independent composer edit' })
    const otherCheck = f.control.checkRequestAnswer(other, desktopWindowClient())
    pending.push(global, otherCheck)
    let completed = false
    void Promise.all(pending).then(() => { completed = true }, () => undefined)
    await expect.poll(() => completed).toBe(true)
    const otherAnswer = f.command({ type: 'answer', threadId: other.threadId, requestId: other.requestId,
      answer: '', questionAnswers: { q: { optionIds: [], text: 'Green' } } })
    pending.push(otherAnswer)
    await otherAnswer
    expect(f.attempts.filter(command => command.type === 'answer' && command.threadId === other.threadId)).toHaveLength(1)
    expect(refresh).toHaveBeenCalledWith(other.threadId, { retryUncertainAnswers: true, retryUncertainAnswerId: other.requestId })
  } finally { release(); await Promise.allSettled([checking, ...pending]); await f.close() }
})

it.each(['empty', 'different'] as const)('owns a queued socket Send by its selected question draft when the global draft is %s', async global => {
  const f = await draftHandoffFixture(undefined, {
    authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }),
  })
  let release: () => void = () => undefined
  let predecessor: Promise<unknown> | undefined, answering: Promise<unknown> | undefined
  try {
    const other = { ...target, threadId: 'docs', requestId: 'other-question' }
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined, answerRetryReady: true } })
    f.host.event({ type: 'question', threadId: other.threadId, text: '', request: { ...request, id: other.requestId, delivery: undefined } })
    if (global === 'different') {
      await f.command({ type: 'select-thread', threadId: other.threadId })
      await f.command({ type: 'compose', text: 'Green' })
    }
    const client = { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId }
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    predecessor = f.control.commandShell({ type: 'compose', text: 'Blue' }, client)
    await started
    expect(f.control.get().draftThreadId).toBe(global === 'different' ? other.threadId : null)
    expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, requestId: request.id, text: 'Blue' }))
    const refresh = vi.fn(async () => f.host.snapshot())
    Object.assign(f.host, { refreshThread: refresh })
    answering = f.control.commandShell({ type: 'send' }, client)
    await expect(f.control.checkRequestAnswer(target, desktopWindowClient())).rejects.toThrow('still being sent')
    expect(refresh).not.toHaveBeenCalled()
    await f.control.checkRequestAnswer(other, desktopWindowClient())
    release(); await predecessor
    expect(await answering).toMatchObject({ error: null })
    expect(f.attempts.filter(command => command.type === 'answer')).toMatchObject([{ threadId: target.threadId, requestId: request.id, answer: 'Blue' }])
    expect(f.control.get().host.threads.find(thread => thread.id === other.threadId)?.requests).toContainEqual(expect.objectContaining({ id: other.requestId }))
  } finally { release(); await Promise.allSettled([predecessor, answering]); vi.restoreAllMocks(); await f.close() }
})

it.each(['send', 'voice', 'socket', 'socket-legacy'] as const)(
  'preserves an unresolved answer when Compose and %s queue before the draft exists', async route => {
  const f = await draftHandoffFixture(undefined, {
    authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }),
  })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    await f.command({ type: 'select-thread', threadId: target.threadId })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const execute = vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
    await f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: 'Earlier answer' })
    const original = (await f.disk()).outbox
    expect(original).toMatchObject([{ type: 'answer', threadId: target.threadId, requestId: request.id }])
    if (route === 'socket-legacy') await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000001',
      text: 'Saved text', requestId: null })
    const client = route.startsWith('socket')
      ? { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { orbColor: 'ice' } }))
    await started
    expect(f.control.get().draftThreadId).toBeNull()
    pending.push(f.control.commandShell({ type: 'compose', text: 'Blue' }, client))
    const sending = f.control.commandShell(route === 'voice' ? { type: 'utterance', text: 'send it. ' } : { type: 'send' }, client)
    pending.push(sending)
    const refresh = vi.fn(async (id: string, purpose?: ThreadReadPurpose) => {
      const snapshot = await f.host.snapshot()
      if (purpose?.retryUncertainAnswers) snapshot.threads.find(thread => thread.id === id)!.requests[0]!.answerRetryReady = true
      return snapshot
    })
    Object.assign(f.host, { refreshThread: refresh })
    await expect(f.control.checkRequestAnswer(target, desktopWindowClient())).rejects.toThrow('still being sent')
    expect(refresh).not.toHaveBeenCalled()
    expect((await f.disk()).outbox).toEqual(original)
    const other = { ...target, threadId: 'docs', requestId: 'other-question' }
    f.host.event({ type: 'question', threadId: other.threadId, text: '', request: { ...request, id: other.requestId, delivery: undefined } })
    await f.control.checkRequestAnswer(other, desktopWindowClient())
    release(); await Promise.all(pending)
    expect(await sending).toMatchObject({ error: expect.stringContaining('earlier action has an unknown result') })
    expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
    expect((await f.disk()).outbox).toEqual(original)
    await expect(f.control.checkRequestAnswer(target, desktopWindowClient())).resolves.toBeUndefined()
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['send', 'voice'] as const)('keeps queued %s on its admitted owner when selection changes before Compose runs', async route => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    const other = { ...target, threadId: 'docs', requestId: 'other-question' }
    await f.command({ type: 'assign', threadId: other.threadId, instruction: 'Work' })
    await f.command({ type: 'select-thread', threadId: target.threadId })
    f.host.event({ type: 'question', threadId: other.threadId, text: '', request: { ...request, id: other.requestId, delivery: undefined } })
    const execute = vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
    await f.command({ type: 'answer', threadId: other.threadId, requestId: other.requestId, answer: 'Earlier answer' })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { orbColor: 'ice' } }))
    await started
    expect(f.control.get().draftThreadId).toBeNull()
    pending.push(f.command({ type: 'compose', text: 'Blue' }))
    const sending = f.command(route === 'voice' ? { type: 'utterance', text: 'send it. ' } : { type: 'send' })
    pending.push(sending)
    await f.command({ type: 'select-thread', threadId: other.threadId })
    Object.assign(f.host, { refreshThread: vi.fn(async (id: string, purpose?: ThreadReadPurpose) => {
      const snapshot = await f.host.snapshot()
      if (purpose?.retryUncertainAnswers) snapshot.threads.find(thread => thread.id === id)!.requests[0]!.answerRetryReady = true
      return snapshot
    }) })
    // This Check is independent: the queued send belongs to Workshop, not the newly selected question.
    await f.control.checkRequestAnswer(other, desktopWindowClient())
    expect((await f.disk()).outbox).toEqual([])
    release(); await Promise.all(pending)
    expect(await sending).toMatchObject({ error: expect.stringContaining('draft now belongs to a different thread') })
    expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
    expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ threadId: other.threadId, requestId: other.requestId, text: 'Blue' }))
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['send', 'voice', 'socket'] as const)('allows Compose then %s queued on the same owner before a draft exists', async route => {
  const f = await draftHandoffFixture(undefined, {
    authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }),
  })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    await f.command({ type: 'select-thread', threadId: target.threadId })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { orbColor: 'ice' } }))
    await started
    expect(f.control.get().draftThreadId).toBeNull()
    const client = route === 'socket'
      ? { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    pending.push(f.control.commandShell({ type: 'compose', text: 'Blue' }, client))
    const sending = f.control.commandShell(route === 'voice' ? { type: 'utterance', text: 'send it. ' } : { type: 'send' }, client)
    pending.push(sending)
    await expect(f.control.checkRequestAnswer(target, desktopWindowClient())).rejects.toThrow('still being sent')
    release(); await Promise.all(pending)
    expect(await sending).toMatchObject({ error: null })
    expect(f.attempts.filter(command => command.type === 'answer')).toMatchObject([{ threadId: target.threadId, requestId: request.id, answer: 'Blue' }])
    expect((await f.disk()).outbox).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('preserves an unresolved answer across the shipped %s composer Send action', async route => {
  const f = await draftHandoffFixture(undefined, {
    authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }),
  })
  let releaseRead: () => void = () => undefined, releaseCompose: () => void = () => undefined
  let checked: Promise<void> | undefined, sending: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    await f.command({ type: 'select-thread', threadId: target.threadId })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const execute = vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
    await f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: 'Earlier answer' })
    const original = (await f.disk()).outbox
    let readEntered: () => void = () => undefined, composeEntered: () => void = () => undefined
    const reading = new Promise<void>(resolve => { readEntered = resolve })
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    const composing = new Promise<void>(resolve => { composeEntered = resolve })
    const composeGate = new Promise<void>(resolve => { releaseCompose = resolve })
    Object.assign(f.host, { refreshThread: vi.fn(async (id: string, purpose?: ThreadReadPurpose) => {
      const snapshot = await f.host.snapshot()
      if (purpose?.retryUncertainAnswers) {
        snapshot.threads.find(thread => thread.id === id)!.requests[0]!.answerRetryReady = true
        readEntered(); await readGate
      }
      return snapshot
    }) })
    checked = f.control.checkRequestAnswer(target, desktopWindowClient())
    void checked.catch(() => undefined)
    await reading
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { composeEntered(); await composeGate; await persist() })
    const client = route === 'socket'
      ? { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } }, client)
    await composing
    releaseRead()
    await expect(checked).rejects.toThrow('still being sent')
    expect(f.control.requestAnswerRecovery(target.threadId, 'claude').uncertainRequestIds).toEqual([request.id])
    releaseCompose()
    expect(await sending).toMatchObject({ error: expect.stringContaining('earlier action has an unknown result') })
    expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
    expect((await f.disk()).outbox).toEqual(original)
  } finally { releaseRead(); releaseCompose(); await Promise.allSettled([checked, sending]); vi.restoreAllMocks(); await f.close() }
})

it('keeps an atomic Send draft saved when its staging persistence fails', async () => {
  const f = await draftHandoffFixture()
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    const control = f.control as unknown as { persist(): Promise<void> }
    vi.spyOn(control, 'persist').mockRejectedValueOnce(new Error('Could not save this draft.'))
    const result = await f.command({ type: 'send', draft: { threadId: target.threadId, text: 'Text at Send', attachments: [] } })
    expect(result.error).toContain('Could not save this thread draft')
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Text at Send' }))
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['before', 'during'] as const)('preserves a newer same-owner saved revision %s atomic staging', async timing => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, sending: Promise<unknown> | undefined, predecessor: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    if (timing === 'before') { predecessor = f.command({ type: 'compose', text: '' }); await started }
    sending = f.command({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } })
    if (timing === 'during') await started
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000099', text: 'Newer Green', requestId: request.id })
    release(); await sending
    if (timing === 'during') expect(f.attempts.filter(command => command.type === 'answer')).toContainEqual(expect.objectContaining({ answer: 'Blue' }))
    else expect(f.attempts.filter(command => command.type === 'answer' || command.type === 'send')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newer Green' }))
  } finally { release(); await Promise.allSettled([predecessor, sending]); vi.restoreAllMocks(); await f.close() }
})

it('keeps an edit made during Send with its explicit owner after queue progression', async () => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, sending: Promise<unknown> | undefined, editing: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    await f.command({ type: 'assign', threadId: 'docs', instruction: 'Documentation' })
    f.host.event({ type: 'question', threadId: 'docs', text: '', request: { ...request, id: 'docs-question', delivery: undefined } })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.command({ type: 'select-thread', threadId: target.threadId })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    sending = f.command({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } })
    await started
    editing = f.command({ type: 'compose', threadId: target.threadId, text: 'Newer edit for Workshop' })
    release(); await sending; await editing
    expect(f.control.get().activeThreadId).toBe('docs')
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newer edit for Workshop', requestId: request.id }))
    expect((await f.disk()).threadDrafts).not.toContainEqual(expect.objectContaining({ threadId: 'docs', text: 'Newer edit for Workshop' }))
  } finally { release(); await Promise.allSettled([sending, editing]); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('never converts a queued atomic %s answer into a prompt when its question closes', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, sending: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    predecessor = f.command({ type: 'compose', text: '' }); await started
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } }, client)
    const closed = await f.host.snapshot(); closed.threads.find(thread => thread.id === target.threadId)!.requests = []
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(closed)
    await f.command({ type: 'refresh', provider: 'claude' })
    release(); await predecessor; await sending
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Blue', requestId: request.id }))
  } finally { release(); await Promise.allSettled([predecessor, sending]); vi.restoreAllMocks(); await f.close() }
})

it('verifies atomic Send attachment handles before staging or native dispatch', async () => {
  const f = await draftHandoffFixture()
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    const result = await f.command({ type: 'send', draft: { threadId: target.threadId, text: 'Text at Send',
      attachments: [{ id: 'unknown', name: 'synthetic.png', mimeType: 'image/png', sizeBytes: 1, digest: 'f'.repeat(64) }] } })
    expect(result.error).not.toBeNull()
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect(f.control.get().threadDrafts).not.toContainEqual(expect.objectContaining({ text: 'Text at Send' }))
  } finally { await f.close() }
})

it.each([['local', 'queued'], ['socket', 'queued'], ['local', 'staging'], ['socket', 'staging']] as const)(
  'refuses an atomic %s Send when an image vanishes while %s', async (route, timing) => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, sending: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    const image = await f.control.stageAttachment({ name: 'synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    if (timing === 'queued') { predecessor = f.command({ type: 'compose', text: 'Text with an image' }); await started }
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Text with an image', attachments: [image] } }, client)
    if (timing === 'staging') await started
    await writeFile(join(f.root, 'attachments', `${image.digest}.png`), 'synthetic corruption', 'utf8')
    expect(await f.control.attachmentContent(image.digest)).toBeNull()
    release(); await predecessor
    expect(await sending).toMatchObject({ error: 'The prompt was not sent. An image is no longer kept. Your text was saved. Attach it again before sending.' })
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Text with an image' }))
  } finally { release(); await Promise.allSettled([predecessor, sending]); vi.restoreAllMocks(); await f.close() }
})

it.each([false, true])('keeps the atomic socket staging outcome independent of another command (staging fails %s)', async fails => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, off: () => void = () => undefined
  let sending: Promise<unknown> | undefined, other: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => {
      entered(); await gate
      if (fails) throw new Error('Synthetic staging write failure')
      await persist()
    })
    if (fails) {
      let navigated = false
      off = f.control.subscribe(state => {
        if (!navigated && state.error?.includes('Could not save this thread draft')) {
          navigated = true
          other = f.command({ type: 'select-thread', threadId: 'docs' })
        }
      })
    }
    const client = { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId }
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Text at Send', attachments: [] } }, client)
    await started
    if (!fails) {
      other = f.command({ type: 'answer', threadId: 'docs', requestId: 'missing', answer: 'Synthetic unrelated answer' })
      expect(await other).toMatchObject({ error: expect.stringContaining('request is no longer pending') })
    }
    release()
    expect(await sending).toMatchObject({ error: fails ? expect.stringContaining('Could not save this thread draft') : null })
    await other
    expect(f.attempts.filter(command => command.type === 'send')).toHaveLength(fails ? 0 : 1)
    if (fails) expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Text at Send' }))
  } finally { off(); release(); await Promise.allSettled([sending, other]); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('refuses an atomic %s Send whose payload names a different draft owner', async route => {
  const f = await draftHandoffFixture()
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    await f.command({ type: 'select-thread', threadId: 'docs' })
    const client = route === 'socket'
      ? { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: 'docs' } : desktopWindowClient()
    const result = await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Text at Send', attachments: [] } }, client)
    expect(result.error).toContain('draft now belongs to a different thread')
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect(f.control.get().threadDrafts).not.toContainEqual(expect.objectContaining({ text: 'Text at Send' }))
  } finally { await f.close() }
})

it.each([['answer', false], ['answer', true], ['send', false], ['send', true], ['voice', false], ['voice', true]] as const)(
  'keeps a newer %s reservation admitted during the native read (still dispatching %s)', async (route, active) => {
  const f = await draftHandoffFixture()
  let releaseRead: () => void = () => undefined, releaseWrite: () => void = () => undefined
  let checking: Promise<void> | undefined, answering: Promise<unknown> | undefined
  try {
    if (route !== 'answer') await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined, answerRetryReady: true } })
    if (route !== 'answer') {
      await f.command({ type: 'select-thread', threadId: target.threadId })
      await f.command({ type: 'compose', text: 'Blue' })
    }
    const stale = await f.host.snapshot()
    let readStarted: () => void = () => undefined, writeStarted: () => void = () => undefined
    const reading = new Promise<void>(resolve => { readStarted = resolve })
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    const writing = new Promise<void>(resolve => { writeStarted = resolve })
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
    Object.assign(f.host, { refreshThread: vi.fn(async (_id: string, purpose?: ThreadReadPurpose) => {
      if (purpose?.retryUncertainAnswers) { readStarted(); await readGate; return stale }
      return f.host.snapshot()
    }) })
    vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
    checking = f.control.checkRequestAnswer(target, desktopWindowClient())
    const rejected = expect(checking).rejects.toThrow(active ? 'still being sent' : 'Another answer started during this check')
    await reading
    if (active) {
      const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
      vi.spyOn(control, 'persist').mockImplementationOnce(async () => { writeStarted(); await writeGate; await persist() })
    }
    answering = route === 'voice' ? f.command({ type: 'utterance', text: 'send it' }) : route === 'send' ? f.command({ type: 'send' })
      : f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: '',
        questionAnswers: { q: { optionIds: [], text: 'Blue' } } })
    if (active) await writing
    else await answering
    expect(f.control.requestAnswerRecovery(target.threadId, 'claude').uncertainRequestIds).toEqual([request.id])
    releaseRead(); await rejected
    expect(f.control.requestAnswerRecovery(target.threadId, 'claude').uncertainRequestIds).toEqual([request.id])
    releaseWrite(); await answering
    expect((await f.disk()).outbox).toMatchObject([{ type: 'answer', threadId: target.threadId, requestId: request.id }])
    // The settled command releases both admission and dispatch ownership, so a new explicit Check can proceed.
    await expect(f.control.checkRequestAnswer(target, desktopWindowClient())).resolves.toBeUndefined()
  } finally { releaseRead(); releaseWrite(); await Promise.allSettled([checking, answering]); vi.restoreAllMocks(); await f.close() }
})
