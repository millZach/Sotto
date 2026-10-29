import React, { type ReactElement } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Lardo, LardoTurnRunning, type LardoPose } from '../../../src/renderer/src/agents/Lardo'
import { lardoPaths } from '../../../src/renderer/src/agents/lardoSprite'

let systemReduce = false
beforeEach(() => {
  systemReduce = false
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout'], now: 0 })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: systemReduce, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  delete document.documentElement.dataset.reducedMotion
})

/** Lardo on a track inside a composer card holding a focused, half-written prompt, as the thread pane puts him. */
function onComposer(element: ReactElement) {
  const view = render(<form className="thread-prompt">
    <div className="thread-monitor" data-creature="lardo"><div className="thread-monitor__track">{element}</div></div>
    <textarea aria-label="Prompt" defaultValue="Make the changelog say what each fix means" />
  </form>)
  const prompt = view.getByLabelText('Prompt') as HTMLTextAreaElement
  prompt.focus()
  prompt.setSelectionRange(12, 12)
  return { ...view, prompt }
}
const actorOf = (container: HTMLElement) => container.querySelector<HTMLElement>('.thread-monitor__actor')!
/** Which frame is drawn, read back from his skin's path. */
const skin = (container: HTMLElement) => actorOf(container).querySelector('.lardo-s')!.getAttribute('d')
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

describe('Lardo', () => {
  it.each<[LardoPose, string | null]>([
    ['monitoring', null], ['working', null], ['held', '.thread-monitor__sand'], ['babysitting', '.thread-monitor__sign'],
  ])('wears the %s pose with its prop', (pose, prop) => {
    const { container } = onComposer(<Lardo pose={pose} agents={3} />)
    for (const letter of ['k', 's', 'h', 'd', 't']) expect(actorOf(container).querySelector(`.lardo-${letter}`)!.getAttribute('d')).toMatch(/^M\d/u)
    if (prop) expect(container.querySelector(prop)).not.toBeNull()
    expect(container.querySelectorAll('.thread-monitor__mini')).toHaveLength(pose === 'working' ? 3 : 0)
  })

  it('holds each pose in its classic stance', () => {
    const stance = (pose: LardoPose) => {
      const { container, unmount } = onComposer(<Lardo pose={pose} />)
      const drawn = skin(container)
      unmount()
      return drawn
    }
    document.documentElement.dataset.reducedMotion = 'on'
    expect(stance('monitoring')).toBe(lardoPaths('sideChest').s)
    expect(stance('working')).toBe(lardoPaths('frontDoubleBiceps').s)
    expect(stance('held')).toBe(lardoPaths('vacuum').s)
    expect(stance('babysitting')).toBe(lardoPaths('abdominalThigh').s)
  })

  it('keeps his own colours while babysitting, where the other creatures mute', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/agents/lardo.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    expect(css).not.toMatch(/babysitting/u)
  })

  it('flexes when the turn finishes while he is up, and goes back to his pose', () => {
    const { container, rerender } = render(<LardoTurnRunning.Provider value><div className="thread-monitor__track"><Lardo pose="working" /></div></LardoTurnRunning.Provider>)
    expect(actorOf(container)).not.toHaveAttribute('data-cue')
    rerender(<LardoTurnRunning.Provider value={false}><div className="thread-monitor__track"><Lardo pose="working" /></div></LardoTurnRunning.Provider>)
    expect(actorOf(container)).toHaveAttribute('data-cue', 'flex')
    advance(400)
    expect(skin(container)).toBe(lardoPaths('backDoubleBiceps').s)
    advance(1000)
    expect(actorOf(container)).not.toHaveAttribute('data-cue')
  })

  it('does not flex for a turn that ended before he came', () => {
    const { container } = render(<LardoTurnRunning.Provider value={false}><div className="thread-monitor__track"><Lardo pose="monitoring" /></div></LardoTurnRunning.Provider>)
    advance(100)
    expect(actorOf(container)).not.toHaveAttribute('data-cue')
  })

  it('throws a piece of the composer when clicked and never touches what is written, the caret or focus', () => {
    const { container, prompt } = onComposer(<Lardo pose="monitoring" />)
    // A press on him keeps focus where it is.
    expect(fireEvent.mouseDown(actorOf(container))).toBe(false)
    fireEvent.click(actorOf(container))
    expect(actorOf(container)).toHaveAttribute('data-cue', 'angry')
    const thrown = document.body.querySelector('.lardo-throw')!
    expect(thrown).not.toBeNull()
    expect(thrown).toHaveAttribute('aria-hidden', 'true')
    expect(prompt.contains(thrown)).toBe(false)
    advance(100)
    expect(skin(container)).toBe(lardoPaths('rip').s)
    advance(1200)
    expect(skin(container)).toBe(lardoPaths('mostMuscularAngry').s)
    expect(document.activeElement).toBe(prompt)
    expect(prompt.value).toBe('Make the changelog say what each fix means')
    expect(prompt.selectionStart).toBe(12)
    advance(1000)
    expect(actorOf(container)).not.toHaveAttribute('data-cue')
    expect(document.body.querySelector('.lardo-throw')).toBeNull()
  })

  it('ignores a click while he is already throwing', () => {
    const { container } = onComposer(<Lardo pose="held" />)
    fireEvent.click(actorOf(container))
    advance(1500)
    fireEvent.click(actorOf(container))
    advance(800)
    expect(actorOf(container)).not.toHaveAttribute('data-cue')
  })

  it.each([
    ['the app', () => { document.documentElement.dataset.reducedMotion = 'on' }],
    ['the system', () => { systemReduce = true }],
  ])('held still by %s, a click only makes him angry: nothing is thrown', (_, reduce) => {
    reduce()
    const { container } = onComposer(<Lardo pose="working" />)
    fireEvent.click(actorOf(container))
    expect(skin(container)).toBe(lardoPaths('mostMuscularAngry').s)
    expect(document.body.querySelector('.lardo-throw')).toBeNull()
    advance(1600)
    expect(skin(container)).toBe(lardoPaths('frontDoubleBiceps').s)
  })

  it('drops what he threw when reduced motion turns on mid-throw, and holds the angry pose', async () => {
    const { container } = onComposer(<Lardo pose="monitoring" />)
    fireEvent.click(actorOf(container))
    advance(400)
    expect(document.body.querySelector('.lardo-throw')).not.toBeNull()
    await act(async () => {
      document.documentElement.dataset.reducedMotion = 'on'
      await Promise.resolve()
    })
    expect(document.body.querySelector('.lardo-throw')).toBeNull()
    expect(skin(container)).toBe(lardoPaths('mostMuscularAngry').s)
    advance(1600)
    expect(actorOf(container)).not.toHaveAttribute('data-cue')
  })

  it('lines up small Lardos added while he is held still', () => {
    document.documentElement.dataset.reducedMotion = 'on'
    const { container, rerender } = render(<div className="thread-monitor__track"><Lardo pose="working" agents={1} /></div>)
    rerender(<div className="thread-monitor__track"><Lardo pose="working" agents={3} /></div>)
    const places = [...container.querySelectorAll<HTMLElement>('.thread-monitor__mini')].map(mini => mini.style.transform)
    expect(places).toHaveLength(3)
    expect(new Set(places).size).toBe(3)
    for (const place of places) expect(place).toMatch(/^translate\(/u)
  })

  it('stands unclickable in the Appearance preview', () => {
    const { container } = onComposer(<Lardo pose="monitoring" playful={false} />)
    expect(fireEvent.mouseDown(actorOf(container))).toBe(true)
    fireEvent.click(actorOf(container))
    expect(actorOf(container)).not.toHaveAttribute('data-cue')
  })

  it('stops everything he started when his pose goes mid-throw', () => {
    const { container, unmount } = onComposer(<Lardo pose="monitoring" />)
    // Standing, the only timer of his is the frame loop's next frame (focusing the prompt leaves jsdom's own).
    const standing = vi.getTimerCount()
    fireEvent.click(actorOf(container))
    expect(vi.getTimerCount()).toBeGreaterThan(standing)
    unmount()
    expect(document.body.querySelector('.lardo-throw')).toBeNull()
    // Every beat of the throw, the cue's end and the frame loop are gone with him.
    expect(vi.getTimerCount()).toBe(standing - 1)
  })
})
