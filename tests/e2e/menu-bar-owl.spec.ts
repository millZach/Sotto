/**
 * The menu bar owl's two choices in Settings → Appearance (ADR-0112), in the built app on a Mac with the `menu-bar-owl`
 * Owl feature on: Body and Eyes show their saved colours, pressing one saves it and moves the pressed state, a restart
 * keeps it, and with the feature off nothing of it shows. An end-to-end run makes no tray, so the animation itself is
 * covered by the unit tests and the verification note.
 *
 *   npm run build && npx playwright test tests/e2e/menu-bar-owl.spec.ts
 *
 * With `SOTTO_E2E_EVIDENCE=publish` the screenshot goes to artifacts/menu-bar-owl/ for the verification note.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'

const shots = evidenceDirectory('artifacts/menu-bar-owl')

test.skip(process.platform !== 'darwin', 'The menu bar owl is for a Mac.')

async function launch(enabled: boolean, userData?: string): Promise<LaunchedSotto> {
  const previous = process.env['SOTTO_OWL_FEATURES']
  process.env['SOTTO_OWL_FEATURES'] = `menu-bar-owl=${enabled ? 1 : 0}`
  try {
    return await launchSotto('success', userData)
  } finally {
    if (previous === undefined) delete process.env['SOTTO_OWL_FEATURES']
    else process.env['SOTTO_OWL_FEATURES'] = previous
  }
}

async function openAppearance(page: Page): Promise<Locator> {
  await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
  await page.reload()
  await openPage(page, 'Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
  return page.locator('#settings-appearance')
}

const body = (appearance: Locator, name: string): Locator => appearance.getByRole('button', { name: new RegExp(`^Use ${name} as the owl's body color`) })
const eyes = (appearance: Locator, name: string): Locator => appearance.getByRole('button', { name: new RegExp(`^Use ${name} as the owl's eye color`) })

test('a Mac in an Owl build chooses the menu bar owl\'s body and eyes in Appearance, and the choice is kept', async () => {
  test.setTimeout(120_000)
  await mkdir(shots, { recursive: true })
  const first = await launch(true)
  const userData = first.userData
  try {
    const appearance = await openAppearance(first.page)
    await expect(appearance.getByRole('heading', { name: 'Menu bar owl' })).toBeVisible()
    // The shipped choices: Slate and Sotto teal.
    await expect(body(appearance, 'Slate')).toHaveAttribute('aria-pressed', 'true')
    await expect(eyes(appearance, 'Sotto teal')).toHaveAttribute('aria-pressed', 'true')
    for (const other of ['Ink', 'Light']) await expect(body(appearance, other)).toHaveAttribute('aria-pressed', 'false')
    for (const other of ['Ice blue', 'Amber']) await expect(eyes(appearance, other)).toHaveAttribute('aria-pressed', 'false')

    // A press saves, and a keyboard press does too.
    await body(appearance, 'Ink').click()
    await expect.poll(() => first.page.evaluate(async () => (await window.sotto!.getSettings()).menuBarOwlBody)).toBe('ink')
    await eyes(appearance, 'Amber').focus()
    await first.page.keyboard.press('Enter')
    await expect.poll(() => first.page.evaluate(async () => (await window.sotto!.getSettings()).menuBarOwlEyes)).toBe('amber')
    await expect(body(appearance, 'Ink')).toHaveAttribute('aria-pressed', 'true')
    await expect(eyes(appearance, 'Amber')).toHaveAttribute('aria-pressed', 'true')
    await expect(body(appearance, 'Slate')).toHaveAttribute('aria-pressed', 'false')
    await appearance.getByRole('heading', { name: 'Menu bar owl' }).scrollIntoViewIfNeeded()
    await first.page.screenshot({ path: join(shots, 'settings-appearance.png') })
    // Nothing else moved: the owl's two choices are the only settings this changed.
    expect(await first.page.evaluate(async () => (await window.sotto!.getSettings()).effortColor)).toBe('ember')
  } finally {
    await closeSotto({ ...first, ownsUserData: false })
  }

  // A restart keeps both choices.
  const second = await launch(true, userData)
  try {
    const appearance = await openAppearance(second.page)
    await expect(body(appearance, 'Ink')).toHaveAttribute('aria-pressed', 'true')
    await expect(eyes(appearance, 'Amber')).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await closeSotto(second)
  }
})

test('stable shows nothing of the menu bar owl and keeps what an Owl build saved', async () => {
  test.setTimeout(120_000)
  const owl = await launch(true)
  const userData = owl.userData
  try {
    await owl.page.evaluate(() => window.sotto!.updateSettings({ menuBarOwlBody: 'ink', menuBarOwlEyes: 'amber' }))
    await expect.poll(() => owl.page.evaluate(async () => { const s = await window.sotto!.getSettings(); return [s.menuBarOwlBody, s.menuBarOwlEyes] })).toEqual(['ink', 'amber'])
  } finally {
    await closeSotto({ ...owl, ownsUserData: false })
  }

  const stable = await launch(false, userData)
  try {
    const appearance = await openAppearance(stable.page)
    await expect(appearance.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible()
    await expect(appearance.getByRole('heading', { name: 'Menu bar owl' })).toHaveCount(0)
    await expect(appearance.getByRole('button', { name: /owl's (body|eye) color/ })).toHaveCount(0)
    expect(await stable.page.evaluate(async () => { const s = await window.sotto!.getSettings(); return [s.menuBarOwlBody, s.menuBarOwlEyes] })).toEqual(['ink', 'amber'])
  } finally {
    await closeSotto(stable)
  }
})
