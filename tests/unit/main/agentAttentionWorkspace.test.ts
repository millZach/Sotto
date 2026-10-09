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
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

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
  const create = () => new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner, })
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
    expect(result).not.toHaveProperty('assignments')
    expect(result.host.threads[0]?.status).toBe('idle')
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
      f.host.event({ type: 'manual', threadId: 'workshop', text: 'Taking over', status: 'idle' })
    }
    const result = await f.control.command(agentCommandSchema.parse({ type: 'manual-send', threadId: 'workshop', text: 'Run the focused tests' }))
    expect(result.error).toBeNull()
    expect(f.host.attempts).toContainEqual(expect.objectContaining({ type: 'send', threadId: 'workshop', text: 'Run the focused tests' }))
    expect(result).not.toHaveProperty('assignments')
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

  it.each(['permission', 'question', 'disconnected', 'closed'] as const)('rejects a manual prompt when %s without sending or answering', async guard => {
    const f = await fixture()
    if (guard === 'permission' || guard === 'question') f.host.event({ type: guard, threadId: 'workshop', text: 'Explicit answer required' })
    if (guard === 'disconnected') f.host.event({ type: 'disconnect', threadId: 'workshop', text: '' })
    if (guard === 'closed') f.host.transform = snapshot => ({ ...snapshot, threads: snapshot.threads.map(t => ({ ...t, archivedAt: new Date().toISOString() })) })
    const result = await f.control.command(agentCommandSchema.parse({ type: 'manual-send', threadId: 'workshop', text: 'Saved prompt' }))
    expect(result.error).not.toBeNull()
    expect(result.draft).toBe('Saved prompt')
    expect(f.host.attempts).toEqual([])
  })

  it('durably queues a running manual prompt without dispatching before completion', async () => {
    const f = await fixture()
    f.host.event({ type: 'manual', threadId: 'workshop', text: 'Working' })
    const result = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Next prompt' })
    expect(result.error).toBeNull()
    expect(result.followups).toEqual([expect.objectContaining({ threadId: 'workshop', text: 'Next prompt', status: 'queued' })])
    expect(JSON.parse(await readFile(join(f.root, 'followups.json'), 'utf8')).items).toEqual(result.followups)
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([])
    await f.restart(); await f.control.command({ type: 'connect' })
    expect(f.control.get().followups).toEqual(result.followups)
    expect(f.host.attempts).toEqual([])
  })

  it('allows prompting an explicitly settled but unarchived thread', async () => {
    const f = await fixture()
    f.host.transform = snapshot => ({ ...snapshot, threads: snapshot.threads.map(t => ({ ...t, settledOverride: 'settled' })) })
    const result = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Start the next task' })
    expect(result.error).toBeNull()
    expect(f.host.attempts).toHaveLength(1)
    expect(result).not.toHaveProperty('assignments')
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

  it('allows a different thread to send while the first manual acknowledgement is pending', async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementation(async command => {
      if ('threadId' in command && command.threadId === 'workshop') await gate
      return original(command)
    })
    const first = f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'First task' })
    await vi.waitFor(() => expect(f.host.execute).toHaveBeenCalled())
    try {
      const second = await f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Second task' })
      expect(second.error).toBeNull()
      expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'send', threadId: 'docs' })])
      expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toEqual([expect.objectContaining({ type: 'send', threadId: 'workshop' })])
    } finally { release(); await first }
    expect(f.host.attempts).toHaveLength(2)
  })

  it('preserves a different thread draft', async () => {
    const f = await fixture()
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    await f.control.command({ type: 'compose', text: 'Original draft' })
    const result = await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Different draft' })
    expect(result.error).toBeNull()
    expect(result.draft).toBe('Original draft')
    expect(result.draftThreadId).toBe('docs')
    expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'send', threadId: 'workshop', text: 'Different draft' })])
  })

  it('answers a pending permission explicitly on an unassigned thread without granting management', async () => {
    const f = await fixture()
    f.host.event({ type: 'permission', threadId: 'workshop', requestId: 'allow', text: 'Allow this operation?' })
    const result = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'allow', answer: 'No', approved: false })
    expect(result.error).toBeNull()
    expect(f.host.attempts).toEqual([expect.objectContaining({ type: 'answer', approved: false })])
    expect(result).not.toHaveProperty('assignments')
  })
})
