// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentModel } from '../../../src/shared/agents'
import { councilFairnessEffort, councilSeatNotes, councilSeatsInForce, councilModelOrder } from '../../../src/shared/council'
import type { CouncilAnswer, CouncilReview } from '../../../src/shared/councilBlocks'
import { councilCounts, reviewAssignments } from '../../../src/shared/councilFlow'

describe('who reviews whom', () => {
  it('gives each of two or three readers every other answer, the one after its own first', () => {
    expect(Object.fromEntries(reviewAssignments(['A', 'B'], ['A', 'B']))).toEqual({ A: ['B'], B: ['A'] })
    expect(Object.fromEntries(reviewAssignments(['A', 'B', 'C'], ['A', 'B', 'C']))).toEqual({ A: ['B', 'C'], B: ['C', 'A'], C: ['A', 'B'] })
  })

  it('gives each of four or five readers two answers, so each answer is read twice, first once and second once', () => {
    for (const letters of [['A', 'B', 'C', 'D'], ['A', 'B', 'C', 'D', 'E']]) {
      const plan = reviewAssignments(letters, letters)
      for (const letter of letters) {
        const readers = [...plan.values()].filter(read => read.includes(letter))
        expect(readers, letter).toHaveLength(2)
        expect(readers.map(read => read.indexOf(letter)).sort()).toEqual([0, 1])
      }
      for (const [reader, read] of plan) expect(read, reader).not.toContain(reader)
    }
  })

  it('keeps the same letters for every reader and reviews an answer whose writer was left out', () => {
    const plan = reviewAssignments(['A', 'B', 'C'], ['A', 'C'])
    expect(Object.fromEntries(plan)).toEqual({ A: ['B', 'C'], C: ['A', 'B'] })
  })
})

describe('Sotto\'s counts', () => {
  const answer = (letter: string, findings: number): CouncilAnswer => ({ answer: `Synthetic ${letter}`, challenges: [],
    findings: Array.from({ length: findings }, (_, index) => ({ id: `${letter}${index + 1}`, kind: 'judgement' as const, claim: 'x' })) })
  const review = (ranking: string[], findings: CouncilReview['findings'] = [], changed = false): CouncilReview => ({ ranking, findings, added: [], scores: [], favourites: [],
    answer: changed ? 'changed' : 'same', evidence: [], ...changed ? { newAnswer: 'x' } : {} })

  it('counts rankings and findings with their denominators', () => {
    const counts = councilCounts({ kinds: ['decision'], answers: new Map([['A', answer('A', 1)], ['B', answer('B', 1)], ['C', answer('C', 0)]]), reviews: [
      { reader: 'A', assigned: ['B', 'C'], block: review(['B', 'C'], [{ id: 'B1', verdict: 'confirmed' }]) },
      { reader: 'B', assigned: ['C', 'A'], block: review(['A', 'C'], [{ id: 'A1', verdict: 'rejected' }], true) },
      { reader: 'C', assigned: ['A', 'B'], block: review(['B', 'A'], [{ id: 'B1', verdict: 'confirmed' }, { id: 'A1', verdict: 'unchecked' }]) },
    ] })
    expect(counts.rankings).toEqual([{ letter: 'A', first: 1, of: 2 }, { letter: 'B', first: 2, of: 2 }, { letter: 'C', first: 0, of: 2 }])
    expect(counts.findings).toEqual([{ finding: 'A1', confirmed: 0, rejected: 1, unchecked: 1, of: 2 }, { finding: 'B1', confirmed: 2, rejected: 0, unchecked: 0, of: 2 }])
    expect(counts.changed).toEqual(['B'])
    expect(counts.partial).toBe(false)
  })

  it('says partial when a block was unavailable, and never counts it as a no', () => {
    const counts = councilCounts({ kinds: ['decision'], answers: new Map([['A', answer('A', 0)], ['B', answer('B', 0)], ['C', null]]), reviews: [
      { reader: 'A', assigned: ['B', 'C'], block: review(['C', 'B']) },
      { reader: 'B', assigned: ['C', 'A'], block: null },
      { reader: 'C', assigned: ['A', 'B'], block: review(['A', 'B']) },
    ] })
    expect(counts.partial).toBe(true)
    expect(counts.rankings).toEqual([{ letter: 'A', first: 1, of: 1 }, { letter: 'B', first: 0, of: 2 }, { letter: 'C', first: 1, of: 1 }])
  })

  it('counts nothing with two panelists', () => {
    const counts = councilCounts({ kinds: ['decision'], answers: new Map([['A', answer('A', 1)], ['B', answer('B', 1)]]), reviews: [
      { reader: 'A', assigned: ['B'], block: review([]) }, { reader: 'B', assigned: ['A'], block: review([]) }] })
    expect(counts).toEqual({ answered: 2, partial: false, rankings: [], findings: [], supports: [], favourites: [], changed: [] })
  })
})

describe('seats Sotto fills', () => {
  const model = (provider: AgentModel['providerId'], id: string, extra: Partial<AgentModel> = {}): AgentModel =>
    ({ id: `native:${provider}:model:${id}`, provider: provider!, providerId: provider, name: id, ready: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], ...extra })
  const four = [model('codex', 'gpt-6-luna'), model('codex', 'gpt-6.1-sol'), model('claude', 'sonnet'), model('claude', 'opus'), model('grok', 'grok-4.7-build'), model('muse', 'muse-wonder-full-1.0')]

  it('takes the strongest model of three providers for the panel and of a fourth for the chair, at high effort', () => {
    const seats = councilSeatsInForce([null, null, null], null, four)
    expect(seats.panelists.map(seat => seat?.model?.name)).toEqual(['opus', 'gpt-6.1-sol', 'grok-4.7-build'])
    expect(seats.chair?.model?.name).toBe('muse-wonder-full-1.0')
    expect(seats.panelists.every(seat => seat?.reasoningEffort === 'high' && seat.from === 'default')).toBe(true)
    expect(councilSeatNotes(seats)).toEqual([])
  })

  it('uses different models of fewer providers, and lets the chair share a provider', () => {
    const seats = councilSeatsInForce([null, null, null], null, four.filter(item => item.providerId !== 'grok' && item.providerId !== 'muse'))
    expect(seats.panelists.map(seat => seat?.model?.name)).toEqual(['opus', 'gpt-6.1-sol', 'sonnet'])
    expect(seats.chair?.model?.name).toBe('gpt-6-luna')
  })

  it('fills an empty seat with a model no chosen seat holds, and notes a model held twice', () => {
    const sol = { modelId: 'native:codex:model:gpt-6.1-sol', reasoningEffort: 'xhigh' }
    const seats = councilSeatsInForce([sol, null, sol], null, four)
    expect(seats.panelists.map(seat => seat?.model?.name)).toEqual(['gpt-6.1-sol', 'opus', 'gpt-6.1-sol'])
    expect(seats.panelists[0]?.reasoningEffort).toBe('xhigh')
    expect(councilSeatNotes(seats)).toContainEqual({ kind: 'same-model', seats: [0, 2] })
  })

  it('keeps a chosen seat whose provider is away and says so, and notes a seat that cannot read this computer\'s files', () => {
    const seats = councilSeatsInForce([{ modelId: 'native:cursor:model:composer', reasoningEffort: null }, null], { modelId: 'native:devin:model:devin', reasoningEffort: null },
      [...four, model('devin', 'devin')])
    expect(seats.panelists[0]).toMatchObject({ ready: false, from: 'choice' })
    expect(councilSeatNotes(seats)).toEqual(expect.arrayContaining([{ kind: 'not-ready', seat: 0 }, { kind: 'remote', seat: 'chair' }]))
  })

  it('runs the fairness check at low, or the lowest effort at or above it', () => {
    expect(councilFairnessEffort(model('claude', 'opus', { reasoningEfforts: ['low', 'medium', 'high'] }))).toBe('low')
    expect(councilFairnessEffort(model('codex', 'sol', { reasoningEfforts: ['minimal', 'medium', 'high', 'xhigh'] }))).toBe('medium')
    expect(councilFairnessEffort(model('claude', 'opus', { reasoningEfforts: ['minimal'] }))).toBe('minimal')
    expect(councilFairnessEffort(model('claude', 'opus', { reasoningEfforts: ['low', 'high', 'ultracode'] }))).toBe('low')
    expect(councilFairnessEffort(model('grok', 'g', { reasoningEfforts: [] }))).toBeNull()
  })

  it('leaves Devin last and drops legacy models from the order', () => {
    const order = councilModelOrder([model('devin', 'devin'), model('claude', 'opus'), model('claude', 'opus-old', { legacy: true })])
    expect(order.map(item => item.name)).toEqual(['opus', 'devin'])
  })
})
