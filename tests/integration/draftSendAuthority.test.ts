// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import { agentCommandSchema } from '../../src/shared/agents'
import { questions, request, target } from '../fixtures/answerDraftFixture'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'

it.each(['local', 'socket'] as const)('validates a guarded atomic %s Send against the actual admission question after client preflight', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const binding = { requestId: request.id, questionsDigest: requestQuestionsDigest(questions) }
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    const replacement = await f.host.snapshot()
    replacement.threads.find(thread => thread.id === target.threadId)!.requests = [{ ...request, id: 'new-question', delivery: undefined }]
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(replacement)
    await f.command({ type: 'refresh', provider: 'claude' })
    const result = await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Original answer', attachments: [], binding } }, client)
    expect(result.error).toContain('Nothing was sent')
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect(f.control.get().threadDrafts).toEqual([])
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('requires exact question ID/digest or explicit prompt intent in a guarded Send', () => {
  const packet = { type: 'send', draft: { threadId: target.threadId, text: 'Synthetic' } }
  for (const binding of [{ requestId: request.id, questionsDigest: null }, { requestId: null, questionsDigest: target.questionsDigest },
    { requestId: request.id, questionsDigest: '' }, { requestId: null, questionsDigest: null, approved: true }]) {
    expect(agentCommandSchema.safeParse({ ...packet, draft: { ...packet.draft, binding } }).success).toBe(false)
  }
  for (const binding of [{ requestId: request.id, questionsDigest: target.questionsDigest }, { requestId: null, questionsDigest: null }]) {
    expect(agentCommandSchema.safeParse({ ...packet, draft: { ...packet.draft, binding } }).success).toBe(true)
  }
})

it.each([['local', 'changed'], ['socket', 'changed'], ['local', 'absent'], ['socket', 'absent'],
  ['local', 'prompt'], ['socket', 'prompt'], ['local', 'exact'], ['socket', 'exact']] as const)(
  'checks a guarded atomic %s %s binding without substituting native intent', async (route, scenario) => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    if (scenario === 'changed' || scenario === 'absent') {
      if (scenario === 'absent') await f.command({ type: 'save-thread-draft', threadId: target.threadId,
        draftId: '00000000-0000-4000-8000-000000000098', requestId: request.id, text: 'Retained original answer' })
      const current = await f.host.snapshot()
      current.threads.find(thread => thread.id === target.threadId)!.requests = scenario === 'absent' ? []
        : [{ ...request, delivery: undefined, questions: [{ ...questions[0]!, question: 'Different same-ID form?' }] }]
      vi.spyOn(f.host, 'snapshot').mockResolvedValue(current)
      await f.command({ type: 'refresh', provider: 'claude' })
    }
    const binding = scenario === 'prompt' ? { requestId: null, questionsDigest: null }
      : { requestId: request.id, questionsDigest: target.questionsDigest }
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    const result = await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [], binding } }, client)
    if (scenario === 'exact') {
      expect(result.error).toBeNull()
      expect(f.attempts.filter(command => command.type === 'answer')).toEqual([expect.objectContaining({ requestId: request.id, answer: 'Blue' })])
    } else {
      expect(result.error).toContain('Nothing was sent')
      expect(f.attempts.filter(command => command.type === 'answer')).toEqual([])
    }
    expect(f.attempts.filter(command => command.type === 'send')).toEqual([])
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('accepts a guarded %s prompt without a pending question', async route => {
  const f = await draftHandoffFixture()
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    expect(await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'New prompt', attachments: [],
      binding: { requestId: null, questionsDigest: null } } }, client)).toMatchObject({ error: null })
    expect(f.attempts.filter(command => command.type === 'send')).toEqual([expect.objectContaining({ text: 'New prompt' })])
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([])
  } finally { await f.close() }
})

it('checks current socket authority before a direct bound draft save mutates the host', async () => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: () => ({ allowed: false, reason: 'no-policy' }) })
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const before = f.control.get()
    const result = await f.control.commandShell({ type: 'save-thread-draft', threadId: target.threadId,
      draftId: '00000000-0000-4000-8000-000000000099', requestId: request.id, text: 'Unprivileged recovery' },
      { clientId: 'paired', user: 'User', transport: 'socket', selectedThreadId: target.threadId })
    expect(result.error).toContain('not allowed from this device')
    expect(f.control.get()).toMatchObject({ error: before.error, notice: before.notice, threadDrafts: before.threadDrafts })
    expect((await f.disk()).threadDrafts).toEqual(before.threadDrafts)
  } finally { await f.close() }
})

it.each([false, true])('keeps a socket targeted Compose policy refusal private (revoked while queued %s)', async revoked => {
  let allowed = revoked
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: () => ({ allowed, reason: allowed ? 'paired-client' : 'no-policy' }) })
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, editing: Promise<unknown> | undefined
  try {
    await f.command({ type: 'configure', patch: { } })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    if (revoked) {
      let entered: () => void = () => undefined
      const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
      const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
      vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
      predecessor = f.command({ type: 'configure', patch: { reasoningEffort: 'high' } }); await started
    } else {
      expect((await f.command({ type: 'compact-thread', threadId: 'missing' })).error).toBeTruthy()
    }
    const feedback = () => {
      const state = f.control.get()
      return { error: state.error, notice: state.notice }
    }
    const before = feedback()
    editing = f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Refused edit' },
      { clientId: 'paired', user: 'User', transport: 'socket', selectedThreadId: target.threadId })
    allowed = false; release(); await predecessor
    expect(await editing).toMatchObject({ error: expect.stringContaining('not allowed from this device') })
    expect(feedback()).toEqual(before)
    expect(f.control.get().threadDrafts).toEqual([])
  } finally { release(); await Promise.allSettled([predecessor, editing]); vi.restoreAllMocks(); await f.close() }
})
