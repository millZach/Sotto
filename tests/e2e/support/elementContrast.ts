import type { Locator } from '@playwright/test'

/**
 * The contrast of one element's text against the surface it sits on, with color-mix and translucent theme surfaces
 * resolved as Chromium paints them: every ancestor's background is laid over white in turn, then the text over that.
 * `textContrast.ts` measures every match of a selector inside a root instead.
 */
export async function elementContrast(locator: Locator): Promise<number> {
  return locator.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d')!
    const rgba = (color: string): number[] => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value)
    }
    const blend = (front: number[], back: number[]): number[] => front.slice(0, 3).map((value, index) => value * front[3]! + back[index]! * (1 - front[3]!))
    const ancestors: Element[] = []; let current: Element | null = element
    while (current) { ancestors.unshift(current); current = current.parentElement }
    let background = [255, 255, 255]
    for (const ancestor of ancestors) background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background)
    const foreground = blend(rgba(getComputedStyle(element).color), background)
    const luminance = (color: number[]): number => color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
    return (Math.max(luminance(foreground), luminance(background)) + .05) / (Math.min(luminance(foreground), luminance(background)) + .05)
  })
}
