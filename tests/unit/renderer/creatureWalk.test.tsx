import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreatureWalk } from '../../../src/renderer/src/agents/CreatureWalk'
import type { Creature } from '../../../src/shared/settings'

/** A stand-in IntersectionObserver the test drives: it records every instance and fires its callback on demand. */
class FakeObserver {
  static instances: FakeObserver[] = []
  readonly targets: Element[] = []
  disconnected = false
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) { FakeObserver.instances.push(this) }
  observe(target: Element) { this.targets.push(target) }
  disconnect() { this.disconnected = true }
  fire(isIntersecting: boolean) { act(() => this.callback([{ isIntersecting }])) }
}

beforeEach(() => {
  FakeObserver.instances = []
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** The observer made so far (one per mount). */
const observer = (index = 0): FakeObserver => {
  const made = FakeObserver.instances[index]
  if (!made) throw new Error(`no observer ${index}`)
  return made
}
const actorOf = (container: HTMLElement) => container.querySelector('.thread-monitor__actor')

describe('creature walk', () => {
  it.each<Creature>(['sotto', 'claude'])('mounts %s only while the block is on screen, keeping the block', creature => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const { container } = render(<CreatureWalk creature={creature} />)
    const block = container.querySelector<HTMLElement>('.creature-walk')!
    expect(block.dataset.creature).toBe(creature)
    expect(block).toHaveAttribute('aria-hidden', 'true')
    expect(actorOf(container)).toBeNull()
    expect(observer().targets).toEqual([block])
    observer().fire(true)
    expect(container.querySelector('.creature-walk > .thread-monitor__track .thread-monitor__actor')).not.toBeNull()
    observer().fire(false)
    expect(actorOf(container)).toBeNull()
    expect(container.querySelector('.creature-walk')).toBe(block)
  })

  it('asks for no animation frames while off screen', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const frames = vi.spyOn(window, 'requestAnimationFrame')
    render(<CreatureWalk creature="claude" />)
    observer().fire(false)
    vi.advanceTimersByTime(1000)
    expect(frames).not.toHaveBeenCalled()
    observer().fire(true)
    vi.advanceTimersByTime(100)
    expect(frames).toHaveBeenCalled()
  })

  it('makes one observer per mount, keeps it across renders and disconnects it on unmount', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const { rerender, unmount } = render(<CreatureWalk creature="sotto" />)
    observer().fire(true)
    rerender(<CreatureWalk creature="claude" />)
    expect(FakeObserver.instances).toHaveLength(1)
    expect(observer().disconnected).toBe(false)
    unmount()
    expect(observer().disconnected).toBe(true)
  })

  it('walks at once where there is no IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { container } = render(<CreatureWalk creature="sotto" />)
    expect(actorOf(container)).not.toBeNull()
  })
})
