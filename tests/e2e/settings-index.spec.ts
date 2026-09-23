import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSottoWithVoice, type LaunchedSotto } from './support/sottoLaunch'

const evidence = resolve('artifacts/settings-index')
const categories = ['Dictation', 'Transcription', 'Cleanup', 'Providers', 'Agents', 'Output', 'Appearance', 'Application'] as const
const sizes = [[1280, 800], [1600, 1000], [820, 560]] as const

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    host.setMinimumSize(800, 540)
    host.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
}

async function category(page: Page, name: typeof categories[number]): Promise<void> {
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name, exact: true }).click()
  await expect(page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.settings-form > [role="tabpanel"]:visible')).toHaveCount(1)
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

test('Index settings: focused categories, real saves, failure feedback, themes and persistence in Windows', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(240_000)
  await mkdir(evidence, { recursive: true })
  // With voice on: the Agents category shows its voice settings only for the beta's hidden coordinator.
  const launched = await launchSottoWithVoice('hotkey-conflict')
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const layout: Record<string, unknown>[] = []
  const settings = () => page.evaluate(() => window.sotto!.getSettings())
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on', autoPaste: true, historyEnabled: true })
    })
    await page.reload()
    await resize(launched, 1280, 800)
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true })).toHaveAttribute('aria-selected', 'true')

    // Every real category, including long forms, fits a typical and narrow native window.
    for (const [width, height] of sizes) {
      await resize(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        for (const name of categories) {
          await category(page, name)
          await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
          const bounds = await page.evaluate(() => {
            const scroll = document.querySelector('.settings-scroll')!
            const panel = scroll.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
            const controls = [...panel.querySelectorAll<HTMLElement>('input,select,button,textarea')]
              .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
            return {
              pageOverflow: document.documentElement.scrollWidth > innerWidth,
              formOverflow: scroll.scrollWidth > scroll.clientWidth + 1,
              clippedControls: controls.filter(element => {
                const box = element.getBoundingClientRect(), frame = scroll.getBoundingClientRect()
                return box.left < frame.left - 1 || box.right > frame.right + 1
              }).map(element => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 60)),
            }
          })
          layout.push({ width, height, mode, category: name, ...bounds })
          expect(bounds, `${name} ${width} ${mode}`).toEqual({ pageOverflow: false, formOverflow: false, clippedControls: [] })
          await shot(page, `${name.toLowerCase()}-${width}-${mode}`)
          if (width === 820 && name === 'Appearance') {
            await page.getByLabel('Glass opacity', { exact: true }).scrollIntoViewIfNeeded()
            await expect(page.getByLabel('Glass opacity', { exact: true })).toBeInViewport()
            await shot(page, `appearance-${width}-${mode}-sliders`)
          }
          if (width === 820 && ['Appearance', 'Application', 'Agents', 'Providers'].includes(name)) {
            await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
            await shot(page, `${name.toLowerCase()}-${width}-${mode}-bottom`)
          }
        }
      }
    }

    await resize(launched, 1280, 800)
    await category(page, 'Dictation')
    const originalHotkey = (await settings()).hotkey
    await page.getByRole('textbox', { name: 'Global shortcut' }).fill('Ctrl+Alt+9')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Output', exact: true }).click()
    await expect(page.locator('.settings-notice')).toContainText('Another application')
    expect((await settings()).hotkey).toBe(originalHotkey)
    // A validation failure survives category navigation without accepting an invalid value.
    await page.getByRole('textbox', { name: 'Paste delay', exact: true }).fill('not a number')
    await category(page, 'Cleanup')
    await category(page, 'Output')
    await expect(page.getByRole('textbox', { name: 'Paste delay', exact: true })).toHaveValue('not a number')
    await expect(page.getByText('Enter a whole number between 50 and 1000.')).toBeVisible()
    await page.getByRole('textbox', { name: 'Paste delay', exact: true }).fill('325')
    await category(page, 'Cleanup')
    await expect.poll(async () => (await settings()).pasteDelayMs).toBe(325)
    await page.getByRole('textbox', { name: 'Personal dictionary' }).fill('Sotto\nZach\nOregon')
    await category(page, 'Transcription')
    await expect.poll(async () => (await settings()).llmDictionary).toBe('Sotto\nZach\nOregon')
    await page.getByRole('button', { name: 'Verify key', exact: true }).click()
    // The E2E profile supplies a local transcription service and its own fixture key.
    await expect(page.getByText('Key verified.', { exact: true })).toBeVisible()
    await shot(page, 'transcription-key-feedback')

    // Native settings/theme IPC remains live; editor cancel and import errors never save.
    await category(page, 'Appearance')
    await page.getByRole('radiogroup', { name: 'Color scheme', exact: true }).getByRole('radio', { name: 'Dark', exact: true }).click()
    const darkColumn = page.getByRole('radiogroup', { name: 'Dark theme', exact: true })
    await darkColumn.getByRole('radio', { name: 'Linen', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'linen')
    await expect.poll(async () => (await settings()).darkTheme).toBe('linen')
    await shot(page, 'appearance-linen-live')
    // A column is one Tab stop: from the chosen theme, Tab leaves it rather than walking the other five.
    await expect(darkColumn.getByRole('radio')).toHaveCount(6)
    await darkColumn.getByRole('radio', { name: 'Linen', exact: true }).focus()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('.theme-half') !== null)).toBe(false)
    await shot(page, 'appearance-keyboard-columns')
    const contrast = page.getByLabel('Contrast', { exact: true })
    await contrast.focus()
    await page.keyboard.press('End')
    await category(page, 'Output')
    await expect.poll(async () => (await settings()).appearanceContrast).toBe(200)
    await category(page, 'Appearance')
    await expect(contrast).toHaveValue('200')
    await page.getByRole('button', { name: 'Reset contrast to 100%' }).click()
    await expect.poll(async () => (await settings()).appearanceContrast).toBe(100)
    await page.getByRole('button', { name: 'Create theme', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Create theme', exact: true })
    await editor.getByLabel('Theme name', { exact: true }).fill('Index review')
    await editor.getByLabel('Background hex value', { exact: true }).fill('#182b24')
    await expect(page.locator('html')).toHaveAttribute('data-theme-id', '__preview')
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'linen')
    await page.getByRole('button', { name: 'Add theme', exact: true }).click()
    const importer = page.getByRole('dialog', { name: 'Add a theme' })
    await importer.getByLabel('Theme JSON').fill('{invalid json')
    await importer.getByRole('button', { name: 'Add theme', exact: true }).click()
    await expect(importer.getByRole('alert')).toBeVisible()
    await shot(page, 'theme-import-error')
    await page.keyboard.press('Escape')
    await expect(importer).toBeHidden()

    await category(page, 'Agents')
    const spoken = page.getByRole('switch', { name: 'Spoken replies', exact: true })
    const spokeBefore = await spoken.getAttribute('aria-checked')
    await spoken.click()
    await category(page, 'Output')
    await category(page, 'Agents')
    await expect(spoken).toHaveAttribute('aria-checked', spokeBefore === 'true' ? 'false' : 'true')
    await page.getByText('Advanced wake settings', { exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Wake model directory', exact: true })).toBeVisible()
    await resize(launched, 820, 560)
    await page.getByRole('textbox', { name: 'Wake runtime directory', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('textbox', { name: 'Wake runtime directory', exact: true })).toBeInViewport()
    await shot(page, 'agents-advanced-820')

    await category(page, 'Application')
    await page.getByRole('switch', { name: 'Keep local history', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'History retention', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Clear history', exact: true }).click()
    const clear = page.getByRole('dialog', { name: 'Clear history?' })
    await expect(clear).toBeVisible()
    await clear.getByRole('button', { name: 'Keep history', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Clear history', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Reset settings', exact: true }).click()
    await page.getByRole('dialog', { name: 'Reset settings?' }).getByRole('button', { name: 'Keep settings', exact: true }).click()

    // Category tabs support keyboard navigation; hidden forms never remain in tab order.
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Application', exact: true }).focus()
    await page.keyboard.press('Home')
    await expect(page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true })).toBeFocused()
    // The column continues into the sidebar foot (the room switch, the page links, the update control) and only
    // then reaches the open panel; no hidden form takes a stop on the way.
    let focusedPanel: string | null | undefined = null
    for (let step = 0; step < 8 && !focusedPanel; step += 1) {
      await page.keyboard.press('Tab')
      focusedPanel = await page.evaluate(() => document.activeElement?.closest('[role="tabpanel"]')?.getAttribute('aria-labelledby'))
      if (!focusedPanel) expect(await page.evaluate(() => document.activeElement?.closest('.thread-nav__foot') !== null)).toBe(true)
    }
    expect(focusedPanel).toContain('capture')

    await page.reload()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await category(page, 'Output')
    await expect(page.getByRole('textbox', { name: 'Paste delay', exact: true })).toHaveValue('325')
    await category(page, 'Cleanup')
    await expect(page.getByRole('textbox', { name: 'Personal dictionary' })).toHaveValue('Sotto\nZach\nOregon')
    await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'linen')
    expect((await settings()).customThemes).toEqual([])
    expect(errors).toEqual([])
    await writeFile(join(evidence, 'verification.json'), JSON.stringify({ layout, errors, persisted: { pasteDelayMs: 325, dictionary: true, darkTheme: 'linen' } }, null, 2))
  } finally { await closeSotto(launched) }
})
