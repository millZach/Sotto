/**
 * Mods (ADR-0217) in the built app with the `mods` Owl feature on: a mod in the mods folder paints its look over the
 * window at launch; Settings › Mods lists it with a switch that takes the look off and puts it back; a mod written while
 * Sotto runs shows up and paints at once; a look that reaches outside is listed with why and paints nothing; the View
 * menu's Turn off every mod switches every mod off; Make a mod starts a thread in the Mods project with the words as
 * written. A build that holds the feature reads nothing and shows no Mods page.
 *
 *   npm run build && npx playwright test tests/e2e/mods.spec.ts
 *
 * With `SOTTO_E2E_EVIDENCE=publish` the screenshots go to artifacts/mods/ for the verification note.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile } from './support/e2eProfile'
import { captureWindow } from './support/sottoCapture'
import { closeSotto, launchSotto, openPage, openThreads, userMessageTexts, type LaunchedSotto } from './support/sottoLaunch'

const shots = evidenceDirectory('artifacts/mods')
const OAK = 'rgb(120, 70, 30)'

async function writeMod(modsFolder: string, id: string, name: string, look: string): Promise<void> {
  await mkdir(join(modsFolder, id), { recursive: true })
  await writeFile(join(modsFolder, id, 'mod.json'), JSON.stringify({ name }), 'utf8')
  await writeFile(join(modsFolder, id, 'look.css'), look, 'utf8')
}

async function launch(enabled: boolean): Promise<LaunchedSotto & { readonly modsFolder: string }> {
  const directory = (await ownedE2EProfile({ prefix: 'sotto-e2e-mods-' })).directory
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
  const modsFolder = join(directory, 'mods')
  await writeMod(modsFolder, 'oak-sidebar', 'Oak sidebar', `[data-part="sidebar"] { background: ${OAK} !important; }`)
  const previous = process.env['SOTTO_OWL_FEATURES']
  process.env['SOTTO_OWL_FEATURES'] = `mods=${enabled ? 1 : 0}`
  try {
    const launched = await launchSotto('phase3-workspace', directory)
    return { ...launched, ownsUserData: true, modsFolder }
  } finally {
    if (previous === undefined) delete process.env['SOTTO_OWL_FEATURES']
    else process.env['SOTTO_OWL_FEATURES'] = previous
  }
}

const sidebarBackground = (page: Page): Promise<string> =>
  page.locator('[data-part="sidebar"]').first().evaluate(element => getComputedStyle(element).backgroundColor)

const LOOKS = [[1600, 1000, 'dark'], [1600, 1000, 'light'], [1280, 800, 'dark'], [1280, 800, 'light'], [820, 560, 'dark'], [820, 560, 'light']] as const

/** The window at each size and half, captured once two frames have painted what changed. */
async function shoot(sotto: LaunchedSotto, name: string, looks: readonly (readonly [number, number, 'dark' | 'light'])[] = LOOKS): Promise<void> {
  for (const [width, height, appearance] of looks) {
    await sotto.page.evaluate(async look => { await window.sotto!.updateSettings({ appearance: look }) }, appearance)
    await sotto.app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width, size.height)
    }, { width, height })
    await expect.poll(() => sotto.page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(width - 2)
    await sotto.page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    await sotto.page.waitForTimeout(150)
    await captureWindow(sotto.app, join(shots, `${name}-${width}x${height}-${appearance}.png`))
  }
  await sotto.page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
}

async function openMods(page: Page): Promise<void> {
  await openPage(page, 'Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Mods', exact: true }).click()
  await expect(page.locator('#settings-mods')).toBeVisible()
}

test('an Owl build paints a mod, switches it from Settings › Mods and the View menu, and makes one in a thread', async () => {
  test.setTimeout(240_000)
  await mkdir(shots, { recursive: true })
  const sotto = await launch(true)
  try {
    const { page, app } = sotto
    await openThreads(page)
    await expect.poll(() => sidebarBackground(page)).toBe(OAK)
    await shoot(sotto, 'oak-sidebar', [[1280, 800, 'dark'], [1280, 800, 'light']])

    // Settings › Mods: the mod with its switch; off takes the look away at once, on puts it back.
    await openMods(page)
    const mods = page.locator('#settings-mods')
    const oak = mods.getByRole('switch', { name: 'Oak sidebar' })
    await expect(oak).toHaveAttribute('aria-checked', 'true')
    await shoot(sotto, 'settings-mods')
    // Reduced motion: the page has no motion of its own, and its switches take the window's 1 ms transitions.
    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
    await expect.poll(() => oak.locator('.tt-toggle__thumb').evaluate(thumb => getComputedStyle(thumb).transitionDuration)).toBe('0.001s')
    await shoot(sotto, 'settings-mods-reduced-motion', [[1280, 800, 'dark']])
    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'system' }) })
    await oak.click()
    await expect.poll(async () => (await page.evaluate(() => window.sotto!.getSettings())).modsOff).toEqual(['oak-sidebar'])
    await openThreads(page)
    await expect.poll(() => sidebarBackground(page)).not.toBe(OAK)
    await openMods(page)
    await mods.getByRole('switch', { name: 'Oak sidebar' }).click()
    await openThreads(page)
    await expect.poll(() => sidebarBackground(page)).toBe(OAK)

    // Written while Sotto runs: listed and painted without a restart. A look that loads from outside is listed with why.
    await writeMod(sotto.modsFolder, 'quiet-sidebar', 'Quiet sidebar', '[data-part="sidebar"] { opacity: 0.5 !important; }')
    await writeMod(sotto.modsFolder, 'outside', 'Outside picture', '[data-part="composer"] { background: url(https://example.com/x.png) !important; }')
    await expect.poll(() => page.locator('[data-part="sidebar"]').first().evaluate(element => getComputedStyle(element).opacity)).toBe('0.5')
    await openMods(page)
    await expect(mods.getByRole('switch', { name: 'Quiet sidebar' })).toBeVisible()
    await expect(mods.getByRole('switch', { name: 'Outside picture' })).toHaveAccessibleDescription(/loads something from outside Sotto/u)
    expect(await page.evaluate(() => document.getElementById('sotto-mod-looks')?.textContent ?? '')).not.toContain('example.com')

    // View its code shows the look as written.
    await mods.getByRole('button', { name: 'More for Oak sidebar' }).click()
    await page.getByRole('menuitem', { name: 'View its code' }).click()
    await expect(mods.getByLabel('Oak sidebar’s look')).toContainText(OAK)
    await shoot(sotto, 'settings-mods-code-and-problem', [[1280, 800, 'dark']])

    // The View menu's Turn off every mod, which answers even where a look hides the controls.
    await app.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const item of items) {
          if (item.label === 'Turn off every mod') return item
          const inner = item.submenu ? find(item.submenu.items) : undefined
          if (inner) return inner
        }
        return undefined
      }
      const item = find(Menu.getApplicationMenu()?.items ?? [])
      if (!item) throw new Error('No Turn off every mod in the menu')
      item.click()
    })
    await expect.poll(async () => [...(await page.evaluate(() => window.sotto!.getSettings())).modsOff].sort()).toEqual(['oak-sidebar', 'outside', 'quiet-sidebar'])
    await expect(mods.getByRole('switch', { name: 'Oak sidebar' })).toHaveAttribute('aria-checked', 'false')
    expect(await page.evaluate(() => document.getElementById('sotto-mod-looks')?.textContent ?? '')).toBe('')

    // Make a mod: a thread in the Mods project, at the mods folder, with the words as written.
    await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true } })
      await agents.command({ type: 'connect' })
    })
    await mods.getByRole('textbox', { name: 'What the mod should change' }).fill('Give the sidebar an oak look')
    await mods.getByRole('button', { name: 'Start a thread' }).click()
    await expect(mods.getByRole('status').filter({ hasText: 'A thread is making it' })).toBeVisible()
    const made = async (): Promise<{ readonly path: boolean; readonly threadId: string | null }> => {
      const state = await page.evaluate(() => window.sotto!.agents!.get())
      const project = state.host.projects.find(item => item.title === 'Mods')
      const thread = state.host.threads.find(item => item.projectId === project?.id)
      return { path: project?.path.replace(/\\/gu, '/').endsWith('/mods') === true, threadId: thread?.id ?? null }
    }
    await expect.poll(async () => (await made()).path).toBe(true)
    const { threadId } = await made()
    expect(threadId).not.toBeNull()
    await expect.poll(() => userMessageTexts(page, threadId!)).toEqual(['Give the sidebar an oak look'])
  } finally {
    await closeSotto(sotto)
  }
})

test('a build that holds mods paints nothing and shows no Mods page', async () => {
  test.setTimeout(120_000)
  const sotto = await launch(false)
  try {
    const { page } = sotto
    await openThreads(page)
    expect(await page.evaluate(() => document.getElementById('sotto-mod-looks'))).toBeNull()
    expect(await sidebarBackground(page)).not.toBe(OAK)
    expect(await page.evaluate(() => window.sotto!.mods)).toBeUndefined()
    await openPage(page, 'Settings')
    await expect(page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Mods', exact: true })).toHaveCount(0)
  } finally {
    await closeSotto(sotto)
  }
})
