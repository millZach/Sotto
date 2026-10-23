/**
 * The interface language (ADR-0122) in the built app with the `interface-language` Owl feature on: Settings > Appearance
 * > Language changes the window at once, the English word Language stays beside the label, the window keeps its
 * left-to-right layout, the row fits at the 820x560 minimum, and with the feature off nothing of it shows. An end-to-end
 * run reads English as the computer's language unless SOTTO_E2E_SYSTEM_LANGUAGES says otherwise.
 *
 *   npm run build && npx playwright test tests/e2e/interface-language.spec.ts
 *
 * With `SOTTO_E2E_EVIDENCE=publish` the screenshots go to artifacts/interface-language/ for the verification note.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { settingsLayoutProblems } from './support/settingsChecks'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { resizeWindow } from './support/sottoWindow'

const shots = evidenceDirectory('artifacts/interface-language')

async function launch(options: { enabled: boolean; systemLanguages?: string }): Promise<LaunchedSotto> {
  const previous = { features: process.env['SOTTO_OWL_FEATURES'], system: process.env['SOTTO_E2E_SYSTEM_LANGUAGES'] }
  process.env['SOTTO_OWL_FEATURES'] = `interface-language=${options.enabled ? 1 : 0}`
  if (options.systemLanguages === undefined) delete process.env['SOTTO_E2E_SYSTEM_LANGUAGES']
  else process.env['SOTTO_E2E_SYSTEM_LANGUAGES'] = options.systemLanguages
  try {
    return await launchSotto('success')
  } finally {
    for (const [name, value] of [['SOTTO_OWL_FEATURES', previous.features], ['SOTTO_E2E_SYSTEM_LANGUAGES', previous.system]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

async function openAppearance(page: Page): Promise<Locator> {
  await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
  await page.reload()
  await openPage(page, 'Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
  return page.locator('#settings-appearance')
}

const picker = (appearance: Locator): Locator => appearance.locator('.language-picker [role="combobox"]')

/** Picks a language from the keyboard, as someone who cannot read the current one would: open, type, Enter. */
async function choose(page: Page, appearance: Locator, letters: string, code: string): Promise<void> {
  await picker(appearance).focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type(letters)
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).interfaceLanguage)).toBe(code)
  await expect(page.locator('html')).toHaveAttribute('lang', code)
}

const SIZES = [[1280, 800], [820, 560]] as const

async function capture(launched: LaunchedSotto, appearance: Locator, name: string, open = false, sizes: readonly (readonly [number, number])[] = SIZES): Promise<void> {
  for (const [width, height] of sizes) {
    await resizeWindow(launched, width, height)
    await appearance.scrollIntoViewIfNeeded()
    await expect.poll(() => settingsLayoutProblems(launched.page, 'settings-appearance-panel', '.language-picker, .language-picker *'))
      .toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
    if (open) {
      await picker(appearance).click()
      await expect(launched.page.getByRole('listbox')).toBeVisible()
    }
    await launched.page.mouse.move(0, 0)
    await launched.page.screenshot({ path: join(shots, `${name}-${width}x${height}.png`), animations: 'disabled', caret: 'hide' })
    if (open) {
      await launched.page.keyboard.press('Escape')
      await expect(launched.page.getByRole('listbox')).toBeHidden()
    }
  }
}

test('Appearance chooses the interface language, and the window follows at once in every language', async () => {
  test.setTimeout(240_000)
  await mkdir(shots, { recursive: true })
  const launched = await launch({ enabled: true })
  try {
    const appearance = await openAppearance(launched.page)
    await expect(launched.page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(picker(appearance)).toHaveAccessibleName('Language Same as this computer (English)')
    await capture(launched, appearance, 'english')
    await capture(launched, appearance, 'english-list', true)

    await choose(launched.page, appearance, 'ja', 'ja')
    await expect(appearance.getByRole('heading', { level: 2, name: '外観' })).toBeVisible()
    await expect(appearance.locator('.language-picker__anchor')).toHaveText('Language')
    await expect(launched.page.locator('html')).toHaveAttribute('dir', 'ltr')
    await capture(launched, appearance, 'japanese')
    await capture(launched, appearance, 'japanese-list', true)
    // The light room too: the row takes its colours from the theme like the rest of the page.
    await launched.page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', 'light')
    await capture(launched, appearance, 'japanese-light-list', true, [[1280, 800]])
    await launched.page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))

    await choose(launched.page, appearance, 'ar', 'ar')
    await expect(appearance.getByRole('heading', { level: 2, name: 'المظهر' })).toBeVisible()
    await expect(launched.page.locator('html')).toHaveAttribute('dir', 'ltr')
    await capture(launched, appearance, 'arabic')

    // The way back: the first entry follows the computer again.
    await picker(appearance).focus()
    await launched.page.keyboard.press('Home')
    await launched.page.keyboard.press('Enter')
    await expect.poll(() => launched.page.evaluate(async () => (await window.sotto!.getSettings()).interfaceLanguage)).toBe('system')
    await expect(launched.page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(appearance.getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('follows the computer\'s language under Same as this computer', async () => {
  test.setTimeout(120_000)
  const launched = await launch({ enabled: true, systemLanguages: 'ko-KR,ja-JP' })
  try {
    await expect(launched.page.locator('html')).toHaveAttribute('lang', 'ja')
    const appearance = await openAppearance(launched.page)
    await expect(picker(appearance)).toHaveAccessibleName('言語 このコンピューターと同じ（日本語）')
  } finally {
    await closeSotto(launched)
  }
})

test('stable has no Language row and stays in English, whatever the computer\'s language', async () => {
  test.setTimeout(120_000)
  const launched = await launch({ enabled: false, systemLanguages: 'ja-JP' })
  try {
    const appearance = await openAppearance(launched.page)
    await expect(appearance.getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible()
    await expect(appearance.locator('.language-picker')).toHaveCount(0)
    await expect(launched.page.locator('html')).toHaveAttribute('lang', 'en')
  } finally {
    await closeSotto(launched)
  }
})

test('an unpackaged run shows a pseudo-language for layout checks, which the picker never lists', async () => {
  test.setTimeout(120_000)
  await mkdir(shots, { recursive: true })
  for (const code of ['en-XA', 'ar-XB']) {
    const previous = process.env['SOTTO_INTERFACE_LANGUAGE']
    process.env['SOTTO_INTERFACE_LANGUAGE'] = code
    let launched: LaunchedSotto | undefined
    try {
      launched = await launch({ enabled: true })
      const appearance = await openAppearance(launched.page)
      await expect(launched.page.locator('html')).toHaveAttribute('lang', code)
      await expect(appearance.getByRole('heading', { level: 2 })).not.toHaveText('Appearance')
      await picker(appearance).click()
      await expect(appearance.locator('.language-picker__list').getByRole('option')).toHaveCount(31)
      await expect(appearance.locator('.language-picker__list').getByRole('option', { name: new RegExp(code) })).toHaveCount(0)
      await launched.page.keyboard.press('Escape')
      await resizeWindow(launched, 820, 560)
      await launched.page.mouse.move(0, 0)
      await launched.page.screenshot({ path: join(shots, `pseudo-${code}-820x560.png`), animations: 'disabled', caret: 'hide' })
    } finally {
      if (previous === undefined) delete process.env['SOTTO_INTERFACE_LANGUAGE']
      else process.env['SOTTO_INTERFACE_LANGUAGE'] = previous
      if (launched) await closeSotto(launched)
    }
  }
})
