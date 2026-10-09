import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, providerIdOfLabel, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { requestDraftProvider } from '../../../src/shared/requestDrafts'

const thread: AgentThread = { id: 'thread', projectId: 'project', title: 'Thread', modelId: 'model', status: 'idle', messages: [], requests: [] }
const hostWith = (provider: string): AgentHostSnapshot => ({ ...EMPTY_AGENT_HOST, models: [{ id: 'model', name: 'Model', provider, ready: true }] })

describe('the provider that owns a request draft', () => {
  it('is the provider id the thread or its model carries', () => {
    expect(requestDraftProvider(hostWith('Codex'), { ...thread, providerId: 'grok' }, 'codex')).toBe('grok')
    expect(requestDraftProvider({ ...EMPTY_AGENT_HOST, models: [{ id: 'model', name: 'Model', provider: 'Codex', providerId: 'devin', ready: true }] }, thread, 'codex')).toBe('devin')
  })
  it('reads a legacy snapshot\'s model label as the provider\'s id or its name', () => {
    expect(requestDraftProvider(hostWith('claude'), thread, 'codex')).toBe('claude')
    expect(requestDraftProvider(hostWith('Claude Code'), thread, 'codex')).toBe('claude')
    expect(requestDraftProvider(hostWith('Grok'), thread, 'codex')).toBe('grok')
    expect(requestDraftProvider(hostWith('Grok Build'), thread, 'codex')).toBe('grok')
  })
  it('falls back for a label that names no provider', () => {
    expect(requestDraftProvider(hostWith('Acme'), thread, 'devin')).toBe('devin')
    expect(requestDraftProvider(EMPTY_AGENT_HOST, thread, 'devin')).toBe('devin')
  })
})

describe('the provider a model label names', () => {
  it('is the provider whose id or name the label is, in any case', () => {
    expect(providerIdOfLabel('claude')).toBe('claude')
    expect(providerIdOfLabel(' Claude Code ')).toBe('claude')
    expect(providerIdOfLabel('CODEX')).toBe('codex')
    expect(providerIdOfLabel('Grok Build')).toBe('grok')
    expect(providerIdOfLabel('Devin')).toBe('devin')
  })
  it('is nothing for any other label', () => {
    expect(providerIdOfLabel('Anthropic')).toBeUndefined()
    expect(providerIdOfLabel('Claude Code CLI')).toBeUndefined()
    expect(providerIdOfLabel('')).toBeUndefined()
  })
})
