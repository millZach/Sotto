import { describe, expect, it } from 'vitest'
import type { AgentThread } from '../../../src/shared/agents'
import { antigravityAnswerTokens, countAntigravityAnswer, countAntigravityFullness } from '../../../src/main/agents/antigravityThreadUsage'

const answer = (inputTokens: number, outputTokens: number, cachedReadTokens = 0) =>
  ({ stopReason: 'end_turn', usage: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens: 0, thoughtTokens: 1, totalTokens: inputTokens + outputTokens + cachedReadTokens } })
const thread = (): AgentThread => ({ id: 't', modelId: 'gemini-3.8-flash' }) as AgentThread

describe('an Antigravity thread’s token count', () => {
  it('counts the whole prompt as input, adding back what agy read from its cache', () => {
    expect(antigravityAnswerTokens(answer(2162, 23, 7018))).toEqual({ input: 9180, output: 23, cached: 7018, cacheWrite: 0 })
    expect(antigravityAnswerTokens({ stopReason: 'end_turn' })).toBeUndefined()
    expect(antigravityAnswerTokens({ stopReason: 'end_turn', usage: { inputTokens: -1 } })).toBeUndefined()
  })

  it('keeps the newest prompt’s tokens as latest when an earlier, steered prompt answers after it', () => {
    const subject = thread()
    expect(countAntigravityAnswer(subject, answer(100, 10), true)).toBe(true)
    expect(countAntigravityAnswer(subject, answer(50, 5), false)).toBe(true)
    expect(subject.usage).toMatchObject({ latest: { input: 100, output: 10 }, total: { input: 150, output: 15 }, partial: true })
  })

  it('reads how full the context is, on the thread’s model', () => {
    const subject = thread()
    expect(countAntigravityFullness(subject, { sessionUpdate: 'usage_update', used: 9101, size: 1048576 })).toBe(true)
    expect(subject.usage).toMatchObject({ contextUsed: 9101, contextWindow: 1048576, modelId: 'gemini-3.8-flash' })
    expect(countAntigravityFullness(subject, { sessionUpdate: 'usage_update' })).toBe(false)
  })
})
