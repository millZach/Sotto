// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { agentCommandSchema, type AgentHostSnapshot } from '../../../src/shared/agents'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import type { AgentReasoner } from '../../../src/main/agents/reasoning'

class WorkspaceHost extends E2EAgentHost {
  transform = (snapshot: AgentHostSnapshot): AgentHostSnapshot => snapshot
  attempts: AgentHostCommand[] = []
  unknown = false
  override async snapshot() { return this.transform(await super.snapshot()) }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(command)
    return this.unknown ? { accepted: false, uncertain: true } : super.execute(command)
  }
}
const fixtures: { root: string; control: AgentControl }[] = []
async function fixture(reasoner: AgentReasoner = e2eAgentReasoner) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-attention-workspace-'))
  const host = new WorkspaceHost()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: value => value.toString() })
  await credentials.load()
  const create = () => new AgentControl({ directory: root, host, credentials, reasoner, membership: {
    status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }),
  } })
  const f = { root, host, control: create(), async restart() { this.control.dispose(); this.control = create(); await this.control.start() } }
  fixtures.push(f)
  await f.control.start(); await f.control.command({ type: 'connect' })
  return f
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    f.control.dispose()
    if (dirname(resolve(f.root)) !== resolve(tmpdir()) || !f.root.includes('sotto-attention-workspace-')) throw new Error('Unexpected fixture path')
    await rm(f.root, { recursive: true, force: true })
  }
})

describe('workspace manual prompt authority and durable dispatch', () => {
  it('interrupts manually started unassigned work without granting management', async () => {
    const f = await fixture()
    await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Start work' })
    const result = await f.control.command({ type: 'interrupt', threadId: 'workshop' })
    expect(result.error).toBeNull()
    expect(f.host.attempts.at(-1)).toMatchObject({ type: 'interrupt', threadId: 'workshop' })
    expect(result.assignments).toEqual([])
    expect(result.host.threads[0]?.status).toBe('idle')
  })

  it('applies and persists spoken-reply mute while intent reasoning is still pending', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const intent = vi.fn(async () => { await gate; return { type: 'clarify', text: 'Clarification' } as const })
    const f = await fixture({ ...e2eAgentReasoner, intent })
    await f.control.command({ type: 'configure', patch: { speak: true } })
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    const pending = f.control.command({ type: 'utterance', text: 'Long reasoning' })
    let mute!: ReturnType<AgentControl['command']>
    try {
      await vi.waitFor(() => expect(intent).toHaveBeenCalled())
      mute = f.control.command({ type: 'configure', patch: { speak: false } })
      f.host.event({ type: 'manual', threadId: 'workshop', text: 'Direct takeover', status: 'idle' })
      expect(f.control.get()).toMatchObject({ busy: true, configuration: { speak: false }, voice: { action: 'stop-speaking' } })
      await mute
      expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).configuration.speak).toBe(false)
    } finally { release(); await pending; await mute }
  })
  it('reconciles a retry without dispatching twice, then allows a fresh prompt', async () => {
    const f = await fixture()
    f.host.event({ type: 'uncertain', threadId: 'workshop', text: '' })
    const command = { type: 'manual-send', threadId: 'workshop', text: 'Run once' } as const
    expect((await f.control.command(command)).error).toMatch(/confirm/)
    f.host.transform = snapshot => ({ ...snapshot, threads: snapshot.threads.map(thread => thread.id !== 'workshop' ? thread : {
      ...thread, status: 'idle',
    }) })
    const retry = await f.control.command(command)
    expect(f.host.attempts).toHaveLength(1)
    expect(retry.draft).toBe('')
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
    // An explicit subsequent action is a new prompt, even if its text is identical.
    expect((await f.control.command(command)).error).toBeNull()
    expect(f.host.attempts).toHaveLength(2)
  })

  it('does not overwrite the saved draft when a different prompt retries unresolved intent', async () => {
    const f = await fixture(); f.host.unknown = true
    await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Original uncertain prompt' })
    const result = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Replacement prompt' })
    expect(result.error).toMatch(/unknown result/)
    expect(result.draft).toBe('Original uncertain prompt')
    expect(f.host.attempts).toHaveLength(1)
  })

  it('preserves an edited draft when retry reconciliation confirms the older prompt', async () => {
    const f = await fixture()
    f.host.event({ type: 'uncertain', threadId: 'workshop', text: '' })
    await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Original prompt' })
    await f.control.command({ type: 'compose', text: 'Edited next prompt' })
    const result = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Replacement from stale caller' })
    expect(result.error).toBeNull()
    expect(result.draft).toBe('Edited next prompt')
    expect(result.draftThreadId).toBe('workshop')
    expect(f.host.attempts).toHaveLength(1)
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
  })
  it.each(['unassigned', 'manual'] as const)('sends an explicit prompt in %s mode without granting management', async mode => {
    const f = await fixture()
    if (mode === 'manual') {
      await f.control.command({ type: 'assign', threadId: 'workshop' })
      f.host.event({ type: 'manual', threadId: 'workshop', text: 'Taking over', status: 'idle' })
    }
    const result = await f.control.command(agentCommandSchema.parse({ type: 'manual-send', threadId: 'workshop', text: 'Run the focused tests' }))
    expect(result.error).toBeNull()
    expect(f.host.attempts).toContainEqual(expect.objectContaining({ type: 'send', threadId: 'workshop', text: 'Run the focused tests' }))
    expect(result.assignments.map(a => a.mode)).toEqual(mode === 'manual' ? ['manual'] : [])
    expect(result.draft).toBe('')
  })

  it('retains uncertain intent across restart and refuses a duplicate', async () => {
    const f = await fixture(); f.host.unknown = true
    const request = agentCommandSchema.parse({ type: 'manual-send', threadId: 'workshop', text: 'Keep this draft' })
    const result = await f.control.command(request)
    expect(result.error).toMatch(/confirm/)
    expect(result.draft).toBe('Keep this draft')
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toHaveLength(1)
    await f.restart()
    expect((await f.control.command(request)).error).toMatch(/unknown result/)
    expect(f.host.attempts).toHaveLength(1)
  })

  it.each(['permission', 'question', 'running', 'disconnected', 'closed', 'managed'] as const)('rejects a manual prompt when %s without sending or answering', async guard => {
    const f = await fixture()
    if (guard === 'permission' || guard === 'question') f.host.event({ type: guard, threadId: 'workshop', text: 'Explicit answer required' })
    if (guard === 'running') f.host.event({ type: 'manual', threadId: 'workshop', text: 'Working' })
    if (guard === 'managed') await f.control.command({ type: 'assign', threadId: 'workshop' })
    if (guard === 'disconnected') f.host.event({ type: 'disconnect', threadId: 'workshop', text: '' })
    if (guard === 'closed') f.host.transform = snapshot => ({ ...snapshot, threads: snapshot.threads.map(t => ({ ...t, archivedAt: new Date().toISOString() })) })
    const result = await f.control.command(agentCommandSchema.parse({ type: 'manual-send', threadId: 'workshop', text: 'Saved prompt' }))
    expect(result.error).not.toBeNull()
    expect(result.draft).toBe('Saved prompt')
    expect(f.host.attempts).toEqual([])
  })

  it('allows prompting an explicitly settled but unarchived thread', async () => {
    const f = await fixture()
    f.host.transform = snapshot => ({ ...snapshot, threads: snapshot.threads.map(t => ({ ...t, settledOverride: 'settled' })) })
    const result = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Start the next task' })
    expect(result.error).toBeNull()
    expect(f.host.attempts).toHaveLength(1)
    expect(result.assignments).toEqual([])
  })

  it('rechecks a permission arriving during the durable dispatch write', async () => {
    const f = await fixture()
    const original = AtomicJsonStore.prototype.write
    let injected = false
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value) {
      await original.call(this, value)
      if (!injected && (value as { outbox?: unknown[] }).outbox?.length) {
        injected = true
        f.host.event({ type: 'permission', threadId: 'workshop', requestId: 'late', text: 'Allow late request?' })
      }
    })
    const result = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Retain this prompt' })
    expect(result.error).toMatch(/pending question or permission/)
    expect(f.host.attempts).toEqual([])
    expect(result.host.threads[0]?.requests).toHaveLength(1)
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
  })

  it('rejects overlapping manual actions instead of queuing a second dispatch', async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementation(async command => { await gate; return original(command) })
    const first = f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'First task' })
    await vi.waitFor(() => expect(f.host.execute).toHaveBeenCalled())
    const second = f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Second task' })
    release(); await first
    expect((await second).error).toMatch(/still in progress/)
    expect(f.host.attempts).toHaveLength(1)
  })

  it('preserves a different thread draft', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    await f.control.command({ type: 'compose', text: 'Original draft' })
    const result = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Different draft' })
    expect(result.error).toMatch(/existing draft/)
    expect(result.draft).toBe('Original draft')
    expect(result.draftThreadId).toBe('docs')
    expect(f.host.attempts).toEqual([])
  })

  it('answers a pending permission explicitly on an unassigned thread without granting management', async () => {
    const f = await fixture()
    f.host.event({ type: 'permission', threadId: 'workshop', requestId: 'allow', text: 'Allow this operation?' })
    const result = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'allow', answer: 'No', approved: false })
    expect(result.error).toBeNull()
    expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'answer', approved: false })])
    expect(result.assignments).toEqual([])
  })
})

describe('attention snapshot lifecycle', () => {
  it('rejects a stale reviewed item without changing selection or resolving another request', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    f.host.event({ type: 'permission', threadId: 'workshop', requestId: 'a', text: 'Request a' })
    const before = f.control.get()
    const result = await f.control.command({ type: 'select-attention', itemId: 'missing' })
    expect(result.error).toMatch(/no longer pending/)
    expect(result.activeThreadId).toBe(before.activeThreadId)
    expect(result.queue).toEqual(before.queue)
    expect(f.host.attempts).toEqual([])
  })
  it.each(['permission', 'question'] as const)('binds a reviewed second %s to spoken actions on the same thread', async kind => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'pause', threadId: 'workshop' })
    for (const requestId of ['a', 'b']) f.host.event({ type: kind, threadId: 'workshop', requestId, text: `Request ${requestId}` })
    const item = f.control.get().queue.find(entry => entry.requestId === 'b')!
    const selected = await f.control.command(agentCommandSchema.parse({ type: 'select-attention', itemId: item.id }))
    expect(selected.error).toBeNull()
    expect(selected.queue[0]?.requestId).toBe('b')
    expect(f.host.attempts).toEqual([])
    const spoken = await f.control.command({ type: 'utterance', text: kind === 'permission' ? 'allow' : 'My second answer' })
    if (kind === 'question') {
      expect(spoken.draftRequestId).toBe('b')
      await f.control.command({ type: 'send' })
    }
    expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'answer', requestId: 'b' })])
    expect(f.control.get().host.threads.find(thread => thread.id === 'workshop')?.requests.map(request => request.id)).toEqual(['a'])
  })
  it.each(['archivedAt', 'settledAt'] as const)('suppresses an obsolete permission after %s without answering it', async field => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    f.host.event({ type: 'permission', threadId: 'workshop', requestId: 'allow', text: 'Allow this operation?' })
    expect(f.control.get().queue).toHaveLength(1)
    f.host.transform = snapshot => ({ ...snapshot, threads: snapshot.threads.map(thread => ({ ...thread, [field]: new Date().toISOString() })) })
    const result = await f.control.command({ type: 'refresh' })
    expect(result.queue).toEqual([])
    expect(result.host.threads[0]?.requests).toHaveLength(1)
    expect(result.speech.text).toBe('')
    expect(result.voice.action).toBe('stop-speaking')
    expect(f.host.attempts).toEqual([])
  })

  it('does not narrate restored attention again after reconnect and selection', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    f.host.event({ type: 'permission', threadId: 'workshop', requestId: 'allow', text: 'Allow this operation?' })
    await f.control.command({ type: 'refresh' })
    await f.restart()
    const speech = f.control.get().speech.id
    const result = await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    expect(result.queue).toHaveLength(1)
    expect(result.speech.id).toBe(speech)
  })

  it.each(['closed', 'settled', 'missing', 'running'] as const)('prunes %s attention without replaying narration', async lifecycle => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'Please review', status: 'idle' })
    expect(f.control.get().queue).toHaveLength(1)
    const speech = f.control.get().speech.id
    f.host.transform = snapshot => ({ ...snapshot, threads: snapshot.threads.flatMap(t => t.id !== 'workshop' ? [t] : lifecycle === 'missing' ? [] : [{ ...t,
      ...(lifecycle === 'closed' ? { archivedAt: new Date().toISOString() } : lifecycle === 'settled' ? { settledOverride: 'settled' as const } : { status: 'running' as const }),
    }]) })
    const state = await f.control.command({ type: 'refresh' })
    expect(state.queue).toEqual([])
    expect(state.speech.id).toBe(speech)
  })

  it('keeps a live permission on an idle thread and does not renarrate it on repeated selection', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    f.host.event({ type: 'permission', threadId: 'workshop', text: 'Allow this?', requestId: 'permission' })
    const before = f.control.get()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    const state = await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    expect(state.queue).toEqual(before.queue)
    expect(state.speech.id).toBe(before.speech.id)
    expect(f.host.attempts).toEqual([])
  })
})

describe.each(['send', 'answer'] as const)('supervision %s authority at the durable dispatch boundary', action => {
  it.each(['pause', 'permission', 'closed', 'takeover', 'running', 'unassign', 'disconnect'] as const)('does not dispatch if %s arrives during the outbox write', async change => {
    const f = await fixture({ ...e2eAgentReasoner, decide: async () => ({ decision: 'followup', text: 'Automatic next step' }) })
    await f.control.command({ type: 'configure', patch: { reasoning: 'openai' } })
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix failures' })
    const original = AtomicJsonStore.prototype.write
    let injected = false
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value) {
      await original.call(this, value)
      if (injected || !(value as { outbox?: unknown[] }).outbox?.length) return
      injected = true
      if (change === 'pause' || change === 'unassign') await f.control.command({ type: change, threadId: 'workshop' })
      else if (change === 'disconnect') f.host.event({ type: 'disconnect', threadId: 'workshop', text: '' })
      else if (change === 'permission') f.host.event({ type: 'permission', threadId: 'workshop', requestId: 'late', text: 'Allow late request?' })
      else if (change === 'takeover') f.host.event({ type: 'manual', threadId: 'workshop', text: 'Direct takeover', status: 'idle' })
      else {
        f.host.transform = snapshot => ({ ...snapshot, threads: snapshot.threads.map(thread => thread.id !== 'workshop' ? thread : {
          ...thread, ...(change === 'closed' ? { archivedAt: new Date().toISOString() } : { status: 'running' as const, requests: [] }),
        }) })
        await f.control.command({ type: 'refresh' })
      }
    })
    f.host.event({ type: action === 'send' ? 'failure' : 'question', requestId: 'original-question', threadId: 'workshop', text: 'Needs fixing', status: 'idle' })
    await vi.waitFor(() => expect(injected).toBe(true))
    await vi.waitFor(() => expect((f.control as unknown as { deciding: Set<string> }).deciding.size).toBe(0))
    expect(f.host.attempts).toEqual([])
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
    if (change === 'permission') expect(f.control.get().host.threads[0]?.requests.some(request => request.id === 'late')).toBe(true)
  })
})
