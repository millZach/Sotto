import type { ThreadReadPurpose } from '../../src/main/agents/host'
// @vitest-environment node
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { agentCommandSchema } from '../../src/shared/agents'
import { questions, request, target } from '../fixtures/answerDraftFixture'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'
import { PIXEL_PNG, handleOf } from '../fixtures/stagedImages'

it.each([false, true])('keeps queued targeted socket Compose feedback private (image lost %s)', async lostImage => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, saving: Promise<unknown> | undefined
  try {
    const image = await f.control.stageAttachment({ name: 'synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    predecessor = f.command({ type: 'configure', patch: { reasoningEffort: 'high' } })
    await started
    // This independent invalid save establishes another operation's shared error while Compose waits.
    await f.command({ type: 'save-thread-draft', threadId: 'missing-thread', draftId: '00000000-0000-4000-8000-000000000119', text: 'Unrelated', requestId: null })
    const before = f.control.get()
    expect(before.error).toBeTruthy()
    saving = f.control.commandShell({ type: 'compose', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000120', text: 'Private composed edit', attachments: [image] },
      { clientId: 'paired', user: 'User', transport: 'socket', selectedThreadId: target.threadId })
    if (lostImage) {
      await writeFile(join(f.root, 'attachments', `${image.digest}.png`), 'synthetic corruption', 'utf8')
      expect(await f.control.attachmentContent(image.digest)).toBeNull()
    }
    release(); await predecessor
    expect(await saving).toMatchObject({ error: lostImage ? expect.stringContaining('image') : null })
    expect(f.control.get()).toMatchObject({ error: before.error, notice: before.notice })
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ text: 'Private composed edit', attachments: lostImage ? [] : [image] }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled([predecessor, saving]); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('distinguishes inherited images from explicit image removal in a stable Send (%s)', async route => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000121'
  const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
  try {
    const image = await f.control.stageAttachment({ name: 'synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'With inherited image', attachments: [image] }, client)
    const packet = { type: 'send' as const, draft: { threadId: target.threadId, draftId, text: 'With inherited image', binding: { requestId: null, questionsDigest: null } } }
    expect((await f.control.commandShell(packet, client)).error).toBeNull()
    const sends = f.attempts.filter(command => command.type === 'send')
    expect(sends).toEqual([expect.objectContaining({ attachments: [expect.objectContaining({ digest: image.digest })] })])
    expect((await f.control.commandShell({ ...packet, draft: { ...packet.draft, attachments: [] } }, client)).error).toContain('revision')
    expect((await f.control.commandShell(packet, client)).error).toBeNull()
    expect(f.attempts.filter(command => command.type === 'send')).toHaveLength(1)
  } finally { await f.close() }
})

it.each(['replacement', 'clear', 'exact', 'idempotent'] as const)('enforces the recovery prior revision (%s)', async scenario => {
  const f = await draftHandoffFixture()
  const priorId = '00000000-0000-4000-8000-000000000103', newerId = '00000000-0000-4000-8000-000000000104', recoveredId = '00000000-0000-4000-8000-000000000105'
  const client = { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId }
  try {
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: priorId, text: 'Original', requestId: null })
    const recovery = { type: 'save-thread-draft' as const, threadId: target.threadId, draftId: recoveredId, expectedDraftId: priorId, text: 'Recovered', requestId: null }
    if (scenario === 'replacement' || scenario === 'clear') await f.command({ ...recovery, draftId: newerId, expectedDraftId: undefined, text: scenario === 'clear' ? '' : 'Other client' })
    if (scenario === 'idempotent') await f.control.commandShell(recovery, client)
    const before = f.control.get()
    const result = await f.control.commandShell(recovery, client)
    if (scenario === 'exact' || scenario === 'idempotent') {
      expect(result.error).toBeNull()
      expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId: recoveredId, text: 'Recovered' }))
    } else {
      expect(result.error).toContain('changed')
      expect(f.control.get()).toMatchObject({ threadDrafts: before.threadDrafts, obsoleteDrafts: before.obsoleteDrafts, error: before.error, notice: before.notice })
      expect((await f.disk()).threadDrafts).toEqual(scenario === 'clear' ? [] : [expect.objectContaining({ draftId: newerId, text: 'Other client' })])
    }
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { await f.close() }
})

it.each(['success', 'missing-image', 'obsolete'] as const)('keeps every socket draft save outcome private (%s)', async scenario => {
  const f = await draftHandoffFixture()
  const priorId = '00000000-0000-4000-8000-000000000106', nextId = '00000000-0000-4000-8000-000000000107'
  const client = { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId }
  try {
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: priorId, text: 'Original', requestId: null })
    if (scenario === 'obsolete') await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: nextId, text: 'Newer', requestId: null })
    await f.command({ type: 'select-thread', threadId: 'missing-thread' })
    const before = f.control.get()
    expect(before.error).toBeTruthy()
    const attachments = scenario === 'missing-image' ? [{ ...handleOf(PIXEL_PNG), digest: 'f'.repeat(64) }] : undefined
    const result = await f.control.commandShell({ type: 'save-thread-draft', threadId: target.threadId, draftId: scenario === 'obsolete' ? priorId : nextId, text: 'Private edit', requestId: null, attachments }, client)
    expect(result.error).toEqual(scenario === 'success' ? null : expect.stringContaining(scenario === 'obsolete' ? 'cleared or replaced' : 'image'))
    expect(f.control.get()).toMatchObject({ error: before.error, notice: before.notice })
    if (scenario !== 'obsolete') expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId: nextId, text: 'Private edit', attachments: [] }))
  } finally { await f.close() }
})

it.each([['local', 'changed'], ['socket', 'changed'], ['local', 'absent'], ['socket', 'absent'],
  ['local', 'exact'], ['socket', 'exact'], ['local', 'prompt'], ['socket', 'prompt']] as const)(
  'validates an exact-form recovery save at %s admission (%s)', async (route, scenario) => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  const priorId = '00000000-0000-4000-8000-000000000086', nextId = '00000000-0000-4000-8000-000000000087'
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const requestId = scenario === 'prompt' ? null : request.id
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: priorId, requestId, text: 'Prior durable edit' })
    if (scenario === 'changed' || scenario === 'absent') {
      const replacement = await f.host.snapshot()
      replacement.threads.find(thread => thread.id === target.threadId)!.requests = scenario === 'absent' ? []
        : [{ ...request, delivery: undefined, questions: [{ ...questions[0]!, question: 'Changed same-ID question?' }] }]
      vi.spyOn(f.host, 'snapshot').mockResolvedValue(replacement)
      await f.command({ type: 'refresh', provider: 'claude' })
    }
    const before = f.control.get()
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    const result = await f.control.commandShell({ type: 'save-thread-draft', threadId: target.threadId, draftId: nextId, requestId, text: 'Recovered latest edit',
      ...(requestId ? { questionsDigest: target.questionsDigest } : {}) }, client)
    if (scenario === 'exact' || scenario === 'prompt') {
      expect(result.error).toBeNull()
      expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId: nextId, requestId, text: 'Recovered latest edit' }))
    } else {
      expect(result.error).toContain('question changed')
      expect(f.control.get()).toMatchObject({ error: before.error, notice: before.notice,
        threadDrafts: before.threadDrafts, obsoleteDrafts: before.obsoleteDrafts })
      expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId: priorId, text: 'Prior durable edit' }))
    }
    expect(f.attempts.filter(command => command.type === 'answer' || command.type === 'send')).toEqual([])
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('accepts a recovery form digest only with its original question ID', () => {
  const packet = { type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000085', text: 'Synthetic' }
  for (const extra of [{ questionsDigest: target.questionsDigest }, { requestId: null, questionsDigest: target.questionsDigest },
    { requestId: request.id, questionsDigest: 'invalid' }]) expect(agentCommandSchema.safeParse({ ...packet, ...extra }).success).toBe(false)
  expect(agentCommandSchema.safeParse({ ...packet, requestId: null }).success).toBe(true)
  expect(agentCommandSchema.safeParse({ ...packet, requestId: request.id, questionsDigest: target.questionsDigest }).success).toBe(true)
})

it.each([['answer', false], ['answer', true], ['send', false], ['send', true],
  ] as const)(
  'keeps a queued %s submission owned before its command lane opens (admitted during Check %s)', async (route, duringRead) => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, releaseRead: () => void = () => undefined
  let predecessor: Promise<unknown> | undefined, answering: Promise<unknown> | undefined, checking: Promise<void> | undefined
  try {
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
    answering = route === 'send' ? f.command({ type: 'send' })
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

it('keeps queued Send on its admitted owner when selection changes before Compose runs', async () => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    const other = { ...target, threadId: 'docs', requestId: 'other-question' }
    await f.command({ type: 'select-thread', threadId: target.threadId })
    f.host.event({ type: 'question', threadId: other.threadId, text: '', request: { ...request, id: other.requestId, delivery: undefined } })
    const execute = vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
    await f.command({ type: 'answer', threadId: other.threadId, requestId: other.requestId, answer: 'Earlier answer' })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { projectsDirectory: 'ice' } }))
    await started
    expect(f.control.get().draftThreadId).toBeNull()
    pending.push(f.command({ type: 'compose', text: 'Blue' }))
    const sending = f.command({ type: 'send' })
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

it('keeps an edit made during Send with its explicit owner after navigation', async () => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, sending: Promise<unknown> | undefined, editing: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: 'docs', text: '', request: { ...request, id: 'docs-question', delivery: undefined } })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const image = await f.control.stageAttachment({ name: 'docs.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    await f.command({ type: 'save-thread-draft', threadId: 'docs', draftId: '00000000-0000-4000-8000-000000000083', text: 'Retained Docs edit',
      requestId: 'docs-question', attachments: [image], skills: [{ name: 'docs', path: 'C:/synthetic/docs' }], files: [{ path: 'notes.md' }] })
    await f.command({ type: 'select-thread', threadId: target.threadId })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    sending = f.command({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } })
    await started
    editing = f.command({ type: 'compose', threadId: target.threadId, text: 'Newer edit for Workshop' })
    release(); await sending; await editing
    await f.command({ type: 'select-thread', threadId: 'docs' })
    expect(f.control.get().activeThreadId).toBe('docs')
    const drafts = (await f.disk()).threadDrafts
    expect(drafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newer edit for Workshop', requestId: null, attachments: [] }))
    const workshop = drafts.find((draft: { threadId: string }) => draft.threadId === target.threadId)
    expect(workshop.skills).toBeUndefined(); expect(workshop.files).toBeUndefined()
    expect(drafts).toContainEqual(expect.objectContaining({ threadId: 'docs', text: 'Retained Docs edit', attachments: [image],
      skills: [{ name: 'docs', path: 'C:/synthetic/docs' }], files: [{ path: 'notes.md' }] }))
  } finally { release(); await Promise.allSettled([sending, editing]); vi.restoreAllMocks(); await f.close() }
})
