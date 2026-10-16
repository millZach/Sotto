import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentProviderStatus, type AgentThread } from '../../../src/shared/agents'
import { CONTINUE_REFUSALS, continuedWordsOf, continueProviderRefusal, continueThreadRefusal } from '../../../src/shared/continueThread'
import { HANDOVER_LEAD } from '../../../src/shared/handover'
import { CLAUDE_SPENDING_LIMIT_SENTENCE, claudeUsageLimitSentence, limitStopOf } from '../../../src/shared/limitStops'

/** What the window and main both say about continuing a thread on another provider (ADR-0088). */
const thread = (patch: Partial<AgentThread> = {}): AgentThread => ({ id: 'source', projectId: 'project', title: 'WAV preview stall', modelId: 'claude:opus',
  providerId: 'claude', status: 'idle', requests: [], messages: [{ id: 'one', role: 'user', text: 'Fix it.', createdAt: '2026-10-16T10:00:00.000Z' }], ...patch })
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
const status = (patch: Partial<AgentProviderStatus>): AgentProviderStatus => ({ id: 'codex', connection: 'connected', name: 'Codex', version: '1', capabilities, ...patch })
const host = (providers: AgentProviderStatus[]): AgentHostSnapshot => ({ ...EMPTY_AGENT_HOST, connected: true, capabilities, providers })

describe('whether a thread can be continued', () => {
  it('can, at rest with something to hand over', () => {
    expect(continueThreadRefusal(thread())).toBeNull()
    expect(continueThreadRefusal(thread({ messages: [], summary: { messageCount: 3, activityCount: 0 } }))).toBeNull()
  })

  it('says why not, in the order a user would fix it', () => {
    expect(continueThreadRefusal(thread({ kind: 'watcher' }))).toBe(CONTINUE_REFUSALS.watcher)
    expect(continueThreadRefusal(thread({ remoteHost: true }))).toBe(CONTINUE_REFUSALS.remote)
    expect(continueThreadRefusal(thread({ archivedAt: '2026-10-16T10:00:00.000Z' }))).toBe(CONTINUE_REFUSALS.archived)
    expect(continueThreadRefusal(thread({ status: 'running' }))).toBe(CONTINUE_REFUSALS.busy)
    expect(continueThreadRefusal(thread({ lastTurn: { id: 'turn', status: 'running' } }))).toBe(CONTINUE_REFUSALS.busy)
    expect(continueThreadRefusal(thread({ requests: [{ id: 'ask', kind: 'question', text: 'Which?' }] as AgentThread['requests'] }))).toBe(CONTINUE_REFUSALS.busy)
    expect(continueThreadRefusal(thread({ nativeSessionStarted: false, messages: [] }))).toBe(CONTINUE_REFUSALS.unstarted)
    expect(continueThreadRefusal(thread({ messages: [], summary: { messageCount: 0, activityCount: 0 } }))).toBe(CONTINUE_REFUSALS.empty)
  })
})

describe('whether a provider can take a continued thread', () => {
  it('can when connected and able to start threads', () => {
    expect(continueProviderRefusal(host([status({})]), 'codex')).toBeNull()
  })

  it('says why not, with the next step', () => {
    expect(continueProviderRefusal(host([status({ connection: 'disconnected', problem: 'signed-out', id: 'grok', name: 'Grok Build' })]), 'grok'))
      .toBe('Grok Build isn’t signed in. Sign in under Settings → Providers to continue there.')
    expect(continueProviderRefusal(host([status({ connection: 'disconnected' })]), 'codex')).toBe('Codex isn’t connected. Connect it under Settings → Providers to continue there.')
    expect(continueProviderRefusal(host([status({ connection: 'connecting' })]), 'codex')).toBe('Codex is still connecting. Continue there once it is connected.')
    expect(continueProviderRefusal(host([status({ capabilities: { ...capabilities, threads: false } })]), 'codex')).toBe('Codex can’t start threads from Sotto.')
    expect(continueProviderRefusal(host([status({ connection: 'disconnected', problem: 'not-installed', id: 'devin', name: 'Devin' })]), 'devin'))
      .toBe('Devin isn’t installed. Install it under Settings → Providers to continue there.')
  })
})

describe('a continued thread’s excerpt', () => {
  const proof = { prefixLength: HANDOVER_LEAD.length + 20, prefixDigest: 'a'.repeat(64), counts: { total: 1, carried: 1, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: true } }
  const continued = { continuedFrom: { threadId: 'source', provider: 'claude' as const, at: '2026-10-16T10:00:00.000Z', handover: proof } }
  it('is the user’s words after the handover, and nothing when it was cut before them', () => {
    const text = `${HANDOVER_LEAD}${'x'.repeat(20)}Carry on.`
    expect(continuedWordsOf(continued, text)).toBe('Carry on.')
    expect(continuedWordsOf(continued, text.slice(0, proof.prefixLength))).toBeUndefined()
    expect(continuedWordsOf(continued, 'A later message.')).toBeUndefined()
    expect(continuedWordsOf({}, text)).toBeUndefined()
  })
})

describe('a limit stop, from Sotto’s own sentence', () => {
  it('reads a usage limit, with when it resets where Claude Code said', () => {
    expect(limitStopOf(claudeUsageLimitSentence('6pm'))).toEqual({ kind: 'usage', provider: 'claude', resetsAt: '6pm' })
    expect(limitStopOf(claudeUsageLimitSentence(undefined))).toEqual({ kind: 'usage', provider: 'claude' })
  })

  it('reads a spending limit, and nothing else', () => {
    expect(limitStopOf(CLAUDE_SPENDING_LIMIT_SENTENCE)).toEqual({ kind: 'spending', provider: 'claude' })
    expect(limitStopOf('Claude’s servers were busy or had a problem, so this turn stopped.')).toBeUndefined()
    expect(limitStopOf('You have hit your usage limit.')).toBeUndefined()
    expect(limitStopOf(undefined)).toBeUndefined()
  })
})
