// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'
import { PIXEL_PNG, handleOf } from '../fixtures/stagedImages'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import type { AgentRequest } from '../../src/shared/agents'
import type { ThreadReadPurpose } from '../../src/main/agents/host'
import { agentCommandSchema } from '../../src/shared/agents'

const questions = [{ id: 'q', question: 'Which color?', options: [], multiSelect: false, allowFreeText: true }]
const request: AgentRequest = { id: 'question', kind: 'question', text: '', options: [], questions, delivery: 'uncertain' }
const target = { threadId: 'workshop', providerId: 'claude' as const, requestId: request.id, questionsDigest: requestQuestionsDigest(questions) }

it.each(['local', 'socket'] as const)('uses the exact submitted Compose and Send revisions (%s)', async route => {
  const f = await draftHandoffFixture()
  const savedId = '00000000-0000-4000-8000-000000000101', sentId = '00000000-0000-4000-8000-000000000102'
  const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
  try {
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, draftId: savedId, text: 'Exact prompt' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId: savedId, text: 'Exact prompt' }))
    const packet = { type: 'send' as const, draft: { threadId: target.threadId, draftId: sentId, text: 'Exact prompt', binding: { requestId: null, questionsDigest: null } } }
    expect((await f.control.commandShell(packet, client)).error).toBeNull()
    expect(f.control.get().deliveredDrafts).toContainEqual({ threadId: target.threadId, draftId: sentId })
    await f.restart()
    expect((await f.control.commandShell(packet, client)).error).toBeNull()
    expect(f.attempts.filter(command => command.type === 'send')).toHaveLength(1)
    expect((await f.control.commandShell({ ...packet, draft: { ...packet.draft, text: 'Different prompt' } }, client)).error).toContain('revision')
    expect(f.attempts.filter(command => command.type === 'send')).toHaveLength(1)
  } finally { await f.close() }
})

it.each([false, true])('keeps exact stable answer delivery proof across restart (newer revision %s)', async newer => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }), mayGrant: () => ({ allowed: true, reason: 'paired-client' }) })
  const draftId = '00000000-0000-4000-8000-000000000109', newerId = '00000000-0000-4000-8000-000000000110'
  const client = { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId }
  const packet = { type: 'send' as const, draft: { threadId: target.threadId, draftId, text: 'Blue', binding: { requestId: request.id, questionsDigest: target.questionsDigest } } }
  let release: () => void = () => undefined, sending: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const execute = f.host.execute.bind(f.host)
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    sending = f.control.commandShell(packet, client)
    await Promise.race([started, sending!.then(result => { throw new Error(`Native answer was refused: ${(result as { error: string }).error}`) })])
    if (newer) await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: newerId, requestId: request.id, text: 'Green' })
    release(); await sending
    expect(f.control.get().deliveries).toContainEqual(expect.objectContaining({ draftId, status: 'accepted' }))
    expect(f.control.get().threadDrafts).toEqual(newer ? [expect.objectContaining({ draftId: newerId, text: 'Green' })] : [])
    await f.restart()
    expect((await f.control.commandShell(packet, client)).error).toBeNull()
    expect(f.attempts.filter(command => command.type === 'answer')).toHaveLength(1)
    expect(f.control.get().threadDrafts).toEqual(newer ? [expect.objectContaining({ draftId: newerId, text: 'Green' })] : [])
  } finally { release(); await Promise.allSettled([sending]); vi.restoreAllMocks(); await f.close() }
})

it('joins only an identical stable Send while its native call is held', async () => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }), mayGrant: () => ({ allowed: true, reason: 'paired-client' }) })
  const draftId = '00000000-0000-4000-8000-000000000111'
  const packet = { type: 'send' as const, draft: { threadId: target.threadId, draftId, text: 'Once', binding: { requestId: null, questionsDigest: null } } }
  let release: () => void = () => undefined, first: Promise<unknown> | undefined, duplicate: Promise<unknown> | undefined
  try {
    const execute = f.host.execute.bind(f.host)
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const native = vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    first = f.control.commandShell(packet); await started
    duplicate = f.control.commandShell(packet)
    const mismatch = await f.control.commandShell({ ...packet, draft: { ...packet.draft, text: 'Changed' } })
    expect(mismatch.error).toContain('revision')
    expect(native).toHaveBeenCalledTimes(1)
    release(); await Promise.all([first, duplicate])
    expect(f.attempts.filter(command => command.type === 'send')).toHaveLength(1)
  } finally { release(); await Promise.allSettled([first, duplicate]); vi.restoreAllMocks(); await f.close() }
})

it.each(['prompt', 'answer'] as const)('does not replay an unresolved stable %s after restart', async kind => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }), mayGrant: () => ({ allowed: true, reason: 'paired-client' }) })
  const draftId = '00000000-0000-4000-8000-000000000112'
  const client = { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId }
  const packet = { type: 'send' as const, draft: { threadId: target.threadId, draftId, text: 'Blue', binding: kind === 'answer'
    ? { requestId: request.id, questionsDigest: target.questionsDigest } : { requestId: null, questionsDigest: null } } }
  try {
    if (kind === 'answer') f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const native = vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
    expect((await f.control.commandShell(packet, client)).error).toBeTruthy()
    expect((await f.disk()).outbox).toContainEqual(expect.objectContaining({ draftId, atomicDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }))
    await f.restart()
    expect((await f.control.commandShell(packet, client)).error).toContain('unknown result')
    expect(native).toHaveBeenCalledTimes(1)
    expect(f.control.get().deliveries).toContainEqual(expect.objectContaining({ draftId, status: 'uncertain' }))
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('publishes only positive late acceptance for a stable answer and preserves its newer revision', async () => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }), mayGrant: () => ({ allowed: true, reason: 'paired-client' }) })
  const draftId = '00000000-0000-4000-8000-000000000113', newerId = '00000000-0000-4000-8000-000000000114'
  let complete: (accepted: boolean) => void = () => undefined
  const completion = new Promise<boolean>(resolve => { complete = resolve })
  const client = { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId }
  const packet = { type: 'send' as const, draft: { threadId: target.threadId, draftId, text: 'Blue', binding: { requestId: request.id, questionsDigest: target.questionsDigest } } }
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const native = vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true, answerCompletion: completion })
    await f.control.commandShell(packet, client)
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: newerId, requestId: request.id, text: 'Green' })
    expect(f.control.get().deliveredDrafts).not.toContainEqual({ threadId: target.threadId, draftId })
    complete(true)
    await vi.waitFor(() => expect(f.control.get().deliveredDrafts).toContainEqual({ threadId: target.threadId, draftId }))
    expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ draftId: newerId, text: 'Green' })])
    expect((await f.control.commandShell(packet, client)).error).toBeNull()
    expect(native).toHaveBeenCalledTimes(1)
  } finally { complete(false); vi.restoreAllMocks(); await f.close() }
})

it.each(['text', 'binding', 'owner'] as const)('refuses stable Compose UUID reuse before changing the composer (%s)', async change => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }), mayGrant: () => ({ allowed: true, reason: 'paired-client' }) })
  const draftId = '00000000-0000-4000-8000-000000000115'
  try {
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, draftId, text: 'Original' })
    const before = f.control.get()
    if (change === 'binding') f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const command = change === 'owner' ? { type: 'compose' as const, threadId: 'docs', draftId, text: 'Original' }
      : { type: 'compose' as const, threadId: target.threadId, draftId, text: change === 'text' ? 'Different' : 'Original' }
    // A binding cannot be changed through a stable recovery UUID either.
    const result = change === 'binding' ? await f.control.commandShell({ type: 'save-thread-draft', threadId: target.threadId, draftId,
      expectedDraftId: draftId, requestId: request.id, text: 'Original' }, { clientId: 'paired', user: 'User', transport: 'socket', selectedThreadId: target.threadId })
      : await f.control.commandShell(command)
    expect(result.error).toContain('revision')
    expect(f.control.get()).toMatchObject({ threadDrafts: before.threadDrafts, draft: before.draft, draftThreadId: before.draftThreadId, draftRequestId: before.draftRequestId })
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { await f.close() }
})

it('records a definite pre-dispatch stable Send refusal separately from uncertainty', async () => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000116'
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const result = await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, draftId, text: 'Prompt', binding: { requestId: null, questionsDigest: null } } },
      { clientId: 'paired', user: 'User', transport: 'socket', selectedThreadId: target.threadId })
    expect(result.error).toContain('Nothing was sent')
    expect(result.deliveries).toContainEqual(expect.objectContaining({ draftId, status: 'failed' }))
    expect((await f.disk()).deliveries).toContainEqual(expect.objectContaining({ draftId, status: 'failed' }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { await f.close() }
})

it.each(['body', 'owner'] as const)('keeps failed stable Send UUID ownership across restart (%s)', async change => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000117'
  const packet = { type: 'send' as const, draft: { threadId: target.threadId, draftId, text: '', binding: { requestId: null, questionsDigest: null } } }
  try {
    expect((await f.control.commandShell(packet)).error).toContain('no prompt')
    expect((await f.disk()).deliveries).toContainEqual(expect.objectContaining({ draftId, status: 'failed', packetDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }))
    await f.restart()
    const changed = { ...packet, draft: { ...packet.draft, text: change === 'body' ? 'Different' : '', threadId: change === 'owner' ? 'docs' : target.threadId } }
    expect((await f.control.commandShell(changed)).error).toContain('revision')
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { await f.close() }
})

it('keeps accepted packet identity when unrelated direct answer receipts evict its public revision', async () => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000118'
  const packet = { type: 'send' as const, draft: { threadId: target.threadId, draftId, text: 'Once', binding: { requestId: null, questionsDigest: null } } }
  try {
    expect((await f.control.commandShell(packet)).error).toBeNull()
    for (let index = 0; index < 129; index++) {
      const requestId = `other-question-${index}`, otherId = `00000000-0000-4000-8000-${(200 + index).toString().padStart(12, '0')}`
      f.host.event({ type: 'question', threadId: 'docs', text: '', request: { ...request, id: requestId, delivery: undefined } })
      await f.command({ type: 'save-thread-draft', threadId: 'docs', draftId: otherId, text: 'Other answer', requestId })
      await f.command({ type: 'answer', threadId: 'docs', requestId, answer: 'Other answer' })
    }
    expect(f.control.get().deliveredDrafts).not.toContainEqual({ threadId: target.threadId, draftId })
    await f.restart()
    expect((await f.control.commandShell(packet)).error).toBeNull()
    expect(f.attempts.filter(command => command.type === 'send')).toHaveLength(1)
    expect(f.control.get().deliveredDrafts).toContainEqual({ threadId: target.threadId, draftId })
  } finally { await f.close() }
})

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

it.each([false, true])('records only the captured draft accepted by a direct answer (newer edit %s)', async newer => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000091', newerId = '00000000-0000-4000-8000-000000000092'
  let release: () => void = () => undefined, answering: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId, requestId: request.id, text: 'Blue' })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    answering = f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: 'Blue' })
    await started
    if (newer) await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: newerId, requestId: request.id, text: 'Green' })
    release(); await answering
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([expect.objectContaining({ answer: 'Blue' })])
    expect(f.control.get().deliveredDrafts).toContainEqual({ threadId: target.threadId, draftId })
    expect(f.control.get().deliveredDrafts).not.toContainEqual({ threadId: target.threadId, draftId: newerId })
    expect((await f.disk()).deliveredDrafts).toContainEqual({ threadId: target.threadId, draftId })
    expect(f.control.get().threadDrafts).toEqual(newer ? [expect.objectContaining({ draftId: newerId, text: 'Green' })] : [])
  } finally { release(); await Promise.allSettled([answering]); vi.restoreAllMocks(); await f.close() }
})

it.each(['replacement', 'empty', 'cancel'] as const)('records exact %s draft obsolescence without claiming native acceptance', async action => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000093', nextId = '00000000-0000-4000-8000-000000000094'
  const original = { type: 'save-thread-draft' as const, threadId: target.threadId, draftId, requestId: null, text: 'Original text' }
  try {
    await f.command(original)
    if (action === 'cancel') await f.control.commandShell({ type: 'cancel-draft' },
      { clientId: 'paired', user: 'User', transport: 'socket', selectedThreadId: target.threadId })
    else await f.command({ ...original, draftId: nextId, text: action === 'empty' ? '' : 'Newer text' })
    const obsolete = [{ threadId: target.threadId, draftId }]
    expect(f.control.get()).toMatchObject({ obsoleteDrafts: obsolete, deliveredDrafts: [] })
    expect(await f.disk()).toMatchObject({ obsoleteDrafts: obsolete, deliveredDrafts: [] })
    await f.restart()
    expect(f.control.get()).toMatchObject({ obsoleteDrafts: obsolete, deliveredDrafts: [] })
    // A delayed save of an obsolete revision cannot revive it after Clear or replace a newer edit.
    expect((await f.command(original)).error).toContain('cleared or replaced')
    expect(f.control.get().threadDrafts).toEqual(action === 'replacement' ? [expect.objectContaining({ draftId: nextId, text: 'Newer text' })] : [])
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { await f.close() }
})

it('does not retire a still-current revision on an idempotent save', async () => {
  const f = await draftHandoffFixture()
  const draft = { type: 'save-thread-draft' as const, threadId: target.threadId,
    draftId: '00000000-0000-4000-8000-000000000095', requestId: null, text: 'Saved text' }
  try {
    await f.command(draft)
    await f.command(draft)
    expect(f.control.get()).toMatchObject({ obsoleteDrafts: [], threadDrafts: [expect.objectContaining({ draftId: draft.draftId, text: draft.text })] })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000097', text: '', attachments: [] })
    expect(f.control.get()).toMatchObject({ obsoleteDrafts: [{ threadId: target.threadId, draftId: draft.draftId }], deliveredDrafts: [], threadDrafts: [] })
  } finally { await f.close() }
})

it.each([['', false], ['Blue', false], ['', true], ['Blue', true]] as const)(
  'does not confirm a saved text revision for a different structured answer (legacy answer %s, active composer %s)', async (answer, active) => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000096'
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    if (active) await f.command({ type: 'compose', text: 'Blue' })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId, requestId: request.id, text: 'Blue' })
    await f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer,
      questionAnswers: { q: { optionIds: [], text: 'Green' } } })
    expect(f.control.get().deliveredDrafts).toEqual([])
    expect((await f.disk()).deliveredDrafts).toEqual([])
    expect(f.control.get()).toMatchObject(active
      ? { obsoleteDrafts: expect.arrayContaining([{ threadId: target.threadId, draftId }]), threadDrafts: [] }
      : { obsoleteDrafts: [], threadDrafts: [expect.objectContaining({ draftId, text: 'Blue', requestId: request.id })] })
  } finally { await f.close() }
})

it('keeps a newer active draft when a different structured answer finishes', async () => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000088', newerId = '00000000-0000-4000-8000-000000000089'
  let release: () => void = () => undefined, answering: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.command({ type: 'compose', text: 'Blue' })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId, requestId: request.id, text: 'Blue' })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    answering = f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: '',
      questionAnswers: { q: { optionIds: [], text: 'Green' } } })
    await started
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: newerId, requestId: request.id, text: 'Newer edit' })
    release(); await answering
    expect(f.control.get()).toMatchObject({ deliveredDrafts: [], obsoleteDrafts: expect.arrayContaining([{ threadId: target.threadId, draftId }]),
      threadDrafts: [expect.objectContaining({ draftId: newerId, requestId: request.id, text: 'Newer edit' })], draft: 'Newer edit' })
  } finally { release(); await Promise.allSettled([answering]); vi.restoreAllMocks(); await f.close() }
})

it.each([false, true])('publishes obsolete revisions only after a durable write (failed write %s)', async fails => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000097', nextId = '00000000-0000-4000-8000-000000000090'
  let release: () => void = () => undefined, changing: Promise<unknown> | undefined
  const published: unknown[] = []
  const off = f.control.subscribe(state => { published.push(state.obsoleteDrafts) })
  try {
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId, requestId: null, text: 'Durable original' })
    const control = f.control as unknown as { store: { write(value: unknown): Promise<void> } }
    const write = control.store.write.bind(control.store)
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(control.store, 'write').mockImplementation(async value => {
      entered(); await gate
      if (fails) throw new Error('Synthetic disk write failure')
      await write(value)
    })
    changing = f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: nextId, requestId: null, text: 'Newer text' })
    await started
    // A provider publication must not turn an in-flight mutation into durable retirement evidence.
    f.host.event({ type: 'question', threadId: 'docs', text: '', request: { ...request, id: 'other-question', delivery: undefined } })
    expect(f.control.get().obsoleteDrafts).toEqual([])
    expect(f.control.shell().obsoleteDrafts).toEqual([])
    expect(published.every(value => JSON.stringify(value) === '[]')).toBe(true)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId, text: 'Durable original' }))
    release(); await changing
    if (fails) {
      expect(f.control.get().obsoleteDrafts).toEqual([])
      expect((await f.disk()).obsoleteDrafts).toEqual([])
      vi.restoreAllMocks()
      await f.command({ type: 'configure', patch: { } })
    }
    expect(f.control.get().obsoleteDrafts).toEqual([{ threadId: target.threadId, draftId }])
    expect(published).toContainEqual([{ threadId: target.threadId, draftId }])
    expect((await f.disk()).obsoleteDrafts).toEqual([{ threadId: target.threadId, draftId }])
  } finally { release(); await Promise.allSettled([changing]); off(); vi.restoreAllMocks(); await f.close() }
})

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

it.each(['local', 'socket'] as const)(
  'ends an empty %s prompt intent when a fresh question arrives', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Deleted prompt' }, client)
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    await f.command({ type: 'select-thread', threadId: target.threadId })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Blue' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Blue', requestId: request.id }))
    expect(await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } }, client)).toMatchObject({ error: null })
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([expect.objectContaining({ requestId: request.id, answer: 'Blue' })])
    expect(f.attempts.filter(command => command.type === 'send')).toEqual([])
  } finally { await f.close() }
})

it.each(['local', 'socket'] as const)('ends a queued empty %s prompt intent for edits admitted after its new question', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { reasoningEffort: 'high' } })); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client))
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    release(); await Promise.all(pending)
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Fresh answer' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Fresh answer', requestId: request.id }))
    expect(f.attempts.filter(command => command.type === 'answer' || command.type === 'send')).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each([['local', 'saved-empty'], ['socket', 'saved-empty'], ['local', 'pristine'], ['socket', 'pristine']] as const)(
  'answers a fresh question on explicit %s Send after an earlier %s prompt was empty', async (route, empty) => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    if (empty === 'pristine') await f.command({ type: 'select-thread', threadId: target.threadId })
    else await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    expect(await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Fresh answer', attachments: [] } }, client)).toMatchObject({ error: null })
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([expect.objectContaining({ requestId: request.id, answer: 'Fresh answer' })])
    expect(f.attempts.filter(command => command.type === 'send')).toEqual([])
  } finally { await f.close() }
})

it.each([['local', false], ['socket', false], ['local', true], ['socket', true]] as const)(
  'saves a queued %s edit as a prompt after its answer is accepted (new question %s)', async (route, nextQuestion) => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined, sending: Promise<unknown> | undefined, editing: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } }, client)
    await started
    editing = f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Blue.' }, client)
    if (nextQuestion) f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, id: 'unseen-next-question', delivery: undefined } })
    release(); await sending
    expect(await editing).toMatchObject({ error: null })
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Blue.', requestId: null }))
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([expect.objectContaining({ requestId: request.id, answer: 'Blue' })])
    expect(f.attempts.filter(command => command.type === 'send')).toEqual([])
    if (nextQuestion) {
      const refused = await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue.', attachments: [] } }, client)
      expect(refused.error).toContain('pending question')
      expect(f.attempts.filter(command => command.type === 'answer')).toHaveLength(1)
    }
  } finally { release(); await Promise.allSettled([sending, editing]); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('keeps a first queued %s prompt binding when a question arrives before the next Compose', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    const image = await f.control.stageAttachment({ name: 'synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { reasoningEffort: 'high' } })); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'First prompt', attachments: [image] }, client))
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Newest prompt' }, client))
    release(); await Promise.all(pending)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newest prompt', requestId: null, attachments: [image] }))
    await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Newest prompt', attachments: [] } }, client)
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('retains a null prompt and refuses immutable %s Send when its queued Compose question closes before execution', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { reasoningEffort: 'high' } })); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    const editing = f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    const sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Newest packet', attachments: [] } }, client)
    pending.push(editing, sending)
    const closed = await f.host.snapshot(); closed.threads.find(thread => thread.id === target.threadId)!.requests = []
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(closed)
    await f.command({ type: 'refresh', provider: 'claude' })
    release(); await Promise.all(pending)
    expect(await editing).toMatchObject({ error: null })
    expect(await sending).toMatchObject({ error: expect.stringContaining('Nothing was sent. Your text was saved.') })
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newest packet', requestId: null }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('ignores a closed-question binding in an empty active %s composer', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.command({ type: 'compose', text: '' })
    expect(f.control.get()).toMatchObject({ composing: true, draftThreadId: target.threadId, draftRequestId: request.id })
    const closed = await f.host.snapshot(); closed.threads.find(thread => thread.id === target.threadId)!.requests = []
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(closed)
    await f.command({ type: 'refresh', provider: 'claude' })
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'New prompt' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'New prompt', requestId: null }))
    expect(await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'New prompt', attachments: [] } }, client)).toMatchObject({ error: null })
    expect(f.attempts.filter(command => command.type === 'send')).toHaveLength(1)
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([])
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each([['local', false], ['socket', false], ['local', true], ['socket', true]] as const)(
  'saves the latest queued atomic %s packet without changing an earlier prompt binding (empty %s)', async (route, empty) => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    if (empty) await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { reasoningEffort: 'high' } })); await started
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: empty ? '' : 'Earlier prompt' }, client))
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Latest packet', attachments: [] } }, client)
    pending.push(sending)
    release(); await Promise.all(pending)
    expect(await sending).toMatchObject({ error: expect.stringContaining('Nothing was sent. Your text was saved.') })
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Latest packet', requestId: null }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('refuses a same-ID new form when a bound question was absent at atomic %s Send admission', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, sending: Promise<unknown> | undefined
  try {
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000090', text: 'Saved answer', requestId: request.id })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    predecessor = f.command({ type: 'compose', text: 'Saved answer' }); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Latest answer', attachments: [] } }, client)
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined,
      questions: [{ ...questions[0]!, question: 'New same-ID form?' }] } })
    release(); await predecessor
    expect(await sending).toMatchObject({ error: expect.stringContaining('changed') })
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Latest answer', requestId: request.id }))
  } finally { release(); await Promise.allSettled([predecessor, sending]); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('ends an empty %s prompt binding on cancel and ignores its later closed question', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    const revision = f.control.get().threadDraftPersistence?.find(item => item.threadId === target.threadId)?.draftId
    expect(revision).toBeTruthy()
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.control.commandShell({ type: 'cancel-draft' }, client)
    expect(f.control.get().threadDraftPersistence?.find(item => item.threadId === target.threadId)?.draftId).toBe(revision)
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Answer after cancel' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ text: 'Answer after cancel', requestId: request.id }))
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    const closed = await f.host.snapshot(); closed.threads.find(thread => thread.id === target.threadId)!.requests = []
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(closed)
    await f.command({ type: 'refresh', provider: 'claude' })
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Prompt after closure' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ text: 'Prompt after closure', requestId: null }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('clears only the binding of an empty %s revision when its thread disappears and returns', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: () => ({ allowed: true, reason: 'paired-client' }) })
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    const revision = f.control.get().threadDraftPersistence?.find(item => item.threadId === target.threadId)?.draftId
    const restored = await f.host.snapshot(), absent = structuredClone(restored)
    absent.threads = absent.threads.filter(thread => thread.id !== target.threadId)
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(absent)
    await f.command({ type: 'refresh', provider: 'claude' })
    expect(f.control.get().threadDraftPersistence?.find(item => item.threadId === target.threadId)?.draftId).toBe(revision)
    restored.threads.find(thread => thread.id === target.threadId)!.requests = [{ ...request, delivery: undefined }]
    vi.mocked(f.host.snapshot).mockResolvedValue(restored)
    await f.command({ type: 'refresh', provider: 'claude' })
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Restored question answer' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ text: 'Restored question answer', requestId: request.id }))
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)(
  'keeps an explicit saved null-bound %s prompt separate from a newly arrived question', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000080', text: 'Plain prompt', requestId: null })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    const result = await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Updated plain prompt', attachments: [] } }, client)
    expect(result.error).toContain('pending question')
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Updated plain prompt', requestId: null }))
  } finally { await f.close() }
})

it.each([['local', 'add'], ['socket', 'add'], ['local', 'remove'], ['socket', 'remove']] as const)(
  'keeps a queued %s image %s when a later text-only Compose inherits omitted fields', async (route, change) => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    const image = await f.control.stageAttachment({ name: 'synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000081', text: 'Initial',
      requestId: null, attachments: change === 'remove' ? [image] : [] })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'compose', text: 'Initial' })); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    const expected = change === 'add' ? [image] : []
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Image edit', attachments: expected }, client))
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Newest text' }, client))
    release(); await Promise.all(pending)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newest text', attachments: expected, requestId: null }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('validates the actual second question form captured by a queued atomic %s answer', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, sending: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, id: 'first-question', delivery: undefined } })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000082', text: 'Saved answer', requestId: request.id })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    predecessor = f.command({ type: 'compose', text: 'Saved answer' }); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } }, client)
    const changed = await f.host.snapshot()
    changed.threads.find(thread => thread.id === target.threadId)!.requests.find(item => item.id === request.id)!.questions = [{ ...questions[0]!, question: 'Different second question?' }]
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(changed)
    await f.command({ type: 'refresh', provider: 'claude' })
    release(); await predecessor
    expect(await sending).toMatchObject({ error: expect.stringContaining('changed') })
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled([predecessor, sending]); vi.restoreAllMocks(); await f.close() }
})

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
    await expect(checked).rejects.toThrow('still being sent')
    expect(f.attempts.filter(command => command.type === 'answer')).toHaveLength(1)
    expect((await f.disk()).outbox).toEqual([])
  } finally { release(); await Promise.allSettled([answer, checked]); vi.restoreAllMocks(); await f.close() }
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
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
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
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
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
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    // A snapshot's save runs once the code that accepted it has run on. Let it start, so the gate below holds the
    // save this test is about.
    await new Promise<void>(resolve => setImmediate(resolve))
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

it.each([['local', false], ['socket', false], ['local', true], ['socket', true]] as const)(
  'never converts a queued atomic %s answer into a prompt when its question closes (targeted predecessor %s)', async (route, targetedPredecessor) => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, sending: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    predecessor = f.command({ type: 'compose', ...(targetedPredecessor ? { threadId: target.threadId } : {}), text: '' }); await started
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
    await f.command({ type: 'select-thread', threadId: 'docs' })
    const client = route === 'socket'
      ? { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: 'docs' } : desktopWindowClient()
    const result = await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Text at Send', attachments: [] } }, client)
    expect(result.error).toContain('draft now belongs to a different thread')
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect(f.control.get().threadDrafts).not.toContainEqual(expect.objectContaining({ text: 'Text at Send' }))
  } finally { await f.close() }
})

it.each([['answer', false], ['answer', true], ['send', false], ['send', true]] as const)(
  'keeps a newer %s reservation admitted during the native read (still dispatching %s)', async (route, active) => {
  const f = await draftHandoffFixture()
  let releaseRead: () => void = () => undefined, releaseWrite: () => void = () => undefined
  let checking: Promise<void> | undefined, answering: Promise<unknown> | undefined
  try {
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
    answering = route === 'send' ? f.command({ type: 'send' })
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
