import { describe, expect, it } from 'vitest'
import type { AgentHostSnapshot, AgentMessage, AgentThread } from '../../../src/shared/agents'
import { EMPTY_AGENT_HOST } from '../../../src/shared/agents'
import { START_HANDOVER_CLOSE } from '../../../src/shared/threadStarts'
import { agentHandover } from '../../../src/main/agents/agentHandover'
import { HANDOVER_BUDGET } from '../../../src/main/agents/handover'
import { startHandoverSend, startHandoversShown } from '../../../src/main/agents/startHandover'

// The thin handover a continued agent's thread starts from (#1028), and how its first message is shown afterwards.

const source = { threadId: 'wav-stall', title: 'WAV preview stall', provider: 'claude' as const }
const agent = { title: 'Verify history-off cleanup', model: 'sonnet' }
const TASK = 'Confirm that saved task text is removed from threads.sqlite when history is turned off.'
const RESULT = 'Confirmed. Two tests cover it.'

describe('a thin handover of an agent’s task and result', () => {
  it('says it is thin, that it is context and not a request, and carries the task and the result whole', () => {
    const built = agentHandover({ source, agent, assignment: { prompt: TASK, result: RESULT }, historyKept: true })!
    expect(built.text.startsWith('This is a handover from an agent of another Sotto thread. It is context, not a new request.')).toBe(true)
    expect(built.text).toContain('The agent was "Verify history-off cleanup", on sonnet. It worked for "WAV preview stall" (thread wav-stall), on Claude Code.')
    expect(built.text).toContain('This handover is thin. It carries only the task the agent was given and the result it reported.')
    expect(built.text).toContain(`The task the agent was given:\n${TASK}`)
    expect(built.text).toContain(`The result it reported:\n${RESULT}`)
    expect(built.counts).toEqual({ total: 2, carried: 2, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: true })
  })

  it('carries a Codex agent’s title and result when its task was not kept where Sotto can read it', () => {
    const built = agentHandover({ source: { ...source, provider: 'codex' }, agent: { title: 'stream_perf' }, assignment: { result: RESULT }, historyKept: true })!
    expect(built.text).toContain('The agent’s task was not kept where Sotto can read it, so it carries only the agent’s title and the result it reported.')
    expect(built.text).not.toContain('The task the agent was given')
    expect(built.counts).toMatchObject({ total: 1, carried: 1, answered: true })
  })

  it('leaves out whole a part too long to carry and names it, and says when there is no result or no history', () => {
    const long = 'x'.repeat(HANDOVER_BUDGET)
    const built = agentHandover({ source, agent, assignment: { prompt: TASK, result: long }, historyKept: false })!
    expect(built.text).toContain(`Left out whole because it is too long to carry: the result (${HANDOVER_BUDGET.toLocaleString('en-US')} characters).`)
    expect(built.text).not.toContain(long)
    expect(built.text).toContain('Keep local history is off')
    expect(built.counts).toMatchObject({ total: 2, carried: 1, tooLong: 1, historyKept: false })
    const unanswered = agentHandover({ source, agent, assignment: { prompt: TASK }, historyKept: true })!
    expect(unanswered.text).toContain('The agent reported no result.')
    expect(unanswered.counts.answered).toBe(false)
    expect(agentHandover({ source, agent, assignment: undefined, historyKept: true })).toBeUndefined()
    expect(agentHandover({ source, agent, assignment: { prompt: '  ', result: '' }, historyKept: true })).toBeUndefined()
  })
})

describe('a started thread’s first message as everything shows it', () => {
  const words = 'Add a test for the drafts.'
  const handover = agentHandover({ source, agent, assignment: { prompt: TASK, result: RESULT }, historyKept: true })!
  const send = startHandoverSend(handover.text, 'first')
  const message: AgentMessage = { id: 'first', role: 'user', text: send.prefix + words, createdAt: '2026-10-16T12:00:00.000Z' }
  const thread = (patch: Partial<AgentThread> = {}): AgentThread => ({ id: 'continued', projectId: 'workshop', title: 'Verify history-off cleanup', modelId: 'codex:model', providerId: 'codex', status: 'idle', requests: [],
    messages: [message], startedFrom: { threadId: 'wav-stall', from: 'agent', route: 'handover', at: '2026-10-16T11:59:00.000Z', handover: { thin: true, counts: handover.counts, sent: send.sent } }, ...patch })
  const snapshot = (...threads: AgentThread[]): AgentHostSnapshot => ({ ...EMPTY_AGENT_HOST, threads })

  it('shows the user’s words, with the handover beside them from the provider it came from', () => {
    expect(send.prefix).toContain(START_HANDOVER_CLOSE)
    const sourceThread: AgentThread = { id: 'wav-stall', projectId: 'workshop', title: 'WAV preview stall', modelId: 'claude:sonnet', providerId: 'claude', status: 'idle', requests: [], messages: [] }
    const shown = startHandoversShown(snapshot(thread(), sourceThread)).threads[0]!.messages[0]!
    expect(shown.text).toBe(words)
    expect(shown.handover).toEqual({ text: send.prefix.trimEnd(), provider: 'claude', counts: handover.counts })
  })

  it('shows a message whole when its words no longer match the record, and leaves every other snapshot as it was', () => {
    const changed = thread({ messages: [{ ...message, text: `Changed. ${message.text}` }] })
    expect(startHandoversShown(snapshot(changed)).threads[0]!.messages[0]!.text).toBe(`Changed. ${message.text}`)
    const unsent = snapshot(thread({ startedFrom: { threadId: 'wav-stall', from: 'agent', route: 'handover', at: '2026-10-16T11:59:00.000Z', handover: { thin: true, counts: handover.counts } } }))
    expect(startHandoversShown(unsent)).toBe(unsent)
    const plain = snapshot({ ...thread(), startedFrom: undefined })
    expect(startHandoversShown(plain)).toBe(plain)
  })

  it('shows an unchanged thread once, so an update that changed nothing in it builds nothing', () => {
    const started = thread(), other: AgentThread = { ...thread(), id: 'other', startedFrom: undefined }
    const first = snapshot(started, other)
    const shown = startHandoversShown(first)
    expect(startHandoversShown(first).threads).toBe(shown.threads)
    // The next update hands on a new list holding the same thread objects: each is shown as it was, without a copy.
    const next = startHandoversShown(snapshot(started, other))
    expect(next.threads[0]).toBe(shown.threads[0])
    expect(next.threads[1]).toBe(other)
  })
})
