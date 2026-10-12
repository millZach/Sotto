import type { Locator } from '@playwright/test'

/**
 * Reads the colours a text element really paints: its computed ink, and the background behind it composited from
 * its ancestors' fills and the first colour of any row image (the hover and selection washes). The background is the
 * rounded sRGB pixel the screen shows. Waits for finite animations first, so a switch has finished painting.
 */
export async function measurePaintedPair(element: Locator) {
  return element.evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)))
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    const color = (value: string) => {
      if (!CSS.supports('color', value)) throw new Error(`Unsupported measured colour: ${value}`)
      // Chromium resolves a translucent sRGB mix as color(srgb ... / alpha).
      const srgb = /^color\(srgb ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+)(?: \/ ([\d.e+-]+))?\)$/u.exec(value)
      if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: Number(srgb[4] ?? 1) }
      context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      const data = context.getImageData(0, 0, 1, 1).data
      return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! / 255 }
    }
    const over = (top: ReturnType<typeof color>, bottom: ReturnType<typeof color>) => ({
      r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
    })
    const ancestors: Element[] = []
    for (let at: Element | null = element; at; at = at.parentElement) ancestors.unshift(at)
    let background = color('black')
    const paint: Array<{ element: string; background: string; image: string }> = []
    for (const ancestor of ancestors) {
      const style = getComputedStyle(ancestor)
      if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none') paint.push({ element: ancestor.className, background: style.backgroundColor, image: style.backgroundImage })
      background = over(color(style.backgroundColor), background)
      if (style.backgroundImage.startsWith('linear-gradient(')) {
        // The row images use two identical colours; keep nested colour commas intact.
        const body = style.backgroundImage.slice('linear-gradient('.length)
        let depth = 0, end = 0
        for (; end < body.length; end++) {
          if (body[end] === '(') depth++
          if (body[end] === ')') depth--
          if (body[end] === ',' && depth === 0) break
        }
        background = over(color(body.slice(0, end)), background)
      }
    }
    const foreground = color(getComputedStyle(element).color)
    return { foreground, background: { r: Math.round(background.r), g: Math.round(background.g), b: Math.round(background.b) }, paint }
  })
}
