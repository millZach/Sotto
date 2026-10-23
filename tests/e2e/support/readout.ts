import { expect, type Locator, type Page } from '@playwright/test'

export interface ReadoutContrast { label: number; status: number; surface: number[] }

/**
 * The readout is words on the room: it is drawn above the composer, out of the composer's own fill, so its DOM
 * ancestors lie about what is under it. Composite the backgrounds from the composer's parent up to the window instead.
 */
export function readoutContrast(task: Locator): Promise<ReadoutContrast> {
  return task.evaluate(element => {
    // Computed colours arrive as oklab or oklch; a canvas turns any of them into sRGB bytes.
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const parse = (value: string): number[] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r!, g!, b!, a! / 255]
    }
    // Without a composer there is no room to measure against: say so rather than fall back to black.
    const room = element.closest('.thread-prompt, .agent-composer')?.parentElement
    if (!room) throw new Error('The readout is not inside a composer, so there is no room to measure it against.')
    const layers: number[][] = []
    for (let node: Element | null = room; node; node = node.parentElement) {
      const colour = parse(getComputedStyle(node).backgroundColor)
      if (colour[3]! > 0) layers.push(colour)
      if (colour[3] === 1) break
    }
    const surface = layers.reverse().reduce((under, over) => under.map((channel, index) => index === 3 ? 1 : over[index]! * over[3]! + channel * (1 - over[3]!)), [0, 0, 0, 1])
    const luminance = ([r, g, b]: number[]): number => {
      const linear = (channel: number): number => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!)
    }
    const ratio = (selector: string): number => {
      const text = parse(getComputedStyle(element.querySelector(selector)!).color)
      const blended = text.map((channel, index) => index === 3 ? 1 : channel * text[3]! + surface[index]! * (1 - text[3]!))
      const [light, dark] = [luminance(blended), luminance(surface)].sort((a, b) => b - a)
      return Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100
    }
    return { label: ratio('.thread-monitor__label'), status: ratio('.thread-monitor__status'), surface: surface.slice(0, 3).map(Math.round) }
  })
}

/** The colour actually painted in the readout's top-left padding, where no glyph reaches. */
export async function paintedUnderReadout(page: Page, task: Locator): Promise<number[]> {
  const box = (await task.boundingBox())!
  const png = await page.screenshot({ clip: { x: box.x + 2, y: box.y + 2, width: 4, height: 4 }, scale: 'css', animations: 'disabled', caret: 'hide' })
  return page.evaluate(async source => {
    const image = new Image()
    image.src = `data:image/png;base64,${source}`
    await image.decode()
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    context.drawImage(image, 0, 0)
    return [...context.getImageData(2, 2, 1, 1).data].slice(0, 3)
  }, png.toString('base64'))
}

/** No fill, outline, shadow, image or generated box: nothing of the readout can cover what is behind it. */
export async function expectReadoutUnfilled(task: Locator): Promise<void> {
  const style = await task.evaluate(element => {
    const computed = getComputedStyle(element)
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    context.fillStyle = computed.backgroundColor
    context.fillRect(0, 0, 1, 1)
    const generated: string[] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(node, pseudo).content
        if (content !== 'none' && content !== 'normal') generated.push(`${node.className}${pseudo} ${content}`)
      }
      if (node.classList.contains('thread-monitor')) break
    }
    return {
      alpha: context.getImageData(0, 0, 1, 1).data[3],
      borders: [computed.borderTopWidth, computed.borderRightWidth, computed.borderBottomWidth, computed.borderLeftWidth],
      boxShadow: computed.boxShadow,
      outline: computed.outlineStyle === 'none' ? '0px' : computed.outlineWidth,
      backgroundImage: computed.backgroundImage,
      generated,
    }
  })
  expect(style.alpha).toBe(0)
  expect(style.borders).toEqual(['0px', '0px', '0px', '0px'])
  expect(style.boxShadow).toBe('none')
  expect(style.outline).toBe('0px')
  expect(style.backgroundImage).toBe('none')
  expect(style.generated).toEqual([])
}
