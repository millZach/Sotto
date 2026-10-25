import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadHeld, ThreadWaitingCommand } from '../../../src/renderer/src/agents/ThreadMonitor'
import type { HeldAction } from '../../../src/renderer/src/agents/threadActivityView'

/** Claude bot's held pose: standing still, an hourglass in its raised right hand, the sand running as Sotto's does. */
vi.mock('../../../src/renderer/src/state/creature', () => ({ useCreatureShown: () => true, useCreature: () => 'claude' }))

const NOW = Date.parse('2026-10-22T15:00:00.000Z')
const action: HeldAction = {
  id: 'a1', turnId: 't1', sequence: 1, kind: 'command', status: 'running', title: 'Run tests',
  command: 'npm test', startedAt: '2026-10-22T14:59:15.000Z',
}

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
  it('stands holding an hourglass whose sand drains, then flips', () => {
    const { container } = render(<ThreadHeld action={action} now={NOW} />)
    const creature = bot(container)
    expect(sand(creature)).toEqual([3, 0])
    at(3)
    expect(sand(creature)).toEqual([2, 1])
    at(5)
    expect(sand(creature)).toEqual([1, 2])
    // Mid-flip the glass turns; it never stays turned once the next cycle runs.
    at(5.75)
    expect(creature.querySelector('g > g')).toHaveAttribute('transform', 'rotate(90 33.5 14.5)')
    at(6.1)
    expect(creature.querySelector('g > g')).toHaveAttribute('transform', 'rotate(0 33.5 14.5)')
    expect(sand(creature)).toEqual([3, 0])
    // It stands at the start of the track and does not walk.
    expect(container.querySelector('.thread-monitor__actor')).not.toHaveAttribute('style')
  })

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

  it('breathes with the glass in its hand: the glass rises a unit with the body, its sand and turn unchanged', () => {
    const { container } = render(<ThreadHeld action={action} now={NOW} />)
    const creature = bot(container)
    const { holder, glass, body, fingers } = parts(creature)
    const state = (): unknown => ({ turn: glass.getAttribute('transform'), sand: sand(creature), fingers: fingers.getAttribute('d'), hand: fingers.parentElement?.getAttribute('transform') })
    at(0.5) // Math.floor(0.5 * 1.2) % 2 === 0: breathing out
    const down = { glass: lift(holder), body: lift(body), state: state() }
    at(1.0) // Math.floor(1.0 * 1.2) % 2 === 1: breathing in
    const up = { glass: lift(holder), body: lift(body), state: state() }
    expect(up.glass - down.glass).toBe(1)
    expect(up.body - down.body).toBe(1)
    expect(up.state).toEqual(down.state)
    // The fingers ride in the raised right hand, inside the breathing body.
    expect(fingers.parentElement).toHaveAttribute('transform', 'translate(0 -7)')
    expect(body.contains(fingers)).toBe(true)
  })

  it('keeps the glass upright while sand drains, flips only in the last half second, and never mirrors the bot', () => {
    const { container } = render(<ThreadHeld action={action} now={NOW} />)
    const creature = bot(container)
    const { holder, glass, body, facing } = parts(creature)
    const turned = [0, 0]
    // Offset off the frame grid so no sample lands on a flip's edge.
    for (let index = 0; index < 240; index += 1) {
      const time = index * 0.05 + 0.01
      at(time)
      const angle = Number(/^rotate\((-?[\d.]+) 33\.5 14\.5\)$/u.exec(glass.getAttribute('transform') ?? '')?.[1])
      const flipping = time % 6 > 5.5
      if (flipping) { expect(angle).toBeGreaterThan(0); expect(angle).toBeLessThan(180); turned[Math.floor(time / 6)]! += 1 }
      else expect(angle).toBe(0)
      expect(lift(holder)).toBe(lift(body))
      expect(facing.getAttribute('transform') ?? '').toBe('')
    }
    expect(turned).toEqual([10, 10])
  })
})
