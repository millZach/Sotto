// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { expect, it, vi } from 'vitest'
import type { ThreadReadPurpose } from '../../src/main/agents/host'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { questions, request, target } from '../fixtures/answerDraftFixture'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'

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

it.each(['answer', 'send'] as const)('preserves a new %s answer reservation before its persistence and native boundary', async route => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined
  let answer: Promise<unknown> | undefined, checked: Promise<void> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined, answerRetryReady: true } })
    if (route !== 'answer') {
      await f.command({ type: 'select-thread', threadId: target.threadId })
      expect(await f.command({ type: 'compose', text: 'Blue' })).toMatchObject({ draftThreadId: target.threadId, draftRequestId: request.id, error: null })
    }
    const refresh = vi.fn(async () => f.host.snapshot())
    Object.assign(f.host, { refreshThread: refresh })
    const control = f.control as unknown as { persist(): Promise<void> }
    const persist = control.persist.bind(control)
    const { promise: reserved, resolve: entered } = deferred<void>()
    const { promise: blocked, resolve: blockedResolve } = deferred<void>()
    release = blockedResolve
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
    await expect(checked).rejects.toThrow('still being sent')
    expect(f.attempts.filter(command => command.type === 'answer')).toHaveLength(1)
    expect((await f.disk()).outbox).toEqual([])
  } finally { release(); await Promise.allSettled([answer, checked]); vi.restoreAllMocks(); await f.close() }
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
    const { promise: started, resolve: entered } = deferred<void>()
    const { promise: blocked, resolve: blockedResolve } = deferred<void>()
    release = blockedResolve
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
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined, answerRetryReady: true } })
    f.host.event({ type: 'question', threadId: other.threadId, text: '', request: { ...request, id: other.requestId, delivery: undefined } })
    if (global === 'different') {
      await f.command({ type: 'select-thread', threadId: other.threadId })
      await f.command({ type: 'compose', text: 'Green' })
    }
    const client = { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId }
    const { promise: started, resolve: entered } = deferred<void>()
    const { promise: gate, resolve: gateResolve } = deferred<void>()
    release = gateResolve
    // A snapshot's save runs once the code that accepted it has run on. Let it start, so the gate below holds the
    // save this test is about.
    await new Promise<void>(resolve => setImmediate(resolve))
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

it.each(['send', 'socket', 'socket-legacy'] as const)(
  'preserves an unresolved answer when Compose and %s queue before the draft exists', async route => {
  const f = await draftHandoffFixture(undefined, {
    authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }),
  })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
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
    const { promise: started, resolve: entered } = deferred<void>()
    const { promise: gate, resolve: gateResolve } = deferred<void>()
    release = gateResolve
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { projectsDirectory: 'ice' } }))
    await started
    expect(f.control.get().draftThreadId).toBeNull()
    pending.push(f.control.commandShell({ type: 'compose', text: 'Blue' }, client))
    const sending = f.control.commandShell({ type: 'send' }, client)
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

it.each(['send', 'socket'] as const)('allows Compose then %s queued on the same owner before a draft exists', async route => {
  const f = await draftHandoffFixture(undefined, {
    authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }),
  })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    await f.command({ type: 'select-thread', threadId: target.threadId })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const { promise: started, resolve: entered } = deferred<void>()
    const { promise: gate, resolve: gateResolve } = deferred<void>()
    release = gateResolve
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { projectsDirectory: 'ice' } }))
    await started
    expect(f.control.get().draftThreadId).toBeNull()
    const client = route === 'socket'
      ? { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    pending.push(f.control.commandShell({ type: 'compose', text: 'Blue' }, client))
    const sending = f.control.commandShell({ type: 'send' }, client)
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
    await f.command({ type: 'select-thread', threadId: target.threadId })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const execute = vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
    await f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: 'Earlier answer' })
    const original = (await f.disk()).outbox
    const { promise: reading, resolve: readEntered } = deferred<void>()
    const { promise: readGate, resolve: readGateResolve } = deferred<void>()
    releaseRead = readGateResolve
    const { promise: composing, resolve: composeEntered } = deferred<void>()
    const { promise: composeGate, resolve: composeGateResolve } = deferred<void>()
    releaseCompose = composeGateResolve
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
