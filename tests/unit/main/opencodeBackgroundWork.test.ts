// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { OpenCodeBackgroundWork } from '../../../src/main/agents/opencodeBackgroundWork'

describe('OpenCodeBackgroundWork (#2635)', () => {
  it('holds a subagent until its child run ends and the report run after it ends', () => {
    const work = new OpenCodeBackgroundWork()
    expect(work.started('call-1', { description: 'GT3 RS drawing' }, { sessionID: 'ses_child', status: 'running' })).toBe(true)
    expect(work.working).toMatchObject([{ label: 'GT3 RS drawing', type: 'subagent' }])
    expect(work.ended('session:ses_child')).toBe('call-1')
    expect(work.runningTools).toEqual(new Set())
    expect(work.holds).toBe(true)
    expect(work.reported()).toBe(true)
    expect(work.working).toEqual([])
  })

  it('takes an ending that came before its call’s success as the end of that call’s work', () => {
    const work = new OpenCodeBackgroundWork()
    expect(work.ended('shell:sh_quick')).toBeUndefined()
    expect(work.started('call-2', { command: 'ls' }, { status: 'running', shellID: 'sh_quick' })).toBe(false)
    expect(work.working).toEqual([])
    expect(work.holds).toBe(false)
  })

  it('leaves a call that finished in place alone, and gives back what was running when the server went', () => {
    const work = new OpenCodeBackgroundWork()
    expect(work.started('call-3', { command: 'ls' }, { status: 'completed' })).toBe(false)
    work.started('call-4', { command: 'npm run render' }, { status: 'running', shellID: 'sh_long' })
    expect(work.clear()).toEqual(['call-4'])
    expect(work.holds).toBe(false)
  })
})
