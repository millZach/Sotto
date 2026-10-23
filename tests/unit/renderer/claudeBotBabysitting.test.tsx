import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadBabysitting } from '../../../src/renderer/src/agents/ThreadMonitor'
import type { Creature } from '../../../src/shared/settings'
import type { AgentThread } from '../../../src/shared/agents'

/** Claude bot's babysitting pose: at rest, muted, holding up a sign with a pull request's mark, never moving. */
const setting = vi.hoisted(() => ({ creature: 'claude' as Creature }))
vi.mock('../../../src/renderer/src/state/creature', () => ({ useCreatureShown: () => true, useCreature: () => setting.creature }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setting.creature = 'claude'
})

const NOW = new Date(2026, 9, 8, 15, 0)
const url = (number: number) => `https://github.com/o/r/pull/${number}`
const thread: Pick<AgentThread, 'babysitting' | 'pullRequests' | 'worktree'> = {
  babysitting: [{ url: url(74), number: 74, startedBy: 'agent', startedAt: new Date(2026, 9, 8, 14, 2).toISOString() }],
  pullRequests: [],
  worktree: { mode: 'shared', status: 'ready', path: 'C:/app', git: { pullRequest: { number: 74, url: url(74), title: 'Greet the reviewer', state: 'open', draft: false } } } as AgentThread['worktree'],
}
const NAME = 'Babysitting #74 Greet the reviewer since 2:02 pm'

describe('Claude bot babysitting', () => {
  it('stands still holding the sign, in the babysitting pose, named as one picture', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    const { container } = render(<ThreadBabysitting thread={thread} now={NOW.getTime()} />)
    expect(screen.queryByRole('status')).toBeNull()
    const ornament = screen.getByRole('img', { name: NAME })
    expect(ornament).toHaveAttribute('data-creature', 'claude')
    expect(ornament).toHaveAttribute('data-ornament', 'babysitting')
    expect(ornament).not.toHaveAttribute('aria-live')
    // The bot, not Sotto's creature, at rest: half-shut eyes painted once.
    for (const part of ['.bot-b', '.bot-h', '.bot-l', '.bot-k', '.bot-a']) expect(ornament.querySelector(part)).not.toBeNull()
    expect(ornament.querySelector('.bot-k')).toHaveAttribute('d', 'M10 14h2v2h-2z M21 14h2v2h-2z')
    // The sign, its outline and the pull request mark, on a pole the hand holds.
    expect(ornament.querySelector('.thread-monitor__sign')).not.toBeNull()
    expect(ornament.querySelector('.thread-monitor__shine')).not.toBeNull()
    expect(ornament.querySelector('.thread-monitor__handle')).not.toBeNull()
    // Nothing moves: no frame loop styles and no frame requested.
    expect(container.querySelector('.thread-monitor__actor')).not.toHaveAttribute('style')
    expect(frame).not.toHaveBeenCalled()
  })

  it('holds the whole sign: the same pull request mark as Sotto\'s, a fill, an outline and a pole to the track', () => {
    const marks = (creature: Creature): number => {
      setting.creature = creature
      const { container, unmount } = render(<ThreadBabysitting thread={thread} now={NOW.getTime()} />)
      const count = (container.querySelector('.thread-monitor__sign')?.getAttribute('d') ?? '').match(/M/gu)?.length ?? 0
      unmount()
      return count
    }
    const sotto = marks('sotto'), claude = marks('claude')
    expect(claude).toBeGreaterThanOrEqual(5)
    expect(claude).toBe(sotto)
    const { container } = render(<ThreadBabysitting thread={thread} now={NOW.getTime()} />)
    const actor = container.querySelector('.thread-monitor__actor')!
    expect(actor.querySelector('.thread-monitor__color[opacity]')).not.toBeNull()
    expect(actor.querySelector('.thread-monitor__shine')?.getAttribute('d')).toMatch(/^M/u)
    const pole = /^M(\d+) (\d+)h(\d+)v(\d+)/u.exec(actor.querySelector('.thread-monitor__handle')?.getAttribute('d') ?? '')
    expect(pole).not.toBeNull()
    expect(Number(pole![2]) + Number(pole![4])).toBe(32)
  })

  it('is painted once in the resting stance: eyes half shut, mouth flat, standing, body down', () => {
    const { container, rerender } = render(<ThreadBabysitting thread={thread} now={NOW.getTime()} />)
    const svg = container.querySelector('.thread-monitor__creature')!
    const [eyes, mouth] = svg.querySelectorAll('.bot-k')
    expect(eyes).toHaveAttribute('d', 'M10 14h2v2h-2z M21 14h2v2h-2z')
    expect(mouth).toHaveAttribute('d', 'M15 19h3v1h-3z')
    const legs = svg.querySelector(':scope > g > path.bot-l')?.getAttribute('d') ?? ''
    const heights = [...legs.matchAll(/v(\d+)/gu)].map(match => match[1])
    expect(heights).toHaveLength(4)
    expect(new Set(heights).size).toBe(1)
    expect(svg.querySelector(':scope > g > g')?.getAttribute('transform') ?? '').toBe('')
    // Re-rendering must not paint again: the stance is written once, after mount.
    const observer = new MutationObserver(() => {})
    observer.observe(svg, { attributes: true, subtree: true })
    rerender(<ThreadBabysitting thread={thread} now={NOW.getTime() + 1} />)
    rerender(<ThreadBabysitting thread={thread} now={NOW.getTime() + 2} />)
    expect(observer.takeRecords()).toHaveLength(0)
    observer.disconnect()
  })

  it('says what Sotto\'s babysitting pose says', () => {
    const claude = render(<ThreadBabysitting thread={thread} now={NOW.getTime()} />)
    const said = screen.getByRole('img', { name: NAME }).textContent
    claude.unmount()
    setting.creature = 'sotto'
    render(<ThreadBabysitting thread={thread} now={NOW.getTime()} />)
    const sotto = screen.getByRole('img', { name: NAME })
    expect(sotto).toHaveAttribute('data-creature', 'sotto')
    expect(said).toBe(sotto.textContent)
    expect(said).toBe('#74 Greet the reviewerBabysitting since 2:02 pm')
  })
})
