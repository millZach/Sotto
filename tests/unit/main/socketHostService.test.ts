// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { HostConnectionError, SocketHostService } from '../../../src/main/agents/socketHostService'
import { RequestDraftService, requestQuestionsDigest } from '../../../src/main/agents/requestDrafts'
import { RetainedDraftStore } from '../../../src/main/agents/retainedDraftStore'
import type { AgentRequest } from '../../../src/shared/agents'
import type { HostOperation, HostRequest } from '../../../src/shared/hostProtocol'
import type { RequestDraftTarget } from '../../../src/shared/requestDrafts'
import { hostIsNewer, hostVersionMismatch } from '../../../src/shared/hostProtocol'
import { version as packageVersion } from '../../../package.json'

let server: Server | undefined
const requested: string[] = []
/** A loopback stand-in for a host that answers /v1/health with the given body and refuses everything else. */
async function hostAnswering(health: unknown): Promise<string> {
  requested.length = 0
  server = createServer((request, response) => {
    requested.push(request.url ?? '')
    if (request.url === '/v1/health') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(health)); return }
    response.writeHead(401); response.end()
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback port.')
  return 'http://127.0.0.1:' + address.port
}
afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined })

const hostId = randomUUID()
const frozen = { v: 1, status: 'ready', hostId, pid: 4242, port: 4319, sottoVersion: '0.1.16', features: ['detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'host-folders'] }

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
    Object.assign(client, { features: atomic ? ['atomic-send'] : [], cached: state, call })
    const input = atomic ? command : { type: 'send' as const }
    expect(client.supportsAtomicSend).toBe(atomic)
    await client.command(input, undefined, 'selected-send')
    expect(call).toHaveBeenCalledExactlyOnceWith({ op: 'command', command: input }, 'selected-send')
  })
})

describe('targeted socket Compose', () => {
  const command = { type: 'compose' as const, threadId: 'thread', text: 'An edit while Send was running', attachments: [] }
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
    Object.assign(client, { features: ['atomic-send'], cached: state, call })
    const detail = vi.spyOn(client, 'readThreadDetail').mockRejectedValue(new Error('History should not delay typing.'))
    const events = vi.spyOn(client, 'readEvents').mockRejectedValue(new Error('Events should not delay typing.'))
    await expect(client.command(command, undefined, 'targeted-save')).resolves.toMatchObject({ error: outcome })
    expect(call).toHaveBeenCalledExactlyOnceWith({ op: 'command', command }, 'targeted-save')
    expect(detail).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled(); expect(onPushError).not.toHaveBeenCalled()
  })
})

describe('bounded targeted autosaves', () => {
  function heldSocket() {
    const retainedDrafts = new RetainedDraftStore()
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false, retainedDrafts })
    const state = emptyDesktopState(hostId), frames: HostRequest[] = []
    const receive = (value: unknown) => (client as unknown as { receive(text: string): void }).receive(JSON.stringify(value))
    const socket = { send: (frame: HostRequest) => { frames.push(structuredClone(frame)); return true },
      close: () => (client as unknown as { disconnected(frames: unknown): void }).disconnected(socket) }
    Object.assign(client, { features: ['atomic-send', 'answer-check'], cached: state, frames: socket, session: { session: 'session', hostId: state.hostId } })
    const reply = (frame: HostRequest, error: string | null = null) => receive({ v: 1, id: frame.id, ok: true,
      result: frame.op === 'detail' ? null : frame.op === 'receipt' ? { status: 'completed' } : { ...state, error } })
    return { client, state, frames, socket, reply, receive, retainedDrafts }
  }
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
      const save = f.client.command({ type: 'compose', threadId, text: 'Spoken send intent', attachments: [] })
      f.reply(f.frames[0]!); await save
      const send = f.client.command({ type: 'send' })
      pending.push(send); void Promise.allSettled(pending)
      expect(f.frames[1]).toMatchObject({ op: 'command', command: { type: 'send', draft: {
        threadId, text: 'Spoken send intent', attachments: [], binding: { requestId: null, questionsDigest: null },
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
      expect(commands).toEqual([{ type: 'compose', threadId: 'thread', text: 'Edit 0', attachments: [] },
        { type: 'compose', threadId: 'thread', text: 'Edit 39', attachments: [] }, { type: 'send', draft: { threadId: 'thread', text: 'Immutable Send', attachments: [], binding: { requestId: null, questionsDigest: null } } }])
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
        { type: 'compose', threadId: 'A', text: 'First A', attachments: [] }, { type: 'compose', threadId: 'A', text: 'Latest A', attachments: [] },
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
    f.reply(f.frames[1]!)
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
      const latest = f.frames.at(-1)!
      expect(latest).toMatchObject({ op: 'command', command: { threadId: 'thread', text: 'Text after removal', attachments: [] } })
      f.reply(latest)
      await next
    } finally { await f.client.close(); await settled; await latestSettled }
  })
})

describe('explicit socket answer checks', () => {
  const answer = { threadId: 'thread', providerId: 'grok' as const, requestId: 'question', questionsDigest: 'a'.repeat(64) }
  it('refuses an older host without making a cached detail or receipt read', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token' }), call = vi.fn()
    Object.assign(client, { features: ['answer-receipts'], call })
    await expect(client.checkRequestAnswer(answer)).rejects.toThrow('Update the host')
    expect(call).not.toHaveBeenCalled()
  })
  it('publishes only a fresh native Check shell on the same connection generation', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token' })
    const before = emptyDesktopState(hostId), fresh = { ...before, error: 'Fresh check state' }, call = vi.fn(async () => fresh), listener = vi.fn()
    Object.assign(client, { features: ['answer-check'], cached: before, call })
    client.subscribe(listener)
    await client.checkRequestAnswer(answer)
    expect(call).toHaveBeenCalledWith({ op: 'check-answer', answer })
    expect(client.shell().error).toBe('Fresh check state'); expect(listener).toHaveBeenCalledTimes(1)
    call.mockImplementationOnce(async () => { Object.assign(client, { generation: 1 }); return { ...fresh, error: 'Old connection response' } })
    await expect(client.checkRequestAnswer(answer)).rejects.toMatchObject({ code: 'disconnected' })
    expect(client.shell().error).toBe('Fresh check state'); expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('SocketHostService version check', () => {
  it('names a host from before protocol v1 froze and says how to start the new version, before sending it anything', async () => {
    // What a 0.1.15 host answers: protocol version 1, but no Sotto version and no features.
    const url = await hostAnswering({ v: 1, status: 'ready', hostId, pid: 4242, port: 4319 })
    const client = new SocketHostService({ url, token: 'paired-token', owned: true })
    const message = hostVersionMismatch(packageVersion, undefined, true)
    await expect(client.connect()).rejects.toMatchObject({ code: 'version_mismatch', message })
    // Connect starts whatever is installed, so the sentence names the version to put there before Stop host.
    expect(message).toContain(`Put the Sotto ${packageVersion} host in its installation folder, press Stop host, then connect again.`)
    expect(message).not.toContain('not supported')
    expect(requested).toEqual(['/v1/health'])
  })

  it('names an older host speaking another protocol version the same way', async () => {
    const url = await hostAnswering({ ...frozen, v: 2, sottoVersion: '0.0.1' })
    const client = new SocketHostService({ url, token: 'paired-token' })
    await expect(client.connect()).rejects.toMatchObject({ code: 'version_mismatch', message: hostVersionMismatch(packageVersion, '0.0.1', false) })
    expect(client.hostIsNewer()).toBe(false)
    expect(requested).toEqual(['/v1/health'])
  })

  it('asks for this computer to be updated when the host is the newer side, since restarting it would not help', async () => {
    const url = await hostAnswering({ ...frozen, v: 2, sottoVersion: '99.0.0' })
    const client = new SocketHostService({ url, token: 'paired-token', owned: true })
    await expect(client.connect()).rejects.toMatchObject({ code: 'version_mismatch', message: expect.stringContaining('Update Sotto on this computer, then connect again.') })
    expect(client.hostIsNewer()).toBe(true)
  })

  it('goes on to open a session with a host that speaks v1, whatever its Sotto version, and ignores features it does not know', async () => {
    const url = await hostAnswering({ ...frozen, sottoVersion: '9.9.9', features: ['detail-delta', 'a-later-feature'] })
    const client = new SocketHostService({ url, token: 'paired-token' })
    // The stand-in refuses the session; what matters is that the version check let the client ask for one.
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })
})

describe('SocketHostService git-refs feature', () => {
  it('sends git-refs to no host that does not list the feature, and names the version instead', async () => {
    const url = await hostAnswering({ ...frozen, features: ['detail-delta'] })
    const client = new SocketHostService({ url, token: 'paired-token', owned: true })
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(client.gitRefs({ threadId: randomUUID() })).rejects.toMatchObject({ code: 'version_mismatch', message: hostVersionMismatch(packageVersion, '0.1.16', true) })
    await expect(client.gitChangedFiles({ threadId: randomUUID() })).rejects.toMatchObject({ code: 'version_mismatch' })
    await expect(client.gitPullRequest({ threadId: randomUUID() })).rejects.toMatchObject({ code: 'version_mismatch' })
    // A host from before staged images is sent no image, and has none to hand back.
    await expect(client.stageAttachment({ name: 'Shot.png', mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) })).rejects.toMatchObject({ code: 'version_mismatch' })
    await expect(client.attachmentContent('a'.repeat(64))).resolves.toBeNull()
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })
})

describe('SocketHostService host-folders feature', () => {
  it('sends host-folders to no host that does not list the feature, and names the version instead', async () => {
    const url = await hostAnswering({ ...frozen, features: ['detail-delta'] })
    const client = new SocketHostService({ url, token: 'paired-token', owned: true })
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(client.hostFolders({})).rejects.toMatchObject({ code: 'version_mismatch', message: hostVersionMismatch(packageVersion, '0.1.16', true) })
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })
})

describe('SocketHostService thread tool features (ADR-0025, October 5 amendment)', () => {
  it('sends no Files, Changes or Agents read to a host that does not list its feature, and names the version instead', async () => {
    const url = await hostAnswering({ ...frozen, features: ['detail-delta', 'git-refs'] })
    const client = new SocketHostService({ url, token: 'paired-token', owned: false })
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    const message = hostVersionMismatch(packageVersion, '0.1.16', false)
    const workspaceId = 'a'.repeat(64)
    for (const read of [
      () => client.threadFiles({ threadId: 'thread', path: '' }), () => client.threadFilePreview({ threadId: 'thread', path: 'a.txt', workspaceId }),
      () => client.gitChanges({ threadId: 'thread' }), () => client.gitReview({ threadId: 'thread', workspaceId, scope: { kind: 'working' } }),
      () => client.subagentPage({ threadId: 'thread' }), () => client.subagentAssignments({ threadId: 'thread', agentId: 'agent' }),
    ]) await expect(read()).rejects.toMatchObject({ code: 'version_mismatch', message })
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })
  it('lets each surface\'s read through only on a host that lists that surface\'s own feature', async () => {
    const url = await hostAnswering({ ...frozen, features: ['thread-changes'] })
    const client = new SocketHostService({ url, token: 'paired-token', owned: true })
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    // Only a hello lists what this client may use (ADR-0053), and the stand-in refuses the session before one, so the
    // test lists what that hello would. tests/integration/socketHost.test.ts covers the hello itself.
    Object.assign(client, { features: ['thread-changes'] })
    await expect(client.threadFiles({ threadId: 'thread', path: '' })).rejects.toMatchObject({ code: 'version_mismatch' })
    await expect(client.subagentPage({ threadId: 'thread' })).rejects.toMatchObject({ code: 'version_mismatch' })
    // Listed, so the read is sent: with no socket open it fails as a dropped connection, not as the version.
    await expect(client.gitChanges({ threadId: 'thread' })).rejects.toMatchObject({ code: 'disconnected' })
  })
})

describe('the version sentence', () => {
  it('says which side to bring up to date, and offers Stop host only for a host Sotto started', () => {
    expect(hostIsNewer('0.1.16', '0.1.15')).toBe(true)
    expect(hostIsNewer('0.2.0', '0.10.0')).toBe(false)
    expect(hostIsNewer('0.1.15', '0.1.15')).toBe(false)
    expect(hostIsNewer(undefined, '0.1.15')).toBe(false)
    expect(hostVersionMismatch('0.1.16', '0.1.15', true)).toBe('This host is running a different version of Sotto. Nothing on the host was lost. Update it from the Threads page, or put the Sotto 0.1.16 host in its installation folder, press Stop host, then connect again.')
    expect(hostVersionMismatch('0.1.16', undefined, false)).toBe('This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto 0.1.16 host in its installation folder, stop the host on that machine, then connect again.')
    expect(hostVersionMismatch('0.1.15', '0.1.16', true)).toBe('This host is running a newer version of Sotto than this computer. Nothing on the host was lost. Update Sotto on this computer, then connect again.')
  })
})

it('keeps the saved pairing when an older host refuses an upgrade with 401', async () => {
  const url = await hostAnswering(frozen)
  server!.removeAllListeners('request')
  server!.on('request', (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(request.url === '/v1/health' ? frozen : {
      v: 1, hostId, clientId: 'client', session: 'session', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }))
  })
  server!.on('upgrade', (_request, stream) => stream.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'))
  const client = new SocketHostService({ url, token: 'paired-token' })
  await expect(client.connect()).rejects.toMatchObject({ code: 'unavailable', pairingRequired: false })
})

describe('what a desktop uses of a host, and where it pairs (ADR-0053)', () => {
  it('uses only the features a hello listed, never the ones health listed for the listener', async () => {
    // Health lists everything the listener offers; this session is refused before any hello says what this client may use.
    const url = await hostAnswering({ ...frozen, features: [...frozen.features, 'provider-sign-in', 'client-updates', 'attachment-staging'] })
    const client = new SocketHostService({ url, token: 'paired-token' })
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(client.offersSignIn()).toBe(false)
    expect(client.offersClientUpdates()).toBe(false)
    await expect(client.signIn({ op: 'sign-in-start', provider: 'codex' })).rejects.toMatchObject({ code: 'version_mismatch' })
    await expect(client.gitRefs({ threadId: randomUUID() })).rejects.toMatchObject({ code: 'version_mismatch' })
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })

  it('sends a pairing code to this computer only, and never to a host’s tailnet address', async () => {
    const url = await hostAnswering(frozen)
    const sent = vi.spyOn(globalThis, 'fetch')
    try {
      for (const address of ['https://forge.tail5728ca.ts.net:8443', 'https://127.0.0.1:4319']) {
        await expect(SocketHostService.pair(address, 'synthetic-code', 'Sotto desktop')).rejects.toThrow('This computer pairs with a host only through its SSH connection. Nothing was sent.')
      }
      expect(sent).not.toHaveBeenCalled()
      // The forward on this computer is where pairing goes; the stand-in refuses the code, which is enough to show it was sent.
      await expect(SocketHostService.pair(url, 'synthetic-code', 'Sotto desktop')).rejects.toMatchObject({ code: 'unauthenticated' })
      expect(requested).toEqual(['/v1/pair'])
    } finally { sent.mockRestore() }
  })
})

describe('SocketHostService on a tailnet connection (ADR-0053)', () => {
  it('sends a host that answers as another one nothing of this device’s pairing', async () => {
    const url = await hostAnswering({ ...frozen, sottoVersion: packageVersion, hostId: randomUUID() })
    const client = new SocketHostService({ url, token: 'paired-token', expectedHostId: hostId })
    await expect(client.connect()).rejects.toMatchObject({ name: 'Error', code: 'unauthenticated', message: 'This address belongs to a different host. Check the connection before continuing.' })
    expect(requested).toEqual(['/v1/health'])
  })

  it('reads a 403 as the host refusing this device here, which keeps the pairing, and a 401 as pairing again', async () => {
    requested.length = 0
    let status = 403
    server = createServer((request, response) => {
      requested.push(request.url ?? '')
      if (request.url === '/v1/health') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ...frozen, sottoVersion: packageVersion })); return }
      response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ v: 1, error: { code: 'forbidden', message: 'Phones are off on forge.' } }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No loopback port.')
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + address.port, token: 'paired-token', expectedHostId: hostId })
    await expect(client.connect()).rejects.toMatchObject({ code: 'forbidden', pairingRequired: false })
    status = 401
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated', pairingRequired: true })
  })

  it('gives up on a health check that takes longer than the time it was given', async () => {
    requested.length = 0
    server = createServer(request => { requested.push(request.url ?? '') })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No loopback port.')
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + address.port, token: 'paired-token', healthTimeoutMs: 50 })
    await expect(client.connect()).rejects.toMatchObject({ name: 'TimeoutError' })
    server.closeAllConnections()
  })
})

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
