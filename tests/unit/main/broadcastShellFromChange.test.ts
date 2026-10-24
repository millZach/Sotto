// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHostSnapshot, AgentMessage, AgentState, AgentThread, ThreadContinuedFrom } from '../../../src/shared/agents'
import { createAgentControl } from '../../fixtures/agentControlFixture'

/**
 * The shell a broadcast carries is prepared from what changed since the last one (#1334): the part that is not threads is
 * copied only when something in it changed, and a thread whose record and marks have not changed is carried as the record
 * the last broadcast carried. Every broadcast still holds exactly what `shell()` would give.
 */
/**
 * The copiers the shell can reach: a whole copy (`clonePlainData`), and the copy over the last broadcast's (`copyOver`, which
 * `immutableUpdates` calls), counted by the containers it made rather than kept from the copy it was read against.
 */
const copies = vi.hoisted(() => ({ plain: 0, over: 0, made: 0 }))
vi.mock('../../../src/main/agents/cloneHostSnapshot', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/main/agents/cloneHostSnapshot')>()
  const containers = (value: unknown, previous: unknown): number => {
    if (value === null || typeof value !== 'object' || value === previous) return 0
    const before = previous !== null && typeof previous === 'object' ? previous as Record<string, unknown> : {}
    return 1 + Object.entries(value).reduce((sum, [key, item]) => sum + containers(item, before[key]), 0)
  }
  return { ...original,
    clonePlainData: <T>(value: T): T => { copies.plain++; return original.clonePlainData(value) },
    copyOver: <T>(values: readonly T[], previous: readonly (T | undefined)[], shared: (value: object) => boolean, seal: (copy: object) => void): T[] => {
      const copy = original.copyOver(values, previous, shared, seal)
      copies.over++; copies.made += copy.reduce((sum, item, index) => sum + containers(item, previous[index]), 0)
      return copy
    } }
})

type Internals = Pick<AgentControl, 'broadcastShell' | 'shell' | 'useContinuationDisplay'> & { state: AgentState; finishedUnread: { restore(saved: readonly string[]): void }
  failuresSeen: { track(snapshot: AgentHostSnapshot): boolean; show(threadIds: readonly string[], threads: readonly AgentThread[]): boolean }
  outbox: { id: string; type: 'configure-thread'; threadId: string; options: { modelId: string } }[]; busyThreads: Map<string, number> }
const controls: AgentControl[] = [], roots: string[] = []
afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-broadcast-shell-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

const at = '2026-10-23T00:00:00.000Z'
const message = (id: string, text: string): AgentMessage => ({ id, role: 'assistant', text, createdAt: at })
const thread = (id: string, extra: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: `Synthetic ${id}`, modelId: 'fake', status: 'idle',
  messages: [message(`${id}-reply`, 'Synthetic reply')], requests: [], activities: [], ...extra })

function fixture(): Internals {
  const directory = mkdtempSync(join(tmpdir(), 'sotto-broadcast-shell-')); roots.push(directory)
  const created = createAgentControl({ directory, host: new E2EAgentHost(), credentials: { has: () => false, available: () => false } as never })
  controls.push(created)
  const control = created as unknown as Internals
  control.state.host = { ...control.state.host, connected: true, projects: [{ id: 'project', title: 'Synthetic', path: join(directory, 'project') }],
    threads: [thread('one'), thread('two')] }
  return control
}

describe('the shell a broadcast carries', () => {
  it('copies what is not threads only when something in it changed, and then only the part that changed', () => {
    const control = fixture()
    const first = control.broadcastShell()
    copies.plain = 0; copies.over = 0; copies.made = 0
    const second = control.broadcastShell()
    // Read against the last broadcast's copy, which it hands back whole: nothing is made, and nothing is copied whole.
    expect(copies).toEqual({ plain: 0, over: 1, made: 0 })
    expect(second.configuration).toBe(first.configuration)
    expect(second.host.projects).toBe(first.host.projects)
    expect(Object.isFrozen(second.configuration)).toBe(true)
    // The coordinator writes some of its state in place; the next broadcast still carries the write.
    control.state.configuration.enabledProviders = ['claude']
    const third = control.broadcastShell()
    expect(third.configuration).not.toBe(first.configuration)
    expect(third.configuration.enabledProviders).toEqual(['claude'])
    expect(third.host.projects).toBe(first.host.projects)
    // The new list, the configuration around it, and the state that holds them; nothing else is made again.
    expect(copies.plain).toBe(0)
    expect(copies.over).toBe(2)
    expect(copies.made).toBe(3)
  })

  it('carries an unchanged thread as the record the last broadcast carried, and a changed one afresh', () => {
    const control = fixture()
    const first = control.broadcastShell()
    const [one, two] = control.state.host.threads as [AgentThread, AgentThread]
    control.state.host = { ...control.state.host, threads: [one, { ...two, title: 'Renamed' }] }
    const second = control.broadcastShell()
    expect(second.host.threads[0]).toBe(first.host.threads[0])
    expect(second.host.threads[1]).not.toBe(first.host.threads[1])
    expect(second.host.threads[1]!.title).toBe('Renamed')
    expect(second.host.threads.every(item => item.messages.length === 0 && Object.isFrozen(item))).toBe(true)
    // A mark is the coordinator's, not the record's: earning one makes the record again, and keeping it does not.
    control.finishedUnread.restore(['one'])
    const third = control.broadcastShell()
    expect(third.host.threads[0]).not.toBe(second.host.threads[0])
    expect(third.host.threads[0]!.finishedUnread).toBe(true)
    expect(control.broadcastShell().host.threads[0]).toBe(third.host.threads[0])
    control.finishedUnread.restore([])
    expect(control.broadcastShell().host.threads[0]!.finishedUnread).toBeUndefined()
  })

  it('holds exactly what shell() gives after every kind of change', () => {
    const control = fixture()
    // Own keys compared exactly, so a key left out and a key set to undefined are told apart.
    const same = (what: string) => expect(control.broadcastShell(), what).toStrictEqual(control.shell())
    const threads = (next: AgentThread[]) => { control.state.host = { ...control.state.host, threads: next } }
    same('at first')
    control.state.notice = 'Synthetic notice'; same('a notice')
    control.state.configuration.enabledProviders = ['codex']; same('the configuration written in place')
    // Drafts: the composer's own, and a saved draft added in place, as a save does.
    control.state.draft = 'Synthetic draft'; control.state.draftThreadId = 'one'; same('the composer draft')
    control.state.threadDrafts = [{ threadId: 'one', draftId: '00000000-0000-4000-8000-000000000001', text: 'Saved', attachments: [], requestId: null, updatedAt: at }]
    same('a saved draft')
    control.state.threadDrafts.push({ threadId: 'two', draftId: '00000000-0000-4000-8000-000000000002', text: 'Another', attachments: [], requestId: null, updatedAt: at })
    same('a saved draft pushed in place')
    // Deliveries, and the timing evidence a publish writes into one in place.
    control.state.deliveries = [{ threadId: 'one', draftId: '00000000-0000-4000-8000-000000000001', status: 'submitting', createdAt: at, updatedAt: at }]
    same('a delivery')
    control.state.deliveries[0]!.localFeedbackMs = 3; same('a delivery written in place')
    // The outbox's settings with no result yet, and a busy thread.
    control.outbox = [{ id: 'configure', type: 'configure-thread', threadId: 'two', options: { modelId: 'other' } }]; same('an unconfirmed setting')
    control.busyThreads.set('one', 1); same('a busy thread')
    control.outbox = []; control.busyThreads.clear(); same('the outbox and busy threads empty again')
    // Selection.
    control.state.activeThreadId = 'two'; control.state.activeProjectId = 'project'; same('a selection')
    control.state.activeThreadId = null; control.state.activeProjectId = null; same('no selection')
    // Disconnect and reconnect, as the coordinator does them: a new host snapshot.
    control.state.host = { ...control.state.host, connected: false }; same('disconnected')
    control.state.host = { ...control.state.host, connected: true }; same('reconnected')
    // A thread added, removed and added again as the very record it was.
    const extra = thread('three', { summary: { messageCount: 1, activityCount: 0, lastAssistant: { id: 'three-reply', text: 'Kept', createdAt: at } } })
    threads([...control.state.host.threads, extra]); same('a thread added')
    threads(control.state.host.threads.filter(item => item.id !== 'three')); same('a thread removed')
    threads([...control.state.host.threads, extra]); same('the same thread added again')
    threads(control.state.host.threads.slice(1)); same('the first thread gone')
    // Finish marks.
    control.finishedUnread.restore(['two']); same('a finish mark')
    control.finishedUnread.restore([]); same('the finish mark read')
    // Failure marks: a failure, the failure seen, and the thread working again.
    threads(control.state.host.threads.map(item => item.id === 'two' ? { ...item, status: 'error', lastTurn: { id: 'turn', status: 'failed' } } : item))
    control.failuresSeen.track(control.state.host); same('a failure')
    control.failuresSeen.show(['two'], control.state.host.threads); same('the failure seen')
    threads(control.state.host.threads.map(item => item.id === 'two' ? { ...item, status: 'idle', lastTurn: { id: 'turn-2', status: 'completed' } } : item))
    control.failuresSeen.track(control.state.host); same('the failure over')
    // A summary shown through a display: a continued thread with no summary of its own, whose row is made from its messages
    // as they are shown because it has delegated (ADR-0081), while its display is on and off.
    const handover = { prefixLength: 9, prefixDigest: 'a'.repeat(64), counts: {} } as unknown as NonNullable<ThreadContinuedFrom['handover']>
    threads([...control.state.host.threads, thread('continued', { continuedFrom: { threadId: 'two', provider: 'codex', at, handover }, hiddenWakeUpMessageIds: ['news'],
      messages: [{ ...message('continued-ask', 'Handover. The user words'), role: 'user' }] })])
    same('a continued thread without its display')
    const off = control.useContinuationDisplay(item => item.messages.map(entry => ({ ...entry, text: entry.text.replace('Handover. ', '') })))
    same('the display on')
    off(); same('the display off')
    // A thread whose last user message was a wake-up of delegation news alone, which no row quotes.
    threads([...control.state.host.threads, thread('delegating', { hiddenWakeUpMessageIds: ['news'],
      summary: { messageCount: 1, activityCount: 0, lastUser: { id: 'news', text: 'Synthetic news', createdAt: at } } })])
    same('a hidden wake-up')
    control.state.host = { ...control.state.host, projects: [] }; same('no projects')
  })
})
