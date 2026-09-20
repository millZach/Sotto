import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(800, 540)
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}

async function prepare(launched: LaunchedSotto): Promise<void> {
  await launched.page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
    await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'grok-previews' })
  })
  await launched.page.reload()
  await openThreads(launched.page)
  await launched.page.getByRole('button', { name: 'Grok voice previews', exact: true }).click()
}

const sidebar = (page: Page): Locator => page.getByRole('complementary', { name: 'Thread sidebar', exact: true })
const separator = (page: Page): Locator => page.getByRole('separator', { name: 'Resize sidebar', exact: true })
const row = (page: Page, title: string): Locator => sidebar(page).locator('.thread-nav__row').filter({ has: page.getByRole('button', { name: title, exact: true }) })

async function dragWidth(page: Page, width: number): Promise<void> {
  const box = (await separator(page).boundingBox())!
  const left = (await sidebar(page).boundingBox())!.x
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(left + width, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
}

async function expectWidth(page: Page, width: number): Promise<void> {
  await expect.poll(async () => Math.round((await sidebar(page).boundingBox())!.width)).toBe(width)
  await expect(separator(page)).toHaveAttribute('aria-valuenow', String(width))
}

async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => ({
    document: document.documentElement.scrollWidth > innerWidth,
    body: document.body.scrollWidth > innerWidth,
    sidebar: (() => { const element = document.querySelector<HTMLElement>('[aria-label="Thread sidebar"]')!; return element.scrollWidth > element.clientWidth })(),
  }))).toEqual({ document: false, body: false, sidebar: false })
}

async function expectCollapsedNavigation(page: Page): Promise<void> {
  const navigation = sidebar(page)
  await expect(navigation.getByRole('tablist', { name: 'Page', exact: true })).toBeHidden()
  await expect(navigation.getByRole('tab')).toHaveCount(0)
  await expect(navigation.getByRole('navigation', { name: 'Pages', exact: true }).getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
  // Scroll widths miss centered controls spilling beyond both edges. Check their actual visible bounds.
  expect(await navigation.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return [...element.querySelectorAll<HTMLElement>('.thread-nav__pages a')].filter(control => {
      const box = control.getBoundingClientRect()
      const style = getComputedStyle(control)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden'
        && (box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5 || box.top < bounds.top - 0.5 || box.bottom > bounds.bottom + 0.5)
    }).map(control => control.textContent?.trim())
  })).toEqual([])
}
test('project rows resize by pointer and keyboard, retain drafts, and remember collapse and width', async () => {
  test.setTimeout(90_000)
  const launched = await launchSotto('design-threads')
  const { page } = launched
  try {
    await resize(launched, 1600, 1000)
    await prepare(launched)
    await expectWidth(page, 320)
    await expect(separator(page)).toHaveAttribute('aria-orientation', 'vertical')
    await expect(separator(page)).toHaveAccessibleDescription(/Left and Right arrow keys.*Shift.*Home.*End/)
    await expect(separator(page)).toHaveAttribute('aria-valuemin', '260')
    await expect(separator(page)).toHaveAttribute('aria-valuemax', '480')
    const preview = row(page, 'Grok voice previews')
    // Row actions temporarily occupy the narrow metadata line on hover or keyboard focus.
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).focus()
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).hover()
    await expect(preview.locator('.thread-nav__provider')).toBeVisible()
    await expect(preview.locator('.thread-nav__provider')).toContainText('Claude')
    await expect(preview.locator('.thread-nav__status')).toBeVisible()
    await expect(preview.locator('.thread-nav__status')).toContainText('Done')
    await expect(preview.locator('.thread-nav__model')).toBeHidden()
    // This fixture has no worktree metadata. A wide row must not invent a branch.
    await expect(preview.locator('.thread-nav__branch svg.lucide-git-branch')).toHaveCount(0)
    await expect(preview.locator('.thread-nav__branch-name')).toHaveText('Project folder')
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Keep this original draft through every sidebar change.')
    const settings = sidebar(page).getByRole('link', { name: 'Settings', exact: true })
    await expect(settings.locator('svg.lucide-settings')).toBeVisible()
    const settingsSymbol = await settings.locator('svg').innerHTML()

    await dragWidth(page, 480)
    await expectWidth(page, 480)
    await expect(preview.locator('.thread-nav__model')).toBeVisible()
    await expect(preview.locator('.thread-nav__model')).toContainText('Sonnet 4.5')
    await separator(page).focus()
    await page.keyboard.press('Home')
    await expectWidth(page, 260)
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => Number(await separator(page).getAttribute('aria-valuenow'))).toBeGreaterThan(260)
    await page.keyboard.press('End')
    await expectWidth(page, 480)
    await page.keyboard.press('ArrowLeft')
    const remembered = Number(await separator(page).getAttribute('aria-valuenow'))
    expect(remembered).toBeLessThan(480)
    expect(remembered).toBeGreaterThan(420)
    await expect(prompt).toHaveValue('Keep this original draft through every sidebar change.')
    await expect(settings.locator('svg')).toHaveJSProperty('innerHTML', settingsSymbol)

    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
    await expect(separator(page)).toBeHidden()
    await expect(prompt).toHaveValue('Keep this original draft through every sidebar change.')
    await page.reload()
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Threads', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await expectWidth(page, remembered)
    await expect(prompt).toHaveValue('Keep this original draft through every sidebar change.')
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Threads', exact: true }).click()
    await expectWidth(page, remembered)
    await expect(settings.locator('svg')).toHaveJSProperty('innerHTML', settingsSymbol)
    await page.reload()
    await openThreads(page)
    await expectWidth(page, remembered)
    await expect(prompt).toHaveValue('Keep this original draft through every sidebar change.')
  } finally { await closeSotto(launched) }
})

test('expanded and collapsed sidebars fit desktop sizes in both appearances and reduced motion', async () => {
  test.setTimeout(90_000)
  const launched = await launchSotto('design-threads')
  const { page } = launched
  try {
    await prepare(launched)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      if (width === 1600) {
        await separator(page).focus()
        await page.keyboard.press('End')
      }
      await expectWidth(page, Math.min(480, width - 470))
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expectNoOverflow(page)
        await expect(sidebar(page).getByRole('link', { name: 'Settings', exact: true }).locator('svg.lucide-settings')).toBeVisible()
        await page.screenshot({ path: `artifacts/thread-sidebar/expanded-${width}-${appearance}.png`, animations: 'disabled' })
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
        await expectNoOverflow(page)
        await expectCollapsedNavigation(page)
        await page.screenshot({ path: `artifacts/thread-sidebar/collapsed-${width}-${appearance}.png`, animations: 'disabled' })
        await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
        await expectWidth(page, Math.min(480, width - 470))
      }
    }
    // A small window caps the rendered width without erasing the width chosen on a larger display.
    await resize(launched, 1600, 1000)
    await expectWidth(page, 480)
  } finally { await closeSotto(launched) }
})
