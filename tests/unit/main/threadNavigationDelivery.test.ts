// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'

import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { agentCommandSchema, type AgentHostSnapshot, type AgentState } from '../../../src/shared/agents'
import { handleOf, PIXEL_PNG, pngOfSize, stageInto } from '../../fixtures/stagedImages'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { deferred } from '../../fixtures/deferred'

const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  for (const control of controls) {
    control.dispose()
    await control.privacyChanged() // Drain snapshot persistence before removing its fixture directory.
  }
  controls.clear()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-navigation-delivery-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})
/** The saved coordinator state that carries an undispatched prompt's durable intent. */
function outboxHasSend(value: unknown): boolean {
  return (value as { outbox?: { type?: string }[] } | null)?.outbox?.some(item => item.type === 'send') === true
}

const image = handleOf(PIXEL_PNG, 'image', 'same.png')
const OTHER_PNG = pngOfSize(64, 3)
class FixtureHost extends E2EAgentHost {
  attempts: AgentHostCommand[] = []
  observeThreads = vi.fn<(ids: string[]) => void>()
  withheld: 'uncertain' | 'accepted' | null = null
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(command)
    if (this.withheld) return this.withheld === 'uncertain' ? { accepted: false, uncertain: true } : { accepted: true }
    return super.execute(command)
  }
  async acknowledge() { await super.execute(this.attempts.at(-1)!) }
}
async function fixture(receiptIds: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-navigation-delivery-')); roots.push(root)
  const host = new FixtureHost()
  const reasoner = { ...e2eAgentReasoner }
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const create = () => {
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner, }); controls.add(control); return control
  }
  let control = create()
  await control.start(); await stageInto(control, PIXEL_PNG, OTHER_PNG); await control.command({ type: 'connect' }); await control.command({ type: 'select-thread', threadId: 'workshop' })
  if (receiptIds.length) {
    control.dispose(); await control.privacyChanged(); controls.delete(control)
    const saved = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'))
    saved.deliveredDrafts = receiptIds.map(draftId => ({ threadId: 'workshop', draftId }))
    await writeFile(join(root, 'agents.json'), JSON.stringify(saved))
    control = create(); await control.start(); await stageInto(control, PIXEL_PNG, OTHER_PNG); await control.command({ type: 'connect' })
  }
  return { root, host, reasoner, get control() { return control }, async restart() {
    control.dispose(); await control.privacyChanged(); controls.delete(control)
    control = create(); await control.start(); await stageInto(control, PIXEL_PNG, OTHER_PNG)
  } }
}

describe('navigation independent of action latency', () => {
  it.each(['prompt', 'image', 'answer'] as const)('creates a manual thread without consuming a saved coordinator %s', async kind => {
    const f = await fixture()
    if (kind === 'answer') f.host.event({ type: 'question', threadId: 'workshop', requestId: 'question-a', text: 'Which color?' })
    const text = kind === 'image' ? '' : 'Keep A'
    const attachments = kind === 'answer' ? [] : [image]
    await f.control.command({ type: 'compose', text, attachments })
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    const before = f.control.get()
    if (kind === 'answer') expect(before.draftRequestId).toBe('question-a')
    const threadId = randomUUID()
    const result = await f.control.command({ type: 'create-thread', threadId, projectId: 'project', title: 'New manual thread', modelId: 'claude:test' })
    expect(result.error).toBeNull()
    expect(result.host.threads).toContainEqual(expect.objectContaining({ id: threadId }))
    expect(result).toMatchObject({ activeThreadId: threadId, draft: before.draft, draftThreadId: before.draftThreadId,
      draftAttachments: before.draftAttachments, draftRequestId: before.draftRequestId, threadDrafts: before.threadDrafts,
      composing: before.composing })
    expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'create-thread', threadId })])
    await f.restart()
    expect(f.control.get()).toMatchObject({ draft: text, draftThreadId: 'workshop', draftAttachments: attachments, draftRequestId: before.draftRequestId })
  })


  it('keeps both open panes observed through refresh without moving focus or granting authority', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    const before = f.control.get()
    const request = agentCommandSchema.parse({ type: 'observe-threads', threadIds: ['workshop', 'docs', 'workshop', 'missing'] })
    await f.control.command(request)
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs', 'workshop'])
    expect(f.control.get()).toMatchObject({ activeThreadId: 'docs', draft: before.draft })
    expect(f.host.attempts).toEqual([])
    await f.control.command({ type: 'refresh' })
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs', 'workshop'])
    await f.restart()
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs'])
    await f.control.command(request)
    await f.control.command(agentCommandSchema.parse({ type: 'observe-threads', threadIds: [] }))
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs'])
    expect(f.control.get()).not.toHaveProperty('assignments')
  })

  it('sends a manual prompt on B while preserving the saved draft on A', async () => {
    const f = await fixture()
    await f.control.command({ type: 'compose', text: 'Keep A', attachments: [image] })
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    const draftId = randomUUID()
    const result = await f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Only B', draftId })
    expect(result.error).toBeNull()
    expect(f.host.attempts.at(-1)).toMatchObject({ type: 'send', threadId: 'docs', text: 'Only B' })
    expect(result).toMatchObject({ draft: 'Keep A', draftThreadId: 'workshop', draftAttachments: [image], deliveredDrafts: [{ threadId: 'docs', draftId }] })
    expect(result).not.toHaveProperty('assignments')
    await f.restart()
    expect(f.control.get()).toMatchObject({ draft: 'Keep A', draftThreadId: 'workshop', draftAttachments: [image] })
  })

  it('publishes cached B and observes it during deferred refresh, retaining the draft and send authority on A', async () => {
    const f = await fixture()
    await f.control.command({ type: 'compose', text: 'Only A', attachments: [image] })
    const before = f.control.get()
    const gate = deferred<AgentHostSnapshot>()
    vi.spyOn(f.host, 'snapshot').mockReturnValueOnce(gate.promise)
    const refresh = f.control.command({ type: 'refresh' })
    await vi.waitFor(() => expect(f.control.get().globalLaneBusy).toBe(true))
    const states: AgentState[] = []; f.control.subscribe(state => states.push(state))
    const select = f.control.command({ type: 'select-thread', threadId: 'docs' })
    try {
      expect(f.control.get().activeThreadId).toBe('docs')
      expect(states.at(-1)?.host.threads.find(t => t.id === states.at(-1)?.activeThreadId)?.title).toBe('Docs')
      expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs', 'workshop'])
      expect(f.control.get()).toMatchObject({ draftThreadId: 'workshop', draft: 'Only A', draftAttachments: [image] })
      expect(f.host.attempts).toEqual([])
    } finally { gate.resolve(before.host); await refresh; await select }
    expect(f.control.get().activeThreadId).toBe('docs')
    await f.control.command({ type: 'send' })
    expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'send', threadId: 'workshop', text: 'Only A' })])
    expect(f.control.get().activeThreadId).toBe('docs')
  })


  it('does not let creation completion bind its draft or selection to a newly selected thread', async () => {
    const f = await fixture()
    const gate = deferred<void>(); const original = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { await gate.promise; return original(command) })
    const creating = f.control.command({ type: 'create-thread', projectId: 'project', title: 'New A', modelId: 'claude:test' })
    await vi.waitFor(() => expect(f.host.execute).toHaveBeenCalled())
    const select = f.control.command({ type: 'select-thread', threadId: 'docs' })
    try { expect(f.control.get().activeThreadId).toBe('docs') }
    finally { gate.resolve(); await creating; await select }
    const created = f.control.get().host.threads.find(t => t.title === 'New A')!
    expect(f.control.get()).toMatchObject({ activeThreadId: 'docs', draftThreadId: null })
    await f.control.command({ type: 'manual-send', threadId: created.id, text: 'Only new A' })
    expect(f.host.attempts.at(-1)).toMatchObject({ type: 'send', threadId: created.id })
  })

  it('preserves selected project when an older project creation finishes', async () => {
    const f = await fixture()
    const gate = deferred<void>(); const original = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { await gate.promise; return original(command) })
    const creating = f.control.command({ type: 'create-project', title: 'New project', path: join(f.root, 'new-project') })
    await vi.waitFor(() => expect(f.host.execute).toHaveBeenCalled())
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    gate.resolve(); await creating
    expect(f.control.get()).toMatchObject({ activeThreadId: 'docs', activeProjectId: 'project' })
    expect(f.control.get().host.projects).toHaveLength(2)
  })

  it('does not let an older answer completion force selection back to its remaining queue item', async () => {
    const f = await fixture()
    for (const requestId of ['one', 'two']) f.host.event({ type: 'permission', threadId: 'workshop', requestId, text: 'Allow?' })
    const gate = deferred<void>(); const original = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { await gate.promise; return original(command) })
    const answering = f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'one', answer: 'Deny', approved: false })
    await vi.waitFor(() => expect(f.host.execute).toHaveBeenCalled())
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    gate.resolve(); await answering
    expect(f.control.get().activeThreadId).toBe('docs')
    expect(f.control.get().host.threads.find(t => t.id === 'workshop')?.requests).toEqual([expect.objectContaining({ id: 'two' })])
    expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'answer', threadId: 'workshop', requestId: 'one' })])
  })

  it('selects cached history while disconnected without granting action authority', async () => {
    const f = await fixture()
    await f.control.command({ type: 'disconnect' })
    expect(await f.control.command({ type: 'select-thread', threadId: 'docs' })).toMatchObject({ activeThreadId: 'docs', error: null, connection: 'disconnected' })
    expect(f.host.attempts).toEqual([])
  })
})

describe('setting aside unconfirmed sends', () => {
  it.each(['permission', 'question'] as const)('sets only the uncertain prompt aside while its later %s stays pending for the user', async kind => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Prompt with no confirmed echo' })
    f.host.event({ type: kind, threadId: 'workshop', requestId: 'pending-request', text: 'Answer this explicitly', status: 'running' })
    const result = await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    expect(result.error).toBeNull()
    expect(result.host.threads.find(thread => thread.id === 'workshop')!.requests).toHaveLength(1)
    expect(f.host.attempts.map(command => command.type)).toEqual(['send'])
    f.host.withheld = null
    const answered = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'pending-request', answer: kind === 'permission' ? 'Deny' : 'Next step', ...(kind === 'permission' ? { approved: false } : {}) })
    expect(answered.error).toBeNull()
    expect(answered.host.threads.find(thread => thread.id === 'workshop')!.requests).toEqual([])
    expect(f.host.attempts.map(command => command.type)).toEqual(['send', 'answer'])
  })

  it.each(['permission', 'question'] as const)('accepts an explicit new %s answer after recovery without replaying an old prompt', async kind => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Old uncertain prompt' })
    await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    f.host.withheld = null
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'New explicit turn' })
    f.host.event({ type: kind, threadId: 'workshop', requestId: 'new-request', text: 'The new turn needs an answer', status: 'running' })
    const command = { type: 'answer' as const, threadId: 'workshop', requestId: 'new-request', answer: kind === 'permission' ? 'Deny' : 'Next step', ...(kind === 'permission' ? { approved: false } : {}) }
    const result = await f.control.command(command)
    expect(result.error).toBeNull()
    expect(result.host.threads.find(thread => thread.id === 'workshop')!.requests).toEqual([])
    await f.control.command(command)
    expect(f.host.attempts.filter(command => command.type === 'answer')).toHaveLength(1)
    expect(f.host.attempts.filter(command => command.type === 'send')).toHaveLength(2)
    expect(result.deliveredDrafts).not.toContainEqual({ threadId: 'workshop', draftId })
  })

  it.each([false, true])('holds a concurrently admitted user queue behind recovery durability (failure %s)', async fail => {
    const f = await fixture(); const draftId = randomUUID(); f.host.withheld = 'uncertain'
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Old uncertain prompt' })
    f.host.withheld = null
    const entered = deferred<void>(); const gate = deferred<void>(); const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if ((value as { outbox?: { setAside?: boolean }[] }).outbox?.some(item => item.setAside)) {
        entered.resolve(); await gate.promise
        if (fail) throw new Error('Recovery failed')
      }
      return write.call(this, value)
    })
    const recovery = f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    await entered.promise
    const queue = f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'Explicit new user follow-up' })
    try {
      await vi.waitFor(() => expect(f.control.get().followups).toHaveLength(1))
      expect(f.host.attempts).toHaveLength(1)
    } finally { gate.resolve() }
    const result = await recovery; await queue
    if (fail) {
      expect(result.error).toMatch(/Could not save this recovery/)
      await f.control.command({ type: 'refresh' })
      expect(f.host.attempts).toHaveLength(1)
    } else {
      expect(result.error).toBeNull()
      await expect.poll(() => f.host.attempts.length).toBe(2)
      await expect.poll(() => f.control.get().followups?.length).toBe(0)
    }
  })

  it.each([false, true])('reads no provider history to set aside a prompt (missing main record %s)', async missing => {
    const f = await fixture(); const draftId = randomUUID()
    if (!missing) {
      f.host.withheld = 'uncertain'
      await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Unknown old prompt' })
    }
    const snapshots = vi.spyOn(f.host, 'snapshot')
    expect((await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })).error).toBeNull()
    expect(snapshots).not.toHaveBeenCalled()
    expect(f.host.attempts).toHaveLength(missing ? 0 : 1)
  })

  it.each([false, true])('publishes missing-send recovery only after its atomic write (failure %s)', async fail => {
    const f = await fixture(); const draftId = randomUUID(); const entered = deferred<void>(); const gate = deferred<void>()
    const states: AgentState[] = []; f.control.subscribe(state => states.push(state))
    const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if ((value as { deliveries?: { draftId: string; setAside?: boolean }[] }).deliveries?.some(item => item.draftId === draftId && item.setAside)) {
        entered.resolve(); await gate.promise
        if (fail) throw new Error('Recovery disk failure')
      }
      return write.call(this, value)
    })
    const recovery = f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    await entered.promise
    try {
      expect(states.some(state => state.deliveries?.some(item => item.draftId === draftId && item.setAside))).toBe(false)
      expect(f.control.get().deliveries?.some(item => item.draftId === draftId)).toBe(false)
    } finally { gate.resolve() }
    const result = await recovery
    if (fail) {
      expect(result.error).toMatch(/Could not save this recovery/)
      expect(result.deliveries?.some(item => item.draftId === draftId)).toBe(false)
      expect(result.obsoleteDrafts).not.toContainEqual({ threadId: 'workshop', draftId })
    } else {
      expect(result.error).toBeNull()
      expect(result.deliveries).toContainEqual(expect.objectContaining({ draftId, status: 'uncertain', setAside: true }))
    }
    vi.restoreAllMocks(); await f.restart()
    expect(f.control.get().deliveries?.some(item => item.draftId === draftId && item.setAside)).toBe(!fail)
    expect(f.host.attempts).toEqual([])
  })

  it('permits normal settings after recovery while keeping a different uncertain setting blocking', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Old uncertain prompt' })
    await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    f.host.withheld = null
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'high' })).error).toBeNull()
    f.host.withheld = 'uncertain'
    await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'low' })
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Must wait for settings' })
    expect(f.host.attempts.map(item => item.type)).toEqual(['send', 'configure-thread', 'configure-thread'])
    expect(f.control.get().deliveries).toContainEqual(expect.objectContaining({ draftId, status: 'uncertain', setAside: true }))
  })

  it('preserves a newer draft and its independent revision fence when missing-outbox recovery fails', async () => {
    const f = await fixture(); const draftId = randomUUID(); const newerId = randomUUID()
    await f.control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId, text: 'Old draft', requestId: null })
    const entered = deferred<void>(); const gate = deferred<void>(); const write = AtomicJsonStore.prototype.write
    let failRecovery = true
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (failRecovery && (value as { obsoleteDrafts?: { draftId: string }[] }).obsoleteDrafts?.some(item => item.draftId === draftId)) {
        failRecovery = false; entered.resolve(); await gate.promise; throw new Error('Recovery write failed')
      }
      return write.call(this, value)
    })
    const recovery = f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    await entered.promise
    try {
      await f.control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: newerId, text: 'Newer text', attachments: [image], requestId: null })
    } finally { gate.resolve() }
    expect((await recovery).error).toMatch(/Could not save this recovery/)
    expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ draftId: newerId, text: 'Newer text', attachments: [image] }))
    expect(f.control.get().obsoleteDrafts).toContainEqual({ threadId: 'workshop', draftId })
    expect(f.host.attempts).toEqual([])
  })

  it('lets a new explicit queue command pass a set-aside send without changing another thread', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID(); const otherDraftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Old A' })
    await f.control.command({ type: 'manual-send', threadId: 'docs', draftId: otherDraftId, text: 'Old B' })
    const result = await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    expect(result.error).toBeNull()
    expect(result.deliveries?.find(item => item.draftId === otherDraftId)?.setAside).not.toBe(true)
    f.host.withheld = null
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'Wait in the queue' })
    await f.control.command({ type: 'refresh' })
    await f.control.privacyChanged()
    await expect.poll(() => f.host.attempts.length).toBe(3)
    await expect.poll(() => f.control.get().followups?.length).toBe(0)
  })

  it('recovers an uncertain prompt delivery with missing outbox without inventing acceptance', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    const old = { type: 'manual-send' as const, threadId: 'workshop', draftId, text: 'Unknown with missing outbox' }
    await f.control.command(old)
    f.control.dispose(); await f.control.privacyChanged()
    const path = join(f.root, 'agents.json'); const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.outbox = []
    await writeFile(path, JSON.stringify(saved))
    await f.restart(); await f.control.command({ type: 'connect' })
    const result = await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    expect(result.error).toBeNull()
    expect(result.deliveries).toContainEqual(expect.objectContaining({ draftId, status: 'uncertain', setAside: true }))
    expect(result.obsoleteDrafts).toContainEqual({ threadId: 'workshop', draftId })
    await f.restart(); await f.control.command({ type: 'connect' })
    expect((await f.control.command(old)).error).toMatch(/revision/)
    expect(f.host.attempts).toHaveLength(1)
    expect(f.control.get().deliveredDrafts).not.toContainEqual({ threadId: 'workshop', draftId })
  })

  it('rolls back a missing-outbox tombstone when recovery cannot be saved', async () => {
    const f = await fixture(); const draftId = randomUUID(); const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if ((value as { obsoleteDrafts?: { draftId: string }[] }).obsoleteDrafts?.some(item => item.draftId === draftId)) throw new Error('Storage unavailable')
      return write.call(this, value)
    })
    const result = await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    expect(result.error).toMatch(/Could not save this recovery/)
    expect(result.obsoleteDrafts).not.toContainEqual({ threadId: 'workshop', draftId })
    expect(f.host.attempts).toEqual([])
  })

  it('preserves newer text and images and accepts a late exact native confirmation', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Old', attachments: [image] })
    const newer = { type: 'save-thread-draft' as const, threadId: 'workshop', draftId: randomUUID(), text: 'Keep newer', attachments: [handleOf(OTHER_PNG, 'replacement', 'same.png')], requestId: null }
    await f.control.command(newer)
    const wrongThread = await f.control.command({ type: 'set-aside-send', threadId: 'docs', draftId })
    expect(wrongThread.error).toMatch(/another thread/)
    expect(f.control.get().deliveries?.find(d => d.draftId === draftId)?.setAside).not.toBe(true)
    await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    await f.host.acknowledge()
    expect(f.control.get().deliveries).toContainEqual(expect.objectContaining({ threadId: 'workshop', draftId, status: 'accepted' }))
    expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ draftId: newer.draftId, text: newer.text, attachments: newer.attachments }))
    expect(f.host.attempts).toHaveLength(1)
  })

  it('rolls recovery back when storage fails and keeps a fresh send blocked', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Unknown' })
    const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if ((value as { outbox?: { setAside?: boolean }[] }).outbox?.some(item => item.setAside)) throw new Error('Storage unavailable')
      return write.call(this, value)
    })
    const result = await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    expect(result.error).toMatch(/Could not save this recovery/)
    expect(result.deliveries?.find(d => d.draftId === draftId)?.setAside).not.toBe(true)
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Still blocked' })
    expect(f.host.attempts).toHaveLength(1)
    const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))
    expect(saved.outbox[0].setAside).not.toBe(true)
    vi.restoreAllMocks()
    await f.restart()
    expect(f.control.get().deliveries?.find(d => d.draftId === draftId)?.setAside).not.toBe(true)
  })

  it('keeps recovery hidden and blocks fresh dispatch until its write is durable', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Unknown' })
    const gate = deferred<void>(); const entered = deferred<void>(); const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if ((value as { outbox?: { setAside?: boolean }[] }).outbox?.some(item => item.setAside)) { entered.resolve(); await gate.promise }
      return write.call(this, value)
    })
    const recovery = f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    await entered.promise
    let send: Promise<AgentState> | undefined
    try {
      expect(f.control.get().deliveries?.find(d => d.draftId === draftId)?.setAside).not.toBe(true)
      send = f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Not before durability' })
      expect(f.host.attempts).toHaveLength(1)
    } finally { gate.resolve(); await recovery; await send }
    expect(f.host.attempts).toHaveLength(1)
  })

  it.each(['manual-send', 'send'] as const)('refuses recovery during an in-flight %s admission', async type => {
    const f = await fixture(); const draftId = randomUUID(); const gate = deferred<AgentHostResult>(); const entered = deferred<void>()
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async () => { entered.resolve(); return gate.promise })
    const sending = f.control.command(type === 'manual-send'
      ? { type, threadId: 'workshop', draftId, text: 'In flight' }
      : { type, draft: { threadId: 'workshop', draftId, text: 'In flight', attachments: [] } })
    await entered.promise
    try {
      const result = await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
      expect(result.error).toMatch(/still submitting/)
      expect(result.deliveries?.find(d => d.draftId === draftId)?.setAside).not.toBe(true)
    } finally { gate.resolve({ accepted: false, uncertain: true }); await sending }
  })

  it('refuses recovery for queued follow-ups and uncertain answers', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Unknown' })
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'Queued' })
    expect((await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })).error).toMatch(/pending actions/)
    f.host.event({ type: 'permission', threadId: 'docs', requestId: 'permission', text: 'Allow?' })
    await f.control.command({ type: 'answer', threadId: 'docs', requestId: 'permission', answer: 'Deny', approved: false })
    expect((await f.control.command({ type: 'set-aside-send', threadId: 'docs', draftId: randomUUID() })).error).toMatch(/pending actions/)
    expect(f.host.attempts.map(item => item.type)).toEqual(['send', 'answer'])
  })

  it.each(['manual-send', 'send'] as const)('durably fences a lost-reply revision without claiming delivery (%s)', async type => {
    const f = await fixture(); const draftId = randomUUID()
    await f.control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId, text: 'Saved before a lost reply', attachments: [], requestId: null })
    const result = await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    expect(result.error).toBeNull()
    expect(result.obsoleteDrafts).toContainEqual({ threadId: 'workshop', draftId })
    expect(result.deliveredDrafts).not.toContainEqual({ threadId: 'workshop', draftId })
    expect(result.deliveries).toContainEqual(expect.objectContaining({ threadId: 'workshop', draftId, status: 'uncertain', setAside: true }))
    const evidence = result.deliveries!.find(item => item.draftId === draftId)!
    expect(evidence.messageId).toBeUndefined(); expect(evidence.commandId).toBeUndefined()
    const durable = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))
    expect(durable.deliveries).toContainEqual(expect.objectContaining({ draftId, status: 'uncertain', setAside: true }))
    await f.restart()
    expect(f.control.get().deliveries).toContainEqual(expect.objectContaining({ draftId, status: 'uncertain', setAside: true }))
    await f.control.command({ type: 'connect' })
    const replay = await f.control.command(type === 'manual-send'
      ? { type, threadId: 'workshop', draftId, text: 'Saved before a lost reply' }
      : { type, draft: { threadId: 'workshop', draftId, text: 'Saved before a lost reply', attachments: [] } })
    expect(replay.error).toMatch(/revision/)
    expect(f.host.attempts).toEqual([])
    expect((await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Fresh' })).error).toBeNull()
    expect(f.host.attempts).toHaveLength(1)
  })

  it('allows a fresh atomic Send while retaining the exact old packet against replay', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    const old = { type: 'send' as const, draft: { threadId: 'workshop', draftId, text: 'Atomic old', attachments: [] } }
    await f.control.command(old)
    await f.control.command({ type: 'set-aside-send', threadId: 'workshop', draftId })
    await f.restart(); await f.control.command({ type: 'connect' })
    expect((await f.control.command(old)).error).toMatch(/unknown result/)
    expect((await f.control.command({ ...old, draft: { ...old.draft, text: 'Changed replay' } })).error).toMatch(/revision/)
    f.host.withheld = null
    const fresh = await f.control.command({ type: 'send', draft: { threadId: 'workshop', draftId: randomUUID(), text: 'Fresh atomic', attachments: [] } })
    expect(fresh.error).toBeNull()
    expect(f.host.attempts).toHaveLength(2)
  })

  it('sets an uncertain prompt aside durably, permits a new explicit send and never replays the old revision', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'
    const draftId = randomUUID()
    const old = { type: 'manual-send' as const, threadId: 'workshop', draftId, text: 'Unconfirmed original', attachments: [image] }
    await f.control.command(old)
    const result = await f.control.command(agentCommandSchema.parse({ type: 'set-aside-send', threadId: 'workshop', draftId }))
    expect(result.error).toBeNull()
    expect(result.deliveries).toContainEqual(expect.objectContaining({ threadId: 'workshop', draftId, status: 'uncertain', setAside: true }))
    const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8'))
    const original = f.host.attempts[0]!
    if (original.type !== 'send') throw new Error('Missing original send')
    expect(saved.outbox[0]).toMatchObject({ draftId, setAside: true, messageId: original.messageId })
    expect(saved.outbox[0].draftDigest).toBeTruthy()
    expect(f.host.attempts).toHaveLength(1)
    await f.restart(); await f.control.command({ type: 'connect' })
    await f.control.command(old)
    expect(f.host.attempts).toHaveLength(1)
    f.host.withheld = null
    const fresh = await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'New explicit message' })
    expect(fresh.error).toBeNull()
    expect(f.host.attempts).toHaveLength(2)
    expect(fresh.deliveredDrafts).not.toContainEqual({ threadId: 'workshop', draftId })
  })
})

describe('manual delivery receipts', () => {
  it('preserves a foreign answer and images through uncertain manual delivery, restart, and acknowledgement', async () => {
    const f = await fixture()
    f.host.event({ type: 'question', threadId: 'workshop', requestId: 'question-a', text: 'Which color?' })
    await f.control.command({ type: 'compose', text: 'Keep this answer', attachments: [image] })
    const saved = f.control.get()
    expect(saved.draftRequestId).toBe('question-a')
    f.host.withheld = 'uncertain'
    const draftId = randomUUID()
    const result = await f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Only B', draftId })
    expect(result.error).toMatch(/confirm/)
    const expected = { draft: saved.draft, draftThreadId: saved.draftThreadId, draftRequestId: saved.draftRequestId, draftAttachments: saved.draftAttachments }
    expect(result).toMatchObject(expected)
    await f.restart()
    await f.host.acknowledge()
    expect(f.control.get()).toMatchObject({ ...expected, deliveredDrafts: [{ threadId: 'docs', draftId }] })
    await f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Only B', draftId })
    expect(f.host.attempts).toHaveLength(1)
  })

  it('accepts optional UUID identities and retains legacy callers', () => {
    const command = { type: 'manual-send', threadId: 'workshop', text: 'Hello' }
    expect(agentCommandSchema.safeParse(command).success).toBe(true)
    expect(agentCommandSchema.safeParse({ ...command, draftId: randomUUID() }).success).toBe(true)
    expect(agentCommandSchema.safeParse({ ...command, draftId: 'filename-text-size' }).success).toBe(false)
  })
  it.each(['normal', 'late', 'restart'] as const)('publishes an actual-message receipt on %s acknowledgement and never resends that revision', async path => {
    const f = await fixture(); const draftId = randomUUID()
    const command = { type: 'manual-send' as const, threadId: 'workshop', draftId, text: 'Look', attachments: [image] }
    if (path !== 'normal') f.host.withheld = 'uncertain'
    const state = await f.control.command(command)
    if (path !== 'normal') {
      expect(state.error).toMatch(/confirm/)
      expect(state.deliveredDrafts ?? []).toEqual([])
      expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox[0]).toMatchObject({ draftId })
      if (path === 'restart') await f.restart()
      await f.host.acknowledge()
    }
    expect(f.control.get().deliveredDrafts).toEqual([{ threadId: 'workshop', draftId }])
    expect(f.control.get()).toMatchObject({ draft: '', draftAttachments: [] })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'Done', status: 'idle' })
    await f.control.command(command)
    expect(f.host.attempts).toHaveLength(1)
    await f.restart()
    expect(f.control.get().deliveredDrafts).toEqual([{ threadId: 'workshop', draftId }])
    await f.control.command(command)
    expect(f.host.attempts).toHaveLength(1)
  })
  it('keeps an accepted response pending until the actual user message is visible', async () => {
    const f = await fixture(); f.host.withheld = 'accepted'; const draftId = randomUUID()
    const state = await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Hello' })
    expect(state.error).toMatch(/confirm/)
    expect(state.deliveredDrafts ?? []).toEqual([])
    expect(state.draft).toBe('Hello')
    await f.host.acknowledge()
    expect(f.control.get().deliveredDrafts).toEqual([{ threadId: 'workshop', draftId }])
  })
  it('keeps outbox targets observed after navigating away and after restart', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Hello' })
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs', 'workshop'])
    await f.restart()
    expect(f.host.observeThreads).toHaveBeenLastCalledWith(['docs', 'workshop'])
    await f.host.acknowledge()
    expect(f.control.get()).toMatchObject({ activeThreadId: 'docs', deliveredDrafts: [{ threadId: 'workshop', draftId }] })
  })
  it('reconciles receipts on startup from a snapshot without needing a provider event', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Hello' })
    f.control.dispose()
    await f.host.acknowledge()
    await f.restart()
    expect(f.control.get()).toMatchObject({ deliveredDrafts: [{ threadId: 'workshop', draftId }], draft: '' })
    expect(f.host.attempts).toHaveLength(1)
  })
  it('does not reconcile an assistant message with the expected ID or an unrelated identical user payload', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'; const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Hello' })
    const sent = f.host.attempts[0]!
    if (sent.type !== 'send') throw new Error('Missing send')
    const snapshot = await f.host.snapshot()
    snapshot.threads[0]!.messages.push({ id: sent.messageId, role: 'assistant', text: sent.text, createdAt: new Date().toISOString() },
      { id: 'unrelated', role: 'user', text: sent.text, createdAt: new Date().toISOString() })
    vi.spyOn(f.host, 'snapshot').mockResolvedValueOnce(snapshot)
    await f.control.command({ type: 'refresh' })
    expect(f.control.get()).toMatchObject({ deliveredDrafts: [], draft: 'Hello' })
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toHaveLength(1)
  })
  it.each(['text', 'image', 'identical replacement'] as const)('does not deliver or clear a %s edit on an earlier receipt', async edit => {
    const f = await fixture(); f.host.withheld = 'uncertain'
    const draftId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Look', attachments: [image] })
    const text = edit === 'text' ? 'Changed' : 'Look'
    // Same name, size, and attachment ID; changed bytes must remain an edit.
    const replacement = edit === 'image' ? handleOf(OTHER_PNG, 'image', 'same.png') : image
    await f.control.command({ type: 'compose', text, attachments: [replacement] })
    await f.host.acknowledge()
    expect(f.control.get()).toMatchObject({ draft: text, draftThreadId: 'workshop', draftAttachments: [replacement], deliveredDrafts: [{ threadId: 'workshop', draftId }] })
  })
  it('does not report a replacement UUID delivered when retry reconciles an older payload', async () => {
    const f = await fixture(); f.host.withheld = 'uncertain'
    const draftId = randomUUID(); const replacementId = randomUUID()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: 'Old' })
    const snapshot = await f.host.snapshot(); const sent = f.host.attempts[0]!
    if (sent.type !== 'send') throw new Error('Missing send')
    snapshot.threads[0]!.messages.push({ id: sent.messageId, role: 'user', text: sent.text, createdAt: new Date().toISOString() })
    vi.spyOn(f.host, 'snapshot').mockResolvedValueOnce(snapshot)
    await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: replacementId, text: 'Replacement' })
    expect(f.control.get().deliveredDrafts).toEqual([{ threadId: 'workshop', draftId }])
    expect(f.host.attempts).toHaveLength(1)
  })
  it('shows the prompt as Sending before its durable write finishes, and still writes the outbox before dispatch', async () => {
    const f = await fixture()
    const gate = deferred<void>()
    const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (outboxHasSend(value)) await gate.promise
      return write.call(this, value)
    })
    const states: AgentState[] = []; f.control.subscribe(state => states.push(state))
    const draftId = randomUUID()
    const sending = f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Appears at once', draftId })
    try {
      await vi.waitFor(() => expect(states.at(-1)?.deliveries).toContainEqual(expect.objectContaining({ threadId: 'docs', draftId, status: 'submitting' })))
      // Durability still gates the provider: the outbox entry is written before anything is dispatched.
      expect(f.host.attempts).toEqual([])
    } finally { gate.resolve(); await sending }
    expect(f.host.attempts.filter(command => command.type === 'send')).toHaveLength(1)
    expect(f.control.get().deliveredDrafts).toContainEqual({ threadId: 'docs', draftId })
  })

  it('marks the delivery failed and dispatches nothing when its durable write fails', async () => {
    const f = await fixture()
    const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (outboxHasSend(value)) throw new Error('Disk unavailable')
      return write.call(this, value)
    })
    const draftId = randomUUID()
    const result = await f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Never sent', draftId })
    // This write is the one that first saves a prompt sent at once, so it fails the way admission's does.
    expect(result.error).toBe('Could not save this prompt, so it was not sent. Check access to local storage and send it again.')
    expect(result.deliveries).toContainEqual(expect.objectContaining({ threadId: 'docs', draftId, status: 'failed' }))
    expect(f.host.attempts).toEqual([])
    expect(result.threadDrafts).toContainEqual(expect.objectContaining({ threadId: 'docs', draftId, text: 'Never sent' }))
  })

  it('bounds receipt history to 128 persisted identities', async () => {
    // Load a full durable history, then cross its retention boundary through real
    // sends. Recreating all 128 prior conversations only measures filesystem load.
    const ids = Array.from({ length: 128 }, () => randomUUID())
    const f = await fixture(ids)
    expect(f.control.get().deliveredDrafts).toHaveLength(128)
    for (let i = 0; i < 2; i++) {
      const draftId = randomUUID(); ids.push(draftId)
      await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId, text: `Prompt ${i}` })
      f.host.event({ type: 'ready', threadId: 'workshop', text: 'Done', status: 'idle' })
    }
    await f.control.privacyChanged()
    const receipts = ids.slice(-128).map(draftId => ({ threadId: 'workshop', draftId }))
    expect(f.control.get().deliveredDrafts).toEqual(receipts)
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).deliveredDrafts).toEqual(receipts)
    await f.restart(); expect(f.control.get().deliveredDrafts).toEqual(receipts)
  })
})
