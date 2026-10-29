// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { IDLE_COMPACTION_AFTER_MS, IDLE_COMPACTION_MIN_CONTEXT, IDLE_COMPACTION_UNTIL_MS, IdleCompaction, idleCompactionDue } from '../../../src/main/agents/idleCompaction'
import type { AgentHostSnapshot, AgentThread } from '../../../src/shared/agents'
import { agentThread } from '../../fixtures/agentState'

/**
 * Idle compaction (ADR-0127): a large Claude thread quiet for 54 minutes is compacted once, before its one-hour prompt
 * cache expires, and never while a turn is running, anything waits on the user or is queued, or once the window has passed.
 * Background work and watches do not count: they run in their own contexts while the thread's cache expires.
 */
const NOW = Date.parse('2026-10-23T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, compact: true }
const quiet = (patch: Partial<AgentThread> = {}): AgentThread => agentThread({ id: 'quiet', providerId: 'claude', modelId: 'claude-opus', manualCompactionSupported: true,
  usage: { contextUsed: 250_000, contextUpdatedAt: ago(IDLE_COMPACTION_AFTER_MS + 60_000), modelId: 'claude-opus', rateVersions: [], partial: false, updatedAt: ago(IDLE_COMPACTION_AFTER_MS) }, ...patch })
const host = (threads: AgentThread[]): AgentHostSnapshot => ({ connected: true, name: 'Test', version: 'test', capabilities, models: [], projects: [{ id: 'project', title: 'Project', path: 'D:/project' }],
  providers: [{ id: 'claude', connection: 'connected', name: 'Claude Code', version: 'test', capabilities }, { id: 'codex', connection: 'connected', name: 'Codex', version: 'test', capabilities }], threads })

describe('when a thread is due for idle compaction', () => {
  it('is due inside the window, from 54 minutes idle up to 59', () => {
    const at = (idle: number) => idleCompactionDue(host([]), quiet({ usage: { ...quiet().usage!, contextUpdatedAt: ago(idle) } }), NOW)
    expect(at(IDLE_COMPACTION_AFTER_MS - 1)).toBe(false)
    expect(at(IDLE_COMPACTION_AFTER_MS)).toBe(true)
    expect(at(IDLE_COMPACTION_UNTIL_MS - 1)).toBe(true)
    // Past the window the cache has likely gone, so compacting would re-read the whole conversation.
    expect(at(IDLE_COMPACTION_UNTIL_MS)).toBe(false)
    expect(at(6 * 60 * 60_000)).toBe(false)
  })

  it('needs a large Claude context measured on the thread’s own model', () => {
    const usage = quiet().usage!
    expect(idleCompactionDue(host([]), quiet({ usage: { ...usage, contextUsed: IDLE_COMPACTION_MIN_CONTEXT } }), NOW)).toBe(true)
    expect(idleCompactionDue(host([]), quiet({ usage: { ...usage, contextUsed: IDLE_COMPACTION_MIN_CONTEXT - 1 } }), NOW)).toBe(false)
    expect(idleCompactionDue(host([]), quiet({ usage: { ...usage, modelId: 'claude-sonnet' } }), NOW)).toBe(false)
    expect(idleCompactionDue(host([]), quiet({ usage: undefined }), NOW)).toBe(false)
    expect(idleCompactionDue(host([]), quiet({ providerId: 'codex' }), NOW)).toBe(false)
  })

  it('leaves alone threads that are busy, waiting, closed, Watcher’s old conversations, or that cannot compact', () => {
    const not: Partial<AgentThread>[] = [
      { status: 'running' }, { status: 'error' }, { lastTurn: { id: 'turn', status: 'running' } },
      { requests: [{ id: 'ask', kind: 'question', text: 'Which?', options: [] }] },
      { compaction: { commandId: 'c', status: 'running' } }, { compaction: { commandId: 'c', status: 'uncertain' } },
      { settledAt: ago(0) }, { archivedAt: ago(0) }, { workspaceSettledAt: ago(0) },
      { kind: 'watcher-history' },
      { manualCompactionSupported: false }, { nativeSessionStarted: false },
    ]
    for (const patch of not) expect(idleCompactionDue(host([]), quiet(patch), NOW), JSON.stringify(patch)).toBe(false)
    expect(idleCompactionDue(host([]), quiet({ compaction: { commandId: 'c', status: 'completed' } }), NOW)).toBe(true)
    // Background work and watches run in their own contexts while the thread's cache expires, so they do not keep it busy.
    expect(idleCompactionDue(host([]), quiet({ backgroundWork: [{ id: 'agents', label: 'Review the diff', type: 'subagent' }],
      monitoring: [{ id: '00000000-0000-4000-8000-000000000000', label: 'CI' }] }), NOW)).toBe(true)
    expect(idleCompactionDue(host([]), quiet({ backgroundWork: [{ id: 'build', label: 'Build', type: 'command' }], status: 'running' }), NOW)).toBe(false)
    // Watcher's own conversation is due on the same terms; the sweep asks Watcher too.
    expect(idleCompactionDue(host([]), quiet({ kind: 'watcher' }), NOW)).toBe(true)
  })
})

describe('the idle compaction sweep', () => {
  const fixture = (threads: AgentThread[], options: { draft?: string; pending?: string; enabled?: () => boolean; fail?: boolean; watcherAtRest?: (threadId: string) => boolean } = {}) => {
    const snapshot = host(threads)
    const asked: string[] = []; const guards: (() => void)[] = []
    const clock = { now: NOW }
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const control = {
      hostView: () => snapshot,
      hasUserDraft: (id: string) => id === options.draft,
      hasPendingThreadWork: (id: string) => id === options.pending,
      compactIdleThread: async (id: string, guard: () => void) => { asked.push(id); guards.push(guard); guard(); await done; if (options.fail) throw new Error('refused') },
    }
    const sweeper = new IdleCompaction({ control, enabled: options.enabled ?? (() => true), now: () => clock.now, ...options.watcherAtRest ? { watcherAtRest: options.watcherAtRest } : {} })
    const thread = (id: string) => snapshot.threads.find(item => item.id === id)!
    /** The provider takes the compaction, shows it running, then shows its result, as Claude does. */
    const compacted = async (id: string, after: Partial<NonNullable<AgentThread['usage']>>): Promise<void> => {
      thread(id).compaction = { commandId: id, status: 'running', idle: true }
      sweeper.sweep()
      thread(id).compaction = { commandId: id, status: 'completed', idle: true }
      thread(id).usage = { ...thread(id).usage!, ...after }
    }
    const accepted = async (): Promise<void> => { finish(); await new Promise(resolve => setTimeout(resolve, 0)) }
    return { snapshot, asked, guards, clock, sweeper, thread, compacted, accepted }
  }

  it('compacts a due thread once per quiet stretch, and again only after the next turn', async () => {
    const f = fixture([quiet()])
    expect(f.sweeper.sweep()).toEqual(['quiet'])
    expect(f.sweeper.sweep()).toEqual([])
    await f.accepted()
    // The compaction's own result, even one that leaves 100k or more, is not a new quiet stretch.
    await f.compacted('quiet', { contextUsed: 150_000, contextUpdatedAt: ago(IDLE_COMPACTION_AFTER_MS + 5_000) })
    expect(f.sweeper.sweep()).toEqual([])
    f.thread('quiet').usage = { ...f.thread('quiet').usage!, contextUsed: 200_000, contextUpdatedAt: ago(IDLE_COMPACTION_AFTER_MS + 1) }
    expect(f.sweeper.sweep()).toEqual(['quiet'])
    expect(f.asked).toEqual(['quiet', 'quiet'])
  })

  it('does not try a quiet stretch again after a refusal or failure', async () => {
    const f = fixture([quiet()], { fail: true })
    expect(f.sweeper.sweep()).toEqual(['quiet'])
    await f.accepted()
    expect(f.sweeper.sweep()).toEqual([])
  })

  it('skips a thread with a draft or queued work, and does nothing while the setting is off', () => {
    expect(fixture([quiet()], { draft: 'quiet' }).sweeper.sweep()).toEqual([])
    expect(fixture([quiet()], { pending: 'quiet' }).sweeper.sweep()).toEqual([])
    let on = false
    const f = fixture([quiet()], { enabled: () => on })
    expect(f.sweeper.sweep()).toEqual([])
    on = true
    expect(f.sweeper.sweep()).toEqual(['quiet'])
  })

  it('compacts Watcher’s own conversation only while Watcher rests, and never without Watcher', () => {
    const watcher = () => quiet({ id: 'watcher', kind: 'watcher' })
    // Without Watcher (its Owl feature off) its thread is left alone.
    expect(fixture([watcher()]).sweeper.sweep()).toEqual([])
    // Watcher has news queued, a compaction of its own or a change under way: not at rest.
    expect(fixture([watcher()], { watcherAtRest: () => false }).sweeper.sweep()).toEqual([])
    const asked: string[] = []
    let resting = true
    const f = fixture([watcher(), quiet()], { watcherAtRest: id => { asked.push(id); return resting } })
    expect(f.sweeper.sweep()).toEqual(['watcher', 'quiet'])
    // Only Watcher's thread asks it.
    expect(new Set(asked)).toEqual(new Set(['watcher']))
    // Asked again as the command dispatches: news that arrived since holds it.
    resting = false
    expect(() => f.guards[0]!()).toThrow('This thread is no longer idle.')
  })

  it('keeps two at once until each thread shows its result, not just until Claude takes the command', async () => {
    const f = fixture([quiet({ id: 'a' }), quiet({ id: 'b' }), quiet({ id: 'c' })])
    expect(f.sweeper.sweep()).toEqual(['a', 'b'])
    await f.accepted()
    expect(f.sweeper.sweep()).toEqual([])
    await f.compacted('a', { contextUsed: 40_000, contextUpdatedAt: ago(0) })
    expect(f.sweeper.sweep()).toEqual(['c'])
  })

  it('frees the place of a compaction that finished before any sweep saw it running', async () => {
    const f = fixture([quiet({ id: 'a', compaction: { commandId: 'earlier', status: 'completed' } }), quiet({ id: 'b' }), quiet({ id: 'c' })])
    expect(f.sweeper.sweep()).toEqual(['a', 'b'])
    await f.accepted()
    // Done, or failed fast, inside one 30-second sweep: a new record, never seen running.
    f.thread('a').compaction = { commandId: 'idle-a', status: 'failed', idle: true }
    expect(f.sweeper.sweep()).toEqual(['c'])
  })

  it('gives up the place of a compaction that never shows a result after ten minutes', async () => {
    const f = fixture([quiet({ id: 'a' }), quiet({ id: 'b' }), quiet({ id: 'c', usage: { ...quiet().usage!, contextUpdatedAt: ago(IDLE_COMPACTION_AFTER_MS - 9 * 60_000 - 30_000) } })])
    expect(f.sweeper.sweep()).toEqual(['a', 'b'])
    await f.accepted()
    f.clock.now = NOW + 10 * 60_000 - 1
    expect(f.sweeper.sweep()).toEqual([])
    f.clock.now = NOW + 10 * 60_000
    expect(f.sweeper.sweep()).toEqual(['c'])
  })

  it('refuses at dispatch when the thread moved on, the user started typing, or the setting went off', () => {
    let on = true
    const f = fixture([quiet({ id: 'a' }), quiet({ id: 'b' })], { enabled: () => on })
    f.sweeper.sweep()
    const [moved, off] = f.guards
    f.snapshot.threads[0]!.usage = { ...f.snapshot.threads[0]!.usage!, contextUpdatedAt: ago(0) }
    expect(moved).toThrow('no longer idle')
    on = false
    expect(off).toThrow('off')
  })

  it('stops for good once stopped', () => {
    const f = fixture([quiet()])
    f.sweeper.stop()
    expect(f.sweeper.sweep()).toEqual([])
  })
})
