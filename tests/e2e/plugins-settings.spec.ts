import { resizeContentWindow } from './support/sottoWindow'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'

/**
 * Settings › Plugins on Owl (ADR-0205): the page sits after Providers, GitHub's row says who gh is signed in as and
 * opens in place, shows its recent use by threads from the plugin use record, it fits the three checked sizes in both modes, Find a setting reaches it, and a gh that is
 * signed out shows the command to sign in. gh is a stand-in that reaches nothing. Captures go to
 * artifacts/plugins-settings for the verification note.
 */
const evidence = evidenceDirectory('artifacts/plugins-settings')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const OWNED = ['SOTTO_OWL_FEATURES', 'SOTTO_E2E_GH_SCRIPT', 'SOTTO_E2E_GH_EXECUTABLE', 'FAKE_GH_SIGN_IN'] as const

const sections = (page: Page) => page.getByRole('tablist', { name: 'Settings sections' })

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** Anything on the open page that is wider than the room it sits in. */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.settings-scroll')!
    const room = scroll.getBoundingClientRect()
    const problems: string[] = []
    if (scroll.scrollWidth > scroll.clientWidth + 1) problems.push(`settings-scroll ${scroll.scrollWidth} > ${scroll.clientWidth}`)
    for (const element of document.querySelectorAll<HTMLElement>('#settings-plugins *')) {
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.right > room.right + 1) problems.push(`${element.tagName.toLowerCase()}.${element.className} right ${Math.round(box.right)} > ${Math.round(room.right)}`)
    }
    return problems.slice(0, 8)
  })
}

test('Plugins shows GitHub’s sign-in on Owl, fits every checked size, and says how to sign in when gh is signed out', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-plugins-settings-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, reducedMotion: 'on' }), 'utf8')
  const signIn = join(profile, 'fake-gh-sign-in.json')
  await writeFile(signIn, JSON.stringify({ login: 'example-user' }), 'utf8')
  // Two uses already in the record, by threads this profile does not hold: the row names what was done and says the thread is gone.
  await writeFile(join(profile, 'plugin-use.json'), JSON.stringify({ version: 1, uses: [
    { id: '11111111-1111-4111-8111-000000000002', at: '2026-11-12T09:07:00.000Z', threadId: 'gone-thread-two', plugin: 'github', tool: 'plugin_read', kind: 'pull-requests', outcome: 'failed' },
    { id: '11111111-1111-4111-8111-000000000001', at: '2026-11-12T09:05:00.000Z', threadId: 'gone-thread-one', plugin: 'github', tool: 'plugin_read', kind: 'issues', outcome: 'done' },
  ] }), 'utf8')
  const previous = Object.fromEntries(OWNED.map(key => [key, process.env[key]]))
  process.env.SOTTO_OWL_FEATURES = 'plugins=1'
  process.env.SOTTO_E2E_GH_SCRIPT = resolve('tests/fixtures/fakeGhSignIn.mjs')
  process.env.SOTTO_E2E_GH_EXECUTABLE = process.execPath
  process.env.FAKE_GH_SIGN_IN = signIn
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await openPage(page, 'Settings')

    // The page sits directly after Providers in the rail.
    const names = await sections(page).getByRole('tab').allTextContents()
    expect(names.indexOf('Plugins')).toBe(names.indexOf('Providers') + 1)
    await sections(page).getByRole('tab', { name: 'Plugins', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
    await expect(panel).toBeVisible()
    const row = panel.getByRole('button', { name: /^GitHub/u })
    await expect(row).toHaveAccessibleName('GitHub Signed in as example-user through gh')

    // The row opens in place, from the keyboard, and closes again.
    await row.focus()
    await page.keyboard.press('Enter')
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByText('Signed in as example-user through gh on this computer.')).toBeVisible()
    await expect(panel.getByText('GitHub uses the gh command’s own sign-in. Sotto stores nothing for it.')).toBeVisible()
    await expect(panel.getByText('A thread’s agent uses a plugin through Sotto’s tools and never holds its secret. Reading never asks you. A change, such as posting a comment, asks you first in its thread, each time.')).toBeVisible()
    const used = panel.getByRole('region', { name: 'Recent use' }).getByRole('listitem')
    await expect(used).toHaveCount(2)
    await expect(used.nth(0)).toContainText('Read pull requests in a thread that is gone It failed.')
    await expect(used.nth(1)).toContainText('Read issues in a thread that is gone')
    // Escape from a control inside the row closes it and gives focus back to its header; Enter opens it again.
    await panel.getByRole('button', { name: 'Check GitHub’s sign-in again' }).focus()
    await page.keyboard.press('Escape')
    await expect(row).toHaveAttribute('aria-expanded', 'false')
    await expect(row).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(row).toHaveAttribute('aria-expanded', 'true')

    for (const mode of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
      for (const [width, height] of SIZES) {
        await resizeContentWindow(launched, width, height, [800, 540])
        expect(await overflow(page), `Plugins ${width}x${height} ${mode}`).toEqual([])
        if (mode === 'dark' || width === 1280) await shot(page, `plugins-github-signed-in-${mode}-${width}x${height}`)
      }
    }

    // A gh that is signed out: Check again asks it anew, and the row shows the command to run.
    await resizeContentWindow(launched, 1280, 800)
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
    await writeFile(signIn, JSON.stringify({}), 'utf8')
    await panel.getByRole('button', { name: 'Check GitHub’s sign-in again' }).click()
    await expect(row).toHaveAccessibleName('GitHub Not signed in')
    await expect(panel.getByText('gh auth login', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Copy the gh sign-in command' })).toBeVisible()
    await shot(page, 'plugins-github-signed-out-dark-1280x800')

    // Find a setting reaches the row by its name.
    const find = page.getByRole('searchbox', { name: 'Find a setting' })
    await sections(page).getByRole('tab', { name: 'Providers', exact: true }).click()
    await find.fill('GitHub')
    await expect(page.getByRole('list', { name: 'Settings found' }).getByRole('button').first()).toContainText('GitHub')
    await find.press('Enter')
    await expect(sections(page).getByRole('tab', { name: 'Plugins', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(row).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    for (const key of OWNED) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    await removeOwnedE2EProfile(profile)
  }
})
