// @vitest-environment node
// The merge order two owners read on the two desks (ADR-0189, decision 8): advice, and the same from either side.
import { describe, expect, it } from 'vitest'
import { teamMergeOrder, type TeamChecks, type TeamDesk } from '../../../src/shared/teams'

const pr = (number: number, checks: TeamChecks, extra: { readonly draft?: boolean; readonly passed?: string; readonly title?: string } = {}) =>
  ({ number, title: extra.title ?? `Pull request ${number}`, draft: extra.draft ?? false, checks, ...extra.passed ? { checksPassedAt: extra.passed } : {} })
const desk = (project: string, ...pullRequests: ReturnType<typeof pr>[]): TeamDesk => ({ more: 0, threads: [{ project, title: 'A thread', stands: 'idle', pullRequests }] })
const numbers = (a: TeamDesk, b: TeamDesk) => teamMergeOrder(a, b).map(row => row.number)

describe('teamMergeOrder', () => {
  it('puts passed checks first, oldest pass first, then running, not read, failed and drafts', () => {
    const yours = desk('Sotto', pr(5, 'failed'), pr(9, 'passed', { passed: '2026-11-04T03:00:00.000Z' }), pr(1, 'passed', { draft: true, passed: '2026-11-01T00:00:00.000Z' }))
    const theirs = desk('Sotto', pr(7, 'unknown'), pr(8, 'passed', { passed: '2026-11-04T01:00:00.000Z' }), pr(6, 'pending'))
    expect(numbers(yours, theirs)).toEqual([8, 9, 6, 7, 5, 1])
  })

  it('gives both owners the same order from their own sides', () => {
    const zach = desk('Sotto', pr(3, 'passed'), pr(4, 'pending'), pr(11, 'unknown'))
    const drake = desk('Sotto', pr(2, 'passed'), pr(10, 'pending'), pr(12, 'failed', { draft: true }))
    expect(numbers(zach, drake)).toEqual(numbers(drake, zach))
  })

  it('orders passes with no time by number, after those with one', () => {
    const order = numbers(desk('Sotto', pr(2, 'passed')), desk('Sotto', pr(30, 'passed', { passed: '2026-11-04T01:00:00.000Z' }), pr(1, 'passed')))
    expect(order).toEqual([30, 1, 2])
  })

  it('shows a pull request both desks hold once, under whatever each calls its project', () => {
    const rows = teamMergeOrder(desk('Sotto', pr(7, 'passed')), desk('sotto-clone', pr(7, 'passed')))
    expect(rows.map(row => [row.number, row.whose])).toEqual([[7, 'both']])
  })

  it('keeps apart two pull requests with one number and different titles, even in projects with one name', () => {
    const rows = teamMergeOrder(desk('Client', pr(7, 'passed', { title: 'One thing' })), desk('Client', pr(7, 'passed', { title: 'Another' })))
    expect(rows.map(row => row.whose).sort()).toEqual(['theirs', 'yours'])
  })

  it('keeps apart pull requests with no title across the two desks, the same from either side', () => {
    const a = desk('Client', pr(7, 'passed', { title: '' })), b = desk('Other', pr(7, 'passed', { title: '' }))
    expect(teamMergeOrder(a, b)).toHaveLength(2)
    expect(teamMergeOrder(a, b).map(row => row.project)).toEqual(teamMergeOrder(b, a).map(row => row.project))
  })

  it('joins two readings of one pull request the same way from either side', () => {
    const cases: readonly (readonly [ReturnType<typeof pr>, ReturnType<typeof pr>])[] = [
      [pr(7, 'passed', { passed: '2026-11-04T01:00:00.000Z' }), pr(7, 'passed', { passed: '2026-11-04T03:00:00.000Z' })],
      [pr(7, 'unknown'), pr(7, 'passed', { passed: '2026-11-04T03:00:00.000Z' })],
      [pr(7, 'passed', { passed: '2026-11-04T01:00:00.000Z' }), pr(7, 'failed')],
      [pr(7, 'passed', { draft: true, passed: '2026-11-04T01:00:00.000Z' }), pr(7, 'passed', { passed: '2026-11-04T01:00:00.000Z' })],
    ]
    const other = pr(8, 'passed', { passed: '2026-11-04T02:00:00.000Z' })
    for (const [a, b] of cases) {
      const one = teamMergeOrder(desk('Sotto', a, other), desk('Sotto', b)), two = teamMergeOrder(desk('Sotto', b), desk('Sotto', a, other))
      expect(one.map(row => [row.number, row.checks, row.draft])).toEqual(two.map(row => [row.number, row.checks, row.draft]))
    }
    expect(numbers(desk('Sotto', pr(7, 'passed', { passed: '2026-11-04T03:00:00.000Z' }), other), desk('Sotto', pr(7, 'passed', { passed: '2026-11-04T01:00:00.000Z' })))).toEqual([7, 8])
    expect(teamMergeOrder(desk('Sotto', pr(7, 'passed')), desk('Sotto', pr(7, 'failed')))[0]!.checks).toBe('failed')
    expect(teamMergeOrder(desk('Sotto', pr(7, 'unknown')), desk('Sotto', pr(7, 'pending')))[0]!.checks).toBe('pending')
  })
})
