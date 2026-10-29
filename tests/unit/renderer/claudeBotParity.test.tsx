import React, { type ReactElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadHeld, ThreadMonitor, ThreadWorking } from '../../../src/renderer/src/agents/ThreadMonitor'
import type { HeldAction } from '../../../src/renderer/src/agents/threadActivityView'
import type { Creature } from '../../../src/shared/settings'

/**
 * Claude bot and Lardo wear Sotto's creature's poses on Sotto's schedule: driven by the same clock on the same track, all
 * three stand in the same place, face the same way, send their small agents along the same path and run the same sand.
 */
const setting = vi.hoisted(() => ({ creature: 'sotto' as Creature }))
vi.mock('../../../src/renderer/src/state/creature', () => ({ useCreatureShown: () => true, useCreature: () => setting.creature }))

let width = 600, systemReduce = false
beforeEach(() => {
  width = 600; systemReduce = false
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: systemReduce, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  delete document.documentElement.dataset.reducedMotion
})

/** Renders `element` as `creature` on a fresh clock started at zero, and reads it `seconds` after it appears. */
function sample<T>(creature: Creature, element: ReactElement, seconds: readonly number[], read: (container: HTMLElement) => T): T[] {
  setting.creature = creature
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'], now: 0 })
  const { container, unmount } = render(element)
  let elapsed = 0
  const seen = seconds.map(second => {
    vi.advanceTimersByTime((second - elapsed) * 1000)
    elapsed = second
    return read(container)
  })
  unmount()
  vi.useRealTimers()
  return seen
}

/** Every creature read at the same times; each one's own art differs, so `read` keeps only what the schedule decides. */
function both<T>(element: ReactElement, seconds: readonly number[], read: (container: HTMLElement) => T): { sotto: T[]; claude: T[]; lardo: T[] } {
  return { sotto: sample('sotto', element, seconds, read), claude: sample('claude', element, seconds, read), lardo: sample('lardo', element, seconds, read) }
}

const reduce = { 'motion': () => undefined, 'reduced motion (app)': () => { document.documentElement.dataset.reducedMotion = 'on' }, 'reduced motion (system)': () => { systemReduce = true } }
const TIMES = [0, 1, 2, 3.9, 4, 6, 9, 11, 13, 13.5]
const actorX = (container: HTMLElement) => container.querySelector<HTMLElement>('.thread-monitor__actor')!.style.transform
/** Mirrored or not, never the string: Sotto mirrors about x 20 and the bot about its own centre. */
const mirrored = (container: HTMLElement) => /scale\(-1 1\)/u.test(container.querySelector('.thread-monitor__actor svg > g')?.getAttribute('transform') ?? '')

/** Under motion the samples must vary (so equality means something); held still, they are one value throughout. */
function expectSchedule<T>({ sotto, claude, lardo }: { sotto: T[]; claude: T[]; lardo: T[] }, motion: boolean): void {
  expect(claude).toEqual(sotto)
  expect(lardo).toEqual(sotto)
  const distinct = new Set(sotto.map(value => JSON.stringify(value))).size
  if (motion) expect(distinct).toBeGreaterThan(1)
  else expect(distinct).toBe(1)
}

describe.each([600, 340])('on a %i px track', track => {
  describe.each(Object.entries(reduce))('with %s', (name, setUp) => {
    const motion = name === 'motion'
    beforeEach(() => { width = track; setUp() })

    it('monitoring walks to the same place facing the same way', () => {
      const tasks = [{ id: '56d13d2c-f6d0-4968-a9ed-18c87a7d5b5a', label: 'Watch the build' }]
      expectSchedule(both(<ThreadMonitor tasks={tasks} />, TIMES, container => ({ x: actorX(container), mirrored: mirrored(container) })), motion)
    })

    it.each([1, 3, 6, 9])('working sends %i agents along the same path', agents => {
      const work = Array.from({ length: agents }, (_, index) => ({
        id: `6f0c1a2e-8f4b-4d3c-9a1e-${String(index).padStart(12, '0')}`, label: `Agent ${index + 1}`, type: 'subagent' as const,
      }))
      const seen = both(<ThreadWorking work={work} />, TIMES, container => ({
        x: actorX(container),
        minis: [...container.querySelectorAll<HTMLElement>('.thread-monitor__mini')].map(mini => mini.style.transform),
      }))
      expect(seen.claude[0]!.minis).toHaveLength(Math.min(6, agents))
      expect(seen.lardo[0]!.minis).toHaveLength(Math.min(6, agents))
      expectSchedule(seen, motion)
      // The bot and Lardo stand at the readout end throughout, as Sotto's creature does.
      expect(new Set(seen.claude.map(frame => frame.x)).size).toBe(1)
      expect(new Set(seen.lardo.map(frame => frame.x)).size).toBe(1)
    })

    it('held runs the same sand and turns the glass at the same moments', () => {
      const action: HeldAction = {
        id: 'a1', turnId: 't1', sequence: 1, kind: 'command', status: 'running', title: 'Run tests',
        command: 'npm test', startedAt: '2026-10-22T14:59:15.000Z',
      }
      expectSchedule(both(<ThreadHeld action={action} now={Date.parse('2026-10-22T15:00:00.000Z')} />, [0, 1, 2, 3, 4, 5.4, 5.75, 6.1, 7], container => {
        // Both draw the sand from hourglass.ts, so the same grains are the same path, in either chamber.
        const [top, bottom] = [...container.querySelectorAll('.thread-monitor__sand')].map(sand => sand.getAttribute('d'))
        return {
          top, bottom,
          turn: Number(/rotate\(([\d.]+)/u.exec(container.querySelector('g[transform^="rotate("]')!.getAttribute('transform')!)![1]),
        }
      }), motion)
    })
  })
})
