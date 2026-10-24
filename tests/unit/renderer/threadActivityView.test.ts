// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentThread } from '../../../src/shared/agents'
import { share } from '../../../src/renderer/src/agents/stateSharing'
import {
  activityLabel, heldAction, currentAction, fenced, formatDuration, groupSummary, heldLongEnough, liveTurnId, newsWorkLabel, openActivityLabel, placeActivities, splitTurns,
  statusText, timingNote, turnHeadline, heldLabel, HELD_AFTER_MS,
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

  it('places a turn whose records name no loaded message after its own user message', () => {
    const activities = [
      record({ id: 'first', afterMessageId: 'gone', turnId: 'u2', sequence: 1 }),
      record({ id: 'second', turnId: 'u2', sequence: 2 }),
    ]
    const placement = placeActivities(messages, messages, activities)
    expect(placement.after.get('u2')!.flatMap(group => group.records.map(item => item.id))).toEqual(['first', 'second'])
    expect(placement.trailing).toEqual([])
  })

  it('keeps group keys stable while records update in place', () => {
    const first = placeActivities(messages, messages, [record({ id: 'a', afterMessageId: 'u1', sequence: 3, status: 'running' })])
    const second = placeActivities(messages, messages, [record({ id: 'a', afterMessageId: 'u1', sequence: 3, status: 'completed' }), record({ id: 'b', afterMessageId: 'u1', sequence: 4 })])
    expect(second.after.get('u1')![0]!.key).toBe(first.after.get('u1')![0]!.key)
  })
})

describe('placing activity when the messages are a window of a longer history', () => {
  // The shape of a long Claude thread whose pane holds its last turns: the store keeps every message and
  // the pane loads a window of them. Main keeps back the work it can place above the window, so in the app
  // these records reach the pane only when main could not place them (a turn naming a message the store no
  // longer holds); the pane still never stacks them under the newest answer.
  const history = [
    message('u0', 'user'), message('a0'), message('u1', 'user'), message('a1'),
    message('u2', 'user'), message('a2'), message('u3', 'user'), message('a3'),
  ]
  const loaded = history.slice(4)
  const activities = [
    turn({ turnId: 'u0', afterMessageId: 'u0', status: 'completed', sequence: 0 }),
    record({ id: 'u0-cmd', turnId: 'u0', afterMessageId: 'a0', sequence: 1 }),
    record({ id: 'u0-agent', turnId: 'u0', kind: 'subagent', sequence: 2 }),
    turn({ turnId: 'u1', afterMessageId: 'u1', status: 'completed', sequence: 3 }),
    record({ id: 'u1-cmd', turnId: 'u1', afterMessageId: 'a1', status: 'failed', exitCode: 1, sequence: 4 }),
    turn({ turnId: 'u2', afterMessageId: 'u2', status: 'completed', sequence: 5 }),
    record({ id: 'u2-cmd', turnId: 'u2', afterMessageId: 'a2', sequence: 6 }),
    turn({ turnId: 'u3', afterMessageId: 'u3', status: 'running', sequence: 7 }),
    record({ id: 'u3-cmd', turnId: 'u3', afterMessageId: 'a3', status: 'running', sequence: 8 }),
  ]
  const placed = (placement: ReturnType<typeof placeActivities>): Record<string, string[]> => Object.fromEntries(
    [...placement.after].map(([id, groups]) => [id, groups.flatMap(group => group.records.map(item => item.id))]))

  it('never stacks the turns above the window under the newest answer', () => {
    const placement = placeActivities(loaded, loaded, activities, false, true)
    expect(placement.trailing).toEqual([])
    expect(placement.leading).toEqual([])
    expect(placed(placement)).toEqual({ a2: ['u2-cmd'], a3: ['u3-cmd'] })
  })

  it('gives those turns their places once the earlier messages are loaded', () => {
    const placement = placeActivities(history, history, activities)
    expect(placement.trailing).toEqual([])
    expect(placement.leading).toEqual([])
    expect(placed(placement)).toEqual({ a0: ['u0-cmd', 'u0-agent'], a1: ['u1-cmd'], a2: ['u2-cmd'], a3: ['u3-cmd'] })
  })

  it('shows earlier work it cannot place ahead of the conversation when no earlier messages exist', () => {
    const placement = placeActivities(loaded, loaded, activities)
    expect(placement.leading.map(group => group.records.map(item => item.id))).toEqual([['u0-cmd', 'u0-agent'], ['u1-cmd']])
    expect(placement.leading.map(group => group.turn?.turnId)).toEqual(['u0', 'u1'])
    expect(placement.trailing).toEqual([])
    // Above the rendered page, it waits with the messages there.
    expect(placeActivities(loaded, loaded.slice(2), activities).leading).toEqual([])
    expect(placeActivities(loaded, loaded, activities, true).leading).toEqual([])
  })

  it('still trails a new turn whose own messages have not arrived', () => {
    const placement = placeActivities(loaded, loaded, [...activities, record({ id: 'next', turnId: 'u4', afterMessageId: 'a4', status: 'running', sequence: 9 })], false, true)
    expect(placement.trailing.map(group => group.records.map(item => item.id))).toEqual([['next']])
    expect(placement.leading).toEqual([])
  })

  it('trails the only turn it has when no turn is placed, whether or not earlier messages exist', () => {
    // A provider turn ID that is not a message, on a thread whose message has not reached the pane yet.
    const live = [record({ id: 'first', turnId: 'codex-turn-9', afterMessageId: 'u9', status: 'running', sequence: 0 })]
    for (const earlier of [false, true]) {
      const placement = placeActivities(loaded, loaded, live, false, earlier)
      expect(placement.trailing.map(group => group.records.map(item => item.id))).toEqual([['first']])
      expect(placement.leading).toEqual([])
    }
    expect(placeActivities([], [], live).trailing.map(group => group.records.map(item => item.id))).toEqual([['first']])
  })
})

describe('the newest turn the placement reads', () => {
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 23, 11, minute)).toISOString()
  const messages: AgentMessage[] = [{ id: 'you', role: 'user', text: 'Check the threads.', createdAt: at(0) }, { id: 'answer', role: 'assistant', text: 'All quiet.', createdAt: at(1) }]
  const activities: AgentActivity[] = [{ id: 'turn-you', turnId: 'you', afterMessageId: 'you', sequence: 0, kind: 'turn', status: 'completed', title: 'Turn', startedAt: at(0), completedAt: at(1) }]

  it('says the newest turn finished from a lifecycle that draws nothing, until a reply is written after it ended', () => {
    expect(placeActivities(messages, messages, activities).newestTurn).toEqual({ turnIds: ['you'], lifecycle: 'finished' })
    const report: AgentMessage = { id: 'report', role: 'assistant', text: 'The review found', createdAt: at(5) }
    expect(placeActivities([...messages, report], [...messages, report], activities).newestTurn).toEqual({ turnIds: ['you'] })
  })

  it('is the same value on every update that changes nothing, so the placement that holds it is shared', () => {
    const first = placeActivities(messages, messages, activities)
    expect(share(first, placeActivities(messages, messages, activities.map(record => ({ ...record }))))).toBe(first)
  })
})

describe('placing the work of an unshown turn', () => {
  // Watcher's conversation leaves out each news wake-up (watcherWakeUpsAsShown), so the news turn's work names a message
  // the transcript does not have. Times follow Zach's Watcher thread of October 19, 2026.
  const clock = (time: string): string => `2026-10-19T11:${time}Z`
  const said = (id: string, role: AgentMessage['role'], time: string, turnMessageId?: string): AgentMessage =>
    ({ id, role, text: id, createdAt: clock(time), ...(turnMessageId ? { turnMessageId } : {}) })
  const work = (turnId: string, from: string, to: string, kinds: AgentActivity['kind'][], first: number): AgentActivity[] => [
    { id: `turn-${turnId}`, turnId, afterMessageId: turnId, sequence: first, kind: 'turn', status: 'completed', title: 'Turn', startedAt: clock(from), completedAt: clock(to) },
    ...kinds.map((kind, index): AgentActivity => ({ id: `${turnId}-${index}`, turnId, afterMessageId: turnId, sequence: first + index + 1, kind, status: 'completed', title: kind,
      startedAt: clock(from), completedAt: clock(to) })),
  ]
  // You, Watcher's answer, two news turns (one wrote nothing), then you again with the answer.
  const messages = [
    said('you-1', 'user', '56:40.379'), said('answer-1', 'assistant', '56:50.463'),
    said('news-reply-1', 'assistant', '56:59.843'),
    said('you-2', 'user', '59:05.573'), said('answer-2', 'assistant', '59:33.423'),
  ]
  const activities = [
    ...work('you-1', '56:41.291', '56:50.600', ['reasoning', 'tool'], 0),
    ...work('news-1', '56:54.086', '57:00.000', ['tool', 'reasoning'], 10),
    ...work('news-2', '57:29.544', '57:36.613', ['tool'], 20),
    ...work('you-2', '59:06.224', '59:33.500', ['reasoning', 'tool'], 30),
  ]

  it('puts a news turn’s work with the reply it wrote, and one that wrote none before the message after it, never at the end', () => {
    const placement = placeActivities(messages, messages, activities)
    expect(placement.trailing).toEqual([])
    expect(placement.unshown.get('news-reply-1')!.map(group => group.turnId)).toEqual(['news-1'])
    expect(placement.before.get('you-2')!.map(group => group.turnId)).toEqual(['news-2'])
    expect([...placement.after.keys()]).toEqual(['you-1', 'you-2'])
  })

  it('takes the reply that names the turn over the one the clocks would pick', () => {
    const named = [...messages.slice(0, 2), said('stray', 'assistant', '56:55.000', 'you-1'), said('news-reply-1', 'assistant', '56:59.843', 'news-1'), ...messages.slice(3)]
    expect(placeActivities(named, named, activities).unshown.get('news-reply-1')!.map(group => group.turnId)).toEqual(['news-1'])
    expect(placeActivities(named, named, activities).unshown.has('stray')).toBe(false)
  })

  it('opens a turn at the reply, so it never reads as the answer to your message above it', () => {
    const placement = placeActivities(messages, messages, activities)
    expect(splitTurns(messages, placement.unshown).map(turn => [turn.user?.id, turn.replies.map(reply => reply.id), turn.unshown])).toEqual([
      ['you-1', ['answer-1'], undefined], [undefined, ['news-reply-1'], true], ['you-2', ['answer-2'], undefined],
    ])
  })

  it('trails a news turn nothing came after, and one it cannot date', () => {
    const running = [...activities, ...work('news-3', '59:40.000', '59:45.000', ['tool'], 40)]
    expect(placeActivities(messages, messages, running).trailing.map(group => group.turnId)).toEqual(['news-3'])
    const undated = activities.map(item => item.turnId === 'news-1' ? { ...item, startedAt: undefined, completedAt: undefined } : item)
    expect(placeActivities(messages, messages, undated).trailing.map(group => group.turnId)).toEqual(['news-1'])
  })

  it('opens a turn at a reply that names an unshown message, even once the turn’s work is gone from the records', () => {
    const named = [...messages.slice(0, 2), said('news-reply-1', 'assistant', '56:59.843', 'news-1'), said('more', 'assistant', '57:01.000', 'news-1'), ...messages.slice(3)]
    expect([...placeActivities(named, named, []).unshown]).toEqual([['news-reply-1', []]])
    expect(placeActivities(named, named, activities.filter(item => !item.turnId.startsWith('news'))).unshown.get('news-reply-1')).toEqual([])
    // A reply before the first user message the window holds may name one above the window, so it is not read.
    const window = [said('cut', 'assistant', '56:10.000', 'above'), ...named]
    expect(placeActivities(window, window, []).unshown.has('cut')).toBe(false)
  })

  it('places a news turn by its reply even when the turn before it lost its work to trimming', () => {
    // The records keep only the newest turns' work, so the news turn is the oldest one left; it is still not above the messages.
    const trimmed = activities.filter(item => item.turnId !== 'you-1')
    const placement = placeActivities(messages, messages, trimmed)
    expect(placement.leading).toEqual([])
    expect(placement.unshown.get('news-reply-1')!.map(group => group.turnId)).toEqual(['news-1'])
    expect(placement.before.get('you-2')!.map(group => group.turnId)).toEqual(['news-2'])
  })

  it('opens a turn at a reply it claims by time even when none of the turn’s work is shown', () => {
    // A Codex or Grok news turn trimmed to its finished lifecycle: nothing of it is drawn, but its reply is still its own.
    const lone = activities.filter(item => item.turnId !== 'news-1' || item.kind === 'turn')
    const placement = placeActivities(messages, messages, lone)
    expect(placement.unshown.get('news-reply-1')).toEqual([])
    expect(splitTurns(messages, placement.unshown).map(turn => turn.key)).toEqual(['you-1', 'unshown:news-reply-1', 'you-2'])
  })

  it('never lets a turn that ended before a reply was written claim it', () => {
    // news-2 ended at 57:36.613 and wrote nothing; the reply after it came from a turn Sotto has no times for.
    const late = [...messages.slice(0, 3), said('late-reply', 'assistant', '58:20.000'), ...messages.slice(3)]
    const placement = placeActivities(late, late, activities)
    expect(placement.unshown.has('late-reply')).toBe(false)
    expect(placement.before.get('you-2')!.map(group => group.turnId)).toEqual(['news-2'])
  })

  it('claims the reply when the turn’s own records began later than the turn, as real ones do', () => {
    // Each record starts when it starts; only another turn's start closes the window for the reply.
    const staggered = activities.map(item => item.turnId === 'news-1' && item.kind !== 'turn' ? { ...item, startedAt: clock(`56:5${5 + item.sequence % 3}.000`) } : item)
    expect(placeActivities(messages, messages, staggered).unshown.get('news-reply-1')!.map(group => group.turnId)).toEqual(['news-1'])
  })

  it('opens a turn at the reply its own records follow, when it began from a message the conversation leaves out', () => {
    // Codex and Grok Build anchor a turn's later records to the last message, which is the news reply being written.
    const anchored: AgentActivity[] = [
      ...activities.filter(item => item.turnId !== 'news-1'),
      { id: 'turn-codex', turnId: 'codex-turn', afterMessageId: 'hidden-wake-up', sequence: 10, kind: 'turn', status: 'completed', title: 'Turn', startedAt: clock('56:54.086'), completedAt: clock('57:00.000') },
      { id: 'codex-tool', turnId: 'codex-turn', afterMessageId: 'news-reply-1', sequence: 11, kind: 'tool', status: 'completed', title: 'read_thread' },
    ]
    const placement = placeActivities(messages, messages, anchored)
    expect(placement.unshown.get('news-reply-1')).toEqual([])
    expect(placement.after.get('news-reply-1')!.map(group => group.turnId)).toEqual(['codex-turn'])
    expect(splitTurns(messages, placement.unshown).map(turn => turn.key)).toEqual(['you-1', 'unshown:news-reply-1', 'you-2'])
  })

  it('claims by time only for a turn that began inside the window, and never a reply that names another turn', () => {
    const window = [said('answer-0', 'assistant', '56:30.000'), ...messages]
    const before = [...activities, ...work('older', '56:20.000', '56:25.000', ['tool'], 50)]
    expect(placeActivities(window, window, before).unshown.has('answer-0')).toBe(false)
    const answered = [messages[0]!, said('answer-1', 'assistant', '56:50.463', 'you-1'), ...messages.slice(2)]
    const overlapping = [...activities.filter(item => item.turnId !== 'you-1'), ...work('stray', '56:45.000', '56:52.000', ['tool'], 50)]
    expect(placeActivities(answered, answered, overlapping).unshown.has('answer-1')).toBe(false)
  })

  it('gives a reply to one turn when two began at the same moment', () => {
    const twins = [...activities, ...work('news-1b', '56:54.086', '57:00.000', ['tool'], 50)]
    const placement = placeActivities(messages, messages, twins)
    expect(placement.unshown.get('news-reply-1')!.map(group => group.turnId)).toEqual(['news-1'])
    // The other wrote nothing it can claim, so it goes before the next turn the transcript starts: that reply.
    expect(placement.before.get('news-reply-1')!.map(group => group.turnId)).toEqual(['news-1b'])
  })

  it('claims nothing by time while the history is loading', () => {
    const placement = placeActivities(messages, messages, activities, true)
    expect(placement.unshown.size).toBe(0)
    expect(placement.trailing).toEqual([])
  })

  it('shows nothing for a reply above the rendered page', () => {
    expect(placeActivities(messages, messages.slice(3), activities).unshown.size).toBe(0)
  })

  it('says how long the news turn took, or how it ended', () => {
    const [lifecycle] = work('news-1', '56:54.086', '57:00.000', [], 0)
    expect(newsWorkLabel(lifecycle, false, undefined, [])).toBe('After news · 5.9s')
    expect(newsWorkLabel({ ...lifecycle!, status: 'failed' }, false, undefined, [])).toBe('After news · failed after 5.9s')
    expect(newsWorkLabel(undefined, false, undefined, [])).toBe('After news')
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
    // A turn a steer cut short says so, rather than reading as one the user stopped.
    expect(turnHeadline(turn({ status: 'interrupted', steered: true, startedAt: at, completedAt: '2026-09-12T10:00:12.000Z' }), false)).toBe('Steered after 12s')
    expect(turnHeadline(turn({ status: 'interrupted', steered: true }), false)).toBe('Steered')
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
    const action = heldAction(live())
    expect(action?.id).toBe('action')
    expect(heldLongEnough(action!, startedMs + HELD_AFTER_MS - 1)).toBe(false)
    expect(heldLongEnough(action!, startedMs + HELD_AFTER_MS)).toBe(true)
  })

  it('offers nothing for kinds that are the model working rather than waiting', () => {
    for (const kind of ['reasoning', 'plan', 'status', 'file-change', 'compaction'] as const) {
      expect(heldAction(live({ kind }))).toBeUndefined()
    }
    for (const kind of ['command', 'tool', 'subagent'] as const) {
      expect(heldAction(live({ kind }))?.id).toBe('action')
    }
  })

  it('offers nothing without a start, a live turn, or a finished action', () => {
    expect(heldAction(live({ startedAt: undefined }))).toBeUndefined()
    expect(heldAction(live({ status: 'completed' }))).toBeUndefined()
    expect(heldAction({ ...live(), status: 'idle' })).toBeUndefined()
    expect(heldLongEnough({ startedAt: undefined }, startedMs + HELD_AFTER_MS)).toBe(false)
    expect(heldLongEnough({ startedAt: 'not a time' }, startedMs + HELD_AFTER_MS)).toBe(false)
  })

  it('follows the latest running record, so a new action restarts the wait', () => {
    const later = '2026-09-12T10:00:19.000Z'
    const thread: Pick<AgentThread, 'status' | 'activities' | 'messages'> = {
      status: 'running', messages: [message('u1', 'user')],
      activities: [turn({ status: 'running' }), record({ id: 'first', status: 'running', startedAt: started, sequence: 1 }),
        record({ id: 'second', status: 'running', startedAt: later, sequence: 2 })],
    }
    const action = heldAction(thread)
    expect(action?.id).toBe('second')
    expect(heldLongEnough(action!, Date.parse(later) + HELD_AFTER_MS - 1)).toBe(false)
  })

  it('reads the command as it was run, and falls back to the title the provider gave', () => {
    expect(heldLabel({ command: 'npm test -- --maxWorkers=2', title: 'Bash' })).toBe('npm test -- --maxWorkers=2')
    expect(heldLabel({ command: '  npm test\n  --watch  ', title: 'Bash' })).toBe('npm test --watch')
    expect(heldLabel({ command: undefined, title: 'WebFetch' })).toBe('WebFetch')
    expect(heldLabel({ command: '   ', title: '  ' })).toBe('Running')
  })
})
