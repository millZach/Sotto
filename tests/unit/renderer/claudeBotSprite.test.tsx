import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BOT_BODY_ROWS, ClaudeBotSprite, paintBot, pixelPath, useBotParts, type BotParts } from '../../../src/renderer/src/agents/claudeBotSprite'

/** The shared drawing every Claude bot pose is built on: what the four poses may rely on. */
afterEach(cleanup)

function mount(children?: React.ReactNode): { parts: BotParts; svg: SVGSVGElement } {
  let captured: BotParts | undefined
  function Probe(): React.ReactNode {
    const parts = useBotParts()
    captured = parts
    return <svg viewBox="0 0 40 32"><ClaudeBotSprite parts={parts}>{children}</ClaudeBotSprite></svg>
  }
  const { container } = render(<Probe />)
  return { parts: captured!, svg: container.querySelector('svg')! }
}

describe('pixelPath', () => {
  it('draws one rectangle per run and merges runs of one width on neighbouring rows', () => {
    expect(pixelPath(['..bb', '..bb', 'b...'], 'b')).toBe('M2 0h2v2h-2z M0 2h1v1h-1z')
    // An origin moves every rectangle; other letters and gaps draw nothing.
    expect(pixelPath(['bh', 'hb'], 'h', 5, 10)).toBe('M6 10h1v1h-1z M5 11h1v1h-1z')
    expect(pixelPath(['...'], 'b')).toBe('')
  })

  it('keeps runs of different widths apart even when they touch', () => {
    expect(pixelPath(['bbb', 'bb.'], 'b')).toBe('M0 0h3v1h-3z M0 1h2v1h-2z')
  })
})

describe('the body', () => {
  it('is a 23 by 18 picture made of body, highlight and shade only', () => {
    expect(BOT_BODY_ROWS).toHaveLength(18)
    for (const row of BOT_BODY_ROWS) expect(row).toMatch(/^[.bhl]{23}$/u)
  })

  it('fills the box x 5-28, y 10-28 of the 40 by 32 grid, with only its corners cut', () => {
    // The body is drawn at (5, 10): its picture's columns 0-22 and rows 0-17 are x 5-28 and y 10-28.
    const filled = BOT_BODY_ROWS.map(row => [...row].flatMap((cell, x) => cell === '.' ? [] : [x]))
    expect(Math.min(...filled.flat())).toBe(0)
    expect(Math.max(...filled.flat())).toBe(22)
    expect(filled.every(row => row.length > 0)).toBe(true)
    expect(filled[0]).toHaveLength(19)
    expect(filled[17]).toHaveLength(19)
    expect(filled.slice(2, 16).every(row => row.length >= 22)).toBe(true)
  })

  it('draws every path inside the 40 by 32 box the poses give it', () => {
    const { svg } = mount()
    const boxes = [...svg.querySelectorAll('path')].flatMap(path => [...path.getAttribute('d')!.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)/gu)])
      .map(([, x, y, w, h]) => ({ x: Number(x), y: Number(y), w: Number(w), h: Number(h) }))
    expect(boxes.length).toBeGreaterThan(20)
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(40)
      expect(box.y + box.h).toBeLessThanOrEqual(32)
    }
  })
})

describe('paintBot', () => {
  it('stands, eyes open, by default', () => {
    const { parts } = mount()
    paintBot(parts)
    expect(parts.legs.current).toHaveAttribute('d', 'M7 27h3v5h-3z M11 27h3v5h-3z M19 27h3v5h-3z M23 27h3v5h-3z')
    expect(parts.body.current).toHaveAttribute('transform', '')
    expect(parts.eyes.current).toHaveAttribute('d', 'M10 12h2v5h-2z M21 12h2v5h-2z')
    expect(parts.glints.current).toHaveAttribute('d', 'M10 12h1v1h-1z M21 12h1v1h-1z')
    expect(parts.bulbFill.current).toHaveAttribute('class', 'bot-a')
  })

  it('trots: diagonal pairs of legs lift on the first and third frames, and every leg is down between', () => {
    const { parts } = mount()
    paintBot(parts, { walking: true, step: 0 })
    expect(parts.legs.current).toHaveAttribute('d', 'M7 27h3v4h-3z M11 27h3v5h-3z M19 27h3v5h-3z M23 27h3v4h-3z')
    expect(parts.feet.current).toHaveAttribute('d', 'M7 30h3v1h-3z M11 31h3v1h-3z M19 31h3v1h-3z M23 30h3v1h-3z')
    paintBot(parts, { walking: true, step: 2 })
    expect(parts.legs.current).toHaveAttribute('d', 'M7 27h3v5h-3z M11 27h3v4h-3z M19 27h3v4h-3z M23 27h3v5h-3z')
    paintBot(parts, { walking: true, step: 1 })
    expect(parts.legs.current).toHaveAttribute('d', 'M7 27h3v5h-3z M11 27h3v5h-3z M19 27h3v5h-3z M23 27h3v5h-3z')
    expect(parts.feet.current).toHaveAttribute('d', 'M7 31h3v1h-3z M11 31h3v1h-3z M19 31h3v1h-3z M23 31h3v1h-3z')
    // Standing is the same as a frame between steps; a step does nothing unless the bot walks.
    paintBot(parts, { walking: false, step: 0 })
    expect(parts.legs.current).toHaveAttribute('d', 'M7 27h3v5h-3z M11 27h3v5h-3z M19 27h3v5h-3z M23 27h3v5h-3z')
  })

  it('wraps the gait, takes a frame that is not a whole number as the one it falls in, and never throws on one that is not a number', () => {
    const { parts } = mount()
    const legs = (step: number): string | null => { paintBot(parts, { walking: true, step }); return parts.legs.current!.getAttribute('d') }
    expect(legs(4)).toBe(legs(0))
    expect(legs(-1)).toBe(legs(3))
    expect(legs(2.7)).toBe(legs(2))
    expect(legs(Number.NaN)).toBe(legs(1))
    expect(legs(Number.POSITIVE_INFINITY)).toBe(legs(1))
  })

  it('stands its legs as evenly about the bot\'s centre as its body is, so turning it round moves nothing but the prop', () => {
    const { parts } = mount()
    paintBot(parts)
    const lefts = [...parts.legs.current!.getAttribute('d')!.matchAll(/M(\d+) 27h3/gu)].map(match => Number(match[1]))
    // Mirroring about x 16.5 sends a leg at x to x' = 30 - x (a leg is 3 wide).
    expect(lefts.map(x => 30 - x).sort((a, b) => a - b)).toEqual([...lefts].sort((a, b) => a - b))
  })

  it('blinks, rests and looks by moving the eyes and the mouth together', () => {
    const { parts } = mount()
    paintBot(parts, { eyes: 'blink' })
    expect(parts.eyes.current).toHaveAttribute('d', 'M10 15h2v1h-2z M21 15h2v1h-2z')
    expect(parts.glints.current).toHaveAttribute('d', 'M0 0h0v0z')
    paintBot(parts, { eyes: 'rest' })
    expect(parts.eyes.current).toHaveAttribute('d', 'M10 14h2v2h-2z M21 14h2v2h-2z')
    expect(parts.mouth.current).toHaveAttribute('d', 'M15 19h3v1h-3z')
    paintBot(parts, { eyes: 'open', look: 1 })
    expect(parts.eyes.current).toHaveAttribute('d', 'M11 12h2v5h-2z M22 12h2v5h-2z')
    expect(parts.mouth.current!.getAttribute('d')).toContain('M16 19h3v1h-3z')
  })

  it('bobs, sways, lights the bulb and turns the emblem, and puts every one back', () => {
    const { parts } = mount()
    paintBot(parts, { bob: true, sway: -1, glow: true, spark: true, handL: 2, handR: -1 })
    expect(parts.body.current).toHaveAttribute('transform', 'translate(0 -1)')
    expect(parts.bulb.current).toHaveAttribute('transform', 'translate(-1 0)')
    expect(parts.bulbFill.current).toHaveAttribute('class', 'bot-w')
    expect(parts.armL.current).toHaveAttribute('transform', 'translate(0 -2)')
    expect(parts.armR.current).toHaveAttribute('transform', 'translate(0 1)')
    const cross = parts.spark.current!.getAttribute('d')
    paintBot(parts)
    expect(parts.body.current).toHaveAttribute('transform', '')
    expect(parts.bulb.current).toHaveAttribute('transform', '')
    expect(parts.bulbFill.current).toHaveAttribute('class', 'bot-a')
    expect(parts.armL.current).toHaveAttribute('transform', '')
    expect(parts.armR.current).toHaveAttribute('transform', '')
    expect(parts.spark.current!.getAttribute('d')).not.toBe(cross)
  })
})

describe('the sprite', () => {
  it('carries the pose\'s prop in the right hand, drawn over the body, and lifts it with the hand', () => {
    const { parts, svg } = mount(<rect data-testid="prop" width="1" height="1" />)
    const hand = parts.armR.current!
    const prop = svg.querySelector('[data-testid="prop"]')!
    expect(hand).toContainElement(prop as HTMLElement)
    // Drawn after the body paths and the face, so the prop is never hidden behind them.
    const order = [...svg.querySelectorAll('path, rect, g')]
    expect(order.indexOf(prop)).toBeGreaterThan(order.indexOf(parts.spark.current!))
    paintBot(parts, { handR: 5 })
    expect(hand).toHaveAttribute('transform', 'translate(0 -5)')
  })

  it('keeps one set of parts for the life of the pose, so an effect keyed on it runs once', () => {
    const seen: BotParts[] = []
    function Probe(): React.ReactNode {
      const parts = useBotParts()
      seen.push(parts)
      return <svg viewBox="0 0 40 32"><ClaudeBotSprite parts={parts} /></svg>
    }
    const { rerender } = render(<Probe />)
    rerender(<Probe />)
    rerender(<Probe />)
    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(new Set(seen).size).toBe(1)
  })

  it('uses only the sprite\'s colour classes, never an inline colour', () => {
    const { svg } = mount()
    for (const path of svg.querySelectorAll('path')) {
      expect(path.getAttribute('class') ?? '').toMatch(/^bot-[bhldkaw]$/u)
      expect(path).not.toHaveAttribute('fill')
      expect(path).not.toHaveAttribute('style')
    }
  })

  it('mirrors about the bot\'s centre through the facing group, which wraps everything', () => {
    const { parts, svg } = mount()
    expect(parts.facing.current).toBe(svg.firstElementChild)
    expect(parts.facing.current!.querySelectorAll('path').length).toBe(svg.querySelectorAll('path').length)
  })
})
