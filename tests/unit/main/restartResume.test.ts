// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { RESUME_RECORD_MAX_AGE_MS, RestartResume } from '../../../src/main/agents/restartResume'
import { foldWakeUpNews, queuedWakeUpText } from '../../../src/main/agents/wakeUp'
import { FollowupStore } from '../../../src/main/agents/followups'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, AgentState, AgentThread } from '../../../src/shared/agents'
import { RESUME_NOTE, RESUMES_IN_A_ROW_MAX, isResumeNoteText, type RestartNews } from '../../../src/shared/restartResume'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

/**
 * Resuming threads after a restart (ADR-0076): what a connected provider reports running is recorded as it starts and
 * dropped as it ends, closing does not change the record, and the next start hands each stopped thread the resume note
 * through its own send path, at most three times in a row.
 */
const roots: string[] = []; const controls: AgentControl[] = []; const resumes: RestartResume[] = []
afterEach(async () => {
  for (const r of resumes.splice(0)) await r.freeze()
  for (const c of controls.splice(0)) { c.dispose(); await c.privacyChanged() }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-restart-resume-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
})
class Host implements AgentHost {
  state!: AgentHostSnapshot
  listeners = new Set<(s: AgentHostSnapshot) => void>()
  attempts: AgentHostCommand[] = []
  async connect() { this.state ??= await new E2EAgentHost().connect(); this.state.connected = true; return this.snapshot() }
  async snapshot() { return structuredClone(this.state) }
  subscribe(fn: (s: AgentHostSnapshot) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  disconnect() { this.state.connected = false }
  update(id: string, patch: Partial<AgentThread>) { Object.assign(this.state.threads.find(t => t.id === id)!, patch); this.emit() }
  emit() { for (const fn of this.listeners) fn(structuredClone(this.state)) }
  async execute(c: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(c)
    if (c.type === 'send') {
      const thread = this.state.threads.find(t => t.id === c.threadId)!
      thread.messages.push({ id: c.messageId, commandId: c.commandId, role: 'user', text: c.text, createdAt: new Date().toISOString() })
      thread.status = 'running'; thread.lastTurn = { id: c.commandId, status: 'running' }; this.emit()
    }
    return { accepted: true }
  }
}
interface Saved { version: 1; working: { threadId: string; since: string; resumes: number; queued?: true }[] }
async function fixture(options: { saved?: Saved['working']; enabled?: boolean; host?: Host; gate?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-restart-resume-')); roots.push(root)
  if (options.saved) await writeFile(join(root, 'restart-resume.json'), JSON.stringify({ version: 1, working: options.saved }))
  const host = options.host ?? new Host()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner }); controls.push(control)
  const resume = new RestartResume({ directory: root, control, enabled: () => options.enabled ?? true, tool: () => false }); resumes.push(resume)
  // As the runtime does; a test of the gate leaves it out, as a build without the feature does.
  if (options.gate !== false) control.useRestartResume({ due: () => options.enabled ?? true, sending: id => resume.noteSending(id), unsent: id => resume.noteUnsent(id) })
  await resume.start()
  await control.start(); await control.command({ type: 'connect' })
  return { root, host, control, resume }
}
const saved = async (root: string): Promise<Saved['working']> => {
  try { return (JSON.parse(await readFile(join(root, 'restart-resume.json'), 'utf8')) as Saved).working } catch { return [] }
}
const sends = (host: Host) => host.attempts.filter((c): c is Extract<AgentHostCommand, { type: 'send' }> => c.type === 'send')
const run = (host: Host, id = 'workshop') => host.update(id, { status: 'running', lastTurn: { id: randomUUID(), status: 'running' } })
const finish = (host: Host, id = 'workshop') => host.update(id, { status: 'idle', lastTurn: { id: randomUUID(), status: 'completed' } })
const stopped = (resumes = 0, since = new Date().toISOString()) => ({ threadId: 'workshop', since, resumes })

describe('resuming threads after a restart', () => {
  it('records a thread while its turn runs and forgets it when the turn ends', async () => {
    const f = await fixture()
    run(f.host)
    await expect.poll(() => saved(f.root)).toEqual([expect.objectContaining({ threadId: 'workshop', resumes: 0 })])
    finish(f.host)
    await expect.poll(() => saved(f.root)).toEqual([])
    expect(JSON.stringify(await readFile(join(f.root, 'restart-resume.json'), 'utf8'))).not.toContain('Fix the')
  })

  it('keeps what was working once Sotto starts closing, whatever closing does to the thread', async () => {
    const f = await fixture()
    run(f.host)
    await expect.poll(() => saved(f.root)).toHaveLength(1)
    await f.resume.freeze()
    f.host.update('workshop', { status: 'idle', lastTurn: { id: randomUUID(), status: 'interrupted' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await saved(f.root)).toEqual([expect.objectContaining({ threadId: 'workshop', resumes: 0 })])
  })

  it('sends a stopped thread the resume note, as a wake-up, once its provider is back, and counts the resumed turn', async () => {
    const f = await fixture({ saved: [stopped()] })
    await expect.poll(() => sends(f.host).length).toBe(1)
    expect(sends(f.host)[0]).toMatchObject({ threadId: 'workshop', wakeUp: true, text: RESUME_NOTE })
    // Queued, then the resumed turn itself once it runs, still counted as the first resume.
    await expect.poll(() => saved(f.root)).toEqual([{ threadId: 'workshop', since: expect.any(String), resumes: 1 }])
    finish(f.host)
    await expect.poll(() => saved(f.root)).toEqual([])
  })

  it('sends nothing and clears the record when the setting is off', async () => {
    const f = await fixture({ saved: [stopped()], enabled: false })
    await expect.poll(() => saved(f.root)).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(sends(f.host)).toEqual([])
  })

  it('leaves a thread for the user after three resumes in a row, and clears a record older than a week', async () => {
    const old = new Date(Date.now() - RESUME_RECORD_MAX_AGE_MS - 60_000).toISOString()
    const f = await fixture({ saved: [stopped(RESUMES_IN_A_ROW_MAX), { ...stopped(0, old), threadId: 'other' }] })
    await expect.poll(() => saved(f.root)).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(sends(f.host)).toEqual([])
  })

  it('forgets a queued note’s record once the queue no longer holds the note, and sends nothing for it', async () => {
    const f = await fixture({ saved: [{ ...stopped(2), queued: true }] })
    await expect.poll(() => saved(f.root)).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(sends(f.host)).toEqual([])
  })

  it('sends nothing to a thread archived while Sotto was closed', async () => {
    const host = new Host()
    await host.connect()
    host.state.threads.find(thread => thread.id === 'workshop')!.archivedAt = new Date().toISOString()
    const f = await fixture({ saved: [stopped()], host })
    await expect.poll(() => saved(f.root)).toEqual([])
    expect(sends(f.host)).toEqual([])
  })
})

/**
 * Codex after a restart: a thread nobody has opened is reported connected and idle before its turns are read, so it has
 * no last turn yet. The first read of it, which the queue makes before it sends, finds the turn the restart cut off.
 */
class UnreadHost extends Host {
  reads = 0
  private placed = false
  constructor(private readonly found: AgentThread['lastTurn'], private readonly foundStatus: AgentThread['status'] = 'idle') { super() }
  async connect() {
    const snapshot = await super.connect()
    if (this.placed) return snapshot
    this.placed = true
    const thread = this.state.threads.find(item => item.id === 'workshop')!
    delete thread.lastTurn; thread.status = 'idle'
    return this.snapshot()
  }
  async refreshThread(threadId: string) {
    const thread = this.state.threads.find(item => item.id === threadId)!
    if (threadId === 'workshop' && !this.reads++) { thread.lastTurn = this.found; thread.status = this.foundStatus }
    return this.snapshot()
  }
}

/** The read before the resume note fails once, as a Codex app-server that is still starting can. */
class FirstReadFailsHost extends UnreadHost {
  failed = false
  override async refreshThread(threadId: string) {
    if (threadId === 'workshop' && !this.failed) { this.failed = true; throw new Error('The thread could not be read.') }
    return super.refreshThread(threadId)
  }
}
const queueRestartNote = (store: FollowupStore) => store.queueWakeUp('workshop', { source: 'restart', since: new Date().toISOString(), resumes: 1 } satisfies RestartNews,
  items => queuedWakeUpText(items, { tool: false }), 'unknown')
/** A queue whose first item an earlier build queued against no turn and left "Not sent", and a coordinator over it. */
async function startWithFailed(host: Host, seed: (store: FollowupStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-restart-resume-')); roots.push(root)
  const store = new FollowupStore(root); await store.load(); await seed(store)
  const stuck = store.peek().items[0]!
  await store.claim(stuck.id)
  await store.settle(stuck.id, 'failed', 'The thread is no longer ready. Review it and resume its queue when ready.')
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner }); controls.push(control)
  control.useRestartResume({ due: () => true, sending: () => undefined, unsent: () => undefined })
  await control.start(); await control.command({ type: 'connect' })
  return control
}

describe('a thread whose history is read only after Sotto restarts', () => {
  it('sends the resume note when the first read finds the turn the restart cut off, unopened', async () => {
    const host = new UnreadHost({ id: 't1', status: 'interrupted' })
    const f = await fixture({ saved: [stopped()], host })
    await expect.poll(() => sends(f.host).length).toBe(1)
    expect(sends(f.host)[0]).toMatchObject({ threadId: 'workshop', wakeUp: true, text: RESUME_NOTE })
    expect(host.reads).toBeGreaterThan(0)
    await expect.poll(() => f.control.get().followups ?? []).toEqual([])
    await expect.poll(() => saved(f.root)).toEqual([{ threadId: 'workshop', since: expect.any(String), resumes: 1 }])
  })

  it('sends it when the thread was opened before the note was queued', async () => {
    const host = new Host()
    await host.connect()
    host.update('workshop', { status: 'idle', lastTurn: { id: 't1', status: 'interrupted' } })
    const f = await fixture({ saved: [stopped()], host })
    await expect.poll(() => sends(f.host).length).toBe(1)
    expect(sends(f.host)[0]).toMatchObject({ threadId: 'workshop', wakeUp: true, text: RESUME_NOTE })
  })

  it('leaves alone a thread the first read finds still working, and keeps its record', async () => {
    const host = new UnreadHost({ id: 't1', status: 'running' }, 'running')
    const before = new Date(Date.now() - 60 * 60_000).toISOString()
    const f = await fixture({ saved: [stopped(1, before)], host })
    // The record now times the turn the read found, and still counts the resume before it.
    await expect.poll(() => saved(f.root)).toEqual([{ threadId: 'workshop', since: expect.not.stringMatching(before), resumes: 1 }])
    expect(host.reads).toBeGreaterThan(0)
    expect(sends(f.host)).toEqual([])
    expect(f.control.get().followups ?? []).toEqual([])
  })

  it('still holds a user’s own queued prompt for review when the read finds an unfinished turn', async () => {
    const host = new UnreadHost({ id: 't1', status: 'interrupted' })
    const f = await fixture({ host })
    await f.control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'Then add the tests.', attachments: [] })
    await expect.poll(() => host.reads).toBeGreaterThan(0)
    await expect.poll(() => f.control.get().followups?.[0]?.status).not.toBe('sending')
    expect(sends(f.host)).toEqual([])
    expect(f.control.get().followups).toEqual([expect.objectContaining({ text: 'Then add the tests.' })])
    expect(f.control.get().followups?.[0]?.status).not.toBe('queued')
  })

  it('sends a note that an earlier build left failed once the user resumes the queue', async () => {
    const host = new Host()
    await host.connect()
    host.update('workshop', { status: 'idle', lastTurn: { id: 't1', status: 'interrupted' } })
    const control = await startWithFailed(host, queueRestartNote)
    expect(control.get().followups).toEqual([expect.objectContaining({ status: 'failed', wakeUp: true })])
    expect(sends(host)).toEqual([])
    await control.command({ type: 'resume-followups', threadId: 'workshop' })
    await expect.poll(() => sends(host).length).toBe(1)
    expect(sends(host)[0]).toMatchObject({ threadId: 'workshop', wakeUp: true, text: RESUME_NOTE })
  })

  it('sends the resume note when the read before it fails and the queue’s own read finds the turn the restart cut off', async () => {
    const host = new FirstReadFailsHost({ id: 't1', status: 'interrupted' })
    const f = await fixture({ saved: [stopped()], host })
    await expect.poll(() => sends(f.host).length).toBe(1)
    expect(host.failed).toBe(true)
    expect(sends(f.host)[0]).toMatchObject({ threadId: 'workshop', wakeUp: true, text: RESUME_NOTE })
    await expect.poll(() => f.control.get().followups ?? []).toEqual([])
  })

  it('sends a failed note once the user resumes the queue of a thread whose turns are not read yet', async () => {
    const host = new UnreadHost({ id: 't1', status: 'interrupted' })
    const control = await startWithFailed(host, queueRestartNote)
    expect(host.reads).toBe(0)
    await control.command({ type: 'resume-followups', threadId: 'workshop' })
    await expect.poll(() => sends(host).length).toBe(1)
    expect(sends(host)[0]).toMatchObject({ threadId: 'workshop', wakeUp: true, text: RESUME_NOTE })
    await expect.poll(() => control.get().followups ?? []).toEqual([])
  })

  it('sends a user’s failed prompt once they resume the queue of a thread whose turns are not read yet', async () => {
    const host = new UnreadHost({ id: 't1', status: 'interrupted' })
    const control = await startWithFailed(host, store => store.enqueue({ threadId: 'workshop', draftId: randomUUID(), text: 'Then add the tests.', attachments: [], resumeAfterTurnId: 'unknown' }))
    expect(host.reads).toBe(0)
    await control.command({ type: 'resume-followups', threadId: 'workshop' })
    await expect.poll(() => sends(host).length).toBe(1)
    expect(sends(host)[0]).toMatchObject({ threadId: 'workshop', text: 'Then add the tests.' })
    expect(sends(host)[0]?.wakeUp).toBeUndefined()
  })
})

/** A coordinator the test drives by hand: its threads, its queue, and when a note goes. */
function scripted(threads: { id: string; status: 'idle' | 'running' }[], followups: { threadId: string; text: string }[] = []) {
  const listeners = new Set<(state: AgentState) => void>()
  let state = {} as AgentState
  const set = (next: typeof threads, queue = followups): void => {
    state = { host: { connected: true, projects: [], threads: next.map(thread => ({ id: thread.id, projectId: 'project', title: thread.id, modelId: 'm', status: thread.status,
      messages: [], requests: [] })) }, followups: queue.map(item => ({ id: randomUUID(), draftId: randomUUID(), attachments: [], status: 'queued', wakeUp: true,
      createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', ...item })) } as unknown as AgentState
    for (const listener of listeners) listener(state)
  }
  set(threads)
  const control = { get: () => state, subscribe: (listener: (state: AgentState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    deliverWakeUp: async () => undefined }
  return { control, set }
}

async function dormantFixture(records: Saved['working'], options: {
  enabled?: boolean; dormant?: readonly string[]; threads?: { id: string; status: 'idle' | 'running' }[]
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-restart-resume-')); roots.push(root)
  await writeFile(join(root, 'restart-resume.json'), JSON.stringify({ version: 1, working: records }))
  const coordinator = scripted(options.threads ?? [{ id: 'ordinary', status: 'idle' }])
  const delivered: { threadId: string; news: RestartNews }[] = []
  const dormant = new Set(options.dormant ?? records.map(record => record.threadId))
  const resume = new RestartResume({ directory: root, control: { ...coordinator.control,
    deliverWakeUp: async (threadId, news) => { delivered.push({ threadId, news }) } }, enabled: () => options.enabled ?? true,
    tool: () => false, preservesDormantThread: id => dormant.has(id) }); resumes.push(resume)
  await resume.start()
  return { root, resume, coordinator, delivered }
}

describe('a gated provider keeps its restart records', () => {
  it('keeps a dormant resume record when a connected ordinary shell omits its thread', async () => {
    const record = { ...stopped(1), threadId: 'muse' }
    const f = await dormantFixture([record])
    await f.resume.freeze()
    expect(await saved(f.root)).toEqual([record])
    expect(f.delivered).toEqual([])
  })

  it.each([false, true])('keeps a dormant record unchanged through native observations and note hooks, queued=%s', async queued => {
    const record = { ...stopped(2), threadId: 'muse', ...(queued ? { queued: true as const } : {}) }
    const f = await dormantFixture([record], { threads: [{ id: 'muse', status: 'idle' }] })
    f.resume.noteSending('muse'); f.resume.noteUnsent('muse')
    f.coordinator.set([{ id: 'muse', status: 'running' }])
    f.coordinator.set([{ id: 'muse', status: 'idle' }])
    f.coordinator.set([{ id: 'ordinary', status: 'idle' }])
    await f.resume.freeze()
    expect(await saved(f.root)).toEqual([record])
    expect(f.delivered).toEqual([])
  })

  it.each(['setting off', 'expired', 'three resumes'] as const)('preserves dormant rows before %s pruning while ordinary rows still follow it', async reason => {
    const since = new Date(Date.now() - (reason === 'expired' ? RESUME_RECORD_MAX_AGE_MS + 60_000 : 0)).toISOString()
    const record = { ...stopped(reason === 'three resumes' ? RESUMES_IN_A_ROW_MAX : 0, since), threadId: 'muse' }
    const ordinary = { ...record, threadId: 'ordinary' }
    const f = await dormantFixture([record, ordinary], { dormant: ['muse'], enabled: reason !== 'setting off' })
    await f.resume.freeze()
    expect(await saved(f.root)).toEqual([record])
    expect(f.delivered).toEqual([])
  })

  it('keeps all 500 dormant rows when ordinary work would otherwise displace the oldest one', async () => {
    const records = Array.from({ length: 500 }, (_, index) => ({ ...stopped(index % 4), threadId: `muse-${index}`,
      ...(index % 2 ? { queued: true as const } : {}) }))
    const f = await dormantFixture(records, { threads: [{ id: 'ordinary', status: 'running' }] })
    await f.resume.freeze()
    expect(await saved(f.root)).toEqual(records)
    expect(f.delivered).toEqual([])
  })

  it('fills the remaining record bound with the newest ordinary work without moving dormant rows', async () => {
    const records = Array.from({ length: 499 }, (_, index) => ({ ...stopped(), threadId: `muse-${index}` }))
    const f = await dormantFixture(records, { threads: [{ id: 'first', status: 'running' }, { id: 'second', status: 'running' }] })
    await f.resume.freeze()
    expect(await saved(f.root)).toEqual([...records, { threadId: 'second', resumes: 0, since: expect.any(String) }])
    expect(f.delivered).toEqual([])
  })

  it('resumes the retained Muse thread once through the coordinator when a fresh Owl instance makes it available', async () => {
    const record = stopped(1)
    const parked = await dormantFixture([record])
    await parked.resume.freeze()
    expect(await saved(parked.root)).toEqual([record])
    const host = new Host(); await host.connect()
    host.state.threads.find(thread => thread.id === record.threadId)!.providerId = 'muse'
    host.state.models[0]!.providerId = 'muse'; host.state.models[0]!.provider = 'Muse'
    host.state.projects[0]!.path = parked.root
    const credentials = await testCredentials(parked.root, { mode: 'unavailable' })
    const control = createAgentControl({ directory: parked.root, host, credentials, reasoner: e2eAgentReasoner, museEnabled: true }); controls.push(control)
    const resume = new RestartResume({ directory: parked.root, control, enabled: () => true, tool: () => false,
      preservesDormantThread: () => false }); resumes.push(resume)
    control.useRestartResume({ due: () => true, sending: id => resume.noteSending(id), unsent: id => resume.noteUnsent(id) })
    await resume.start(); await control.start(); await control.command({ type: 'connect' })
    await expect.poll(() => sends(host).length).toBe(1)
    expect(sends(host)[0]).toMatchObject({ threadId: record.threadId, wakeUp: true, text: RESUME_NOTE })
    await expect.poll(() => saved(parked.root)).toEqual([{ threadId: record.threadId, since: expect.any(String), resumes: 2 }])
    finish(host)
    await resume.freeze()
    expect(await saved(parked.root)).toEqual([])
    expect(sends(host)).toHaveLength(1)
  })

  it.each(['expired', 'three resumes'] as const)('keeps the normal %s limit when a fresh instance makes a retained thread available', async reason => {
    const since = new Date(Date.now() - (reason === 'expired' ? RESUME_RECORD_MAX_AGE_MS + 60_000 : 0)).toISOString()
    const record = { ...stopped(reason === 'three resumes' ? RESUMES_IN_A_ROW_MAX : 0, since), threadId: 'muse' }
    const parked = await dormantFixture([record]); await parked.resume.freeze()
    expect(await saved(parked.root)).toEqual([record])
    const coordinator = scripted([{ id: record.threadId, status: 'idle' }])
    const delivered: RestartNews[] = []
    const resume = new RestartResume({ directory: parked.root, control: { ...coordinator.control,
      deliverWakeUp: async (_threadId, news) => { delivered.push(news) } }, enabled: () => true, tool: () => false,
      preservesDormantThread: () => false }); resumes.push(resume)
    await resume.start(); await resume.freeze()
    expect(await saved(parked.root)).toEqual([])
    expect(delivered).toEqual([])
  })
})

describe('what the record counts', () => {
  it('starts a turn of the user’s own again from none, even while a resume note waits (Sotto Bug Bot)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-restart-resume-')); roots.push(root)
    await writeFile(join(root, 'restart-resume.json'), JSON.stringify({ version: 1, working: [{ ...stopped(RESUMES_IN_A_ROW_MAX), queued: true }] }))
    const coordinator = scripted([{ id: 'workshop', status: 'idle' }], [{ threadId: 'workshop', text: RESUME_NOTE }])
    const resume = new RestartResume({ directory: root, control: coordinator.control, enabled: () => true, tool: () => false }); resumes.push(resume)
    await resume.start()
    // The note still waits, so the record stays; then the user's own turn runs before it.
    expect(await saved(root)).toEqual([expect.objectContaining({ resumes: RESUMES_IN_A_ROW_MAX, queued: true })])
    coordinator.set([{ id: 'workshop', status: 'running' }])
    await resume.freeze()
    expect(await saved(root)).toEqual([{ threadId: 'workshop', since: expect.any(String), resumes: 0 }])
  })

  it('counts the resumes before it for the turn the note itself starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-restart-resume-')); roots.push(root)
    await writeFile(join(root, 'restart-resume.json'), JSON.stringify({ version: 1, working: [{ ...stopped(2), queued: true }] }))
    const coordinator = scripted([{ id: 'workshop', status: 'idle' }], [{ threadId: 'workshop', text: RESUME_NOTE }])
    const resume = new RestartResume({ directory: root, control: coordinator.control, enabled: () => true, tool: () => false }); resumes.push(resume)
    await resume.start()
    resume.noteSending('workshop')
    coordinator.set([{ id: 'workshop', status: 'running' }], [])
    await resume.freeze()
    expect(await saved(root)).toEqual([{ threadId: 'workshop', since: expect.any(String), resumes: 2 }])
  })

  it('keeps the count when the read before the note finds the thread working, before anyone is told it changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-restart-resume-')); roots.push(root)
    const before = new Date(Date.now() - 60 * 60_000).toISOString()
    await writeFile(join(root, 'restart-resume.json'), JSON.stringify({ version: 1, working: [stopped(2, before)] }))
    const coordinator = scripted([{ id: 'workshop', status: 'idle' }])
    let working: AgentState | undefined
    const control = { ...coordinator.control, get: () => working ?? coordinator.control.get(),
      // The read found the turn still running; the coordinator's listeners have not heard yet.
      deliverWakeUp: async () => {
        const state = coordinator.control.get()
        working = { ...state, host: { ...state.host, threads: state.host.threads.map(thread => ({ ...thread, status: 'running' as const })) } }
        throw new Error('This thread is working again.')
      } }
    const resume = new RestartResume({ directory: root, control, enabled: () => true, tool: () => false }); resumes.push(resume)
    await resume.start()
    await expect.poll(() => saved(root)).toEqual([{ threadId: 'workshop', since: expect.not.stringMatching(before), resumes: 2 }])
  })

  it('drops the record of a thread that is no longer on the host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-restart-resume-')); roots.push(root)
    await writeFile(join(root, 'restart-resume.json'), JSON.stringify({ version: 1, working: [{ ...stopped(), threadId: 'deleted' }] }))
    const coordinator = scripted([{ id: 'workshop', status: 'running' }])
    const resume = new RestartResume({ directory: root, control: coordinator.control, enabled: () => true, tool: () => false }); resumes.push(resume)
    await resume.start()
    await expect.poll(() => saved(root)).toEqual([expect.objectContaining({ threadId: 'workshop', resumes: 0 })])
    coordinator.set([])
    await expect.poll(() => saved(root)).toEqual([])
  })
})

describe('a resume note waiting in the queue', () => {
  const restart: RestartNews = { source: 'restart', since: new Date().toISOString(), resumes: 1 }
  it('goes nowhere where the feature is off, so a note saved by Owl is not sent by stable', async () => {
    const f = await fixture({ gate: false })
    await f.control.deliverWakeUp('workshop', restart, { tool: false })
    await expect.poll(() => f.control.get().followups ?? []).toEqual([])
    expect(sends(f.host)).toEqual([])
  })

  it('goes ahead of the user’s follow-ups, which waited on the turn it resumes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-restart-resume-')); roots.push(root)
    const store = new FollowupStore(root); await store.load()
    const word = (items: readonly unknown[]) => queuedWakeUpText(items as never, { tool: false })
    await store.enqueue({ threadId: 'workshop', draftId: randomUUID(), text: 'queued before Sotto closed', attachments: [] })
    await store.queueWakeUp('workshop', restart, word, 'turn-1')
    await store.enqueue({ threadId: 'workshop', draftId: randomUUID(), text: 'queued after', attachments: [] })
    expect(store.peek().items.map(item => item.wakeUp ? 'note' : item.text)).toEqual(['note', 'queued before Sotto closed', 'queued after'])
    const ids = store.peek().items.map(item => item.id)
    await store.reorder('workshop', [ids[2]!, ids[1]!, ids[0]!])
    expect(store.peek().items.map(item => item.wakeUp ? 'note' : item.text)).toEqual(['note', 'queued after', 'queued before Sotto closed'])
  })
})

describe('a resume note folded with other news', () => {
  const restart: RestartNews = { source: 'restart', since: new Date().toISOString(), resumes: 1 }
  const pr: BabysitNews = { pullRequest: { url: 'https://github.com/o/r/pull/7', number: 7, title: 'Seven' }, startedBy: 'agent', head: 'h', changes: [], ended: 'merged' }
  it('opens the wake-up, so the thread can tell it is a resume', () => {
    const folded = foldWakeUpNews(foldWakeUpNews([], pr), restart)
    expect(folded[0]).toBe(restart)
    const text = queuedWakeUpText(folded, { tool: false })
    expect(text.startsWith(`${RESUME_NOTE}\n\n`)).toBe(true)
    expect(text).toContain('Pull request #7')
    expect(isResumeNoteText(text)).toBe(true)
    expect(isResumeNoteText(queuedWakeUpText([pr], { tool: false }))).toBe(false)
  })
  it('keeps one note, however many restarts it folds', () => {
    const later: RestartNews = { ...restart, resumes: 2 }
    expect(foldWakeUpNews([restart, pr], later)).toEqual([later, pr])
  })
})
