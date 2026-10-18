import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { elementContrast } from './support/elementContrast'
import { closeSotto, launchSotto, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/opencode-sign-in')
// Made up for this journey; the fixture's model sources are fake and no key leaves this computer.
const KEY = 'sk-e2e-made-up-key-41c9'

async function providerPanel(page: Page): Promise<Locator> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Providers', exact: true }).click()
  return page.getByRole('region', { name: 'Provider configuration', exact: true })
}

const contrasts: { surface: string; width: number; appearance: string; ratio: number }[] = []
async function measure(dialog: Locator, surfaces: Record<string, string>, width: number, appearance: string): Promise<void> {
  for (const [surface, selector] of Object.entries(surfaces)) {
    const ratio = await elementContrast(dialog.locator(selector).first())
    contrasts.push({ surface, width, appearance, ratio: Math.round(ratio * 100) / 100 })
    expect(ratio, surface).toBeGreaterThanOrEqual(4.5)
  }
}

/** Nothing in the dialog spills sideways or past the window at this size. */
async function fits(page: Page, dialog: Locator): Promise<void> {
  const box = await dialog.boundingBox()
  const size = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1); expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1)
  // The dialog and its scrolling parts never scroll sideways.
  expect(await dialog.evaluate(node => [node, ...node.querySelectorAll<HTMLElement>('.oc-dialog__body, .oc-pick, .oc-wait, .tt-dialog__actions')]
    .filter(part => part.scrollWidth > part.clientWidth + 1).map(part => part.className))).toEqual([])
}

test('signs Sotto’s OpenCode in with a key, signs out, and waits on a browser sign-in, keeping the key out of the window', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-opencode-sign-in-' })).directory
  const root = join(profile, 'opencode-fixture')
  await mkdir(root, { recursive: true })
  await mkdir(evidence, { recursive: true })
  await writeFile(join(root, 'script.json'), JSON.stringify({ oauth: { 'xai:device': { mode: 'auto', code: 'QX7M-4LRT' }, 'gitlab:pkce': { mode: 'code' } } }))
  const previousEnvironment = {
    SOTTO_E2E_OPENCODE_ROOT: process.env.SOTTO_E2E_OPENCODE_ROOT,
    SOTTO_E2E_OPENCODE_EXECUTABLE: process.env.SOTTO_E2E_OPENCODE_EXECUTABLE,
    SOTTO_OWL_FEATURES: process.env.SOTTO_OWL_FEATURES,
  }
  process.env.SOTTO_E2E_OPENCODE_ROOT = root
  process.env.SOTTO_E2E_OPENCODE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'opencode=1'
  const pageErrors: string[] = []
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }))
    await page.reload()
    await resizeWindow(launched, 1280, 800)
    const panel = await providerPanel(page)
    await page.getByRole('button', { name: 'OpenCode', exact: true }).click()
    const connect = panel.getByRole('button', { name: 'Connect OpenCode' })
    if (await connect.count()) await connect.click()
    await expect(panel.getByRole('button', { name: 'Disconnect OpenCode' })).toBeVisible()
    const deferUpdates = page.getByRole('button', { name: 'Not now', exact: true })
    if (await deferUpdates.count()) await deferUpdates.click()
    const sources = panel.getByRole('group', { name: 'Model sources' })
    await expect(sources).toContainText('OpenCode Zen')
    await expect(sources).toContainText('2 models')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'tile-fresh-1280-dark.png') })

    // Add a model source: the list, common ones first; the keyboard moves from the search into it.
    const add = sources.getByRole('button', { name: 'Add a model source' })
    await add.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveAccessibleName('Add a model source')
    await expect(dialog.getByRole('textbox', { name: 'Search model sources' })).toBeFocused()
    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await fits(page, dialog)
        await measure(dialog, { 'dialog description': '.tt-dialog__description', 'group heading': '.oc-group-head', 'how a source signs in': '.oc-opt__how', 'source name': '.oc-opt__name' }, width, appearance)
        await page.screenshot({ animations: 'disabled', path: join(evidence, `dialog-pick-${width}-${appearance}.png`) })
      }
    }
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resizeWindow(launched, 1280, 800)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(add).toBeFocused()

    // A key: typed into a password field, handed to Sotto's OpenCode, and nowhere in the window afterwards.
    await add.click()
    await dialog.getByRole('textbox', { name: 'Search model sources' }).fill('anthro')
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveAccessibleName('Sign in to Anthropic')
    const field = dialog.getByLabel('Anthropic API key')
    await expect(field).toHaveAttribute('type', 'password')
    await expect(field).toBeFocused()
    await field.fill(KEY)
    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await fits(page, dialog)
        await measure(dialog, { 'key sentence': '.oc-keynote', 'back to model sources': '.oc-back', 'field label': '.oc-field' }, width, appearance)
        await page.screenshot({ animations: 'disabled', path: join(evidence, `dialog-key-${width}-${appearance}.png`) })
      }
    }
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resizeWindow(launched, 1280, 800)
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(sources).toContainText('Signed in to Anthropic. Its 2 models are in the model menu, under OpenCode.')
    const anthropic = sources.getByRole('listitem').filter({ hasText: 'Anthropic' })
    await expect(anthropic).toContainText('API key')
    await expect(anthropic).toContainText('2 models')
    expect(await readFile(join(root, 'credentials.json'), 'utf8')).toContain(KEY)
    expect(await page.content()).not.toContain(KEY)
    const state = await page.evaluate(async () => JSON.stringify(await window.sotto!.agents!.get()))
    expect(state).not.toContain(KEY)
    expect(state).toContain('"name":"Claude Fixture","ready":true')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'tile-signed-1280-dark.png') })
    for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
      await measure(sources, { 'how a source signed in': '.oc-src small', 'model count': '.oc-count', 'notice': '.oc-notice', 'Sign out': '.oc-list .tt-button--ghost' }, 1280, appearance)
    }

    // Sign out: the key is gone from Sotto's OpenCode, and the tile says so.
    await anthropic.getByRole('button', { name: 'Sign out of Anthropic' }).click()
    await expect(sources).toContainText('Signed out of Anthropic. Its key is gone from Sotto’s OpenCode.')
    expect(await readFile(join(root, 'credentials.json'), 'utf8')).not.toContain(KEY)
    await expect(add).toBeFocused()

    // A browser sign-in to its waiting state: the page is opened from main, and the device code is shown.
    await add.click()
    await dialog.getByRole('textbox', { name: 'Search model sources' }).fill('xai')
    await page.keyboard.press('Enter')
    await dialog.getByRole('radio', { name: /SuperGrok subscription/u }).check()
    await dialog.getByRole('button', { name: 'Open the xAI sign-in page in your browser' }).click()
    const waiting = dialog.getByRole('group', { name: 'Signing in to xAI' })
    await expect(waiting.locator('code')).toHaveText('QX7M-4LRT')
    await expect(waiting).toContainText('sign-in.fixture.invalid/xai/device')
    await expect(waiting.getByRole('status')).toContainText('Waiting for xAI. This updates by itself once you enter the code.')
    await expect.poll(async () => readFile(join(root, 'opened-pages.txt'), 'utf8').catch(() => '')).toContain('https://sign-in.fixture.invalid/xai/device?user_code=QX7M-4LRT')
    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await fits(page, dialog)
        await measure(dialog, { 'device code': '.oc-code code', 'page address': '.oc-site', 'waiting line': '.oc-wait__status' }, width, appearance)
        await page.screenshot({ animations: 'disabled', path: join(evidence, `dialog-device-${width}-${appearance}.png`) })
      }
    }
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resizeWindow(launched, 1280, 800)
    // The page finishes, and the dialog closes by itself.
    await writeFile(join(root, 'approve.json'), JSON.stringify({ integrationID: 'xai' }))
    await expect(dialog).toHaveCount(0, { timeout: 20_000 })
    await expect(sources.getByRole('listitem').filter({ hasText: 'xAI' })).toContainText('SuperGrok subscription')

    // A sign-in that pastes a code back, cancelled while it waits.
    await add.click()
    await dialog.getByRole('textbox', { name: 'Search model sources' }).fill('gitlab')
    await page.keyboard.press('Enter')
    await dialog.getByRole('radio', { name: /GitLab account/u }).check()
    await dialog.getByRole('button', { name: 'Open the GitLab Duo sign-in page in your browser' }).click()
    await expect(dialog.getByLabel('Code from the GitLab Duo page')).toBeFocused()
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'dialog-code-1280-dark.png') })
    await dialog.getByRole('button', { name: 'Cancel signing in to GitLab Duo' }).click()
    await expect(dialog.getByRole('button', { name: 'Open the GitLab Duo sign-in page in your browser' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    expect(await readFile(join(root, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
    expect(pageErrors).toEqual([])
    await writeFile(join(evidence, 'contrast.json'), JSON.stringify(contrasts, null, 2))
  } finally {
    if (launched) await closeSotto(launched)
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
