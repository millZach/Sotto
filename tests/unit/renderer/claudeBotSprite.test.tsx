import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeBotSprite, paintBot, pixelPath, useBotParts, type BotParts } from '../../../src/renderer/src/agents/claudeBotSprite'

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
})
