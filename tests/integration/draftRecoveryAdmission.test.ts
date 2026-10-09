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
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    const image = await f.control.stageAttachment({ name: 'synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    predecessor = f.command({ type: 'configure', patch: { speak: false, followupLimit: 3 } })
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
    expect(f.control.get()).toMatchObject({ error: before.error, notice: before.notice, speech: before.speech })
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ text: 'Private composed edit', attachments: lostImage ? [] : [image] }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled([predecessor, saving]); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('distinguishes inherited images from explicit image removal in a stable Send (%s)', async route => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000121'
  const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
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
      expect(f.control.get()).toMatchObject({ threadDrafts: before.threadDrafts, obsoleteDrafts: before.obsoleteDrafts, error: before.error, notice: before.notice, speech: before.speech })
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
    await f.command({ type: 'resume-draft', threadId: 'missing-thread' })
    const before = f.control.get()
    expect(before.error).toBeTruthy()
    const attachments = scenario === 'missing-image' ? [{ ...handleOf(PIXEL_PNG), digest: 'f'.repeat(64) }] : undefined
    const result = await f.control.commandShell({ type: 'save-thread-draft', threadId: target.threadId, draftId: scenario === 'obsolete' ? priorId : nextId, text: 'Private edit', requestId: null, attachments }, client)
    expect(result.error).toEqual(scenario === 'success' ? null : expect.stringContaining(scenario === 'obsolete' ? 'cleared or replaced' : 'image'))
    expect(f.control.get()).toMatchObject({ error: before.error, notice: before.notice, speech: before.speech })
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
      expect(f.control.get()).toMatchObject({ error: before.error, notice: before.notice, speech: before.speech,
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
