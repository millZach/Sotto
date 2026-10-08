import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { babysitReadout } from '../../../src/renderer/src/agents/babysitting'
import { ThreadBabysitting } from '../../../src/renderer/src/agents/ThreadMonitor'
import { ornamentPose } from '../../../src/renderer/src/agents/threadActivityView'
import type { AgentThread } from '../../../src/shared/agents'

/** The creature's fourth pose above the composer (ADR-0061, variant C): at rest, the weakest claim the track shows. */
afterEach(cleanup)

const none = { monitoring: false, agents: false, held: false, commands: false, babysitting: false, running: false }
describe('which pose holds the track', () => {
  it('ranks babysitting below every other pose', () => {
    expect(ornamentPose({ ...none, babysitting: true })).toBe('babysitting')
    expect(ornamentPose({ ...none, babysitting: true, monitoring: true })).toBe('monitoring')
    expect(ornamentPose({ ...none, babysitting: true, agents: true })).toBe('working')
    expect(ornamentPose({ ...none, babysitting: true, held: true, running: true })).toBe('held')
    expect(ornamentPose({ ...none, babysitting: true, commands: true })).toBe('waiting')
    expect(ornamentPose(none)).toBeUndefined()
  })

  it('steps aside while a turn runs, as a command left waiting does', () => {
    expect(ornamentPose({ ...none, babysitting: true, running: true })).toBeUndefined()
    expect(ornamentPose({ ...none, commands: true, running: true })).toBeUndefined()
    // A watch and background agents still hold the track through a turn.
    expect(ornamentPose({ ...none, monitoring: true, running: true })).toBe('monitoring')
  })
})

const NOW = new Date(2026, 9, 8, 15, 0)
const url = (number: number) => `https://github.com/o/r/pull/${number}`
const thread = (numbers: number[]): Pick<AgentThread, 'babysitting' | 'pullRequests' | 'worktree'> => ({
  babysitting: numbers.map(number => ({ url: url(number), number, startedBy: 'agent' as const, startedAt: new Date(2026, 9, 8, 14, 2).toISOString() })),
  pullRequests: [{ number: 76, url: url(76), title: 'Mention the greeting in the README', state: 'open', draft: false, source: 'linked', linkedAt: '2026-10-08T20:00:00.000Z' }],
  worktree: { mode: 'shared', status: 'ready', path: 'C:/app', git: { pullRequest: { number: 74, url: url(74), title: 'Greet the reviewer', state: 'open', draft: false } } } as AgentThread['worktree'],
})

describe('what the pose says', () => {
  it('names the pull request and its title over since when, and every one on hover', () => {
    expect(babysitReadout(thread([74]), NOW)).toEqual({ label: '#74 Greet the reviewer', since: '2:02 pm', title: '#74 Greet the reviewer' })
    expect(babysitReadout(thread([74, 76]), NOW)).toEqual({ label: '#74 Greet the reviewer, #76', since: '2:02 pm',
      title: '#74 Greet the reviewer\n#76 Mention the greeting in the README' })
    // A pull request the thread has no title for is named by its number alone.
    expect(babysitReadout(thread([80]), NOW)?.label).toBe('#80')
    expect(babysitReadout(thread([]), NOW)).toBeUndefined()
  })

  it('stands still, in the babysitting pose, and is read as a status', () => {
    const { container } = render(<ThreadBabysitting thread={thread([74])} now={NOW.getTime()} />)
    const ornament = screen.getByRole('status')
    expect(ornament).toHaveAttribute('data-ornament', 'babysitting')
    expect(ornament).toHaveTextContent('#74 Greet the reviewerBabysitting since 2:02 pm')
    // The time is one piece, so where it does not fit it drops whole rather than ending in an ellipsis.
    expect(container.querySelector('.thread-monitor__status--babysitting .thread-monitor__since')).toHaveTextContent(/^since 2:02 pm$/u)
    // Nothing in it moves: no element is driven by a frame loop, so reduced motion shows the same pose.
    expect(container.querySelector('.thread-monitor__actor')).not.toHaveAttribute('style')
    expect(container.querySelector('.thread-monitor__sign')).not.toBeNull()
  })
})
