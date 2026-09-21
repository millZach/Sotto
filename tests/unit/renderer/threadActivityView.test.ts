import { describe, expect, it } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentThread } from '../../../src/shared/agents'
import {
  activityLabel, blockingAction, currentAction, fenced, formatDuration, groupSummary, hasWaited, liveTurnId, openActivityLabel, placeActivities,
  statusText, timingNote, turnHeadline, waitingLabel, WAITING_AFTER_MS,
} from '../../../src/renderer/src/agents/threadActivityView'

const at = '2026-09-12T10:00:00.000Z'
const message = (id: string, role: AgentMessage['role'] = 'assistant'): AgentMessage => ({ id, role, text: id, createdAt: at })
let sequence = 0
const record = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 't1', sequence: sequence++, kind: 'command', status: 'completed', title: 'Command', ...patch })
const turn = (patch: Partial<AgentActivity> = {}): AgentActivity => record({ id: `turn-${patch.turnId ?? 't1'}`, kind: 'turn', title: 'Turn', ...patch })

describe('placing activity in the transcript', () => {
  const messages = [message('u1', 'user'), message('a1'), message('u2', 'user'), message('a2')]

  it('follows each record’s own anchor in first-observed order without touching messages', () => {
    sequence = 0
    const activities = [
      record({ id: 'late', afterMessageId: 'u1', sequence: 5 }),
      record({ id: 'early', afterMessageId: 'u1', sequence: 1 }),
      record({ id: 'after-commentary', afterMessageId: 'a1', sequence: 7 }),
    ]
    const placement = placeActivities(messages, messages, activities)
    expect(placement.after.get('u1')!.flatMap(group => group.records.map(item => item.id))).toEqual(['early', 'late'])
    expect(placement.after.get('a1')!.flatMap(group => group.records.map(item => item.id))).toEqual(['after-commentary'])
    expect(placement.trailing).toEqual([])
    expect(messages.map(item => item.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('keeps an unanchored record with its turn, and trails a turn that has no anchor at all', () => {
    const activities = [
      record({ id: 'anchored', afterMessageId: 'u2', turnId: 't2', sequence: 1 }),
      record({ id: 'lost-anchor', afterMessageId: 'gone', turnId: 't2', sequence: 2 }),
      record({ id: 'first-in-turn', turnId: 't3', sequence: 3 }),
      record({ id: 'before-anchor', turnId: 't4', sequence: 4 }),
      record({ id: 'later-anchor', turnId: 't4', afterMessageId: 'a1', sequence: 5 }),
    ]
    const placement = placeActivities(messages, messages, activities)
    expect(placement.after.get('u2')![0]!.records.map(item => item.id)).toEqual(['anchored', 'lost-anchor'])
    expect(placement.after.get('a1')![0]!.records.map(item => item.id)).toEqual(['before-anchor', 'later-anchor'])
    expect(placement.trailing.map(group => group.records.map(item => item.id))).toEqual([['first-in-turn']])
    expect(placeActivities(messages, messages, activities, true).trailing).toEqual([])
  })

  it('hides records anchored above the rendered page until that page is shown', () => {
    const activities = [record({ id: 'old', afterMessageId: 'u1' }), record({ id: 'new', afterMessageId: 'u2', turnId: 't2' })]
    const page = placeActivities(messages, messages.slice(2), activities)
    expect([...page.after.keys()]).toEqual(['u2'])
    expect([...placeActivities(messages, messages, activities).after.keys()]).toEqual(['u1', 'u2'])
  })

  it('heads the turn’s first group with work with its lifecycle and drops a lone completed lifecycle', () => {
    const activities = [
      turn({ afterMessageId: 'u1', status: 'completed', durationMs: 124_000, sequence: 0 }),
      record({ id: 'cmd', afterMessageId: 'a1', sequence: 1 }),
      record({ id: 'cmd-2', afterMessageId: 'a2', sequence: 2 }),
      turn({ turnId: 't2', afterMessageId: 'u2', status: 'completed', sequence: 3 }),
    ]
    const placement = placeActivities(messages, messages, activities)
    expect(placement.after.has('u1')).toBe(false)
    expect(placement.after.get('a1')![0]!.turn?.durationMs).toBe(124_000)
    expect(placement.after.get('a2')![0]!.turn).toBeUndefined()
    expect(placement.after.has('u2')).toBe(false)
    const stopped = placeActivities(messages, messages, [turn({ turnId: 't9', afterMessageId: 'u2', status: 'interrupted', sequence: 9 })])
    expect(stopped.after.get('u2')![0]!.turn?.status).toBe('interrupted')
  })

  it('keeps group keys stable while records update in place', () => {
    const first = placeActivities(messages, messages, [record({ id: 'a', afterMessageId: 'u1', sequence: 3, status: 'running' })])
    const second = placeActivities(messages, messages, [record({ id: 'a', afterMessageId: 'u1', sequence: 3, status: 'completed' }), record({ id: 'b', afterMessageId: 'u1', sequence: 4 })])
    expect(second.after.get('u1')![0]!.key).toBe(first.after.get('u1')![0]!.key)
  })
})

describe('the live turn', () => {
  const messages = [message('u1', 'user'), message('a1'), message('t1', 'user')]

  it('is the running lifecycle while the thread runs, and its newest running record is the current action', () => {
    const activities = [turn({ status: 'running', sequence: 1 }), record({ id: 'one', status: 'running', command: 'npm ci', sequence: 2 }), record({ id: 'two', status: 'running', command: 'npm test', sequence: 3 }), record({ id: 'done', sequence: 4 })]
    expect(liveTurnId({ status: 'running', activities, messages })).toBe('t1')
    expect(currentAction({ activities }, 't1')?.id).toBe('two')
    expect(liveTurnId({ status: 'idle', activities, messages })).toBeNull()
  })

  it('falls back to the turn’s user message when no record survived, so the line still reads', () => {
    // A turn restored from a provider's own history carries no record of Sotto watching it.
    expect(liveTurnId({ status: 'running', activities: [], messages })).toBe(messages.findLast(message => message.role === 'user')!.id)
    expect(liveTurnId({ status: 'running', activities: [], messages: [] })).toBeNull()
  })
})

describe('activity wording', () => {
  it('formats recorded durations compactly', () => {
    expect(formatDuration(420)).toBe('0.4s')
    expect(formatDuration(42_900)).toBe('42s')
    expect(formatDuration(124_000)).toBe('2m 04s')
    expect(formatDuration(3_720_000)).toBe('1h 02m')
  })

  it('labels commands, files, subagents and notices from what the provider reported', () => {
    expect(activityLabel(record({ id: 'c', command: 'npm   test\n--run' }))).toMatchObject({ subject: 'npm test --run', mono: true })
    expect(activityLabel(record({ id: 'f', kind: 'file-change', title: 'File changes', changes: [{ path: 'src/a.ts', kind: 'add' }] }))).toMatchObject({ lead: 'Created', subject: 'src/a.ts', preview: '' })
    expect(activityLabel(record({ id: 'f2', kind: 'file-change', title: 'File changes', changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }] }))).toMatchObject({ lead: 'Edited', preview: 'and 1 more file' })
    expect(activityLabel(record({ id: 's', kind: 'subagent', title: 'spawnAgent', agents: [{ id: 'x', status: 'running' }] }))).toMatchObject({ subject: 'Spawn agent', preview: '1 agent' })
    expect(activityLabel(record({ id: 'r', kind: 'reasoning', title: 'Reasoning summary', text: '\n**Checking tests**\nmore' })).preview).toBe('Checking tests')
    expect(activityLabel(record({ id: 'e', kind: 'status', title: 'Codex is retrying', error: 'Stream closed\ntrace' })).preview).toBe('Stream closed')
    expect(activityLabel(record({ id: 't', kind: 'tool', title: 'fixture / inspect', text: '## Reading `src/a.ts`' })).preview).toBe('Reading src/a.ts')
  })

  it('names an open multi-file change by its count, since each file is listed below', () => {
    const changes = [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }]
    expect(openActivityLabel(record({ id: 'f', kind: 'file-change', title: 'File changes', changes }))).toEqual({ lead: 'Changed', subject: '2 files', mono: false, preview: '' })
    expect(openActivityLabel(record({ id: 'g', kind: 'file-change', title: 'File changes', changes: changes.slice(0, 1) }))).toMatchObject({ lead: 'Edited', subject: 'a.ts' })
  })

  it('never reports an unconfirmed outcome as success', () => {
    expect(statusText(record({ id: 'u', status: 'unknown', durationMs: 1000 }), true)).toBe('Outcome unknown')
    expect(statusText(record({ id: 'f', status: 'failed', exitCode: 2 }), true)).toBe('Exit 2')
    expect(statusText(record({ id: 'i', status: 'interrupted' }), true)).toBe('Stopped')
    expect(statusText(record({ id: 'r', status: 'running' }), false)).toBe('Last seen running')
    expect(statusText(record({ id: 'c', durationMs: 1500 }), true)).toBe('1.5s')
    expect(statusText(record({ id: 'n' }), true)).toBe('')
  })

  it('distinguishes provider timing, Sotto’s observation and missing time', () => {
    expect(timingNote(record({ id: 'p', durationMs: 5, timingSource: 'provider' }), 'Codex')).toBe('Reported by Codex')
    expect(timingNote(record({ id: 'o', startedAt: at, completedAt: '2026-09-12T10:00:03.000Z', timingSource: 'observed' }), 'Codex')).toBe('Timed by Sotto')
    // The start was observed, but the duration is Codex's own figure.
    expect(timingNote(record({ id: 'n', startedAt: at, completedAt: '2026-09-12T10:00:03.000Z', durationMs: 2_400, timingSource: 'observed' }), 'Codex')).toBe('Reported by Codex')
    expect(timingNote(record({ id: 's', startedAt: at, completedAt: '2026-09-12T10:00:03.000Z', durationMs: 3_000, timingSource: 'observed' }), 'Codex')).toBe('Timed by Sotto')
    expect(timingNote(record({ id: 'm' }), 'Codex')).toBe('Time not recorded')
    expect(timingNote(record({ id: 'r', status: 'running' }), 'Codex')).toBe('')
  })

  it('summarizes counts and turn outcomes', () => {
    expect(groupSummary([record({ id: '1' }), record({ id: '2' }), record({ id: '3', kind: 'file-change', changes: [{ path: 'a', kind: 'update' }, { path: 'b', kind: 'add' }] }), record({ id: '4', kind: 'tool' })])).toBe('Ran 2 commands, changed 2 files, used 1 tool')
    expect(turnHeadline(turn({ status: 'completed', durationMs: 124_000 }), false)).toBe('Worked for 2m 04s')
    expect(turnHeadline(turn({ status: 'completed' }), false)).toBe('Worked')
    expect(turnHeadline(turn({ status: 'interrupted', startedAt: at, completedAt: '2026-09-12T10:00:12.000Z' }), false)).toBe('Stopped after 12s')
    expect(turnHeadline(turn({ status: 'running' }), false)).toBe('Last seen working')
    expect(turnHeadline(turn({ status: 'unknown' }), false)).toBe('Outcome unknown')
  })

  it('fences provider output so it cannot close its own block', () => {
    expect(fenced('a\n````\nb\n', 'output')).toBe('`````output\na\n````\nb\n`````')
  })
})

describe('the action a thread is waiting on', () => {
  const started = '2026-09-12T10:00:00.000Z'
  const startedMs = Date.parse(started)
  const live = (patch: Partial<AgentActivity> = {}): Pick<AgentThread, 'status' | 'activities' | 'messages'> => ({
    status: 'running', messages: [message('u1', 'user')],
    activities: [turn({ status: 'running' }), record({ id: 'action', status: 'running', startedAt: started, ...patch })],
  })

  it('offers the running action whatever its age, and leaves the clock to the caller', () => {
    const action = blockingAction(live())
    expect(action?.id).toBe('action')
    expect(hasWaited(action!, startedMs + WAITING_AFTER_MS - 1)).toBe(false)
    expect(hasWaited(action!, startedMs + WAITING_AFTER_MS)).toBe(true)
  })

  it('offers nothing for kinds that are the model working rather than waiting', () => {
    for (const kind of ['reasoning', 'plan', 'status', 'file-change', 'compaction'] as const) {
      expect(blockingAction(live({ kind }))).toBeUndefined()
    }
    for (const kind of ['command', 'tool', 'subagent'] as const) {
      expect(blockingAction(live({ kind }))?.id).toBe('action')
    }
  })

  it('offers nothing without a start, a live turn, or a finished action', () => {
    expect(blockingAction(live({ startedAt: undefined }))).toBeUndefined()
    expect(blockingAction(live({ status: 'completed' }))).toBeUndefined()
    expect(blockingAction({ ...live(), status: 'idle' })).toBeUndefined()
    expect(hasWaited({ startedAt: undefined }, startedMs + WAITING_AFTER_MS)).toBe(false)
    expect(hasWaited({ startedAt: 'not a time' }, startedMs + WAITING_AFTER_MS)).toBe(false)
  })

  it('follows the latest running record, so a new action restarts the wait', () => {
    const later = '2026-09-12T10:00:19.000Z'
    const thread: Pick<AgentThread, 'status' | 'activities' | 'messages'> = {
      status: 'running', messages: [message('u1', 'user')],
      activities: [turn({ status: 'running' }), record({ id: 'first', status: 'running', startedAt: started, sequence: 1 }),
        record({ id: 'second', status: 'running', startedAt: later, sequence: 2 })],
    }
    const action = blockingAction(thread)
    expect(action?.id).toBe('second')
    expect(hasWaited(action!, Date.parse(later) + WAITING_AFTER_MS - 1)).toBe(false)
  })

  it('reads the command as it was run, and falls back to the title the provider gave', () => {
    expect(waitingLabel({ command: 'npm test -- --maxWorkers=2', title: 'Bash' })).toBe('npm test -- --maxWorkers=2')
    expect(waitingLabel({ command: '  npm test\n  --watch  ', title: 'Bash' })).toBe('npm test --watch')
    expect(waitingLabel({ command: undefined, title: 'WebFetch' })).toBe('WebFetch')
    expect(waitingLabel({ command: '   ', title: '  ' })).toBe('Running')
  })
})
