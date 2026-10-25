import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { elementContrast } from './support/elementContrast'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/cursor-provider')

/** Settings > Providers: the list of providers, one row each. */
async function providerList(page: Page): Promise<Locator> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Providers', exact: true }).click()
  return page.getByRole('list', { name: 'Thread providers', exact: true })
}

/** Scrolls Cursor's row to the top of Settings, as someone reading it would, before a capture. */
async function showRow(header: Locator): Promise<void> {
  await header.evaluate(element => element.closest('.provider-row')?.scrollIntoView({ block: 'start' }))
}

/** Nothing in these surfaces is cut off sideways at the window's width. */
async function clipped(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll(roots => roots.flatMap(root => [root, ...root.querySelectorAll<HTMLElement>('*')])
    .filter(element => element instanceof HTMLElement && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible')
    .map(element => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`))
}

test('signs Cursor in from its row, groups its models by maker, offers its three modes, and stays out of stable', async () => {
  test.setTimeout(300_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-cursor-' })).directory
  const root = join(profile, 'cursor-fixture')
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  await mkdir(evidence, { recursive: true })
  // Cursor starts signed out, as a fresh install does; the test finishes the sign-in the way the page would.
  await writeFile(join(root, 'signed-out'), '')
  const previous = { root: process.env.SOTTO_E2E_CURSOR_ROOT, executable: process.env.SOTTO_E2E_CURSOR_EXECUTABLE, owl: process.env.SOTTO_OWL_FEATURES }
  process.env.SOTTO_E2E_CURSOR_ROOT = root
  process.env.SOTTO_E2E_CURSOR_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'cursor=1'
  const contrasts: { surface: string; width: number; appearance: string; ratio: number }[] = []
  const journey: Record<string, unknown> = {}
  const pageErrors: string[] = []
  let launched: LaunchedSotto | undefined
  const measure = async (surface: string, locator: Locator, width: number, appearance: string) => {
    const ratio = await elementContrast(locator)
    contrasts.push({ surface, width, appearance, ratio })
    expect(ratio, `${surface} at ${width} in ${appearance}`).toBeGreaterThanOrEqual(4.5)
  }
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }))
    await page.reload()

    // Settings > Providers > Cursor's row, signed out: one Sign in, and Sotto keeps no Cursor key.
    const list = await providerList(page)
    const row = list.getByRole('button', { name: 'Cursor', exact: true })
    const panel = page.getByRole('region', { name: 'Cursor details', exact: true })
    // Codex's row is open to begin with; End from its header goes to the last, Cursor's, and Enter opens it.
    await list.getByRole('button', { name: 'Codex', exact: true }).focus()
    await page.keyboard.press('End')
    await expect(row).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    // Sotto's cube for Cursor, in the shared ink on Cursor's own badge.
    await expect(row.locator('.provider-badge[data-provider="cursor"] svg[data-provider="cursor"]')).toBeVisible()
    // A new provider starts switched off; turning Cursor on and connecting finds it signed out.
    const enable = page.getByRole('switch', { name: 'Enable Cursor', exact: true })
    if (await enable.getAttribute('aria-checked') !== 'true') await enable.click()
    await expect(enable).toHaveAttribute('aria-checked', 'true')
    // Switching it on connects by itself; press Connect only once that has settled and Cursor still offers it.
    await expect(row).not.toContainText('Connecting…')
    const connect = panel.getByRole('button', { name: 'Connect Cursor', exact: true })
    if (await connect.isVisible()) await connect.click()
    const signIn = panel.getByRole('button', { name: 'Sign in to Cursor in your browser', exact: true })
    await expect(signIn).toBeVisible()
    await expect(row).toContainText('Not signed in')
    // The row says what to do, so no alert repeats it, under its header or in it.
    await expect(list.getByRole('alert')).toHaveCount(0)
    await resizeWindow(launched, 1600, 1000)
    await showRow(row)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'signed-out-1600-dark.png') })
    await measure('signed-out lead', panel.locator('.provider-connection p').first(), 1600, 'dark')

    // Sign in (variant A): the page opens in the browser from main, the row waits, and connects by itself.
    await signIn.focus()
    await page.keyboard.press('Enter')
    await expect(panel.getByText('Finish signing in on cursor.com in your browser.', { exact: true })).toBeVisible()
    await expect(panel.getByText('Waiting for Cursor. This connects by itself.', { exact: true })).toBeVisible()
    // Focus goes to Open the page again, the next thing someone waiting might press.
    await expect(panel.getByRole('button', { name: 'Open Cursor’s sign-in page in your browser again', exact: true })).toBeFocused()
    await expect(panel.getByRole('button', { name: 'Cancel signing in to Cursor', exact: true })).toBeVisible()
    await expect(row).toContainText('Signing in…')
    await expect(row.locator('.provider-row__status')).toHaveAttribute('data-status', 'busy')
    await expect(enable).toBeDisabled()
    await expect(list.getByRole('alert')).toHaveCount(0)
    await resizeWindow(launched, 1280, 800)
    await showRow(row)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'signing-in-1280-dark.png') })
    await measure('waiting lead', panel.getByText('Finish signing in on cursor.com in your browser.', { exact: true }), 1280, 'dark')
    await measure('waiting status', row.locator('.provider-row__status'), 1280, 'dark')
    await expect.poll(async () => (await readFile(join(root, 'opened-pages.txt'), 'utf8').catch(() => '')).trim()).toMatch(/^https:\/\/cursor\.com\//u)
    const login = (await readFile(join(root, 'commands.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { command: string; env: Record<string, string | undefined> })
      .find(entry => entry.command === 'login')
    // Cursor's login ran with Sotto's own Cursor folder and printed its page rather than opening one.
    expect(login?.env.NO_OPEN_BROWSER).toBe('1')
    expect(login?.env.CURSOR_CONFIG_DIR).toBe(join(profile, 'cursor', 'config'))
    await writeFile(join(root, 'login-done'), '')
    await expect(panel.getByRole('button', { name: 'Sign out of Cursor on this computer', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByRole('button', { name: 'Disconnect Cursor', exact: true })).toBeVisible()
    await expect(row).toContainText('Connected')
    await expect(row).toContainText('2026.10.22')
    await expect(enable).toBeEnabled()
    // Signing in answered the switch's refused connect, so its sentence does not come back now Cursor is connected.
    await expect(list.getByRole('alert')).toHaveCount(0)
    journey.signIn = { page: 'https://cursor.com/', configFolder: 'profile/cursor/config', noOpenBrowser: true }
    expect(existsSync(join(root, 'signed-out'))).toBe(false)

    // Its models under their makers, in Cursor's order, each maker a small heading.
    const models = panel.getByRole('group', { name: 'Cursor available models', exact: true })
    await expect(models.getByRole('heading', { level: 5 })).toHaveText(['Cursor', 'Anthropic', 'OpenAI'])
    await expect(models.getByRole('list', { name: 'Anthropic', exact: true }).getByRole('listitem')).toContainText(['Claude Fixture'])
    journey.settingsMakers = await models.getByRole('heading', { level: 5 }).allTextContents()

    // Connected, at every size and in light.
    for (const [width, height, appearance] of [[1600, 1000, 'dark'], [1280, 800, 'dark'], [820, 560, 'dark'], [820, 560, 'light']] as const) {
      await page.evaluate(value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await resizeWindow(launched, width, height)
      await expect(panel.getByRole('button', { name: 'Sign out of Cursor on this computer', exact: true })).toBeVisible()
      await showRow(row)
      await page.screenshot({ animations: 'disabled', path: join(evidence, `connected-${width}-${appearance}.png`) })
      expect(await clipped(page, '.providers-settings'), `Providers at ${width} in ${appearance}`).toEqual([])
      await measure('connected lead', panel.locator('.provider-connection p').first(), width, appearance)
      await measure('maker heading', models.getByRole('heading', { level: 5 }).first(), width, appearance)
    }
    // Escape inside the open row closes it and gives focus back to its header.
    await panel.getByRole('button', { name: 'Sign out of Cursor on this computer', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()
    await expect(row).toHaveAttribute('aria-expanded', 'false')
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))

    // A Cursor project whose new thread starts on Anthropic's model.
    const prepared = await page.evaluate(async path => {
      const state = await window.sotto!.agents!.get()
      const cursor = state.host.models.filter(candidate => candidate.providerId === 'cursor')
      const model = cursor.find(candidate => candidate.source === 'Anthropic')
      if (!model) return { error: 'no Anthropic model', makers: [...new Set(cursor.map(candidate => candidate.source))] }
      await window.sotto!.agents!.command({ type: 'configure', patch: { newThreadModelId: model.id } })
      const created = await window.sotto!.agents!.command({ type: 'create-project', provider: 'cursor', title: 'Cursor project', path, useExisting: true })
      return { error: created.error, makers: [...new Set(cursor.map(candidate => candidate.source))] }
    }, projectPath)
    expect(prepared).toEqual({ error: null, makers: ['Cursor', 'Anthropic', 'OpenAI'] })
    journey.makers = prepared.makers
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread in Cursor project', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New thread', exact: true })).toBeVisible()
    await resizeWindow(launched, 1280, 800)

    // The chip names the maker and Cursor, so a Cursor thread on Claude never reads as Claude Code.
    const chip = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await expect(chip).toHaveText('Anthropic/Claude Fixture')
    await expect(chip).toHaveAttribute('title', 'Claude Fixture from Anthropic, in Cursor')
    await expect(chip.locator('svg.provider-mark')).toHaveAttribute('data-provider', 'cursor')

    // The menu opens on Cursor's model makers, then the chosen maker's models; Escape steps back one level at a time.
    const menu = page.getByRole('dialog', { name: 'Choose model', exact: true })
    const makers = menu.getByRole('group', { name: 'Cursor’s model makers', exact: true })
    for (const [width, height, appearance] of [[1280, 800, 'dark'], [820, 560, 'light']] as const) {
      await page.evaluate(value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await resizeWindow(launched, width, height)
      await chip.focus()
      await page.keyboard.press('Enter')
      await expect(makers).toBeVisible()
      await expect(makers.getByRole('button')).toHaveText([/^Cursor/u, /^Anthropic/u, /^OpenAI/u])
      const foot = menu.getByText('Every model here runs through Cursor, on your Cursor plan.', { exact: false })
      await expect(foot).toBeVisible()
      await page.screenshot({ animations: 'disabled', path: join(evidence, `makers-${width}-${appearance}.png`) })
      await measure('menu foot', foot, width, appearance)
      expect(await clipped(page, '.model-picker'), `model menu at ${width} in ${appearance}`).toEqual([])
      await makers.getByRole('button', { name: /^Show Anthropic models/u }).click()
      const anthropic = menu.getByRole('listbox', { name: 'Anthropic models', exact: false })
      await expect(anthropic.getByRole('option')).toHaveText(['Claude Fixture'])
      await expect(menu.getByRole('button', { name: 'Back to Cursor’s model makers', exact: true })).toHaveText('Makers')
      await page.screenshot({ animations: 'disabled', path: join(evidence, `anthropic-${width}-${appearance}.png`) })
      await page.keyboard.press('Escape')
      await expect(makers.getByRole('button', { name: /^Show Anthropic models/u })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await expect(chip).toBeFocused()
    }
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resizeWindow(launched, 1280, 800)

    // Exactly Cursor's three permission modes, each said as Cursor doing it.
    const permissions = page.getByRole('combobox', { name: 'Thread permissions', exact: true })
    await permissions.focus()
    await page.keyboard.press('Enter')
    const modes = page.getByRole('listbox', { name: 'Thread permissions', exact: true })
    // Every provider's menu leads with Provider default; after it come exactly Cursor's three modes, and no Allow edits.
    const options = modes.getByRole('option')
    await expect(options).toHaveCount(4)
    await expect(options.nth(0)).toHaveText('Provider default')
    await expect(options.nth(1)).toContainText('Ask for approval')
    await expect(options.nth(1)).toContainText('It edits files inside the project without asking.')
    await expect(options.nth(2)).toContainText('Its classifier runs on Cursor’s servers')
    await expect(options.nth(3)).toContainText('Full access')
    await expect(modes.getByRole('option', { name: /Allow edits/u })).toHaveCount(0)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'permissions-1280-dark.png') })
    await measure('permission description', modes.locator('small').first(), 1280, 'dark')
    await page.keyboard.press('Escape')
    await expect(modes).toBeHidden()
    expect(pageErrors).toEqual([])
    await closeSotto(launched)
    launched = undefined

    // Stable: Cursor's Owl feature is off, so nothing of Cursor shows, and its records are kept for Owl.
    process.env.SOTTO_OWL_FEATURES = 'cursor=0'
    launched = await launchSotto('success', profile)
    const stable = await providerList(launched.page)
    await expect(stable.getByRole('button', { name: 'Codex', exact: true })).toBeVisible()
    await expect(stable.getByRole('button', { name: 'OpenCode', exact: true })).toBeVisible()
    await expect(launched.page.getByRole('button', { name: 'Cursor', exact: true })).toHaveCount(0)
    await expect(launched.page.getByRole('switch', { name: 'Enable Cursor', exact: true })).toHaveCount(0)
    await expect(launched.page.getByText(/Cursor uses its install script|Cursor its install script/u)).toHaveCount(0)
    // OpenCode's is the last row stable has: the capture shows the list's end, where Cursor's row would be, and the note after it.
    await showRow(stable.getByRole('button', { name: 'OpenCode', exact: true }))
    await launched.page.screenshot({ animations: 'disabled', path: join(evidence, 'stable-providers.png') })
    expect(existsSync(join(profile, 'cursor-projects.json'))).toBe(true)
    journey.stable = { cursorRow: false, recordsKept: true }
  } finally {
    await writeFile(join(evidence, 'contrast.json'), `${JSON.stringify(contrasts, null, 2)}\n`)
    await writeFile(join(evidence, 'journey.json'), `${JSON.stringify(journey, null, 2)}\n`)
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_CURSOR_ROOT', previous.root], ['SOTTO_E2E_CURSOR_EXECUTABLE', previous.executable], ['SOTTO_OWL_FEATURES', previous.owl]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(join(root, 'login-done'), { force: true })
    await removeOwnedE2EProfile(profile)
  }
})
