import type { Page } from '@playwright/test'

/**
 * Stills the Owl night sky's twinkle, so a capture of an Owl window repeats exactly: every star at its own strength,
 * the picture reduced motion shows. The twinkle runs on the compositor, which does not repaint a paused animation
 * moved to another time, so it is switched off, a style change the screen follows. Stable has no sky to still.
 */
export async function holdOwlSky(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const star of document.querySelectorAll<HTMLElement>('.thread-nav__star')) star.style.animation = 'none'
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

/** Lets the twinkle start again from the stylesheet, as it does when the sky first appears. */
export async function releaseOwlSky(page: Page): Promise<void> {
  await page.evaluate(() => { for (const star of document.querySelectorAll<HTMLElement>('.thread-nav__star')) star.style.removeProperty('animation') })
}
