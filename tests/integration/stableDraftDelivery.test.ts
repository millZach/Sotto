// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { expect, it, vi } from 'vitest'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { request, target } from '../fixtures/answerDraftFixture'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'

it.each(['local', 'socket'] as const)('uses the exact submitted Compose and Send revisions (%s)', async route => {
  const f = await draftHandoffFixture()
  const savedId = '00000000-0000-4000-8000-000000000101', sentId = '00000000-0000-4000-8000-000000000102'
  const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
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
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const execute = f.host.execute.bind(f.host)
    const { promise: started, resolve: entered } = deferred<void>()

    const { promise: gate, resolve: gateResolve } = deferred<void>()
    release = gateResolve
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
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    const execute = f.host.execute.bind(f.host)
    const { promise: started, resolve: entered } = deferred<void>()

    const { promise: gate, resolve: gateResolve } = deferred<void>()
    release = gateResolve
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
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
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
  const { promise: completion, resolve: complete } = deferred<boolean>()
  const client = { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId }
  const packet = { type: 'send' as const, draft: { threadId: target.threadId, draftId, text: 'Blue', binding: { requestId: request.id, questionsDigest: target.questionsDigest } } }
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
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
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
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
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
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
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
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
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
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
