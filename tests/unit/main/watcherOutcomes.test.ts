// @vitest-environment node
import { expect, it } from 'vitest'
import type { AgentThread } from '../../../src/shared/agents'
import { EMPTY_SUBAGENT_SUMMARY } from '../../../src/shared/subagents'
import { markTurnActivity } from '../../../src/main/agents/turnActivity'
import { watcherLatestTurnMessageId, watcherTurnOutcome } from '../../../src/main/agents/watcherOutcomes'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 10, 0, seconds)).toISOString()
function thread(overrides: Partial<AgentThread> = {}): AgentThread {
  return { id: 'worker', projectId: 'project', modelId: 'model', title: 'Worker', status: 'idle', requests: [], messages: [
    { id: 'brief', role: 'user', text: 'Synthetic brief', createdAt: at(0) },
    { id: 'reply', role: 'assistant', text: 'Synthetic reply', createdAt: at(2) },
  ], ...overrides }
}
const brief = { messageId: 'brief', delivery: 'now' as const }
const watcher = (id: string) => id === 'brief'

it('concludes nothing before the thread shows the brief, and nothing for a brief without a message', () => {
  expect(watcherTurnOutcome({ messageId: 'elsewhere', delivery: 'now' }, thread(), watcher)).toBeUndefined()
  expect(watcherTurnOutcome({ delivery: 'now' }, thread(), watcher)).toBeUndefined()
})

it('reads a shown brief with no turn of its own yet as working', () => {
  expect(watcherTurnOutcome(brief, thread({ status: 'running' }), watcher)).toEqual({ outcome: 'working' })
})

it.each([['failed', 'failed'], ['unknown', 'unknown']] as const)('reads a %s turn as %s', (status, outcome) => {
  const activities = markTurnActivity([], { provider: 'grok', turnId: 'brief', status, at: Date.parse(at(1)) })
  expect(watcherTurnOutcome(brief, thread({ activities }), watcher)).toMatchObject({ outcome, turnMessageId: 'brief' })
})

it('takes the newest turn\'s ending from the provider\'s own report when it names the same turn', () => {
  const activities = markTurnActivity([], { provider: 'codex', turnId: 'native-turn', afterMessageId: 'brief', status: 'running', at: Date.parse(at(1)) })
  const finished = thread({ activities, lastTurn: { id: 'native-turn', status: 'completed' } })
  expect(watcherTurnOutcome(brief, finished, watcher)).toEqual({ outcome: 'answered', turnMessageId: 'brief', nativeTurnId: 'native-turn', replyMessageId: 'reply' })
  expect(watcherLatestTurnMessageId(finished)).toBe('brief')
  // A newest turn of another identity is not taken for this one.
  expect(watcherTurnOutcome(brief, thread({ activities, lastTurn: { id: 'other-turn', status: 'completed' } }), watcher)).toEqual({ outcome: 'working', turnMessageId: 'brief' })
})

it('gives a held steer\'s turn only the replies written after it started', () => {
  const messages: AgentThread['messages'] = [
    { id: 'brief', role: 'user', text: 'Synthetic brief', createdAt: at(0) },
    { id: 'steer', role: 'user', text: 'Synthetic held steer', createdAt: at(1) },
    { id: 'first-reply', role: 'assistant', text: 'Synthetic first reply', createdAt: at(2) },
    { id: 'second-reply', role: 'assistant', text: 'Synthetic second reply', createdAt: at(4) },
  ]
  let activities = markTurnActivity([], { provider: 'claude', turnId: 'brief', status: 'completed', at: Date.parse(at(0)) })
  activities = markTurnActivity(activities, { provider: 'claude', turnId: 'steer', status: 'completed', at: Date.parse(at(3)) })
  const ours = (id: string) => id === 'brief' || id === 'steer'
  expect(watcherTurnOutcome(brief, thread({ messages, activities }), ours)).toMatchObject({ outcome: 'answered', replyMessageId: 'first-reply' })
  expect(watcherTurnOutcome({ messageId: 'steer', delivery: 'steer' }, thread({ messages, activities }), ours))
    .toMatchObject({ outcome: 'answered', turnMessageId: 'steer', replyMessageId: 'second-reply' })
})

it('keeps a finished newest turn in background while work or unknown sub-agents remain', () => {
  const activities = markTurnActivity([], { provider: 'grok', turnId: 'brief', status: 'completed', at: Date.parse(at(1)) })
  expect(watcherTurnOutcome(brief, thread({ activities, subagentSummary: { ...EMPTY_SUBAGENT_SUMMARY, unknown: 1, total: 1 } }), watcher))
    .toMatchObject({ outcome: 'background' })
  expect(watcherTurnOutcome(brief, thread({ activities, monitoring: [{ id: '00000000-0000-4000-8000-000000000009', label: 'Synthetic watch' }] }), watcher))
    .toMatchObject({ outcome: 'background' })
  expect(watcherTurnOutcome(brief, thread({ activities }), watcher)).toMatchObject({ outcome: 'answered', replyMessageId: 'reply' })
})

it('keeps a turn cut for a steer working until the turn the steer runs as is shown', () => {
  const activities = markTurnActivity([], { provider: 'claude', turnId: 'brief', status: 'interrupted', steered: true, at: Date.parse(at(1)) })
  expect(watcherTurnOutcome(brief, thread({ status: 'running', activities }), watcher)).toEqual({ outcome: 'working', turnMessageId: 'brief' })
})

it('keeps a brief seen in background there while work remains, even after another turn begins', () => {
  const messages: AgentThread['messages'] = [...thread().messages, { id: 'later', role: 'user', text: 'Synthetic later message', createdAt: at(3) }]
  let activities = markTurnActivity([], { provider: 'grok', turnId: 'brief', status: 'completed', at: Date.parse(at(0)) })
  activities = markTurnActivity(activities, { provider: 'grok', turnId: 'later', status: 'running', at: Date.parse(at(3)) })
  const backgroundWork = [{ id: '00000000-0000-4000-8000-000000000008', label: 'Synthetic agent', type: 'subagent' as const }]
  const seen = { ...brief, outcome: 'background' as const }
  expect(watcherTurnOutcome(seen, thread({ messages, activities, status: 'running', backgroundWork }), watcher)).toMatchObject({ outcome: 'background' })
  expect(watcherTurnOutcome(seen, thread({ messages, activities, status: 'running' }), watcher)).toMatchObject({ outcome: 'answered', replyMessageId: 'reply' })
})
