// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { FollowupStore } from '../../../src/main/agents/followups'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { agentCommandSchema, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'

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
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: t => Buffer.from(t), decryptString: t => t.toString() }); await credentials.load()
  const create = () => {
    const c = new AgentControl({ directory: root, host, credentials, reasoner: e2eAgentReasoner,
      membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
    controls.push(c); return c
  }
  const control = create(); await control.start(); await control.command({ type: 'connect' })
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
  const f = await fixture(); let release!: () => void
  f.host.gate = new Promise<void>(done => { release = done })
  const first = f.control.command({ ...queued('slow'), type: 'manual-send' })
  try {
    await expect.poll(() => f.host.attempts.length).toBe(1)
    const second = await f.control.command({ ...queued('independent', 'docs'), type: 'manual-send' })
    expect(second.deliveredDrafts).toHaveLength(1)
    await f.control.command({ ...queued('newer draft'), type: 'save-thread-draft' })
    expect(f.control.get().threadDraftPersistence?.[0]?.status).toBe('saved')
  } finally { release(); await first }
})

it('waits through permission requests, settlement and disconnection, and revokes management on explicit enqueue', async () => {
  const f = await fixture(); await f.control.command({ type: 'assign', threadId: 'workshop' })
  f.host.update('workshop', { status: 'running', requests: [{ id: 'permit', kind: 'permission', text: 'Allow?', options: [] }] })
  await f.control.command(queued('user follow-up'))
  expect(f.control.get().assignments[0]?.mode).toBe('manual')
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
  let release!: () => void; let entered!: () => void; let blocked = false
  const gate = new Promise<void>(done => { release = done }); const ready = new Promise<void>(done => { entered = done })
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
