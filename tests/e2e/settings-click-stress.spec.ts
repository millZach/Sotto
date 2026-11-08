// DO NOT MERGE. A throwaway stress of #2051, for a Diagnose pull request only: it tries to make the Settings journey's
// projects directory click hang on purpose, so the hang probe records it. It runs on every platform, unlike
// settings-index.spec.ts, so it can be tried on Linux too.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { clickOrProbeHang, evaluateRecordingInput } from './support/hangProbe'

const ITERATIONS = Number(process.env.SOTTO_2051_ITERATIONS ?? '150')
const CLICK_MS = Number(process.env.SOTTO_2051_CLICK_MS ?? '30000')

/**
 * What the page waits for after the save before the evaluation returns and the click is sent: nothing, a microtask, a
 * frame, or not even the save's own answer.
 */
const gaps = ['none', 'microtask', 'frame', 'unawaited'] as const
type Gap = typeof gaps[number]

const CHANGE = 'Change the default projects directory on this computer'
const CHOOSE = 'Choose the default projects directory on this computer'
const categories = ['Dictation', 'Cleanup', 'Threads', 'Keyboard', 'Git & worktrees', 'Providers', 'Hosts & phones', 'Cloud iPhone', 'Appearance', 'Application'] as const

async function category(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

/** Runs in the page: saves the folder and waits as `gap` says before answering. Self-contained, as it is sent as source. */
async function saveFolder({ path, gap }: { path: string; gap: Gap }): Promise<void> {
  const saved = window.sotto!.agents!.command({ type: 'configure', patch: { projectsDirectory: path } })
  if (gap === 'unawaited') { saved.catch(() => undefined); return }
  await saved
  if (gap === 'microtask') await Promise.resolve()
  else if (gap === 'frame') await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
}

async function openSettings(launched: LaunchedSotto): Promise<void> {
  const { page } = launched
  // The same start as settings-index.spec.ts.
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on', autoPaste: true, historyEnabled: true })
  })
  await page.reload()
  await resizeContentWindow(launched, 1280, 800, [800, 540])
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true })).toHaveAttribute('aria-selected', 'true')
}

/** Opens and closes the theme importer, as settings-index.spec.ts does just before it goes to Threads. */
async function throughThemeImporter(page: Page): Promise<void> {
  await category(page, 'Appearance')
  await page.getByRole('button', { name: 'Add theme', exact: true }).click()
  const importer = page.getByRole('dialog', { name: 'Add a theme' })
  await importer.getByLabel('Theme JSON').fill('{invalid json')
  await importer.getByRole('button', { name: 'Add theme', exact: true }).click()
  await expect(importer.getByRole('alert')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(importer).toBeHidden()
}

/**
 * settings-index.spec.ts up to its projects directory click, with its screenshots taken but not kept and its layout
 * checks left out: every category at three sizes in both looks, the shortcut conflict (Windows only), the paste delay,
 * the dictionary, Verify key, and Appearance's themes, contrast, editor and importer.
 */
async function journeyPreamble(launched: LaunchedSotto): Promise<void> {
  const { page } = launched
  const settings = () => page.evaluate(() => window.sotto!.getSettings())
  const shot = async (): Promise<void> => { await page.mouse.move(1, 1); await page.screenshot({ animations: 'disabled', caret: 'hide' }) }
  for (const [width, height] of [[1280, 800], [1600, 1000], [820, 560]] as const) {
    await resizeContentWindow(launched, width, height, [800, 540])
    for (const mode of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
      for (const name of categories) {
        await category(page, name)
        await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
        await shot()
        if (width === 820 && ['Dictation', 'Threads', 'Git & worktrees', 'Hosts & phones', 'Appearance', 'Application', 'Providers'].includes(name)) {
          await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
          await shot()
        }
      }
    }
  }
  await resizeContentWindow(launched, 1280, 800, [800, 540])
  await category(page, 'Dictation')
  if (process.platform === 'win32') {
    const pressRow = page.getByRole('group', { name: 'Press to start and stop' })
    await pressRow.getByRole('button', { name: /^Change shortcut/u }).click()
    await page.keyboard.down('Control')
    await page.keyboard.down('Alt')
    await page.keyboard.press('9')
    await page.keyboard.up('Alt')
    await page.keyboard.up('Control')
    await expect(pressRow.getByRole('alert')).toContainText('Another app already uses Ctrl + Alt + 9.')
    await category(page, 'Cleanup')
    await category(page, 'Dictation')
  }
  await page.getByRole('textbox', { name: 'Paste delay', exact: true }).fill('325')
  await category(page, 'Cleanup')
  await expect.poll(async () => (await settings()).pasteDelayMs).toBe(325)
  await page.getByRole('textbox', { name: 'Personal dictionary' }).fill('Sotto\nZach\nOregon')
  await category(page, 'Dictation')
  await category(page, 'Cleanup')
  await page.getByRole('button', { name: 'Verify key', exact: true }).click()
  await expect(page.getByText('Key verified.', { exact: true })).toBeVisible()
  await shot()
  await category(page, 'Appearance')
  await page.getByRole('radiogroup', { name: 'Color scheme', exact: true }).getByRole('radio', { name: 'Dark', exact: true }).click()
  await page.getByRole('switch', { name: 'A different theme when dark' }).click()
  await page.getByRole('radiogroup', { name: 'Dark theme', exact: true }).getByRole('radio', { name: 'Clay', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'clay')
  const contrast = page.getByLabel('Contrast', { exact: true })
  await contrast.focus()
  await page.keyboard.press('End')
  await category(page, 'Dictation')
  await category(page, 'Appearance')
  await page.getByRole('button', { name: 'Reset contrast to 100%' }).click()
  await page.getByRole('button', { name: 'Create theme', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Create theme', exact: true })
  await editor.getByLabel('Theme name', { exact: true }).fill('Index review')
  await editor.getByLabel('Background hex value', { exact: true }).fill('#182b24')
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await throughThemeImporter(page)
}

for (const variant of ['recorder', 'no-recorder', 'theme-importer', 'journey'] as const) {
  test(`DO NOT MERGE (#2051): the projects directory click right after its save, ${variant}`, async () => {
    const iterations = variant === 'theme-importer' ? Math.ceil(ITERATIONS / 3) : variant === 'journey' ? Math.ceil(ITERATIONS / 10) : ITERATIONS
    test.setTimeout(240_000 + iterations * 8_000)
    const launched = await launchSotto('hotkey-conflict')
    const { page } = launched
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const timings: { i: number; from: string; gap: Gap; clickMs: number }[] = []
    try {
      const projects = join(launched.userData, 'projects')
      const folders = [join(projects, 'one', 'inner'), join(projects, 'two', 'inner')]
      for (const folder of folders) await mkdir(folder, { recursive: true })
      await openSettings(launched)
      if (variant === 'journey') await journeyPreamble(launched)
      await category(page, 'Threads')
      const change = page.getByRole('button', { name: CHANGE, exact: true })
      const choose = page.getByRole('button', { name: CHOOSE, exact: true })
      const browser = page.getByRole('dialog', { name: /^Default projects directory on this computer/ })
      let current = (await page.evaluate(async () => (await window.sotto!.agents!.get()).configuration.projectsDirectory))
      for (let i = 0; i < iterations; i += 1) {
        // Half the saves start from no folder, as the journey's does, so the press lands on the render that relabels the
        // button and adds Clear beside it; the other half move between two folders.
        const fromEmpty = i % 2 === 0
        const gap = gaps[Math.floor(i / 2) % gaps.length]!
        const folder = folders[Math.floor(i / 2) % 2]!
        if (variant === 'theme-importer' || (variant === 'journey' && i > 0)) {
          await throughThemeImporter(page)
          await category(page, 'Threads')
        }
        if (fromEmpty && current !== '') {
          await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'configure', patch: { projectsDirectory: '' } }) })
          await expect(choose).toBeVisible()
        }
        if (variant === 'no-recorder') await page.evaluate(saveFolder, { path: folder, gap })
        else await evaluateRecordingInput(page, saveFolder, { path: folder, gap })
        current = folder
        const started = Date.now()
        await test.step(`click ${i} (${fromEmpty ? 'from empty' : 'between folders'}, gap ${gap})`, () => clickOrProbeHang(launched, change, { timeout: CLICK_MS }))
        timings.push({ i, from: fromEmpty ? 'empty' : 'folder', gap, clickMs: Date.now() - started })
        await expect(browser.getByRole('button', { name: 'inner', exact: true })).toHaveAttribute('aria-current', 'location')
        await page.keyboard.press('Escape')
        await expect(browser).toBeHidden()
      }
      const slowest = [...timings].sort((a, b) => b.clickMs - a.clickMs).slice(0, 5)
      console.log(`#2051 stress ${variant}: ${timings.length} clicks, slowest ${JSON.stringify(slowest)}`)
      expect(errors).toEqual([])
    } finally { await closeSotto(launched) }
  })
}
