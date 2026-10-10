// @vitest-environment node
import { CheckoutSendRefusal } from '../../../src/main/agents/checkoutMutations'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'

import { AttachmentStore } from '../../../src/main/agents/attachmentStore'
import { FollowupStore } from '../../../src/main/agents/followups'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { agentCommandSchema, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { handleOf, PIXEL_PNG, pngOfSize, stageInto } from '../../fixtures/stagedImages'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { deferred } from '../../fixtures/deferred'

const roots: string[] = []; const controls: AgentControl[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of controls.splice(0)) { c.dispose(); await c.privacyChanged() }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-followups-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
})
class Host implements AgentHost {
  state!: AgentHostSnapshot
  listeners = new Set<(s: AgentHostSnapshot) => void>()
  attempts: AgentHostCommand[] = []
  gate?: Promise<void>
  result?: AgentHostResult
  async connect() { this.state ??= await new E2EAgentHost().connect(); this.state.connected = true; return this.snapshot() }
  async snapshot() { return structuredClone(this.state) }
  subscribe(fn: (s: AgentHostSnapshot) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  disconnect() { this.state.connected = false }
  update(id: string, patch: Partial<AgentThread>) { Object.assign(this.state.threads.find(t => t.id === id)!, patch); this.emit() }
  emit() { for (const fn of this.listeners) fn(structuredClone(this.state)) }
  async execute(c: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(c)
    if ('threadId' in c && c.threadId === 'workshop') await this.gate
    if (this.result) return this.result
    if (c.type === 'send' || c.type === 'steer') {
      const thread = this.state.threads.find(t => t.id === c.threadId)!
      thread.messages.push({ id: c.messageId, commandId: c.commandId, role: 'user', text: c.text, createdAt: new Date().toISOString() })
      thread.status = 'running'; thread.lastTurn = { id: c.commandId, status: 'running' }; this.emit()
    } else if (c.type === 'interrupt') this.update(c.threadId, { status: 'idle', lastTurn: { id: 'interrupted', status: 'interrupted' } })
    return { accepted: true }
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-followups-')); roots.push(root)
  const host = new Host()
  const credentials = await testCredentials(root, { mode: 'unavailable' });
  const create = () => {
    const c = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
    })
    controls.push(c); return c
  }
  const control = create(); await control.start(); await stageInto(control, PIXEL_PNG); await control.command({ type: 'connect' })
  return { root, host, control, create }
}
const queued = (text: string, threadId = 'workshop') => ({ type: 'queue-followup' as const, threadId, draftId: randomUUID(), text })
const complete = (host: Host, id = 'workshop') => host.update(id, { status: 'idle', lastTurn: { id: randomUUID(), status: 'completed' } })

it('durably transfers exact draft ownership, edits/removes/reorders and restores skill identity across restart', async () => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  const a = { ...queued('$build first'), skills: [{ name: 'build', path: 'C:/skills/build/SKILL.md' }] }; const b = queued('second'); const c = queued('remove')
  await f.control.command({ ...a, type: 'save-thread-draft' }); await f.control.command(a)
  const newer = { ...queued('newer revision'), type: 'save-thread-draft' as const }; await f.control.command(newer)
  await f.control.command(b); await f.control.command(c)
  const [one, two, three] = f.control.get().followups!
  await f.control.command({ type: 'edit-followup', threadId: 'workshop', itemId: one!.id, text: '$build edited' })
  await f.control.command({ type: 'remove-followup', threadId: 'workshop', itemId: three!.id })
  await f.control.command({ type: 'reorder-followups', threadId: 'workshop', itemIds: [two!.id, one!.id] })
  f.control.dispose(); await f.control.privacyChanged()
  const restored = f.create(); await restored.start(); await restored.command({ type: 'connect' })
  expect(restored.get().followups?.map(i => i.text)).toEqual(['second', '$build edited'])
  expect(restored.get().followups?.[1]?.skills).toEqual(a.skills)
  expect(restored.get().threadDrafts).toEqual([expect.objectContaining({ draftId: newer.draftId })])
  expect(restored.get().deliveredDrafts).toEqual([])
  await restored.command(a)
  expect(restored.get().followups).toHaveLength(2)
  expect(f.host.attempts).toHaveLength(0)
  expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
})

it('queues running manual sends by default, acknowledges immediately and dispatches one item per completed turn', async () => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  const feedback: number[] = []; f.control.subscribe(s => { if (s.deliveries?.some(d => d.localFeedbackMs !== undefined)) feedback.push(s.deliveries!.at(-1)!.localFeedbackMs!) })
  await f.control.command({ ...queued('first'), type: 'manual-send' }); await f.control.command(queued('second'))
  expect(Math.min(...feedback)).toBeLessThan(100)
  expect(f.host.attempts).toHaveLength(0)
  complete(f.host)
  await expect.poll(() => f.control.get().followups?.length).toBe(1)
  f.host.emit(); f.host.emit()
  expect(f.host.attempts).toHaveLength(1)
  complete(f.host)
  await expect.poll(() => f.control.get().followups?.length).toBe(0)
  expect(f.host.attempts.filter(c => c.type === 'send').map(c => c.text)).toEqual(['first', 'second'])
})

it('allows another thread send and draft saves while a first provider send is slow', async () => {
  const f = await fixture(); const { promise: heldRelease, resolve: release } = deferred<void>()
  f.host.gate = heldRelease
  const first = f.control.command({ ...queued('slow'), type: 'manual-send' })
  try {
    await expect.poll(() => f.host.attempts.length).toBe(1)
    const second = await f.control.command({ ...queued('independent', 'docs'), type: 'manual-send' })
    expect(second.deliveredDrafts).toHaveLength(1)
    await f.control.command({ ...queued('newer draft'), type: 'save-thread-draft' })
    expect(f.control.get().threadDraftPersistence?.[0]?.status).toBe('saved')
  } finally { release(); await first }
})

it('waits through permission requests, settlement and disconnection, and queues only explicit follow-ups', async () => {
  const f = await fixture();
  f.host.update('workshop', { status: 'running', requests: [{ id: 'permit', kind: 'permission', text: 'Allow?', options: [] }] })
  await f.control.command(queued('user follow-up'))

  complete(f.host); expect(f.host.attempts).toHaveLength(0)
  f.host.update('workshop', { requests: [], workspaceSettledAt: new Date().toISOString() }); expect(f.host.attempts).toHaveLength(0)
  f.host.state.connected = false; f.host.update('workshop', { workspaceSettledAt: null }); expect(f.host.attempts).toHaveLength(0)
  f.host.state.connected = true; f.host.emit()
  await expect.poll(() => f.control.get().followups?.length).toBe(0)
  expect(f.host.attempts.map(c => c.type)).toEqual(['send'])
})

it('pauses on interruption and failed native completion until explicit resume', async () => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  await f.control.command(queued('after interrupt'))
  await f.control.command({ type: 'interrupt', threadId: 'workshop' })
  expect(f.control.get().followups?.[0]?.status).toBe('paused')
  await f.control.command({ type: 'resume-followups', threadId: 'workshop' })
  await expect.poll(() => f.control.get().followups?.length).toBe(0)
  await f.control.command(queued('after failure'))
  f.host.update('workshop', { status: 'error', lastTurn: { id: 'failed-native', status: 'failed' } })
  await expect.poll(() => f.control.get().followups?.[0]?.status).toBe('paused')
  expect(f.host.attempts.filter(c => c.type === 'send')).toHaveLength(1)
  await f.control.command({ type: 'resume-followups', threadId: 'workshop' })
  await expect.poll(() => f.control.get().followups?.length).toBe(0)
})

it('keeps uncertain dispatch immutable across restart and reconciles exact evidence without replay', async () => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' }); await f.control.command(queued('uncertain'))
  f.host.result = { accepted: false, uncertain: true }; complete(f.host)
  await expect.poll(() => f.control.get().followups?.[0]?.status).toBe('uncertain')
  expect(f.control.pendingThreadWorkReason('workshop')).toBe('uncertain-send')
  const item = f.control.get().followups![0]!
  expect((await f.control.command({ type: 'remove-followup', threadId: item.threadId, itemId: item.id })).error).toMatch(/may already/)
  f.control.dispose(); await f.control.privacyChanged()
  const restored = f.create(); await restored.start(); await restored.command({ type: 'connect' }); await restored.command({ type: 'resume-followups', threadId: item.threadId })
  expect(restored.get().followups?.[0]?.status).toBe('uncertain'); expect(f.host.attempts).toHaveLength(1)
  f.host.update('workshop', { messages: [{ id: item.messageId!, commandId: item.commandId!, role: 'user', text: item.text, createdAt: new Date().toISOString() }] })
  await expect.poll(() => restored.get().followups?.length).toBe(0)
  expect(f.host.attempts).toHaveLength(1)
})

it('restores a crash after durable claim but before outbox creation as uncertain, never queued', async () => {
  const f = await fixture(); const store = new FollowupStore(f.root); await store.load()
  await store.enqueue({ ...queued('crash window'), attachments: [] }); const item = store.get().items[0]!
  await store.claim(item.id)
  const restored = new FollowupStore(f.root); await restored.load()
  expect(restored.get().items[0]?.status).toBe('uncertain')
  await expect(restored.edit(item.threadId, item.id)).rejects.toThrow(/may already/)
})

it('rejects unsupported steer without cancellation or consuming its draft', async () => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  const command = { ...queued('steer safely'), type: 'steer' as const }
  expect(agentCommandSchema.safeParse(command).success).toBe(true)
  const state = await f.control.command(command)
  expect(state.error).toMatch(/does not support native steering/)
  expect(state.threadDrafts?.[0]?.draftId).toBe(command.draftId)
  expect(f.host.attempts).toHaveLength(0)
})

it('preserves a newer same-text skill selection when the earlier uncertain revision is acknowledged', async () => {
  const f = await fixture(); f.host.result = { accepted: false, uncertain: true }
  const first = { ...queued('$build run'), type: 'manual-send' as const, skills: [{ name: 'build', path: 'C:/one/SKILL.md' }] }
  await f.control.command(first)
  const newer = { ...first, type: 'save-thread-draft' as const, draftId: randomUUID(), skills: [{ name: 'build', path: 'C:/two/SKILL.md' }] }
  await f.control.command(newer)
  const sent = f.host.attempts[0]!
  if (sent.type !== 'send') throw new Error('Expected a prompt')
  expect(sent.skills).toEqual(first.skills)
  f.host.update('workshop', { messages: [{ id: sent.messageId, commandId: sent.commandId, role: 'user', text: sent.text, createdAt: new Date().toISOString() }] })
  expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ draftId: newer.draftId, skills: newer.skills }))
  expect(f.control.get().deliveredDrafts).toEqual([{ threadId: first.threadId, draftId: first.draftId }])
})

it('keeps a definitively rejected queue head for editing and does not advance until explicit resume', async () => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  await f.control.command(queued('rejected')); await f.control.command(queued('later'))
  f.host.result = { accepted: false }; complete(f.host)
  await expect.poll(() => f.control.get().followups?.[0]?.status).toBe('failed')
  f.host.emit(); f.host.emit(); expect(f.host.attempts).toHaveLength(1)
  const item = f.control.get().followups![0]!
  await f.control.command({ type: 'edit-followup', threadId: item.threadId, itemId: item.id, text: 'corrected' })
  delete f.host.result
  await f.control.command({ type: 'resume-followups', threadId: item.threadId })
  await expect.poll(() => f.control.get().followups?.length).toBe(1)
  expect(f.host.attempts.filter(c => c.type === 'send').map(c => c.text)).toEqual(['rejected', 'corrected'])
})

it('rechecks native completion after saving outbox intent, before dispatching a queued follow-up', async () => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' }); await f.control.command(queued('must wait'))
    let blocked = false
  const { promise: gate, resolve: release } = deferred<void>(); const { promise: ready, resolve: entered } = deferred<void>()
  const original = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function(this: AtomicJsonStore<unknown>, value) {
    await original.call(this, value)
    const snapshot = value as { outbox?: { type: string }[] }
    if (!blocked && snapshot.outbox?.some(item => item.type === 'send')) { blocked = true; entered(); await gate }
  })
  complete(f.host)
  try { await ready; f.host.update('workshop', { status: 'idle', lastTurn: { id: 'externally-interrupted', status: 'interrupted' } }) }
  finally { release() }
  await expect.poll(() => f.control.get().followups?.[0]?.status).toBe('failed')
  expect(f.host.attempts).toHaveLength(0)
})

it('does not dispatch a stale queue head after an edit operation has reordered it', async () => {
  const f = await fixture(); const store = new FollowupStore(f.root); await store.load()
  await store.enqueue({ ...queued('was first'), attachments: [] }); await store.enqueue({ ...queued('now first'), attachments: [] })
  const [first, second] = store.get().items
  await store.reorder('workshop', [second!.id, first!.id])
  await expect(store.claim(first!.id)).rejects.toThrow(/no longer ready/)
  expect(store.get().items.map(i => i.status)).toEqual(['queued', 'queued'])
})

it('clears an accepted selected-skill and file revision from both draft representations and disk', async () => {
  const f = await fixture()
  const command = { ...queued('$build run'), type: 'manual-send' as const, skills: [{ name: 'build', path: 'C:/synthetic/SKILL.md' }], files: [{ path: 'README.md' }] }
  const state = await f.control.command(command)
  expect(state.deliveredDrafts).toContainEqual({ threadId: command.threadId, draftId: command.draftId })
  expect(state.draft).toBe('')
  expect(state.threadDrafts).toEqual([])
  expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))).toMatchObject({ draft: '', threadDrafts: [], composing: false })
})

it('does not queue a revision whose manual acknowledgement is still pending', async () => {
  const f = await fixture(); const { promise: heldRelease, resolve: release } = deferred<void>()
  f.host.gate = heldRelease
  const command = { ...queued('dispatch once'), type: 'manual-send' as const }
  const first = f.control.command(command)
  try {
    await expect.poll(() => f.host.attempts.length).toBe(1)
    const duplicate = f.control.command({ ...command, type: 'queue-followup' })
    release(); await first; await duplicate
    expect(f.control.get().followups).toEqual([])
    complete(f.host)
    await f.control.command({ type: 'refresh' })
    expect(f.host.attempts).toHaveLength(1)
  } finally { release(); await first }
})

it.each(['manual-send', 'steer'] as const)('reconciles an identical uncertain file prompt through %s before and after restart without dispatching again', async type => {
  const f = await fixture(); f.host.state.capabilities.steer = true
  if (type === 'steer') f.host.update('workshop', { status: 'running', lastTurn: { id: 'active-turn', status: 'running' } })
  f.host.result = { accepted: false, uncertain: true }
  const command = { ...queued('Read @README.md'), type, files: [{ path: 'README.md' }],
    attachments: [handleOf(PIXEL_PNG)], skills: [{ name: 'build', path: 'C:/skills/build/SKILL.md' }] }
  await f.control.command(command)
  expect(f.control.get().deliveries).toContainEqual(expect.objectContaining({ draftId: command.draftId, status: 'uncertain' }))
  const refresh = vi.spyOn(f.host, 'snapshot')
  for (const restart of [false, true]) {
    if (restart) { f.control.dispose(); await f.control.privacyChanged() }
    const control = restart ? f.create() : f.control
    if (restart) { await control.start(); await control.command({ type: 'connect' }) }
    refresh.mockClear()
    const retry = await control.command(command)
    expect(retry.error).not.toMatch(/new draft revision/)
    expect(refresh).toHaveBeenCalled()
    expect(f.host.attempts).toHaveLength(1)
    expect(retry.followups).toEqual([])
    expect(retry.deliveries).toContainEqual(expect.objectContaining({ draftId: command.draftId, status: 'uncertain' }))
    if (restart) {
      const sent = f.host.attempts[0]!
      if (sent.type !== 'send' && sent.type !== 'steer') throw new Error('Expected a prompt')
      f.host.update('workshop', { messages: [{ id: sent.messageId, commandId: sent.commandId, role: 'user', text: sent.text, createdAt: new Date().toISOString() }] })
      expect(control.get().deliveries).toContainEqual(expect.objectContaining({ draftId: command.draftId, status: 'accepted' }))
      expect(control.get().draft).toBe('')
      expect(control.get().threadDrafts).toEqual([])
      expect(f.host.attempts).toHaveLength(1)
    }
  }
})

it('keeps file prompt admission and retries bounded by image handles with one dispatch and no content reads', async () => {
  const f = await fixture()
  const image = await f.control.stageAttachment({ name: 'large.png', mimeType: 'image/png', bytes: pngOfSize(8 * 1024 * 1024) })
  const reads = vi.spyOn(AttachmentStore.prototype, 'read')
  const command = { ...queued('Read @README.md with this image'), type: 'manual-send' as const,
    files: [{ path: 'README.md' }], attachments: [image], skills: [{ name: 'build', path: 'C:/skills/build/SKILL.md' }] }
  const { promise: heldRelease, resolve: release } = deferred<void>()
  f.host.gate = heldRelease
  f.host.result = { accepted: false, uncertain: true }
  const sending = f.control.command(command)
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
  try {
    await expect.poll(() => f.host.attempts.length).toBe(1)
    for (let index = 0; index < 10; index++) expect(f.control.command(command)).toBe(sending)
    release(); await sending
    for (let index = 0; index < 3; index++) {
      const state = await f.control.command(command)
      expect(state.error).not.toMatch(/new draft revision/)
      expect(bytes(state)).toBeLessThan(64 * 1024)
    }
    for (const changed of [{ attachments: [handleOf(PIXEL_PNG)] }, { skills: [{ name: 'build', path: 'C:/other/SKILL.md' }] }]) {
      expect((await f.control.command({ ...command, ...changed })).error).toMatch(/new draft revision/)
    }
    expect(f.host.attempts).toHaveLength(1)
    expect(reads).not.toHaveBeenCalled()
    expect(bytes(command)).toBeLessThan(64 * 1024)
    expect(bytes(f.host.attempts[0])).toBeLessThan(64 * 1024)
    expect(Buffer.byteLength(await readFile(join(f.root, 'agents.json'), 'utf8'))).toBeLessThan(64 * 1024)
  } finally { release(); await sending }
})

it.each(['manual-send', 'steer', 'queue-followup'] as const)('reserves queue ownership against %s while its durable write is pending', async type => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  const command = { ...queued('owned once'), files: [{ path: 'README.md' }] }

  const { promise: gate, resolve: release } = deferred<void>(); const { promise: ready, resolve: entered } = deferred<void>()
  const original = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function(this: AtomicJsonStore<unknown>, value) {
    if ((value as { items?: unknown[] }).items?.length) { entered(); await gate }
    await original.call(this, value)
  })
  const first = f.control.command(command)
  try {
    await ready
    const duplicate = f.control.command({ ...command, type })
    expect(duplicate).toBe(first)
    release(); await first
    expect((await duplicate).error).toBeNull()
    expect(f.host.attempts).toEqual([])
    expect(f.control.get().followups).toHaveLength(1)
    expect(f.control.get().threadDrafts).toEqual([])
  } finally { release(); await first }
})

it.each(['manual-send', 'steer', 'queue-followup'] as const)('rejects different content with a queued revision ID through %s', async type => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  const command = queued('original'); await f.control.command(command)
  const state = await f.control.command({ ...command, type, text: 'must not disappear' })
  expect(state.error).toMatch(/new draft revision/)
  expect(state.followups?.map(i => i.text)).toEqual(['original'])
  expect(f.host.attempts).toEqual([])
})

it.each(['manual-send', 'steer', 'queue-followup'] as const)('keeps an accepted manual revision owned across restart when retried through %s', async type => {
  const f = await fixture(); const command = { ...queued('accepted once'), files: [{ path: 'README.md' }] }
  await f.control.command({ ...command, type: 'manual-send' })
  f.control.dispose(); await f.control.privacyChanged()
  const restored = f.create(); await restored.start(); await restored.command({ type: 'connect' })
  expect((await restored.command({ ...command, type })).error).toBeNull()
  expect(restored.get().followups).toEqual([])
  const conflict = await restored.command({ ...command, type, skills: [{ name: 'build', path: 'C:/different/SKILL.md' }] })
  expect(conflict.error).toMatch(/new draft revision/)
  expect((await restored.command({ ...command, type, files: [{ path: 'src/main.ts' }] })).error).toMatch(/new draft revision/)
  complete(f.host); await restored.command({ type: 'refresh' })
  expect(f.host.attempts).toHaveLength(1)
})

it.each(['manual-send', 'steer', 'queue-followup'] as const)('keeps queue admission identity after an edit/removal and restart through %s', async type => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  const command = { ...queued('original'), files: [{ path: 'README.md' }] }; await f.control.command(command)
  const item = f.control.get().followups![0]!
  await f.control.command({ type: 'edit-followup', threadId: item.threadId, itemId: item.id, text: 'edited in queue' })
  await f.control.command({ type: 'remove-followup', threadId: item.threadId, itemId: item.id })
  f.control.dispose(); await f.control.privacyChanged()
  const restored = f.create(); await restored.start(); await restored.command({ type: 'connect' })
  expect((await restored.command({ ...command, type })).error).toBeNull()
  expect((await restored.command({ ...command, type, text: 'new content needs its own revision' })).error).toMatch(/new draft revision/)
  expect((await restored.command({ ...command, type, files: [{ path: 'src/main.ts' }] })).error).toMatch(/new draft revision/)
  expect(restored.get().followups).toEqual([])
  expect(f.host.attempts).toEqual([])
})

it('never queues uncertain manual intent, while retaining newer revisions and the same ID on another thread', async () => {
  const f = await fixture(); f.host.result = { accepted: false, uncertain: true }
  const command = queued('uncertain once')
  await f.control.command({ ...command, type: 'manual-send' })
  f.control.dispose(); await f.control.privacyChanged()
  const restored = f.create(); await restored.start(); await restored.command({ type: 'connect' })
  await restored.command(command)
  expect(restored.get().followups).toEqual([])
  expect(restored.get().deliveries).toContainEqual(expect.objectContaining({ draftId: command.draftId, status: 'uncertain' }))
  expect((await restored.command({ ...command, text: 'changed content' })).error).toMatch(/new draft revision/)
  const newer = { ...command, draftId: randomUUID(), text: 'legitimate next revision' }
  await restored.command({ ...newer, type: 'save-thread-draft' }); await restored.command(newer)
  f.host.update('docs', { status: 'running' })
  await restored.command({ ...command, threadId: 'docs' })
  expect(restored.get().followups).toEqual(expect.arrayContaining([
    expect.objectContaining({ threadId: 'workshop', draftId: newer.draftId, text: newer.text }),
    expect.objectContaining({ threadId: 'docs', draftId: command.draftId }),
  ]))
  expect(f.host.attempts.filter(c => 'threadId' in c && c.threadId === 'workshop')).toHaveLength(1)
})

it('rejects conflicting file selections during manual admission before any outbox write', async () => {
  const f = await fixture();
  const { promise: gate, resolve: release } = deferred<void>(); const { promise: ready, resolve: entered } = deferred<void>()
  const original = AtomicJsonStore.prototype.write
  let blocked = false
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function(this: AtomicJsonStore<unknown>, value) {
    if (!blocked && (value as { deliveries?: unknown[] }).deliveries?.length) { blocked = true; entered(); await gate }
    await original.call(this, value)
  })
  const command = { ...queued('reserved before persistence'), files: [{ path: 'README.md' }] }
  const sending = f.control.command({ ...command, type: 'manual-send' })
  try {
    await ready
    expect(f.host.attempts).toEqual([])
    for (const type of ['manual-send', 'steer', 'queue-followup'] as const) {
      expect(f.control.command({ ...command, type })).toBe(sending)
      const conflict = f.control.command({ ...command, type, files: [{ path: 'src/main.ts' }] })
      expect(conflict).not.toBe(sending)
      expect((await conflict).error).toMatch(/new draft revision/)
      expect((await f.control.command({ ...command, type, text: 'conflict' })).error).toMatch(/new draft revision/)
    }
  } finally { release(); await sending }
  expect(f.control.get().followups).toEqual([])
  expect(f.host.attempts).toHaveLength(1)
})

it('releases a failed queue admission so the retained revision can be retried', async () => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  const command = queued('retry when durable')
  await f.control.command({ ...command, type: 'save-thread-draft' })
  const original = AtomicJsonStore.prototype.write
  const spy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function(this: AtomicJsonStore<unknown>, value) {
    if ((value as { items?: unknown[] }).items?.length) throw new Error('Synthetic queue write failure')
    await original.call(this, value)
  })
  expect((await f.control.command(command)).error).toMatch(/Synthetic queue write failure/)
  expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ draftId: command.draftId }))
  expect(f.control.get().followupReceipts).toEqual([])
  spy.mockRestore()
  expect((await f.control.command(command)).error).toBeNull()
  expect(f.control.get().followups).toHaveLength(1)
  expect(f.control.get().threadDrafts).toEqual([])
  expect(f.host.attempts).toEqual([])
})

it('requires explicit resume when an idle thread has no known turn outcome', async () => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  await f.control.command(queued('Review an unknown outcome'))
  delete f.host.state.threads.find(thread => thread.id === 'workshop')!.lastTurn
  f.host.update('workshop', { status: 'idle' })
  await expect.poll(() => f.control.get().followups?.[0]?.status).toBe('paused')
  expect(f.control.pendingThreadWorkReason('workshop')).toBe('paused-followups')
  f.host.emit(); await f.control.command({ type: 'refresh' })
  expect(f.control.get().followups?.[0]?.status).toBe('paused')
  expect(f.host.attempts).toEqual([])
  await f.control.command({ type: 'resume-followups', threadId: 'workshop' })
  await expect.poll(() => f.control.get().followups?.length).toBe(0)
  expect(f.host.attempts.filter(command => command.type === 'send')).toHaveLength(1)
})

it('steers a selected edited queue item once, preserving the remaining queue and newer draft', async () => {
  const f = await fixture()
  f.host.state.capabilities.steer = true
  f.host.update('workshop', { status: 'running' })
  await f.control.command(queued('first'))
  const prompt = { ...queued('$build second @README.md'), skills: [{ name: 'build', path: 'C:/skills/build/SKILL.md' }], files: [{ path: 'README.md' }],
    attachments: [handleOf(PIXEL_PNG, randomUUID(), 'reference.png')] }
  await f.control.command(prompt)
  const item = f.control.get().followups![1]!
  await f.control.command({ type: 'edit-followup', threadId: item.threadId, itemId: item.id, text: '$build edited second @README.md' })
  const newer = { ...queued('newer draft'), type: 'save-thread-draft' as const }
  await f.control.command(newer)
  const request = { type: 'steer-followup' as const, threadId: item.threadId, itemId: item.id }
  expect(agentCommandSchema.safeParse(request).success).toBe(true)
  await Promise.all([f.control.command(request), f.control.command(request)])
  expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'steer', text: '$build edited second @README.md', skills: prompt.skills, files: prompt.files, attachments: [expect.objectContaining(prompt.attachments[0])] })])
  expect(f.control.get().followups?.map(item => item.text)).toEqual(['first'])
  expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ draftId: newer.draftId, text: newer.text })])
  complete(f.host)
  await expect.poll(() => f.control.get().followups?.length).toBe(0)
  expect(f.host.attempts.map(item => item.type)).toEqual(['steer', 'send'])
})

it.each(['unsupported', 'question', 'refused', 'uncertain'] as const)('preserves a queued steer when %s and never replays uncertainty', async outcome => {
  const f = await fixture()
  f.host.state.capabilities.steer = outcome !== 'unsupported'
  f.host.update('workshop', { status: 'running', requests: outcome === 'question' ? [{ id: 'question', kind: 'question', text: 'Which?', options: [] }] : [] })
  await f.control.command(queued('keep this message'))
  const item = f.control.get().followups![0]!
  if (outcome === 'refused') f.host.result = { accepted: false }
  if (outcome === 'uncertain') f.host.result = { accepted: false, uncertain: true }
  const request = { type: 'steer-followup' as const, threadId: item.threadId, itemId: item.id }
  const result = await f.control.command(request)
  expect(result.followups?.[0]).toMatchObject({ id: item.id, text: item.text, status: outcome === 'uncertain' ? 'uncertain' : outcome === 'refused' ? 'failed' : 'queued' })
  expect(f.host.attempts).toHaveLength(outcome === 'unsupported' || outcome === 'question' ? 0 : 1)
  if (outcome === 'uncertain') {
    await f.control.command(request)
    f.control.dispose(); await f.control.privacyChanged()
    const restored = f.create(); await restored.start(); await restored.command({ type: 'connect' })
    await restored.command(request)
    expect(f.host.attempts).toHaveLength(1)
    expect(restored.get().followups?.[0]?.status).toBe('uncertain')
  }
})

it('reconciles a late steer confirmation behind an untouched queue head', async () => {
  const f = await fixture(); f.host.state.capabilities.steer = true
  f.host.update('workshop', { status: 'running' })
  await f.control.command(queued('keep first')); await f.control.command(queued('steer second'))
  const item = f.control.get().followups![1]!
  f.host.result = { accepted: false, uncertain: true }
  await f.control.command({ type: 'steer-followup', threadId: item.threadId, itemId: item.id })
  const attempt = f.host.attempts[0]!
  if (attempt.type !== 'steer') throw new Error('Expected a steer')
  f.host.update('workshop', { messages: [{ id: attempt.messageId, commandId: attempt.commandId, role: 'user', text: attempt.text, createdAt: new Date().toISOString() }] })
  await expect.poll(() => f.control.get().followups?.map(item => item.text)).toEqual(['keep first'])
  expect(f.host.attempts).toHaveLength(1)
})

it('reads a waiting image follow-up without copying the queue on every streaming snapshot', async () => {
  const f = await fixture(); f.host.update('workshop', { status: 'running' })
  // A 3 MB screenshot waiting behind a running turn: the case that made every copy cost milliseconds.
  const shot = pngOfSize(3 * 1024 * 1024, 7); await stageInto(f.control, shot)
  await f.control.command({ ...queued('look at this'), attachments: [handleOf(shot, 'shot', 'shot.png')] })
  const copies = vi.spyOn(FollowupStore.prototype, 'get')
  const reads = vi.spyOn(FollowupStore.prototype, 'peek')
  for (let chunk = 0; chunk < 50; chunk += 1) f.host.update('workshop', { title: `streaming ${chunk}` })
  f.control.get()
  expect(reads.mock.calls.length).toBeGreaterThanOrEqual(50)
  expect(copies).not.toHaveBeenCalled()
  expect(f.host.attempts).toHaveLength(0)
  expect(f.control.get().followups?.[0]?.attachments[0]?.digest).toBe(handleOf(shot).digest)
})

it('keeps a view it handed out unchanged when the queue changes after it', async () => {
  const f = await fixture(); const store = new FollowupStore(f.root); await store.load()
  await store.enqueue({ ...queued('first'), attachments: [] })
  const before = store.peek()
  await store.enqueue({ ...queued('second'), attachments: [] })
  await store.edit(before.items[0]!.threadId, before.items[0]!.id, { text: 'edited', attachments: [] })
  expect(before.items.map(item => item.text)).toEqual(['first'])
  expect(store.peek().items.map(item => item.text)).toEqual(['edited', 'second'])
})

it('keeps a checkout-refused follow-up failed in the queue until the user resumes it', async () => {
  const f = await fixture()
  f.host.update('workshop', { status: 'running' })
  await f.control.command(queued('Keep these words'))
  const execute = vi.spyOn(f.host, 'execute').mockRejectedValue(new CheckoutSendRefusal())
  complete(f.host)
  await expect.poll(() => f.control.get().followups?.[0]?.status).toBe('failed')
  expect(f.control.pendingThreadWorkReason('workshop')).toBe('failed-followups')
  expect(f.control.get().followups?.[0]).toMatchObject({ text: 'Keep these words', error: 'A Git action is running in this folder. Your follow-up was not sent. It is kept in the queue. Resume the queue when the action finishes.' })
  expect(f.host.state.threads.find(t => t.id === 'workshop')?.messages.some(m => m.text === 'Keep these words')).toBe(false)
  execute.mockRestore()
  await f.control.command({ type: 'resume-followups', threadId: 'workshop' })
  await expect.poll(() => f.control.get().followups?.length).toBe(0)
  expect(f.host.state.threads.find(t => t.id === 'workshop')?.messages.filter(m => m.text === 'Keep these words')).toHaveLength(1)
})


it('says a checkout-refused manual prompt is kept and retains its durable draft', async () => {
  const f = await fixture()
  f.host.update('workshop', { status: 'idle', requests: [] })
  vi.spyOn(f.host, 'execute').mockRejectedValue(new CheckoutSendRefusal())
  const command = { ...queued('Keep this manual prompt'), type: 'manual-send' as const }
  const result = await f.control.command(command)
  expect(result.error).toBe('A Git action is running in this folder. Your message was not sent. Your text is kept. Send it again when the action finishes.')
  expect(result.threadDrafts).toContainEqual(expect.objectContaining({ draftId: command.draftId, text: command.text }))
  expect(result.deliveries).toContainEqual(expect.objectContaining({ draftId: command.draftId, status: 'failed' }))
  expect(f.host.state.threads.find(t => t.id === 'workshop')?.messages.some(m => m.text === command.text)).toBe(false)
})
