// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readThinkingLevels, thinkingConfig, withLevels, type DevinLevels, type ThinkingLane } from '../../../src/main/agents/devinThinking'
import { DevinRejected } from '../../../src/main/agents/devinRpc'

/** A config answer as Devin CLI 3000.14 gives one, with a `thought_level` option where `levels` has any. */
const answer = (levels: string[], current = levels[0] ?? '') => ({ configOptions: [
  { id: 'model', currentValue: 'm', options: [{ value: 'm', name: 'M' }] },
  ...(levels.length ? [{ id: 'thought_level', currentValue: current, options: levels.map(value => ({ value, name: value })) }] : []),
] })

describe('Devin thinking levels', () => {
  it('reads a model\'s levels lowest first and the level a session starts on', () => {
    expect(thinkingConfig(answer(['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'))).toEqual({
      current: 'medium', levels: { levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' } })
    expect(thinkingConfig(answer([]))).toBeUndefined()
  })
  it('marks a model with no levels, and leaves one not read without any', () => {
    const model = { id: 'm', name: 'M', provider: 'Devin', ready: true, reasoningEfforts: ['old'], defaultReasoningEffort: 'old' }
    expect(withLevels(model, { levels: ['low', 'high'], default: 'high' })).toMatchObject({ reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' })
    expect(withLevels(model, { levels: [] })).toEqual({ id: 'm', name: 'M', provider: 'Devin', ready: true, reasoningEfforts: [], noReasoningEfforts: true })
    expect(withLevels(model, undefined)).toEqual({ id: 'm', name: 'M', provider: 'Devin', ready: true })
  })
  it('shares the models between lanes, leaves a refused one unread, and stops when the connection goes', async () => {
    const levels: Record<string, string[]> = { a: ['low', 'high'], b: [], c: ['medium'], d: ['max'], e: ['low'] }
    const found = new Map<string, DevinLevels>()
    const opened: string[] = []
    let live = true
    const open = async (): Promise<ThinkingLane> => {
      const sessionId = `s${opened.length}`; opened.push(sessionId)
      return { sessionId, close: async () => undefined,
        request: async (_method, params, apply) => {
          const model = (params as { value: string }).value
          if (model === 'c') throw new DevinRejected(-32602)
          if (model === 'd') live = false
          apply(answer(levels[model]!))
        } }
    }
    await readThinkingLevels({ models: ['a', 'b', 'c', 'd', 'e'], lanes: 1, open, current: () => live, found: (id, value) => found.set(id, value) })
    expect(opened).toEqual(['s0'])
    expect([...found.keys()]).toEqual(['a', 'b'])
    expect(found.get('b')).toEqual({ levels: [] })

    live = true; found.clear(); opened.length = 0
    await readThinkingLevels({ models: ['a', 'b', 'e'], lanes: 4, open, current: () => live, found: (id, value) => found.set(id, value) })
    expect(opened).toHaveLength(3)
    expect([...found.keys()].sort()).toEqual(['a', 'b', 'e'])
  })
  it('ends a lane whose process fails, without guessing the rest', async () => {
    const found: string[] = []
    let closed = 0
    await readThinkingLevels({ models: ['a', 'b', 'c'], lanes: 1, current: () => true, found: id => found.push(id),
      open: async () => ({ sessionId: 's', close: async () => { closed++ },
        request: async (_method, params, apply) => {
          if ((params as { value: string }).value === 'b') throw new Error('Devin stopped.')
          apply(answer(['low']))
        } }) })
    expect(found).toEqual(['a'])
    expect(closed).toBe(1)
  })
})
