import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { antigravityToolCallSignal } from '../../../src/main/agents/antigravityActivity'
import { AntigravityBackgroundTasks } from '../../../src/main/agents/antigravityBackgroundWork'
import { stillWorkingAgents } from '../../../src/renderer/src/agents/DelegatedWork'
import { ThreadWaitingCommand, ThreadWorking } from '../../../src/renderer/src/agents/ThreadMonitor'
import { ornamentPose } from '../../../src/renderer/src/agents/threadActivityView'
import type { AgentBackgroundWork } from '../../../src/shared/agentMonitoring'

/**
 * An Antigravity release watch that set wakeup after wakeup once read "Run schedule — Working · 18 agents" with small bots
 * above the composer, though no agent ever ran. A `schedule` timer is waited on, so it wears the waiting pose and is
 * counted as nothing else.
 */
vi.mock('../../../src/renderer/src/state/creature', () => ({ useCreatureShown: () => true, useCreature: () => 'claude' }))

const timers = (count: number): AgentBackgroundWork[] => {
  const tasks = new AntigravityBackgroundTasks()
  for (let i = 0; i < count; i++) {
    tasks.observe(antigravityToolCallSignal({
      sessionUpdate: 'tool_call', toolCallId: `sched-${i}`, title: 'Run schedule', status: 'completed',
      rawInput: { DurationSeconds: 120 + i, Prompt: 'Check the release' }, rawOutput: { status: 'scheduled', taskId: `t-${i}` },
    }, `k-${i}`)!, 't1')
  }
  tasks.turnEnded('t1', false, false)
  return tasks.working(new Set(), [], false)
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Antigravity schedule timers above the composer', () => {
  it('never draw the working pose, count as agents or send out small bots', () => {
    const work = timers(3)
    expect(work).toHaveLength(3)
    const { container } = render(<ThreadWorking work={work} />)
    expect(container.textContent).not.toMatch(/agents?/u)
    expect(container.querySelectorAll('.thread-monitor__mini')).toHaveLength(0)
    expect(stillWorkingAgents(work, true)).toBeUndefined()
  })

  it('wear the waiting pose once the turn ends, and nothing while it runs', () => {
    const work = timers(2)
    const commands = work.filter(task => task.type === 'command')
    const facts = { monitoring: false, agents: work.length > commands.length, held: false, commands: commands.length > 0, babysitting: false }
    expect(ornamentPose({ ...facts, running: false })).toBe('waiting')
    expect(ornamentPose({ ...facts, running: true })).toBeUndefined()
    const { container } = render(<ThreadWaitingCommand commands={commands} now={undefined} />)
    expect(container.textContent).toContain('Waiting')
    expect(container.textContent).toContain('Run schedule')
    expect(container.querySelectorAll('.thread-monitor__mini')).toHaveLength(0)
  })
})
