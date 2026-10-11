import type { ElectronApplication, Locator, Page } from '@playwright/test'

/** Restore the user's clipboard after a copy journey, even when the check fails. */
export async function withClipboard<T>(app: ElectronApplication, run: () => Promise<T>): Promise<T> {
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
  try { return await run() } finally { await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved) }
}

export function horizontalOverflow(page: Page): Promise<number> {
  return page.getByLabel('Thread transcript').evaluate(element => element.scrollWidth - element.clientWidth)
}

// What the visual specs share (ADR-0056): calling the visualize tool as a thread's agent would, scrolling a card into
// view, quiet captures, and the checks for contrast and motion.

export type ToolReply = { content: { type: string; text?: string }[]; isError?: boolean }

/** Calls the visualize tool for the Workshop thread, through the same server a provider's call reaches. */
export const visualize = (page: Page, args: unknown): Promise<ToolReply> =>
  page.evaluate(request => window.sottoE2E!.visualTool!(request), { threadId: 'workshop', arguments: args }) as Promise<ToolReply>

/** Scrolls the transcript so the element sits `offset` pixels below its top, with the words before it in view. */
export async function scrollToCard(locator: Locator, offset = 80): Promise<void> {
  await locator.evaluate((element, gap) => {
    const transcript = element.closest('.thread-workspace__transcript')!
    transcript.scrollTop += element.getBoundingClientRect().top - transcript.getBoundingClientRect().top - gap
  }, offset)
}

/** A screenshot at `path` with nothing focused, so a focus ring left by the keyboard checks does not stand in the picture. */
export async function quietShot(page: Page, path: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.screenshot({ path, animations: 'disabled' })
}

/**
 * The contrast of each selected element's text against what it sits on: the room, the card, and every background
 * between the card and the element, the element's own included.
 */
export async function textContrasts(card: Locator, selectors: readonly string[]): Promise<number[]> {
  return card.evaluate((element, list) => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d')!
    const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--tt-canvas)'; document.body.append(probe)
    const room = getComputedStyle(probe).backgroundColor; probe.remove()
    const luminance = (data: Uint8ClampedArray): number => [...data].slice(0, 3).map(value => value / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
    const paint = (...colours: string[]): number => {
      for (const colour of colours) { context.fillStyle = colour; context.fillRect(0, 0, 1, 1) }
      return luminance(context.getImageData(0, 0, 1, 1).data)
    }
    return list.map(selector => {
      const target = element.querySelector(selector)!
      const layers = [room, getComputedStyle(element).backgroundColor]
      for (let node = target as Element | null; node && node !== element; node = node.parentElement) {
        const colour = getComputedStyle(node).backgroundColor
        if (colour && colour !== 'rgba(0, 0, 0, 0)') layers.splice(2, 0, colour)
      }
      const background = paint(...layers)
      const foreground = paint(...layers, getComputedStyle(target).color)
      return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05)
    })
  }, selectors)
}

/** Every element in `locator`, its own pseudo-elements included, that transitions or animates for longer than 1 ms. */
export function slowMotion(locator: Locator): Promise<string[]> {
  return locator.evaluate(element => {
    const seconds = (value: string): number => Math.max(...value.split(',').map(part => part.trim().endsWith('ms') ? parseFloat(part) / 1000 : parseFloat(part)))
    const slow: string[] = []
    for (const node of [element, ...element.querySelectorAll('*')]) for (const pseudo of [null, '::before', '::after']) {
      const style = getComputedStyle(node, pseudo)
      if (seconds(style.transitionDuration) > 0.001 || seconds(style.animationDuration) > 0.001) slow.push(`${node.className}${pseudo ?? ''}`)
    }
    return slow
  })
}
