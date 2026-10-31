import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { hostKeysPerTest } from './support/hostKeys'
import { promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { evidenceDirectory } from '../fixtures/evidence'

// #1820: at the minimum window, a thread waiting on a permission opened with its card's Deny and Allow under the
// floating composer, which read "Queued until you answer the card" over choices nobody could see. The transcript keeps
// room for the composer below its last item and a focus margin of the same height (WCAG 2.4.11), and opening the thread
// lands on its choices. Measured in the built app at 820x560, with nothing scrolled by hand.

const evidence = evidenceDirectory('artifacts/pending-card-clearance')
const hostKeys = hostKeysPerTest()
test.beforeEach(() => { hostKeys.reset() })

const CHOICES = ['Deny', 'Allow'] as const

async function prepare(launched: LaunchedSotto): Promise<void> {
  const { page } = launched
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'blue' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await hostKeys.read(page)
  await openThreads(page)
}

async function open(page: Page, title: string): Promise<void> {
  const row = page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true })
  // Press the title, as a person does: a row's hover actions cover its middle.
  await row.click({ position: { x: 16, y: 12 } })
  await expect(row).toHaveAttribute('aria-current', 'page')
}

interface Clearance { readonly name: string; readonly bottom: number; readonly composerTop: number; readonly hit: boolean }

/** Where a choice sits against the top of what the composer draws, and whether a press at its middle reaches it. */
async function clearance(pane: Locator, name: string): Promise<Clearance> {
  return pane.evaluate((element, name) => {
    const compose = element.querySelector<HTMLElement>(':scope > .thread-workspace__compose')!
    const shown = [...compose.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.offsetHeight > 0)
    const composerTop = Math.min(...shown.map(child => child.getBoundingClientRect().top))
    const button = [...element.querySelectorAll<HTMLButtonElement>('.thread-transcript .agent-request[data-kind="permission"] button')]
      .find(candidate => candidate.textContent?.trim() === name)!
    const box = button.getBoundingClientRect()
    return { name, bottom: box.bottom, composerTop, hit: button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) }
  }, name)
}

function expectClear(place: Clearance): void {
  const context = JSON.stringify(place)
  expect(place.bottom, context).toBeLessThanOrEqual(place.composerTop + 1)
  expect(place.hit, context).toBe(true)
}

/** The frames a focus scroll and the transcript's own placement take to settle. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test('a thread waiting on a permission opens with its choices above the composer at 820x560, and Tab never leaves one under it', async () => {
  test.setTimeout(150_000)
  const launched = await launchSotto('design-threads')
  const { page } = launched
  try {
    await prepare(launched)
    // The window's own minimum drops a little below the request, so a frame that rounds the content to 820x562, as Windows
    // can, still reaches the exact size.
    await resizeContentWindow(launched, 820, 560, [800, 540])
    const pane = page.locator(`section.thread-pane[data-thread-id="${hostKeys.key('visual-gate')}"]`)
    const allow = pane.getByRole('button', { name: 'Allow', exact: true })

    // Opened from the sidebar, from another thread and again from a third, the choices show without a scroll.
    for (const before of ['Footer links', 'Streaming WAV stall']) {
      await open(page, before)
      await open(page, 'Visual gate flake')
      await expect(allow).toBeVisible()
      await settle(page)
      for (const name of CHOICES) expectClear(await clearance(pane, name))
    }
    // The empty composer's placeholder in both appearances (#1819), above it the card's choices.
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await page.screenshot({ path: join(evidence, `opened-820x560-${appearance}.png`), animations: 'disabled' })
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    // A composer that grows under a reader at the end, with a draft of several lines, keeps the choices clear of it, and
    // so does opening the thread again on that draft.
    const prompt = promptField(pane)
    await prompt.click()
    for (const [index, line] of ['Check the widget capture first.', 'Then run the agents suite.', 'Tell me what failed.'].entries()) {
      if (index > 0) await page.keyboard.press('Shift+Enter')
      await page.keyboard.type(line)
    }
    await expect.poll(() => prompt.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(60)
    await settle(page)
    for (const name of CHOICES) expectClear(await clearance(pane, name))
    await open(page, 'Footer links')
    await open(page, 'Visual gate flake')
    await expect(allow).toBeVisible()
    await settle(page)
    for (const name of CHOICES) expectClear(await clearance(pane, name))
    await page.screenshot({ path: join(evidence, 'reopened-on-draft-820x560-dark.png'), animations: 'disabled' })

    // Each choice reached by Tab while it sits under the composer comes clear of it. The reader first scrolls the choice
    // under the card, then focus moves onto it from the control before it in the tab order.
    for (const name of CHOICES) {
      const placed = await pane.evaluate((element, name) => {
        const log = element.querySelector<HTMLElement>('[aria-label="Thread transcript"]')!
        const compose = element.querySelector<HTMLElement>(':scope > .thread-workspace__compose > .thread-prompt')!
        const tabbable = [...document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex], [contenteditable="true"]')]
          .filter(candidate => candidate.tabIndex >= 0 && !(candidate as HTMLButtonElement).disabled && candidate.getClientRects().length > 0)
        const button = tabbable.find(candidate => candidate.closest('.agent-request[data-kind="permission"]') !== null && candidate.textContent?.trim() === name)!
        log.scrollTop += button.getBoundingClientRect().top - (compose.getBoundingClientRect().top + 12)
        log.dispatchEvent(new Event('scroll'))
        const before = tabbable[tabbable.indexOf(button) - 1]!
        before.focus({ preventScroll: true })
        const box = button.getBoundingClientRect()
        return { under: box.top >= compose.getBoundingClientRect().top - 1, from: before.getAttribute('aria-label') ?? before.textContent?.trim() ?? before.tagName }
      }, name)
      expect(placed.under, `${name} under the composer before Tab, from ${placed.from}`).toBe(true)
      await page.keyboard.press('Tab')
      const focused = pane.getByRole('button', { name, exact: true })
      await expect(focused).toBeFocused()
      await settle(page)
      expectClear(await clearance(pane, name))
    }
    await page.screenshot({ path: join(evidence, 'tabbed-allow-820x560-dark.png'), animations: 'disabled' })
  } finally { await closeSotto(launched) }
})
