// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectWithinBudget } from '../../fixtures/perfBudget'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { agentCommandSchema, agentStateSchema, type AgentAttachment, type AgentState } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  vi.restoreAllMocks()
  for (const control of controls) { control.dispose(); await control.privacyChanged() }
  controls.clear()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-thread-drafts-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})
const image: AgentAttachment = { id: 'image', name: 'pixel.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
class DraftHost extends E2EAgentHost {
  attempts: AgentHostCommand[] = []
  gate: Promise<void> | undefined
  result: AgentHostResult | undefined
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(command)
    await this.gate
    return this.result ?? super.execute(command)
  }
  async acknowledge() { await super.execute(this.attempts.at(-1)!) }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-thread-drafts-')); roots.push(root)
  const host = new DraftHost()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  let history = true
  const create = () => {
    const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner, historyEnabled: () => history,
      membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
    controls.add(control); return control
  }
  let control = create()
  await control.start(); await control.command({ type: 'connect' })
  const disk = async () => JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'))
  return { root, host, disk, get control() { return control }, disableHistory() { history = false },
    async restart(transform?: (saved: Awaited<ReturnType<typeof disk>>) => void) {
      control.dispose(); await control.privacyChanged(); controls.delete(control)
      if (transform) { const saved = await disk(); transform(saved); await writeFile(join(root, 'agents.json'), JSON.stringify(saved)) }
      control = create(); await control.start()
    },
  }
}
const save = (threadId: string, text: string, attachments: AgentAttachment[] = [], draftId = randomUUID()) =>
  ({ type: 'save-thread-draft' as const, threadId, draftId, text, attachments })
const send = (draft: ReturnType<typeof save>) => ({ ...draft, type: 'manual-send' as const })

describe('persistent per-thread drafts', () => {
  it('shows the saved manual draft on management handoff and preserves edits after release and restart', async () => {
    const f = await fixture()
    const skills = [{ name: 'build', path: 'C:/synthetic/SKILL.md' }]
    const draft = { ...save('docs', '$build Unsent manual draft', [image]), skills }
    await f.control.command(draft)
    await f.control.command({ type: 'assign', threadId: 'docs' })
    expect(f.control.get()).toMatchObject({ draft: draft.text, draftThreadId: 'docs', draftAttachments: [image] })
    await f.control.command({ type: 'compose', text: 'Unsent manual draft with managed edit' })
    await f.control.command({ type: 'unassign', threadId: 'docs' })
    const edited = f.control.get().threadDrafts?.find(item => item.threadId === 'docs')
    expect(edited).toMatchObject({ text: 'Unsent manual draft with managed edit', attachments: [image], skills })
    expect(edited?.draftId).not.toBe(draft.draftId)
    await f.restart()
    expect(f.control.get().threadDrafts).toContainEqual(edited)
    expect(f.host.attempts).toEqual([])
  })

  it('keeps a foreign draft with its owner when another thread enters managed mode', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Workshop draft', attachments: [image] })
    const foreign = f.control.get().threadDrafts?.find(item => item.threadId === 'workshop')
    const docs = save('docs', 'Docs draft')
    await f.control.command(docs)
    await f.control.command({ type: 'assign', threadId: 'docs' })
    expect(f.control.get()).toMatchObject({ draft: 'Workshop draft', draftThreadId: 'workshop', draftAttachments: [image] })
    expect(f.control.get().threadDrafts).toContainEqual(foreign)
    expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ draftId: docs.draftId, text: docs.text }))
  })

  it('restores independent text and exact attachment bytes across navigation, disconnect and restart', async () => {
    const f = await fixture()
    const a = save('workshop', 'A\nwith newline', [image]); const b = save('docs', '', [{ ...image, dataUrl: 'data:image/png;base64,d29ybGQ=' }])
    await f.control.command(a); await f.control.command({ type: 'select-thread', threadId: 'docs' })
    await f.control.command({ type: 'disconnect' }); await f.control.command(b)
    await f.restart()
    expect(f.control.get().threadDrafts).toEqual([a, b].map(draft => expect.objectContaining({ threadId: draft.threadId, draftId: draft.draftId, text: draft.text, attachments: draft.attachments })))
    expect(f.control.get().assignments).toEqual([])
    expect(f.host.attempts).toEqual([])
    expect(f.control.get().threadDraftPersistence).toEqual([a, b].map(draft => ({ threadId: draft.threadId, draftId: draft.draftId, status: 'saved' })))
    expect(await f.disk()).not.toHaveProperty('threadDraftPersistence')
    expect(agentStateSchema.safeParse(f.control.get()).success).toBe(true)
  })

  it('initializes evidence from disk even if the startup rewrite fails, ignoring serialized evidence', async () => {
    const f = await fixture()
    const draft = save('workshop', 'Already on disk', [image])
    await f.control.command(draft)
    await expect(f.restart(saved => {
      Object.assign(saved, { threadDraftPersistence: [{ threadId: 'workshop', draftId: randomUUID(), status: 'saved' }] })
      const original = AtomicJsonStore.prototype.write
      vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function(this: AtomicJsonStore<unknown>, value) {
        if ('threadDrafts' in (value as object)) return Promise.reject(new Error('Startup rewrite failed'))
        return original.call(this, value)
      })
    })).rejects.toThrow('Startup rewrite failed')
    expect(f.control.get().threadDraftPersistence).toEqual([{ threadId: 'workshop', draftId: draft.draftId, status: 'saved' }])
    expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ text: draft.text, attachments: [image] }))
  })

  it('migrates a legacy native answer under its original owner and request, never current selection', async () => {
    const f = await fixture()
    await f.restart(saved => {
      delete saved.threadDrafts; delete saved.deliveries
      saved.draft = 'Original answer'; saved.draftAttachments = [image]; saved.draftThreadId = 'workshop'
      saved.draftRequestId = 'original-question'; saved.activeThreadId = 'docs'; saved.composing = true; saved.manualDraftId = null
    })
    const draft = f.control.get().threadDrafts![0]!
    expect(draft).toMatchObject({ threadId: 'workshop', requestId: 'original-question', text: 'Original answer', attachments: [image] })
    await f.control.command({ type: 'connect' }); await f.control.command(save('docs', 'Independent B'))
    expect(f.control.get()).toMatchObject({ draftThreadId: 'workshop', draftRequestId: 'original-question', draft: 'Original answer' })
    await f.restart()
    expect(f.control.get().threadDrafts).toContainEqual(draft)
  })

  it('does not bind an unbound retired-provider recovery draft to a native thread', async () => {
    const f = await fixture()
    await f.restart(saved => { saved.configuration.provider = 't3'; saved.draft = 'Retired draft'; saved.draftThreadId = 'old-native-id'; saved.activeThreadId = 'docs'; saved.composing = true })
    expect(f.control.get()).toMatchObject({ draft: 'Retired draft', draftThreadId: null, threadDrafts: [] })
    expect(f.host.attempts).toEqual([])
  })

  it('saves edits outside blocked provider work without changing selection or authority', async () => {
    const f = await fixture(); const gate = deferred<AgentState['host']>()
    const previous = f.control.get()
    vi.spyOn(f.host, 'snapshot').mockReturnValueOnce(gate.promise)
    const refresh = f.control.command({ type: 'refresh' })
    await vi.waitFor(() => expect(f.control.get().busy).toBe(true))
    try {
      await f.control.command(save('docs', 'Saved during discovery', [image]))
      expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: 'docs', text: 'Saved during discovery', attachments: [image] }))
      expect(f.control.get()).toMatchObject({ activeThreadId: previous.activeThreadId, assignments: previous.assignments })
    } finally { gate.resolve(previous.host); await refresh }
  })

  it('clears only the explicitly targeted draft and rejects invalid attachment payloads', async () => {
    const f = await fixture(); await f.control.command(save('workshop', 'A', [image])); await f.control.command(save('docs', 'B'))
    await f.control.command(save('workshop', ''))
    await f.restart()
    expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ threadId: 'docs', text: 'B' })])
    expect(agentCommandSchema.safeParse(save('docs', 'Bad', [{ ...image, dataUrl: 'file:///secret' }])).success).toBe(false)
  })

  it('keeps managed compose revisions and clears in sync with the per-thread draft', async () => {
    const f = await fixture(); await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command(save('workshop', 'Earlier text', [image]))
    await f.control.command({ type: 'compose', text: 'Managed edit' })
    expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ threadId: 'workshop', text: 'Managed edit', attachments: [image] })])
    await f.control.command({ type: 'compose', text: '', attachments: [] }); await f.restart()
    expect(f.control.get().threadDrafts).toEqual([])
  })

  it('does not convert a saved answer into a manual prompt or grant management authority', async () => {
    const f = await fixture(); const answer = { ...save('workshop', 'Answer remains'), requestId: 'question-a' }
    await f.control.command(answer)
    expect((await f.control.command(save('workshop', 'Replace answer'))).error).not.toBeNull()
    expect((await f.control.command(send(save('workshop', 'Manual prompt')))).error).not.toBeNull()
    expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ draftId: answer.draftId, requestId: 'question-a', text: 'Answer remains' })])
    expect(f.control.get().assignments).toEqual([]); expect(f.host.attempts).toEqual([])
  })

  it.each([false, true])('clears a submitted per-thread answer while preserving a newer revision (%s)', async edit => {
    const f = await fixture(); f.host.event({ type: 'question', threadId: 'workshop', requestId: 'question', text: 'Which color?' })
    const draft = { ...save('workshop', 'Blue'), requestId: 'question' }; await f.control.command(draft)
    const gate = deferred<void>(); f.host.gate = gate.promise
    const pending = f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'question', answer: 'Blue' })
    await vi.waitFor(() => expect(f.host.attempts).toHaveLength(1))
    try { if (edit) await f.control.command({ ...save('workshop', 'Green'), requestId: 'question' }) }
    finally { gate.resolve(); await pending }
    await f.restart()
    expect(f.control.get().threadDrafts).toEqual(edit ? [expect.objectContaining({ text: 'Green', requestId: 'question' })] : [])
  })

  it('retains unsent work with history disabled and stores only metadata for accepted deliveries', async () => {
    const f = await fixture(); f.disableHistory()
    await f.control.command(save('docs', 'private unsent', [image]))
    await f.control.command(send(save('workshop', 'private sent')))
    await f.restart()
    const disk = await f.disk()
    expect(disk.threadDrafts).toEqual([expect.objectContaining({ threadId: 'docs', text: 'private unsent', attachments: [image] })])
    expect(JSON.stringify(disk)).not.toContain('private sent')
    expect(JSON.stringify(disk.deliveries)).not.toContain('private unsent')
  })
})

describe('truthful durable draft delivery', () => {
  it('publishes local queued feedback before provider latency and durably records submitting before dispatch', async () => {
    const f = await fixture(); const gate = deferred<void>(); f.host.gate = gate.promise
    const draft = save('workshop', 'Timing fixture', [image]); const samples: { status: string; ms: number }[] = []
    const started = performance.now()
    f.control.subscribe(state => { const delivery = state.deliveries?.find(item => item.draftId === draft.draftId); if (delivery) samples.push({ status: delivery.status, ms: performance.now() - started }) })
    const pending = f.control.command(send(draft))
    expect(samples[0]).toMatchObject({ status: 'queued' })
    expectWithinBudget(samples[0]!.ms, 100, 'publishing queued feedback for a send')
    try {
      await vi.waitFor(() => expect(f.host.attempts).toHaveLength(1))
      expect((await f.disk()).deliveries).toEqual([expect.objectContaining({ draftId: draft.draftId, status: 'submitting' })])
      expect(f.control.get().threadDrafts).toContainEqual(expect.objectContaining({ draftId: draft.draftId }))
    } finally { gate.resolve(); await pending }
    const delivery = f.control.get().deliveries![0]!
    expect(delivery.status).toBe('accepted')
    expect(delivery.providerLatencyMs).toBeGreaterThan(delivery.localFeedbackMs!)
    expect(f.control.get().threadDrafts).toEqual([])
    process.stdout.write(`Windows backend send timing (ms): ${JSON.stringify({ observedLocalFeedbackMs: samples[0]!.ms, localFeedbackMs: delivery.localFeedbackMs, providerLatencyMs: delivery.providerLatencyMs })}\n`)
  })

  it.each(['uncertain', 'accepted-without-echo'] as const)('reconciles %s across restart without replay and retains a newer revision', async outcome => {
    const f = await fixture(); const old = save('workshop', 'Same text', [image])
    f.host.result = outcome === 'uncertain' ? { accepted: false, uncertain: true } : { accepted: true }
    await f.control.command(send(old))
    expect(f.control.get().deliveries![0]!.status).toBe('uncertain')
    const newer = save('workshop', 'Same text', [image]); await f.control.command(newer)
    await f.restart(); await f.control.command({ type: 'connect' })
    await f.control.command(send(old)); expect(f.host.attempts).toHaveLength(1)
    await f.host.acknowledge(); await f.control.privacyChanged()
    expect(f.control.get().deliveries![0]!.status).toBe('accepted')
    expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ draftId: newer.draftId })])
    await f.control.command(send(old)); expect(f.host.attempts).toHaveLength(1)
    await f.restart()
    expect(f.control.get().deliveries![0]!.status).toBe('accepted')
  })

  it('coalesces duplicate in-flight submission IDs and preserves edits made before the old provider call completes', async () => {
    const f = await fixture(); const gate = deferred<void>(); f.host.gate = gate.promise
    const draft = save('workshop', 'First'); const pending = f.control.command(send(draft))
    const duplicate = f.control.command(send(draft)); expect(duplicate).toBe(pending)
    await vi.waitFor(() => expect(f.host.attempts).toHaveLength(1))
    const newer = save('workshop', 'Next', [image])
    try { await f.control.command(newer) } finally { gate.resolve(); await pending }
    expect(f.control.get().threadDrafts).toEqual([expect.objectContaining({ draftId: newer.draftId, text: 'Next', attachments: [image] })])
    expect(f.host.attempts).toHaveLength(1)
    await f.control.command({ ...draft, type: 'save-thread-draft' })
    expect(f.control.get().threadDrafts![0]!.draftId).toBe(newer.draftId)
  })

  it.each(['disconnected', 'managed', 'rejected'] as const)('reports %s as failed, keeps the complete draft before dispatch', async condition => {
    const f = await fixture()
    if (condition === 'disconnected') await f.control.command({ type: 'disconnect' })
    if (condition === 'managed') await f.control.command({ type: 'assign', threadId: 'workshop' })
    if (condition === 'rejected') f.host.result = { accepted: false }
    const count = f.host.attempts.length; const draft = save('workshop', 'Keep me', [image])
    const result = await f.control.command(send(draft))
    expect(result.error).not.toBeNull(); expect(result.deliveries!.at(-1)!.status).toBe('failed')
    expect(result.threadDrafts).toContainEqual(expect.objectContaining({ text: 'Keep me', attachments: [image] }))
    expect(f.host.attempts).toHaveLength(count + (condition === 'rejected' ? 1 : 0))
    expect((await f.disk()).outbox).toEqual([])
  })

  it('fails an interrupted local queue on restart without auto-submission', async () => {
    const f = await fixture(); const draft = save('workshop', 'Not dispatched', [image]); await f.control.command(draft)
    await f.restart(saved => { saved.deliveries = [{ threadId: draft.threadId, draftId: draft.draftId, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] })
    expect(f.control.get().deliveries![0]!.status).toBe('failed')
    expect(f.control.get().threadDrafts![0]!.draftId).toBe(draft.draftId)
    expect(f.host.attempts).toEqual([])
  })

  it('restores durable submitting intent as uncertain and never sends it again', async () => {
    const f = await fixture(); const draft = save('workshop', 'May have dispatched', [image]); f.host.result = { accepted: false, uncertain: true }
    await f.control.command(send(draft))
    await f.restart(saved => { saved.deliveries[0].status = 'submitting' })
    expect(f.control.get().deliveries![0]!.status).toBe('uncertain')
    await f.control.command({ type: 'connect' }); await f.control.command(send(draft))
    expect(f.host.attempts).toHaveLength(1)
  })

  it('migrates legacy pending sends without a revision and reconciles their exact original message', async () => {
    const f = await fixture(); const draft = save('workshop', 'Legacy pending')
    f.host.result = { accepted: false, uncertain: true }; await f.control.command(send(draft))
    await f.restart(saved => {
      delete saved.threadDrafts; delete saved.deliveries; saved.manualDraftId = null
      delete saved.outbox[0].draftId; delete saved.outbox[0].draftDigest
    })
    expect(f.control.get().deliveries![0]!.status).toBe('uncertain')
    await f.control.command({ type: 'connect' }); await f.host.acknowledge()
    expect(f.control.get().deliveries![0]!.status).toBe('accepted')
    expect(f.control.get().threadDrafts).toEqual([]); expect(f.control.get().draft).toBe('')
    expect(f.host.attempts).toHaveLength(1)
  })

  it.each(['admission', 'outbox'] as const)('does not dispatch or leave phantom uncertain intent when %s persistence fails', async stage => {
    const f = await fixture(); const original = AtomicJsonStore.prototype.write
    const spy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function(this: AtomicJsonStore<unknown>, value) {
      const state = value as { outbox?: unknown[] }
      if (stage === 'admission' || state.outbox?.length) return Promise.reject(new Error('Synthetic disk failure'))
      return original.call(this, value)
    })
    const draft = save('workshop', 'Recover locally', [image]); const result = await f.control.command(send(draft))
    expect(result.deliveries![0]!.status).toBe('failed'); expect(result.error).not.toBeNull()
    expect(f.host.attempts).toEqual([])
    expect(result.threadDrafts![0]!.draftId).toBe(draft.draftId)
    spy.mockRestore(); await f.control.privacyChanged()
    expect((await f.disk()).outbox).toEqual([])
    expect((await f.control.command(send(draft))).deliveries![0]!.status).toBe('accepted')
    expect(f.host.attempts).toHaveLength(1)
  })
})

describe('state publication cost', () => {
  // Every publish copies and sends every thread's full history, so writes that change no
  // renderer-visible evidence must not publish again once they complete.
  async function settledWrites(writes: Promise<void>[]) {
    while (writes.length) await Promise.allSettled(writes.splice(0))
    await new Promise(resolve => setImmediate(resolve))
  }
  function recordWrites() {
    const writes: Promise<void>[] = []
    const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
      const pending = write.call(this, value); writes.push(pending); return pending
    })
    return writes
  }

  it('publishes a host update once when its write leaves draft evidence unchanged', async () => {
    const f = await fixture()
    const draft = save('workshop', 'Already saved')
    await f.control.command(draft)
    const writes = recordWrites(); await settledWrites(writes)
    const published: AgentState[] = []
    f.control.subscribe(state => published.push(state))
    f.host.event({ type: 'stream', threadId: 'docs', messageId: 'streaming', text: 'First delta', status: 'running' })
    await settledWrites(writes)
    expect(published).toHaveLength(1)
    // The broadcast is the shell, so the streamed text reaches listeners as the thread's summary.
    expect(published[0]!.host.threads.find(thread => thread.id === 'docs')!.summary!.lastAssistant!.text).toBe('First delta')
    expect(published[0]!.threadDraftPersistence).toEqual([{ threadId: 'workshop', draftId: draft.draftId, status: 'saved' }])
  })

  it('still publishes completed draft evidence to listeners that received no command response', async () => {
    const f = await fixture()
    const writes = recordWrites()
    const published: AgentState[] = []
    f.control.subscribe(state => published.push(state))
    const draft = save('workshop', 'Confirm me', [image])
    const response = f.control.command(draft)
    await settledWrites(writes); await response; await settledWrites(writes)
    expect(published.at(-1)!.threadDraftPersistence).toEqual([{ threadId: 'workshop', draftId: draft.draftId, status: 'saved' }])
  })

  it('reads configuration without copying thread histories or exposing internal state', async () => {
    const f = await fixture()
    const configuration = f.control.configuration()
    expect(configuration).toEqual(f.control.get().configuration)
    configuration.provider = configuration.provider === 'codex' ? 'claude' : 'codex'
    expect(f.control.get().configuration).not.toEqual(configuration)
  })
})
