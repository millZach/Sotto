// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { RetainedDraftStore } from '../../../src/main/agents/retainedDraftStore'
import type { HostRequest } from '../../../src/shared/hostProtocol'
import { hostId } from '../../fixtures/socketHostService'

describe('atomic socket Send', () => {
  const command = { type: 'send' as const, draft: { threadId: 'thread', text: 'A new prompt', attachments: [] } }
  it('keeps the draft and sends no packet or Compose fallback when the host lacks atomic-send', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token' }), call = vi.fn()
    Object.assign(client, { features: ['answer-check'], cached: emptyDesktopState(hostId), call })
    expect(client.supportsAtomicSend).toBe(false)
    await expect(client.command(command)).resolves.toMatchObject({ error: 'Update the host before sending this draft. Your draft is kept on this computer.' })
    expect(client.state().error).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
  it.each([false, true])('sends one packet and preserves legacy Send (atomic feature: %s)', async atomic => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    const state = emptyDesktopState(hostId), call = vi.fn(async () => state)
    Object.assign(client, { features: atomic ? ['draft-revisions', 'atomic-send'] : [], cached: state, call })
    const input = atomic ? command : { type: 'send' as const }
    expect(client.supportsAtomicSend).toBe(atomic)
    await client.command(input, undefined, 'selected-send')
    expect(call).toHaveBeenCalledExactlyOnceWith({ op: 'command', command: input }, 'selected-send')
  })
})

describe('targeted socket Compose', () => {
  const command = { type: 'compose' as const, threadId: 'thread', text: 'An edit while Send was running', attachments: [] }
  it('keeps revision fields off an older atomic-send host and preserves the full local copy', async () => {
    const retainedDrafts = new RetainedDraftStore(), call = vi.fn()
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', expectedHostId: hostId, retainedDrafts })
    Object.assign(client, { features: ['atomic-send'], cached: emptyDesktopState(hostId), call })
    expect((await client.command(command)).error).toContain('Update the host.')
    expect(retainedDrafts.get(hostId, 'thread')?.draft.text).toBe(command.text)
    expect((await client.command({ type: 'send', draft: { threadId: 'thread', text: command.text, attachments: [] } })).error).toContain('Update the host')
    expect(call).not.toHaveBeenCalled()
  })
  it('captures the saved registration once and never adopts a replacement registration', async () => {
    const retainedDrafts = new RetainedDraftStore(), original = randomUUID(), replacement = randomUUID()
    const registration = vi.spyOn(retainedDrafts, 'registrationForHost').mockReturnValue(original)
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', expectedHostId: hostId, retainedDrafts })
    registration.mockReturnValue(replacement)
    Object.assign(client, { features: [], cached: emptyDesktopState(hostId) })
    await client.command(command)
    expect(retainedDrafts.get(hostId, 'thread')?.registrationId).toBe(original)
    expect(registration).toHaveBeenCalledExactlyOnceWith(hostId)
  })
  it('keeps the draft and sends no ownerless Compose fallback when the host lacks atomic-send', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token' }), call = vi.fn()
    Object.assign(client, { features: ['answer-check'], cached: emptyDesktopState(hostId), call })
    await expect(client.command(command)).resolves.toMatchObject({ error: 'This host cannot save this draft yet. Your draft is kept on this computer and has not been saved on the host. Update the host.' })
    expect(client.state().error).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
  it('preserves ownerless Compose on an older host', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    const state = emptyDesktopState(hostId), call = vi.fn(async () => state)
    Object.assign(client, { features: [], cached: state, call })
    const legacy = { type: 'compose' as const, text: 'Legacy draft' }
    await client.command(legacy, undefined, 'legacy-save')
    expect(call).toHaveBeenCalledExactlyOnceWith({ op: 'command', command: legacy }, 'legacy-save')
  })
  it.each([null, 'The draft could not be saved. Your earlier draft is kept.'])('settles its own acknowledged outcome without history reads: %s', async outcome => {
    const onPushError = vi.fn()
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', onPushError })
    const state = emptyDesktopState(hostId), call = vi.fn(async () => ({ ...state, error: outcome }))
    Object.assign(client, { features: ['draft-revisions', 'atomic-send'], cached: state, call })
    const detail = vi.spyOn(client, 'readThreadDetail').mockRejectedValue(new Error('History should not delay typing.'))
    const events = vi.spyOn(client, 'readEvents').mockRejectedValue(new Error('Events should not delay typing.'))
    await expect(client.command(command, undefined, 'targeted-save')).resolves.toMatchObject({ error: outcome })
    expect(call).toHaveBeenCalledExactlyOnceWith({ op: 'command', command: { ...command, draftId: expect.any(String) } }, 'targeted-save')
    expect(detail).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled(); expect(onPushError).not.toHaveBeenCalled()
  })
  it.each([null, 'The draft image was not saved. Re-attach it before sending.'])('preserves an ordinary direct save outcome without substituting a later shared error: %s', async outcome => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token' })
    const state = emptyDesktopState(hostId)
    Object.assign(client, { features: ['draft-revisions', 'atomic-send'], cached: state,
      call: vi.fn(async () => ({ ...state, error: outcome })) })
    const detail = vi.spyOn(client, 'readThreadDetail').mockImplementation(async () => {
      Object.assign(client, { cached: { ...state, error: 'An unrelated later host error.' } }); return null
    })
    const events = vi.spyOn(client, 'readEvents')
    expect((await client.command({ type: 'save-thread-draft', threadId: 'thread', draftId: randomUUID(),
      text: 'Direct caller edit', requestId: null, attachments: [] })).error).toBe(outcome)
    expect(detail).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled()
  })
})

describe('bounded targeted autosaves', () => {
  function heldSocket() {
    const retainedDrafts = new RetainedDraftStore()
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false, retainedDrafts })
    const state = emptyDesktopState(hostId), frames: HostRequest[] = []
    state.host.threads = [{ id: 'thread', projectId: 'project', modelId: '', title: 'Thread', status: 'idle', messages: [], requests: [] }]
    const receive = (value: unknown) => (client as unknown as { receive(text: string): void }).receive(JSON.stringify(value))
    const socket = { send: (frame: HostRequest) => { frames.push(structuredClone(frame)); return true },
      close: () => (client as unknown as { disconnected(frames: unknown): void }).disconnected(socket) }
    Object.assign(client, { features: ['draft-revisions', 'atomic-send', 'answer-check'], cached: state, frames: socket, session: { session: 'session', hostId: state.hostId } })
    const reply = (frame: HostRequest, error: string | null = null) => receive({ v: 1, id: frame.id, ok: true,
      result: frame.op === 'detail' ? null : frame.op === 'receipt' ? { status: 'completed' } : { ...state, error } })
    return { client, state, frames, socket, reply, receive, retainedDrafts }
  }
  it('releases an inherited Send hold only on the original exact terminal failed packet proof', async () => {
    const f = heldSocket(), draftId = randomUUID(), sentId = randomUUID(), packetDigest = 'b'.repeat(64), now = new Date().toISOString()
    f.state.activeThreadId = 'thread'
    const edit = { hostId, draft: { threadId: 'thread', draftId, text: 'Newer local edit', attachments: [],
      requestId: null, updatedAt: new Date().toISOString() }, questionsDigest: null, saved: false, recovery: true,
      sendAttempt: { commandId: 'original-send', draftId: sentId, requestId: null, packetDigest } }
    f.retainedDrafts.put(edit)
    try {
      for (const proof of [undefined, 'a'.repeat(64)]) {
        f.receive({ v: 1, event: 'shell', state: { ...f.state, deliveries: [{ threadId: 'thread', draftId: sentId,
          status: 'failed', createdAt: now, updatedAt: now, ...(proof ? { packetDigest: proof } : {}) }] } })
        expect(f.retainedDrafts.get(hostId, 'thread')?.sendAttempt).toEqual(edit.sendAttempt)
        expect((await f.client.command({ type: 'send' })).error).toContain('may already have been sent')
      }
      f.receive({ v: 1, event: 'shell', state: { ...f.state, deliveries: [{ threadId: 'thread', draftId: sentId,
        status: 'failed', createdAt: now, updatedAt: now, packetDigest }] } })
      expect(f.retainedDrafts.get(hostId, 'thread')).toMatchObject({ draft: edit.draft })
      expect(f.retainedDrafts.get(hostId, 'thread')?.sendAttempt).toBeUndefined()
      expect(f.frames).toHaveLength(0)
    } finally { await f.client.close() }
  })
  it('does not retain a Send hold when the full request budget refuses it before any frame attempt', async () => {
    const f = heldSocket()
    f.state.activeThreadId = 'thread'
    const draft = { threadId: 'thread', draftId: randomUUID(), text: 'Still ready to send', attachments: [],
      requestId: null, updatedAt: new Date().toISOString() }
    f.retainedDrafts.put({ hostId, draft, questionsDigest: null, saved: false, recovery: false })
    const reads = Array.from({ length: 32 }, (_, index) => f.client.receipt(`held-${index}`))
    const settled = Promise.allSettled(reads)
    try {
      await expect(f.client.command({ type: 'send' })).rejects.toMatchObject({ code: 'busy', commandId: undefined })
      expect(f.retainedDrafts.get(hostId, 'thread')?.sendAttempt).toBeUndefined()
      expect(f.retainedDrafts.get(hostId, 'thread')?.draft).toEqual(draft)
      expect(f.frames).toHaveLength(32)
    } finally { await f.client.close(); await settled }
  })
  it('keeps an unresolved sent copy through obsolescence until exact positive delivery arrives', async () => {
    const f = heldSocket(), draftId = randomUUID()
    const edit = { hostId, draft: { threadId: 'thread', draftId, text: 'Possibly sent', attachments: [], requestId: null,
      updatedAt: new Date().toISOString() }, questionsDigest: null, saved: false, recovery: true,
      sendAttempt: { commandId: 'unknown-send', draftId, requestId: null, packetDigest: 'c'.repeat(64) } }
    f.retainedDrafts.put(edit)
    try {
      f.receive({ v: 1, event: 'shell', state: { ...f.state, obsoleteDrafts: [{ threadId: 'thread', draftId }] } })
      expect(f.retainedDrafts.get(hostId, 'thread')).toEqual(edit)
      f.receive({ v: 1, event: 'shell', state: { ...f.state, deliveredDrafts: [{ threadId: 'thread', draftId }] } })
      expect(f.retainedDrafts.get(hostId, 'thread')).toBeUndefined()
      expect(f.frames).toHaveLength(0)
    } finally { await f.client.close() }
  })
  it('does not let an earlier independent shell read retire a newer exactly saved local revision', async () => {
    const f = heldSocket(), threadId = 'thread'
    f.state.activeThreadId = threadId
    const old = { threadId, draftId: randomUUID(), text: 'Earlier host draft', attachments: [], requestId: null, updatedAt: new Date().toISOString() }
    f.state.threadDrafts = [old]
    let settled: Promise<unknown> = Promise.resolve()
    try {
      const reading = f.client.readShell()
      const save = f.client.command({ type: 'compose', threadId, text: 'Newly saved draft' })
      settled = Promise.allSettled([reading, save])
      const latest = f.retainedDrafts.get(hostId, threadId)!.draft
      f.receive({ v: 1, id: f.frames[1]!.id, ok: true, result: { ...f.state, threadDrafts: [latest],
        threadDraftPersistence: [{ threadId, draftId: latest.draftId, status: 'saved' }] } })
      await save
      f.receive({ v: 1, id: f.frames[0]!.id, ok: true, result: f.state })
      await reading
      expect(f.retainedDrafts.get(hostId, threadId)).toMatchObject({ saved: true, draft: { text: 'Newly saved draft' } })
      expect(f.client.shell().draft).toBe('Newly saved draft')
    } finally { await f.client.close(); await settled }
  })
  it('retires a saved copy whose thread is absent from an authoritative live shell', async () => {
    const f = heldSocket(), threadId = 'thread'
    try {
      const save = f.client.command({ type: 'compose', threadId, text: 'Previously saved' })
      const latest = f.retainedDrafts.get(hostId, threadId)!.draft
      f.receive({ v: 1, id: f.frames[0]!.id, ok: true, result: { ...f.state, threadDrafts: [latest],
        threadDraftPersistence: [{ threadId, draftId: latest.draftId, status: 'saved' }] } })
      await save
      f.receive({ v: 1, event: 'shell', state: { ...f.state, host: { ...f.state.host, threads: [] } } })
      expect(f.retainedDrafts.get(hostId, threadId)).toBeUndefined()
    } finally { await f.client.close() }
  })
  it('retires a late successful save against newer authority even after an unrelated old command reply', async () => {
    const f = heldSocket(), threadId = 'thread'
    let settled: Promise<unknown> = Promise.resolve()
    try {
      const unrelated = f.client.command({ type: 'configure', patch: {} })
      const save = f.client.command({ type: 'compose', threadId, text: 'Saved B with a held acknowledgement' })
      settled = Promise.allSettled([unrelated, save])
      const own = f.retainedDrafts.get(hostId, threadId)!.draft
      const newer = { ...own, draftId: randomUUID(), text: 'Newer host C' }
      f.receive({ v: 1, event: 'shell', state: { ...f.state, threadDrafts: [newer],
        threadDraftPersistence: [{ threadId, draftId: newer.draftId, status: 'saved' }] } })
      expect(f.retainedDrafts.get(hostId, threadId)?.saved).toBe(false)
      f.reply(f.frames[0]!)
      await unrelated
      f.receive({ v: 1, id: f.frames[1]!.id, ok: true, result: { ...f.state, threadDrafts: [own],
        threadDraftPersistence: [{ threadId, draftId: own.draftId, status: 'saved' }] } })
      await save
      expect(f.retainedDrafts.get(hostId, threadId)?.saved).toBe(true)
      expect(f.frames[2]).toMatchObject({ op: 'shell' })
      f.receive({ v: 1, id: f.frames[2]!.id, ok: true, result: { ...f.state, threadDrafts: [newer],
        threadDraftPersistence: [{ threadId, draftId: newer.draftId, status: 'saved' }] } })
      await vi.waitFor(() => expect(f.retainedDrafts.get(hostId, threadId)).toBeUndefined())
      expect(f.retainedDrafts.get(hostId, threadId)).toBeUndefined()
      expect(f.client.shell().threadDrafts).toContainEqual(newer)
    } finally { await f.client.close(); await settled }
  })
  it('keeps a queued save when the intervening live push preceded its execution', async () => {
    const f = heldSocket(), threadId = 'thread'
    try {
      const save = f.client.command({ type: 'compose', threadId, text: 'B saved after the earlier A push' })
      const own = f.retainedDrafts.get(hostId, threadId)!.draft
      const earlier = { ...own, draftId: randomUUID(), text: 'A before queued B executes' }
      f.receive({ v: 1, event: 'shell', state: { ...f.state, threadDrafts: [earlier],
        threadDraftPersistence: [{ threadId, draftId: earlier.draftId, status: 'saved' }] } })
      const current = { ...f.state, threadDrafts: [own], threadDraftPersistence: [{ threadId, draftId: own.draftId, status: 'saved' as const }] }
      f.receive({ v: 1, id: f.frames[0]!.id, ok: true, result: current })
      await save
      expect(f.retainedDrafts.get(hostId, threadId)).toMatchObject({ saved: true, draft: { draftId: own.draftId,
        text: own.text, attachments: own.attachments, requestId: own.requestId } })
      expect(f.frames[1]).toMatchObject({ op: 'shell' })
      f.receive({ v: 1, id: f.frames[1]!.id, ok: true, result: current })
      await vi.waitFor(() => expect(f.client.shell().threadDraftPersistence?.[0]?.draftId).toBe(own.draftId))
      expect(f.retainedDrafts.get(hostId, threadId)).toMatchObject({ saved: true, draft: { draftId: own.draftId,
        text: own.text, attachments: own.attachments, requestId: own.requestId } })
    } finally { await f.client.close() }
  })
  it('follows one shared refresh with a new observation when a second save was acknowledged during that read', async () => {
    const f = heldSocket(), otherId = 'other'
    f.state.host.threads.push({ ...f.state.host.threads[0]!, id: otherId })
    const a = f.client.command({ type: 'compose', threadId: 'thread', text: 'A saved' }, undefined, 'save-a')
    const b = f.client.command({ type: 'compose', threadId: otherId, text: 'B saved' }, undefined, 'save-b')
    const check = f.client.checkRequestAnswer({ threadId: 'thread', providerId: 'codex', requestId: 'question', questionsDigest: 'a'.repeat(64) })
    const settled = Promise.allSettled([a, b, check])
    try {
      const draftA = f.retainedDrafts.get(hostId, 'thread')!.draft, draftB = f.retainedDrafts.get(hostId, otherId)!.draft
      const stateA = { ...f.state, threadDrafts: [draftA], threadDraftPersistence: [{ threadId: 'thread', draftId: draftA.draftId, status: 'saved' as const }] }
      const stateAB = { ...stateA, threadDrafts: [draftA, draftB], threadDraftPersistence: [...stateA.threadDraftPersistence,
        { threadId: otherId, draftId: draftB.draftId, status: 'saved' as const }] }
      f.receive({ v: 1, event: 'shell', state: f.state })
      f.receive({ v: 1, id: f.frames[0]!.id, ok: true, result: stateA }); await a
      expect(f.frames[3]).toMatchObject({ op: 'shell' })
      f.receive({ v: 1, id: f.frames[1]!.id, ok: true, result: stateAB }); await b
      expect(f.frames.filter(frame => frame.op === 'shell')).toHaveLength(1)
      f.receive({ v: 1, id: f.frames[3]!.id, ok: true, result: stateA })
      await vi.waitFor(() => expect(f.frames[4]).toMatchObject({ op: 'shell' }))
      expect(f.retainedDrafts.get(hostId, otherId)?.saved).toBe(true)
      f.receive({ v: 1, id: f.frames[4]!.id, ok: true, result: stateAB })
      f.reply(f.frames[2]!); await settled
      expect(f.retainedDrafts.get(hostId, otherId)?.saved).toBe(true)
      expect(f.frames.filter(frame => frame.op === 'shell')).toHaveLength(2)
    } finally { await f.client.close(); await settled }
  })
  it.each(['skills', 'files'] as const)('retains the full unsaved edit when a durable Compose acknowledgement changes its %s', async field => {
    const f = heldSocket(), threadId = 'thread'
    const skills = [{ name: 'Chosen skill', path: 'skills/chosen' }], files = [{ path: 'chosen.ts' }]
    const original = { threadId, draftId: randomUUID(), text: 'Full draft', attachments: [], requestId: null,
      skills, files, updatedAt: new Date().toISOString() }
    f.retainedDrafts.put({ hostId, draft: original, questionsDigest: null, saved: false, recovery: false })
    try {
      const save = f.client.command({ type: 'compose', threadId, text: original.text })
      const current = f.retainedDrafts.get(hostId, threadId)!
      const acknowledged = { ...current.draft, draftId: randomUUID(), [field]: [] }
      f.receive({ v: 1, id: f.frames[0]!.id, ok: true, result: { ...f.state,
        threadDrafts: [acknowledged], threadDraftPersistence: [{ threadId, draftId: acknowledged.draftId, status: 'saved' }] } })
      await save
      expect(f.retainedDrafts.get(hostId, threadId)).toEqual(current)
      expect(f.client.shell().threadDrafts).toContainEqual(current.draft)
    } finally { await f.client.close() }
  })
  it('upgrades an explicit legacy Send to the exact retained text, images and binding', async () => {
    const f = heldSocket(), threadId = 'thread'
    const pending: Promise<unknown>[] = []
    f.state.activeThreadId = threadId
    try {
      const save = f.client.command({ type: 'compose', threadId, text: 'Remote send intent', attachments: [] })
      f.reply(f.frames[0]!); await save
      const send = f.client.command({ type: 'send' })
      pending.push(send); void Promise.allSettled(pending)
      expect(f.frames[1]).toMatchObject({ op: 'command', command: { type: 'send', draft: {
        threadId, text: 'Remote send intent', attachments: [], binding: { requestId: null, questionsDigest: null },
      } } })
      f.reply(f.frames[1]!); await send
      expect(f.retainedDrafts.get(hostId, threadId)).toBeUndefined()
    } finally { await f.client.close(); await Promise.allSettled(pending) }
  })
  it('holds recovery until every overlapping explicit Send and Clear has settled', async () => {
    const f = heldSocket(), threadId = 'thread', recover = vi.spyOn(f.client as unknown as { recoverDrafts(): void }, 'recoverDrafts')
    let settled: Promise<unknown> = Promise.resolve()
    f.state.activeThreadId = threadId
    try {
      const first = f.client.command({ type: 'send', draft: { threadId, text: 'First', attachments: [] } })
      const second = f.client.command({ type: 'send', draft: { threadId, text: 'Second', attachments: [] } })
      const clear = f.client.command({ type: 'cancel-draft' })
      settled = Promise.allSettled([first, second, clear])
      const heldOwners = () => (f.client as unknown as { delivering: { has(owner: string): boolean } }).delivering.has(threadId)
      expect(heldOwners()).toBe(true)
      f.reply(f.frames[1]!, 'Synthetic refusal'); await second
      expect(heldOwners()).toBe(true)
      f.reply(f.frames[2]!, 'Synthetic refusal'); await clear
      expect(heldOwners()).toBe(true)
      f.reply(f.frames[0]!, 'Synthetic refusal'); await first
      expect(heldOwners()).toBe(false)
      expect(recover).toHaveBeenCalledTimes(3)
    } finally { recover.mockRestore(); await f.client.close(); await settled }
  })
  it('keeps the exact latest saved revision when an older own Compose acknowledgement arrives last', async () => {
    const f = heldSocket(), threadId = 'thread'
    f.state.activeThreadId = threadId
    const first = f.client.command({ type: 'compose', threadId, text: 'Older A' })
    const latest = f.client.command({ type: 'compose', threadId, text: 'Saved B' })
    const check = f.client.checkRequestAnswer({ threadId, providerId: 'codex', requestId: 'question', questionsDigest: 'b'.repeat(64) })
    const settled = Promise.allSettled([first, latest, check])
    const reply = (index: number, text: string, draftId: string) => f.receive({ v: 1, id: f.frames[index]!.id, ok: true, result: {
      ...f.state, composing: true, draftThreadId: threadId, draft: text, draftAttachments: [],
      threadDrafts: [{ threadId, draftId, text, attachments: [], requestId: null, updatedAt: new Date().toISOString() }],
      threadDraftPersistence: [{ threadId, draftId, status: 'saved' }],
    } })
    const savedId = randomUUID()
    try {
      reply(1, 'Saved B', savedId); await latest
      expect(f.retainedDrafts.get(hostId, threadId)).toMatchObject({ saved: true, hostDraftId: savedId })
      reply(0, 'Older A', randomUUID()); await first
      expect(f.client.shell().draft).toBe('Saved B')
      expect(f.retainedDrafts.get(hostId, threadId)).toMatchObject({ saved: true, hostDraftId: savedId })
      f.reply(f.frames[2]!); await check
      expect(f.client.shell().draft).toBe('Saved B')
    } finally { await f.client.close(); await settled }
  })
  it('admits Send, detail, receipt and Check during forty held autosaves, with only the first and latest save on the wire', async () => {
    const f = heldSocket()
    try {
      const saves = Array.from({ length: 40 }, (_, index) => f.client.command({ type: 'compose', threadId: 'thread', text: `Edit ${index}` }))
      const detail = f.client.readThreadDetail('thread'), receipt = f.client.receipt('answer-attempt')
      const check = f.client.checkRequestAnswer({ threadId: 'thread', providerId: 'codex', requestId: 'question', questionsDigest: 'a'.repeat(64) })
      const packet = { type: 'send' as const, draft: { threadId: 'thread', text: 'Immutable Send', attachments: [], binding: { requestId: null, questionsDigest: null } } }
      const send = f.client.command(packet)
      const all = Promise.allSettled([...saves, detail, receipt, check, send])
      packet.draft.text = 'A later local edit'
      const commands = f.frames.filter(frame => frame.op === 'command').map(frame => frame.command)
      expect(commands).toEqual([{ type: 'compose', threadId: 'thread', text: 'Edit 0', attachments: [], draftId: expect.any(String) },
        { type: 'compose', threadId: 'thread', text: 'Edit 39', attachments: [], draftId: expect.any(String) }, { type: 'send', draft: { threadId: 'thread', text: 'Immutable Send', attachments: [], draftId: expect.any(String), binding: { requestId: null, questionsDigest: null } } }])
      expect(f.frames.filter(frame => ['detail', 'receipt', 'check-answer'].includes(frame.op))).toHaveLength(3)
      for (const frame of f.frames) f.reply(frame)
      expect((await Promise.all(saves)).every(state => state.error === null)).toBe(true)
      expect((await all).every(result => result.status === 'fulfilled')).toBe(true)
      expect(f.frames).toHaveLength(6)
    } finally { await f.client.close() }
  })
  it.each([{ remove: false, explicitUndefined: false }, { remove: true, explicitUndefined: false },
    { remove: false, explicitUndefined: true }, { remove: true, explicitUndefined: true }])('retains the last explicit attachment edit through omitted text saves (%j)', async ({ remove, explicitUndefined }) => {
    const f = heldSocket()
    try {
      const first = f.client.command({ type: 'compose', threadId: 'thread', text: 'First' })
      const image = { id: 'image', digest: 'a'.repeat(64), name: 'Image', mimeType: 'image/png' as const, sizeBytes: 1 }
      const add = f.client.command({ type: 'compose', threadId: 'thread', text: 'Image added', attachments: [image] })
      const saves = [add, f.client.command({ type: 'compose', threadId: 'thread', text: 'Text after image' })]
      if (remove) saves.push(f.client.command({ type: 'compose', threadId: 'thread', text: 'Image removed', attachments: [] }))
      saves.push(f.client.command({ type: 'compose', threadId: 'thread', text: 'Latest text', ...(explicitUndefined ? { attachments: undefined } : {}) }))
      const settledSaves = Promise.allSettled(saves)
      const expectedImage = structuredClone(image)
      image.name = 'Changed caller object'
      f.reply(f.frames[0]!)
      await first
      await vi.waitFor(() => expect(f.frames).toHaveLength(2))
      expect(f.frames[1]).toMatchObject({ op: 'command', command: { type: 'compose', threadId: 'thread', text: 'Latest text', attachments: remove ? [] : [expectedImage] } })
      f.reply(f.frames[1]!)
      expect((await settledSaves).every(result => result.status === 'fulfilled' && result.value.error === null)).toBe(true)
    } finally { await f.client.close() }
  })
  it('seals owners before selection and refuses a pending save rather than flushing it after a full-budget barrier', async () => {
    const f = heldSocket()
    try {
      const a = f.client.command({ type: 'compose', threadId: 'A', text: 'First A', attachments: [] })
      const latestA = f.client.command({ type: 'compose', threadId: 'A', text: 'Latest A', attachments: [] })
      const selectB = f.client.command({ type: 'select-thread', threadId: 'B' })
      const b = f.client.command({ type: 'compose', threadId: 'B', text: 'Latest B' })
      const selectA = f.client.command({ type: 'select-thread', threadId: 'A' })
      expect((await b).error).toContain('Your draft is kept on this computer')
      expect(f.frames.filter(frame => frame.op === 'command').map(frame => frame.command)).toEqual([
        { type: 'compose', threadId: 'A', text: 'First A', attachments: [], draftId: expect.any(String) }, { type: 'compose', threadId: 'A', text: 'Latest A', attachments: [], draftId: expect.any(String) },
        { type: 'select-thread', threadId: 'B' }, { type: 'select-thread', threadId: 'A' },
      ])
      for (const frame of f.frames) f.reply(frame)
      await vi.waitFor(() => expect(f.frames.filter(frame => frame.op === 'detail')).toHaveLength(2))
      for (const frame of f.frames.filter(frame => frame.op === 'detail')) f.reply(frame)
      await Promise.all([a, latestA, selectB, selectA])
      expect(f.frames.filter(frame => frame.op === 'command' && frame.command.type === 'compose')).toHaveLength(2)
    } finally { await f.client.close() }
  })
  it('preserves explicit receipt identities under the same two-save budget and settles every coalesced failure', async () => {
    const f = heldSocket()
    try {
      const first = f.client.command({ type: 'compose', threadId: 'thread', text: 'One' }, undefined, 'save-one')
      const second = f.client.command({ type: 'compose', threadId: 'thread', text: 'Two' }, undefined, 'save-two')
      const third = f.client.command({ type: 'compose', threadId: 'thread', text: 'Three' }, undefined, 'save-three')
      const send = f.client.command({ type: 'send', draft: { threadId: 'thread', text: 'Three', attachments: [] } })
      expect((await third).error).toContain('Your draft is kept on this computer')
      expect(f.frames.slice(0, 2).map(frame => frame.id)).toEqual(['save-one', 'save-two'])
      f.reply(f.frames[0]!)
      f.reply(f.frames[1]!, 'The save failed.')
      f.reply(f.frames[2]!)
      expect((await first).error).toBeNull(); expect((await second).error).toBe('The save failed.')
      await send
      expect(f.frames.some(frame => frame.id === 'save-three')).toBe(false)
      const held = f.client.command({ type: 'compose', threadId: 'thread', text: 'Held' })
      const edits = ['Later one', 'Later two'].map(text => f.client.command({ type: 'compose', threadId: 'thread', text }))
      const index = f.frames.length - 1
      f.reply(f.frames[index]!)
      await held
      await vi.waitFor(() => expect(f.frames).toHaveLength(index + 2))
      f.reply(f.frames[index + 1]!, 'The latest save failed.')
      expect((await Promise.all(edits)).map(state => state.error)).toEqual(['The latest save failed.', 'The latest save failed.'])
    } finally { await f.client.close() }
  })
  it.each([{ earlierId: true, incomingId: false }, { earlierId: false, incomingId: true }])('captures the queued predecessor that an explicit receipt identity seals (%j)', async ({ earlierId, incomingId }) => {
    const f = heldSocket()
    const first = f.client.command({ type: 'compose', threadId: 'thread', text: 'First' })
    const earlier = f.client.command({ type: 'compose', threadId: 'thread', text: 'Sealed predecessor' }, undefined, earlierId ? 'earlier-id' : undefined)
    const predecessorId = f.retainedDrafts.get(hostId, 'thread')!.draft.draftId
    const latest = f.client.command({ type: 'compose', threadId: 'thread', text: 'Latest removal', attachments: [] }, undefined, incomingId ? 'incoming-id' : undefined)
    const settled = Promise.allSettled([first, earlier, latest])
    try {
      expect(f.frames[1]).toMatchObject({ op: 'command', command: { type: 'compose', draftId: predecessorId, text: 'Sealed predecessor' } })
      expect(f.retainedDrafts.get(hostId, 'thread')).toMatchObject({ baseDraftId: predecessorId,
        draft: { text: 'Latest removal', attachments: [] } })
    } finally { await f.client.close(); await settled }
  })
  it('keeps the actual predecessor base when a sealed pending save is refused by both occupied slots', async () => {
    const f = heldSocket()
    const first = f.client.command({ type: 'compose', threadId: 'thread', text: 'First' }, undefined, 'first-id')
    const second = f.client.command({ type: 'compose', threadId: 'thread', text: 'Second' }, undefined, 'second-id')
    const secondId = f.retainedDrafts.get(hostId, 'thread')!.draft.draftId
    const refused = f.client.command({ type: 'compose', threadId: 'thread', text: 'Unsent third' }, undefined, 'third-id')
    const latest = f.client.command({ type: 'compose', threadId: 'thread', text: 'Latest removal', attachments: [] })
    const settled = Promise.allSettled([first, second, refused, latest])
    try {
      expect((await refused).error).toContain('still saving earlier edits')
      expect(f.frames).toHaveLength(2)
      expect(f.frames[1]).toMatchObject({ op: 'command', command: { draftId: secondId } })
      expect(f.retainedDrafts.get(hostId, 'thread')).toMatchObject({ baseDraftId: secondId,
        draft: { text: 'Latest removal', attachments: [] } })
    } finally { await f.client.close(); await settled }
  })
  it('settles unsent callers on disconnect and never replays them on a replacement connection', async () => {
    const f = heldSocket()
    const promises = ['First', 'Latest one', 'Latest two'].map(text => f.client.command({ type: 'compose', threadId: 'thread', text }))
    const settled = Promise.allSettled(promises)
    await f.client.close()
    expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(f.frames).toHaveLength(1)
    Object.assign(f.client, { frames: f.socket })
    const next = f.client.command({ type: 'compose', threadId: 'thread', text: 'New connection edit' })
    expect(f.frames).toHaveLength(2)
    const latest = f.retainedDrafts.get(hostId, 'thread')!.draft
    f.receive({ v: 1, id: f.frames[1]!.id, ok: true, result: { ...f.state, threadDrafts: [latest],
      threadDraftPersistence: [{ threadId: 'thread', draftId: latest.draftId, status: 'saved' }] } })
    expect((await next).error).toBeNull()
    expect(f.frames.map(frame => frame.op === 'command' && frame.command.type === 'compose' ? frame.command.text : null)).toEqual(['First', 'New connection edit'])
    await f.client.close()
  })
  it('retains an explicit image removal after a full-budget barrier for the next text-only edit', async () => {
    const f = heldSocket()
    const image = { id: 'image', digest: 'a'.repeat(64), name: 'Image', mimeType: 'image/png' as const, sizeBytes: 1 }
    f.state.draftAttachments = [image]
    f.state.draftThreadId = 'thread'
    f.state.activeThreadId = 'thread'
    f.state.composing = true
    const first = f.client.command({ type: 'compose', threadId: 'thread', text: 'First' }, undefined, 'first-save')
    const second = f.client.command({ type: 'compose', threadId: 'thread', text: 'Second' }, undefined, 'second-save')
    const removal = f.client.command({ type: 'compose', threadId: 'thread', text: 'Removed image', attachments: [] })
    const check = f.client.checkRequestAnswer({ threadId: 'thread', providerId: 'codex', requestId: 'question', questionsDigest: 'b'.repeat(64) })
    const settled = Promise.allSettled([first, second, removal, check])
    let latestSettled: Promise<unknown> | undefined
    try {
      expect(f.frames.filter(frame => frame.op === 'command')).toHaveLength(2)
      for (const frame of f.frames) f.reply(frame)
      await settled
      const next = f.client.command({ type: 'compose', threadId: 'thread', text: 'Text after removal', attachments: undefined })
      latestSettled = next.catch(() => null)
      for (const frame of f.frames.filter(frame => frame.op === 'command' && frame.command.type === 'save-thread-draft')) f.reply(frame)
      await vi.waitFor(() => expect(f.frames.some(frame => frame.op === 'command' && frame.command.type === 'compose' && frame.command.text === 'Text after removal')).toBe(true))
      const latest = f.frames.at(-1)!
      expect(latest).toMatchObject({ op: 'command', command: { threadId: 'thread', text: 'Text after removal', attachments: [] } })
      f.reply(latest)
      await next
    } finally { await f.client.close(); await settled; await latestSettled }
  })
})
