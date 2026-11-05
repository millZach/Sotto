import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadWaitingCommand } from '../../../src/renderer/src/agents/ThreadMonitor'

/** Claude bot's held pose: standing still, an hourglass in its raised right hand, the sand running as Sotto's does. */
vi.mock('../../../src/renderer/src/state/creature', () => ({ useCreatureShown: () => true, useCreature: () => 'claude' }))

const NOW = Date.parse('2026-10-22T15:00:00.000Z')

// The pose's frame loop, driven by hand: a clock the loop reads and the frames it asks for.
let clock = 0, reduced = false
let frames: FrameRequestCallback[] = []
beforeEach(() => {
  clock = 1_000; reduced = false; frames = []
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener: () => undefined, removeEventListener: () => undefined }))
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
})
afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.reducedMotion
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Runs the frames the loop asked for, `seconds` after it began. */
function at(seconds: number): void {
  clock = 1_000 + seconds * 1_000
  const pending = frames; frames = []
  act(() => { for (const frame of pending) frame(clock) })
}

const EMPTY = 'M0 0h0v0z'
/** The pieces the pose moves: the glass's holder (svg's first group) and turning group, the grain, the bot, its body and fingers. */
function parts(creature: Element): Record<'holder' | 'glass' | 'grain' | 'facing' | 'body' | 'fingers', Element> {
  const [holder, facing] = [...creature.children] as [Element, Element]
  const glass = holder.firstElementChild!
  const fingers = creature.querySelector('path[d="M31 20h1v3h-1z"]')!
  return { holder, glass, grain: glass.querySelectorAll('path')[3]!, facing, body: fingers.parentElement!.parentElement!, fingers }
}
/** How many units a group is lifted: '' or `translate(0 -n)`. */
const lift = (group: Element): number => 0 - Number(/^translate\(0 (-?\d+)\)$/u.exec(group.getAttribute('transform') ?? '')?.[1] ?? 0)
const grains = (path: Element | undefined): number => {
  const drawn = path?.getAttribute('d') ?? 'M0 0h0v0z'
  return drawn === 'M0 0h0v0z' ? 0 : (drawn.match(/M/gu) ?? []).length
}
const sand = (creature: Element): [number, number] => {
  const [top, bottom] = creature.querySelectorAll('.thread-monitor__sand')
  return [grains(top), grains(bottom)]
}

function bot(container: HTMLElement): Element {
  const ornament = container.querySelector('[data-creature]')!
  expect(ornament).toHaveAttribute('data-creature', 'claude')
  expect(ornament).toHaveAttribute('data-ornament', 'held')
  for (const part of ['.bot-b', '.bot-h', '.bot-l', '.bot-k', '.bot-a, .bot-w']) expect(ornament.querySelector(part)).not.toBeNull()
  // The glass: two chambers of sand and the bright outline holding its shape.
  const creature = ornament.querySelector('.thread-monitor__creature')!
  const paths = creature.querySelectorAll('.thread-monitor__color.thread-monitor__sand')
  expect(paths).toHaveLength(2)
  expect(creature.querySelector('.thread-monitor__shine')).not.toBeNull()
  // The right hand is raised to hold it, and the turning group is the first nested group, where Sotto's e2e reads it.
  expect(creature.querySelector('g[transform="translate(0 -7)"]')).not.toBeNull()
  expect(creature.querySelector('g > g')?.getAttribute('transform')).toMatch(/^rotate\(/u)
  return creature
}

describe('Claude bot held', () => {
  it.each([['the system setting', true], ['the app setting', false]])('holds a half-run glass, one steady frame, under %s', (_, system) => {
    reduced = system
    if (!system) document.documentElement.dataset.reducedMotion = 'on'
    const { container } = render(<ThreadWaitingCommand now={NOW}
      commands={[{ id: '7b1e6c6e-3f8a-4f55-9a54-7cbf1d7a0f3e', label: 'npm run dev', type: 'command', startedAt: '2026-10-22T14:59:15.000Z' }]} />)
    const creature = bot(container)
    const first = [...creature.querySelectorAll('path')].map(path => path.getAttribute('d')).join('|')
    // Half run, upright, no grain falling, nothing breathing or mirrored: only the glass says time is passing.
    expect(sand(creature)).toEqual([2, 1])
    expect(parts(creature).grain).toHaveAttribute('d', EMPTY)
    expect(parts(creature).glass).toHaveAttribute('transform', 'rotate(0 33.5 14.5)')
    expect(lift(parts(creature).holder)).toBe(0)
    expect(lift(parts(creature).body)).toBe(0)
    expect(parts(creature).facing.getAttribute('transform') ?? '').toBe('')
    expect(frames).toHaveLength(0)
    at(4.9)
    expect([...creature.querySelectorAll('path')].map(path => path.getAttribute('d')).join('|')).toBe(first)
  })
})
