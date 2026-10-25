import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadMonitor } from '../../../src/renderer/src/agents/ThreadMonitor'

// The real wiring picks the bot from the creature setting; pin it to Claude bot.
vi.mock('../../../src/renderer/src/state/creature', () => ({ useCreatureShown: () => true, useCreature: () => 'claude' }))

const tasks = [{ id: '56d13d2c-f6d0-4968-a9ed-18c87a7d5b5a', label: 'Watch the build' }]
let systemReduce = false

beforeEach(() => {
  systemReduce = false
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: systemReduce, addEventListener() {}, removeEventListener() {} }))
  // jsdom lays nothing out; give the track room to walk (reach = 400 - 80).
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  delete document.documentElement.dataset.reducedMotion
})

const actorOf = (container: HTMLElement) => container.querySelector<HTMLElement>('.thread-monitor__actor')!
/** Where the bot stands, which way it faces, and how it holds the glass (the handle's group, inside the right hand's). */
const stanceOf = (container: HTMLElement) => {
  const handle = container.querySelector('.thread-monitor__handle')!
  const glass = handle.parentElement!
  return {
    x: actorOf(container).style.transform,
    facing: actorOf(container).querySelector('svg > g')!.getAttribute('transform'),
    glass: glass.getAttribute('transform'),
    hand: glass.parentElement!.getAttribute('transform'),
    handle: handle.getAttribute('d'),
  }
}
const MIRRORED = 'translate(33 0) scale(-1 1)'
const CARRIED = 'translate(24 7)'
const RAISED = { glass: 'translate(18 14)', hand: 'translate(0 -5)', handle: 'M9 5h2v2H9z' }
const stancesAt = (container: HTMLElement, seconds: readonly number[]) => {
  let elapsed = 0
  return seconds.map(second => {
    vi.advanceTimersByTime((second - elapsed) * 1000)
    elapsed = second
    return stanceOf(container)
  })
}

/** The actor's transform at each of `seconds` after the pose appears. */
const transformsAt = (container: HTMLElement, seconds: readonly number[]): string[] => {
  let elapsed = 0
  return seconds.map(second => {
    vi.advanceTimersByTime((second - elapsed) * 1000)
    elapsed = second
    return actorOf(container).style.transform
  })
}

describe('Claude bot monitoring', () => {
  it('draws the bot carrying the magnifying glass on the track', () => {
    const { container } = render(<ThreadMonitor tasks={tasks} />)
    const ornament = container.querySelector('.thread-monitor')!
    expect(ornament).toHaveAttribute('data-creature', 'claude')
    expect(ornament).toHaveAttribute('data-ornament', 'monitoring')
    expect(actorOf(container).parentElement).toHaveClass('thread-monitor__track')
    const creature = actorOf(container).querySelector('svg.thread-monitor__creature')!
    for (const part of ['bot-b', 'bot-h', 'bot-l', 'bot-d', 'bot-k']) expect(creature.querySelector(`.${part}`)).not.toBeNull()
    expect(creature.querySelector('.thread-monitor__handle')).not.toBeNull()
    expect(creature.querySelector('.thread-monitor__shine')).not.toBeNull()
  })

  it('walks out, inspects at the far end and walks back', () => {
    const { container } = render(<ThreadMonitor tasks={tasks} />)
    // Frames land on a 30 fps grid, so midway is near half the reach rather than exactly on it; x is always an even pixel.
    const xs = transformsAt(container, [0, 2, 6, 11]).map(transform => Number(/^translateX\((\d+)px\)$/u.exec(transform)![1]))
    const [start, out, far, back] = xs as [number, number, number, number]
    expect(start).toBe(0)
    expect(out).toBeGreaterThan(140); expect(out).toBeLessThan(180)
    expect(far).toBe(320)
    expect(back).toBeGreaterThan(140); expect(back).toBeLessThan(180)
    for (const x of xs) expect(x % 2).toBe(0)
    // Heading back it faces the other way; at the far end it holds the glass up and its legs stand.
    const facing = actorOf(container).querySelector('svg > g')!
    expect(facing.getAttribute('transform')).toBe('translate(33 0) scale(-1 1)')
  })

  it('faces the way it heads: right while inspecting at the far end, left through the rest at the start', () => {
    const { container } = render(<ThreadMonitor tasks={tasks} />)
    const seen = stancesAt(container, [1, 4.3, 6, 8.7, 11, 13.5])
    expect(seen.map(stance => stance.facing)).toEqual(['', '', '', '', MIRRORED, MIRRORED])
    expect(seen.map(stance => stance.x)).toEqual([seen[0]!.x, 'translateX(320px)', 'translateX(320px)', 'translateX(320px)', seen[4]!.x, 'translateX(0px)'])
    // The glass comes up only while it inspects, the hand with it; it is carried low on the walks and at the rest.
    expect(seen.map(stance => stance.glass)).toEqual([CARRIED, RAISED.glass, RAISED.glass, RAISED.glass, CARRIED, CARRIED])
    expect(seen.slice(1, 4)).toEqual(Array(3).fill(expect.objectContaining(RAISED)))
  })

  it.each([
    ['the app setting', () => { document.documentElement.dataset.reducedMotion = 'on' }],
    ['the system setting', () => { systemReduce = true }],
  ])('holds one inspecting stance at the far end under reduced motion from %s', (_, reduce) => {
    reduce()
    const { container } = render(<ThreadMonitor tasks={tasks} />)
    const seen = stancesAt(container, [0, 2, 6, 11, 13.5])
    expect(new Set(seen.map(stance => JSON.stringify(stance))).size).toBe(1)
    expect(seen[0]).toEqual({ x: 'translateX(320px)', facing: '', ...RAISED })
  })
})
