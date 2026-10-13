import type { Locator } from '@playwright/test'

/** The contrast of the text of each element `selector` names inside `root` against the surface it sits on. */
export function textContrast(root: Locator, selector: string, visibleOnly = false) {
  return root.evaluate((element, { selector, visibleOnly }) => {
    // Computed colours arrive as oklab or oklch; a canvas turns any of them into sRGB bytes.
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const parse = (value: string): number[] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r!, g!, b!, a! / 255]
    }
    const background = (from: Element | null): number[] => {
      const layers: number[][] = []
      for (let node = from; node; node = node.parentElement) {
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
    return [...element.querySelectorAll(selector)]
      .filter(item => !visibleOnly || item.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
      .map(item => {
      const surface = background(item)
      const text = parse(getComputedStyle(item).color)
      const blended = text.map((channel, index) => index === 3 ? 1 : channel * text[3]! + surface[index]! * (1 - text[3]!))
      const [light, dark] = [luminance(blended), luminance(surface)].sort((a, b) => b - a)
      return { text: item.textContent!.slice(0, 30), ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100 }
    })
  }, { selector, visibleOnly })
}
