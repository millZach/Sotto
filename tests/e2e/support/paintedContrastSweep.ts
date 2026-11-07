import type { Page } from '@playwright/test'
import sharp from 'sharp'

/** One run of text on screen, its ink as computed and the surface under it as the frame painted it. */
export interface PaintedText {
  readonly region: string
  readonly text: string
  readonly selector: string
  readonly size: string
  readonly weight: string
  /** The computed ink, faded by opacity, over the surface. */
  readonly ratio: number
  /** The pixel of the text's box that stands furthest from the surface, over the surface: what its strokes reach once drawn. */
  readonly stroke: number
}

/** The part of the window a text sits in, by the nearest landmark the shell draws. */
const REGIONS: ReadonlyArray<readonly [string, string]> = [
  ['composer', 'form.thread-prompt'],
  ['needs-you', '.needs-you'],
  ['sidebar', '.thread-nav'],
  ['pane-header', '.thread-workspace__head'],
  ['transcript', '.thread-transcript'],
  ['tools', '.tools-panel, .tools-rail'],
]

/**
 * Every visible text in the frame with its contrast as painted: the ink is the element's computed colour, faded by its
 * own and its ancestors' opacity, laid over the colour the screenshot shows most often inside the text's box, which is
 * the surface it really sits on whatever gradients, washes or glass lie under it. The text's own strokes are a small
 * share of its box, so the commonest pixel is the surface. Run it on the frame `image` was taken from.
 */
export async function paintedContrastSweep(page: Page, image: Buffer): Promise<PaintedText[]> {
  const found = await page.evaluate(regions => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const rgba = (value: string): number[] => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = '#000'; context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r!, g!, b!, a! / 255]
    }
    const seen = new Set<Element>()
    const out: Array<{ region: string; text: string; selector: string; size: string; weight: string; ink: number[]; box: number[] }> = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.replace(/\s+/gu, ' ').trim()
      const element = node.parentElement
      if (!text || !element || seen.has(element) || element.closest('svg, input, textarea, [hidden]')) continue
      if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue
      const range = document.createRange(); range.selectNodeContents(node)
      const rect = range.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 4 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue
      // A text clipped away by an ancestor that scrolls or clips is not on screen.
      const centre = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 6))), Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)))
      if (!centre || !(centre === element || element.contains(centre) || centre.contains(element))) continue
      seen.add(element)
      let opacity = 1
      for (let at: Element | null = element; at; at = at.parentElement) opacity *= Number(getComputedStyle(at).opacity)
      const ink = rgba(getComputedStyle(element).color)
      ink[3] = ink[3]! * opacity
      const region = regions.find(([, selector]) => element.closest(selector))?.[0] ?? 'other'
      const classes = [...element.classList].slice(0, 2).join('.')
      out.push({ region, text: text.slice(0, 48), selector: `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`, size: getComputedStyle(element).fontSize, weight: getComputedStyle(element).fontWeight,
        ink, box: [rect.left, rect.top, rect.width, rect.height] })
    }
    return { found: out, width: innerWidth }
  }, REGIONS)
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const scale = info.width / found.width
  const luminance = (rgb: number[]): number => {
    const [r, g, b] = rgb.map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  return found.found.map(item => {
    const [left, top, width, height] = item.box.map(value => Math.round(value! * scale))
    const counts = new Map<number, number>()
    const pixels: number[][] = []
    for (let y = Math.max(0, top!); y < Math.min(info.height, top! + height!); y += 1) {
      for (let x = Math.max(0, left!); x < Math.min(info.width, left! + width!); x += 1) {
        const at = (y * info.width + x) * 4
        const key = (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!
        counts.set(key, (counts.get(key) ?? 0) + 1)
        pixels.push([data[at]!, data[at + 1]!, data[at + 2]!])
      }
    }
    const surfaceKey = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
    const surface = [(surfaceKey >> 16) & 255, (surfaceKey >> 8) & 255, surfaceKey & 255]
    const ink = item.ink.slice(0, 3).map((channel, index) => channel * item.ink[3]! + surface[index]! * (1 - item.ink[3]!))
    const ratio = (a: number, b: number): number => Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
    const ground = luminance(surface)
    const stroke = pixels.reduce((best, pixel) => Math.max(best, ratio(luminance(pixel), ground)), 1)
    return { region: item.region, text: item.text, selector: item.selector, size: item.size, weight: item.weight, ratio: ratio(luminance(ink), ground), stroke }
  }).sort((a, b) => a.ratio - b.ratio)
}
