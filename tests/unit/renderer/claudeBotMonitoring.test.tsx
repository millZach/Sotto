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
const RAISED = { glass: 'translate(18 14)', hand: 'translate(0 -5)', handle: 'M9 5h2v2H9z' }
const stancesAt = (container: HTMLElement, seconds: readonly number[]) => {
  let elapsed = 0
  return seconds.map(second => {
    vi.advanceTimersByTime((second - elapsed) * 1000)
    elapsed = second
    return stanceOf(container)
  })
}

describe('Claude bot monitoring', () => {
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
