// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MuseBackgroundWork } from '../../../src/main/agents/museBackgroundWork'
import type { MuseItem } from '../../../src/main/agents/museActivity'

const command = (itemId: string, turnId: string, status: string, revision: number): MuseItem =>
  ({ itemId, kind: 'toolCall', status, revision, turnId, args: JSON.stringify({ command: 'sleep 45', description: 'Render' }) } as MuseItem)
const agent = (itemId: string, turnId: string, status: string, revision: number, workflowRunId?: string): MuseItem =>
  ({ itemId, kind: 'subagent', status, revision, turnId, objective: 'Draw the car', ...(workflowRunId ? { workflowRunId } : {}) } as unknown as MuseItem)

describe('MuseBackgroundWork (#2636)', () => {
  it('counts an item still open when its turn completes until its own completion', () => {
    const work = new MuseBackgroundWork()
    work.item(command('c', 't1', 'inProgress', 1))
    expect(work.working).toEqual([])
    expect(work.turnEnded('t1', true)).toBe(true)
    expect(work.working).toMatchObject([{ type: 'command', label: 'Render' }])
    expect(work.item(command('c', 't1', 'completed', 2))).toBe(true)
    expect(work.working).toEqual([])
  })

  it('never takes a revision older than one it has, so a completed item is not brought back', () => {
    const work = new MuseBackgroundWork()
    work.item(command('c', 't1', 'inProgress', 1)); work.turnEnded('t1', true)
    work.item(command('c', 't1', 'completed', 3))
    expect(work.item(command('c', 't1', 'inProgress', 2))).toBe(false)
    expect(work.working).toEqual([])
    expect(work.holds).toBe(false)
  })

  it('takes only inProgress as open, as MSP says: an unknown status is terminal', () => {
    const work = new MuseBackgroundWork()
    work.item(command('c', 't1', 'running', 1)); work.item(command('d', 't1', 'somethingNew', 1))
    work.turnEnded('t1', true)
    expect(work.working).toEqual([])
  })

  it('leaves nothing running after a failed or stopped turn, and keeps what earlier turns left', () => {
    const work = new MuseBackgroundWork()
    work.item(command('early', 't1', 'inProgress', 1)); work.turnEnded('t1', true)
    work.item(command('late', 't2', 'inProgress', 1))
    expect(work.turnEnded('t2', false)).toBe(false)
    expect(work.working.map(item => item.label)).toEqual(['Render'])
    expect(work.running('t2')).toEqual(new Set())
  })

  it('keeps counting an item however many turns follow, until its own completion', () => {
    const work = new MuseBackgroundWork()
    work.item(command('c', 't0', 'inProgress', 1)); work.turnEnded('t0', true)
    for (let turn = 1; turn <= 300; turn++) work.turnEnded(`t${turn}`, true)
    expect(work.working).toHaveLength(1)
    expect(work.holds).toBe(true)
  })

  it('counts a workflow’s own agent never, but keeps its row running, and counts a standalone subagent', () => {
    const work = new MuseBackgroundWork()
    work.item(agent('child', 't1', 'inProgress', 1, 'run-1')); work.item(agent('alone', 't1', 'inProgress', 1))
    expect(work.running('t1')).toEqual(new Set(['child', 'alone']))
    work.turnEnded('t1', true)
    expect(work.working.map(item => [item.type, item.label])).toEqual([['subagent', 'Draw the car']])
  })

  it('ends an item a history read shows ended, though its completion never came live', () => {
    const work = new MuseBackgroundWork()
    work.item(command('c', 't1', 'inProgress', 1)); work.turnEnded('t1', true)
    expect(work.history([command('c', 't1', 'completed', 4)])).toBe(true)
    expect(work.working).toEqual([])
    // An older revision arriving live afterwards does not open it again (#2655, N2).
    expect(work.item(command('c', 't1', 'inProgress', 3))).toBe(false)
    expect(work.working).toEqual([])
  })
})
