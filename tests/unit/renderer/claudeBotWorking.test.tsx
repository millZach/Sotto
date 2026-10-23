import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadWorking } from '../../../src/renderer/src/agents/ThreadMonitor'

/** Claude bot's working pose: it stands at the readout end and sends one small bot out per running task. */
vi.mock('../../../src/renderer/src/state/creature', () => ({ useCreature: () => 'claude' }))

const work = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `6f0c1a2e-8f4b-4d3c-9a1e-${String(index).padStart(12, '0')}`, label: `Agent ${index + 1}`, type: 'subagent' as const,
}))
const frames: FrameRequestCallback[] = []
let trackWidth = 600
const motion = (reduced: boolean) => vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }))
/** Paints the frame `seconds` after the pose appeared (the loop's clock starts at 0 here). */
const at = (seconds: number) => frames.pop()!(seconds * 1000)
const minis = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.thread-monitor__mini')]
const placed = (container: HTMLElement) => minis(container).map(mini => {
  const [, x, y] = /^translate\((-?\d+)px, (-?\d+)px\)$/u.exec(mini.style.transform)!
  return [Number(x), Number(y)]
})
const legs = (container: HTMLElement) => minis(container).map(mini => mini.querySelector('path')!.getAttribute('d')!)
const even = (x: number) => Math.round(x / 2) * 2

/** Sotto's working schedule, written out again so the pose cannot drift from it unnoticed. */
const start = (width: number) => Math.max(0, width - 96)
const walking = (width: number, time: number, index: number): [number, number] =>
  [even(start(width) - (start(width) + 24) * ((time * 0.09 + index * 0.17) % 1)), Math.floor(time * 6 + index) % 2 ? -1 : 0]
const standing = (width: number, count: number, index: number): [number, number] =>
  [even(Math.max(0, start(width) - 12 - index * Math.min(36, Math.max(0, start(width) - 12) / count))), 0]

const bot = (container: HTMLElement) => {
  const actor = container.querySelector<HTMLElement>('.thread-monitor__actor')!
  return {
    actor,
    facing: actor.querySelector('.thread-monitor__creature > g')!,
    hand: actor.querySelector('path[d="M28 19h3v5h-3z"]')!.parentElement!,
    eyes: actor.querySelectorAll('path.bot-k')[0]!,
    bulb: actor.querySelector('path[d="M15 4h3v3h-3z"]')!,
    spark: actor.querySelectorAll('path.bot-d')[1]!,
  }
}
/** Eyes one unit toward the small bots (look 1 in the mirrored bot): open slots, or shut to a line in a blink. */
const OPEN = 'M11 12h2v5h-2z M22 12h2v5h-2z'
const BLINK = 'M11 15h2v1h-2z M22 15h2v1h-2z'
/** The chest emblem as a plus (its centre column at x 16) rather than a cross (which starts at x 14). */
const isPlus = (spark: Element) => spark.getAttribute('d')!.startsWith('M16 22h1v1h-1z')

beforeEach(() => {
  frames.length = 0
  trackWidth = 600
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)))
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.spyOn(performance, 'now').mockReturnValue(0)
  // jsdom lays nothing out; give the track a real pane's width so the spacing formulas have room.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => trackWidth)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Claude bot working', () => {
  it('wears the working pose and sends out one small bot per agent, at most six, from behind the big one', () => {
    motion(true)
    const { container, rerender } = render(<ThreadWorking work={work(1)} />)
    const ornament = container.querySelector('.thread-monitor')!
    expect(ornament).toHaveAttribute('data-creature', 'claude')
    expect(ornament).toHaveAttribute('data-ornament', 'working')
    expect(ornament.querySelector('.thread-monitor__status')).toHaveTextContent(/^Working$/u)
    expect(minis(container)).toHaveLength(1)
    rerender(<ThreadWorking work={work(3)} />)
    expect(ornament.querySelector('.thread-monitor__status')).toHaveTextContent('Working · 3 agents')
    expect(minis(container)).toHaveLength(3)
    rerender(<ThreadWorking work={work(9)} />)
    expect(ornament.querySelector('.thread-monitor__status')).toHaveTextContent('Working · 9 agents')
    expect(minis(container)).toHaveLength(6)
    // Each is a tiny bot in the big one's colours, hidden from assistive tech, drawn before the bot so it steps out from behind.
    const { actor } = bot(container)
    for (const mini of minis(container)) {
      expect(mini).toHaveAttribute('aria-hidden', 'true')
      expect(mini.querySelector('svg')).toHaveAttribute('viewBox', '0 0 12 10')
      expect(mini.querySelector('.bot-a')).not.toBeNull()
      expect(mini.compareDocumentPosition(actor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(actor.querySelector('.thread-monitor__creature')).not.toBeNull()
  })

  it('walks the small bots on Sotto\'s schedule: from under the arm, at its pace, a beat apart', () => {
    motion(false)
    const { container } = render(<ThreadWorking work={work(3)} />)
    // The first paint is t = 0: they leave from 96 px short of the end, spaced by the 0.17 phase, the middle one up a pixel.
    expect(placed(container)).toEqual([[504, 0], [414, -1], [324, 0]])
    at(2)
    expect(placed(container)).toEqual([0, 1, 2].map(index => walking(600, 2, index)))
    expect(placed(container)).toEqual([[408, 0], [320, -1], [230, 0]])
  })

  it.each([[1, 600], [3, 600], [6, 600], [3, 120], [6, 120]])(
    'under reduced motion stands %i small bots a stride apart on a %i px track, none past the left end', (count, width) => {
      trackWidth = width
      motion(true)
      const { container } = render(<ThreadWorking work={work(count)} />)
      const expected = Array.from({ length: count }, (_, index) => standing(width, count, index))
      expect(placed(container)).toEqual(expected)
      if (width === 600) expect(expected.map(([x]) => x)).toEqual([492, 456, 420, 384, 348, 312].slice(0, count))
      for (const [x] of expected) expect(x).toBeGreaterThanOrEqual(0)
      expect(requestAnimationFrame).not.toHaveBeenCalled()
    })

  it('shuffles each small bot\'s legs on its own bob beat and plants both under reduced motion', () => {
    motion(false)
    const { container } = render(<ThreadWorking work={work(2)} />)
    const seen = new Map<string, Set<string>>()
    for (const time of [0, 0.2, 0.4, 0.6, 0.8]) {
      if (time > 0) at(time)
      placed(container).forEach(([, y], index) => {
        const key = y === -1 ? 'up' : 'down'
        seen.set(key, (seen.get(key) ?? new Set()).add(legs(container)[index]!))
      })
    }
    // One leg path on the up beat, the other on the down beat, for every mini: they trade places in step with the bob.
    expect(seen.get('up')!.size).toBe(1)
    expect(seen.get('down')!.size).toBe(1)
    const [up] = seen.get('up')!, [down] = seen.get('down')!
    expect(up).not.toBe(down)
    cleanup(); frames.length = 0
    motion(true)
    const still = render(<ThreadWorking work={work(2)} />).container
    const planted = legs(still)
    expect(new Set(planted).size).toBe(1)
    expect(planted[0]).not.toBe(up)
    expect(planted[0]).not.toBe(down)
  })

  it('faces the room from the readout end, waves on the half second and blinks on Sotto\'s cadence', () => {
    motion(false)
    const { container } = render(<ThreadWorking work={work(3)} />)
    const { actor, facing, hand, eyes } = bot(container)
    // Mirrored with its right edge 18 px short of the track end, so the readout clears it.
    expect(actor.style.transform).toBe('translateX(520px)')
    expect(facing).toHaveAttribute('transform', 'translate(33 0) scale(-1 1)')
    const raised: string[] = []
    for (const time of [0.1, 0.6, 1.1, 1.6]) { at(time); raised.push(hand.getAttribute('transform')!) }
    expect(raised).toEqual(['', 'translate(0 -1)', '', 'translate(0 -1)'])
    at(4.8); expect(eyes).toHaveAttribute('d', OPEN)
    at(4.9); expect(eyes).toHaveAttribute('d', BLINK)
    at(5.1); expect(eyes).toHaveAttribute('d', OPEN)
  })

  it('under reduced motion holds the big bot in one steady pose', () => {
    motion(true)
    const { container } = render(<ThreadWorking work={work(3)} />)
    const { actor, facing, hand, eyes, bulb, spark } = bot(container)
    expect(actor.style.transform).toBe('translateX(520px)')
    expect(facing).toHaveAttribute('transform', 'translate(33 0) scale(-1 1)')
    expect(hand).toHaveAttribute('transform', '')
    // Body and bulb at rest: no bob, no sway.
    expect(facing.children[2]).toHaveAttribute('transform', '')
    expect(bulb.parentElement).toHaveAttribute('transform', '')
    expect(eyes).toHaveAttribute('d', OPEN)
    expect(bulb).toHaveAttribute('class', 'bot-a')
    expect(isPlus(spark)).toBe(true)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
})
