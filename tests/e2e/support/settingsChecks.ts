import type { Page } from '@playwright/test'

/**
 * Nothing in a Settings panel overflows the form or the window, and none of the elements `selector` names inside it
 * is cut off at either side.
 */
export function settingsLayoutProblems(page: Page, panelId: string, selector: string) {
  return page.evaluate(({ panelId, selector }) => {
    const scroll = document.querySelector('.settings-scroll')!
    const panel = document.getElementById(panelId)!
    const frame = scroll.getBoundingClientRect()
    const clipped = [...panel.querySelectorAll<HTMLElement>(selector)]
      .filter(element => element.getClientRects().length)
      .filter(element => { const box = element.getBoundingClientRect(); return box.left < frame.left - 1 || box.right > frame.right + 1 })
      .map(element => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 60))
    return { pageOverflow: document.documentElement.scrollWidth > innerWidth, formOverflow: scroll.scrollWidth > scroll.clientWidth + 1, clipped }
  }, { panelId, selector })
}

/** The contrast of the text of each element `selector` names inside `panelId` against the surface it sits on. */
export function settingsTextContrast(page: Page, panelId: string, selector: string) {
  return page.evaluate(({ panelId, selector }) => {
    // Computed colours arrive as oklab or oklch; a canvas turns any of them into sRGB bytes.
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const parse = (value: string): number[] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r!, g!, b!, a! / 255]
    }
    const background = (element: Element | null): number[] => {
      const layers: number[][] = []
      for (let node = element; node; node = node.parentElement) {
        const colour = parse(getComputedStyle(node).backgroundColor)
        if (colour[3]! > 0) layers.push(colour)
        if (colour[3] === 1) break
      }
      return layers.reverse().reduce((under, over) => under.map((channel, index) => index === 3 ? 1 : over[index]! * over[3]! + channel * (1 - over[3]!)), [0, 0, 0, 1])
    }
    const luminance = ([r, g, b]: number[]): number => {
      const linear = (channel: number): number => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!)
    }
    return [...document.getElementById(panelId)!.querySelectorAll(selector)].map(element => {
      const surface = background(element)
      const text = parse(getComputedStyle(element).color)
      const blended = text.map((channel, index) => index === 3 ? 1 : channel * text[3]! + surface[index]! * (1 - text[3]!))
      const [light, dark] = [luminance(blended), luminance(surface)].sort((a, b) => b - a)
      return { text: element.textContent!.slice(0, 30), ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100 }
    })
  }, { panelId, selector })
}
