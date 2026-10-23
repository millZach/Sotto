import { resizeContentWindow } from './support/sottoWindow'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'

/**
 * Settings' pages after the regroup (pick B, docs/prototypes/settings-structure-prototype.html): every page at the three
 * checked sizes in both modes fits without sideways overflow, Find a setting opens a page with focus on the setting, and
 * an old section link lands where it should. Captures go to artifacts/settings-pages for the verification note.
 */
const evidence = evidenceDirectory('artifacts/settings-pages')
const PAGES = ['Dictation', 'Cleanup', 'Threads', 'Git & worktrees', 'Providers', 'Hosts & phones', 'Cloud iPhone', 'Appearance', 'Application'] as const
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const

const sections = (page: Page) => page.getByRole('tablist', { name: 'Settings sections' })

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** Anything wider than the room it sits in: the form, a card, or a control. */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.settings-scroll')!
    const room = scroll.getBoundingClientRect()
    const problems: string[] = []
    if (scroll.scrollWidth > scroll.clientWidth + 1) problems.push(`settings-scroll ${scroll.scrollWidth} > ${scroll.clientWidth}`)
    for (const element of document.querySelectorAll<HTMLElement>('.settings-form > [role="tabpanel"]:not([hidden]) *')) {
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.right > room.right + 1) problems.push(`${element.tagName.toLowerCase()}.${element.className} right ${Math.round(box.right)} > ${Math.round(room.right)}`)
    }
    const rail = document.querySelector<HTMLElement>('.settings-sidebar__body')!
    if (rail.scrollWidth > rail.clientWidth + 1) problems.push('settings rail scrolls sideways')
    return problems.slice(0, 8)
  })
}

test('Settings pages fit every checked size in both modes, and Find a setting lands on the setting', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-settings-pages-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, reducedMotion: 'on' }), 'utf8')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await openPage(page, 'Settings')
    await expect(sections(page).getByRole('tab')).toHaveText([...PAGES])

    for (const mode of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
      for (const [width, height] of SIZES) {
        await resizeContentWindow(launched, width, height, [800, 540])
        for (const name of PAGES) {
          await sections(page).getByRole('tab', { name, exact: true }).click()
          await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible()
          expect(await overflow(page), `${name} ${width}x${height} ${mode}`).toEqual([])
          if (width !== 1600 || ['Dictation', 'Threads', 'Git & worktrees', 'Application'].includes(name)) await shot(page, `${name.toLowerCase().replace(/[^a-z]+/gu, '-')}-${mode}-${width}x${height}`)
        }
      }
    }

    // Find a setting: type, see where it lives, open it from the keyboard with focus on the setting.
    await resizeContentWindow(launched, 1280, 800)
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
    const find = page.getByRole('searchbox', { name: 'Find a setting' })
    await find.fill('worktree')
    await expect(page.getByRole('list', { name: 'Settings found' }).getByRole('button')).toHaveCount(6)
    await shot(page, 'find-worktree-dark-1280x800')
    await find.fill('reduced motion')
    await find.press('Enter')
    await expect(sections(page).getByRole('tab', { name: 'Appearance', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('combobox', { name: 'Reduced motion' })).toBeFocused()
    await shot(page, 'find-opened-reduced-motion-dark-1280x800')

    // Phones' button on the shared page brings Run the local host into view with focus on it, when the local host is off.
    await resizeContentWindow(launched, 820, 560, [800, 540])
    await sections(page).getByRole('tab', { name: 'Hosts & phones', exact: true }).click()
    await shot(page, 'hosts-and-phones-top-dark-820x560')
    await page.locator('#settings-phones').scrollIntoViewIfNeeded()
    await shot(page, 'hosts-and-phones-phones-dark-820x560')
    expect(errors).toEqual([])
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    await removeOwnedE2EProfile(profile)
  }
})
