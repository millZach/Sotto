import { afterEach, describe, expect, it } from 'vitest'

import { surfaceOf } from '../../../src/renderer/src/watcher/WatcherNightScene'

/** A one-pixel canvas that paints the last rgb()/rgba() it was given, as the browser's would. */
function pixel(): CanvasRenderingContext2D {
  let fill = 'rgba(0, 0, 0, 0)'
  const fake = {
    clearRect: () => undefined,
    fillRect: () => undefined,
    get fillStyle() { return fill },
    set fillStyle(value: string) { if (/^rgba?\(/u.test(value)) fill = value },
    getImageData: () => {
      const [r = 0, g = 0, b = 0, a = 1] = fill.slice(fill.indexOf('(') + 1, -1).split(',').map(part => Number(part.trim()))
      return { data: [r, g, b, Math.round(a * 255)] }
    },
  }
  return fake as unknown as CanvasRenderingContext2D
}

function room(...backgrounds: string[]): HTMLElement {
  let parent: HTMLElement = document.body
  let node = parent
  for (const background of backgrounds) {
    node = document.createElement('div')
    node.style.backgroundColor = background
    parent.appendChild(node)
    parent = node
  }
  return node
}

afterEach(() => { document.body.replaceChildren(); document.body.removeAttribute('style') })

describe('the surface the night scene reads (ADR-0126, ADR-0149)', () => {
  it('is the first solid background on a solid window', () => {
    expect(surfaceOf(room('rgb(20, 22, 26)', 'rgba(0, 0, 0, 0)'), pixel())).toEqual({ r: 20, g: 22, b: 26 })
  })

  it('lays a translucent room over the desktop that is worst for the words', () => {
    const pane = room('rgba(10, 12, 16, 0.8)')
    // Light words: the room as pure white behind the window leaves it.
    const behindLight = surfaceOf(pane, pixel(), { r: 250, g: 250, b: 250 })!
    expect(behindLight.r).toBeCloseTo(10 * 0.8 + 255 * 0.2, 5)
    // Dark words: the room over pure black.
    const behindDark = surfaceOf(pane, pixel(), { r: 5, g: 5, b: 5 })!
    expect(behindDark.r).toBeCloseTo(10 * 0.8, 5)
  })

  it('stacks translucent layers down to the first solid one', () => {
    const pane = room('rgb(100, 100, 100)', 'rgba(200, 200, 200, 0.5)')
    // Half is 128 of 255 on a canvas.
    expect(surfaceOf(pane, pixel(), { r: 0, g: 0, b: 0 })!.r).toBeCloseTo(150, 0)
  })
})
