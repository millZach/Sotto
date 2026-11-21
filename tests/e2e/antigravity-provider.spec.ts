import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { elementContrast } from './support/elementContrast'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/antigravity-provider')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const APPEARANCES = ['dark', 'light'] as const

/** Settings > Providers: the list of providers, one row each. */
async function providerList(page: Page): Promise<Locator> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Providers', exact: true }).click()
  return page.getByRole('list', { name: 'Thread providers', exact: true })
}

/** Scrolls Antigravity's row to the top of Settings, as someone reading it would, before a capture. */
async function showRow(header: Locator): Promise<void> {
  await header.evaluate(element => element.closest('.provider-row')?.scrollIntoView({ block: 'start' }))
}

/** Nothing in these surfaces is cut off sideways at the window's width. */
async function clipped(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll(roots => roots.flatMap(root => [root, ...root.querySelectorAll<HTMLElement>('*')])
    .filter(element => element instanceof HTMLElement && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible')
    .map(element => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`))
}

test('signs Antigravity in four ways from its row, groups its models by maker, and offers its four modes', async () => {
  test.setTimeout(300_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-antigravity-' })).directory
  const root = join(profile, 'antigravity-fixture')
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  await mkdir(evidence, { recursive: true })
  // `agy` starts signed out, so the row offers every method's steps before it connects.
  await writeFile(join(root, 'script.json'), JSON.stringify({ signedOut: true }))
  const previous = { root: process.env.SOTTO_E2E_ANTIGRAVITY_ROOT, executable: process.env.SOTTO_E2E_ANTIGRAVITY_EXECUTABLE }
  process.env.SOTTO_E2E_ANTIGRAVITY_ROOT = root
  process.env.SOTTO_E2E_ANTIGRAVITY_EXECUTABLE = process.execPath
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
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, threadListGrouping: 'project', appearance: 'dark', reducedMotion: 'on' }))
    await page.reload()

    const list = await providerList(page)
    const row = list.getByRole('button', { name: 'Antigravity', exact: true })
    const panel = page.getByRole('region', { name: 'Antigravity details', exact: true })
    await row.click()
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    const enable = page.getByRole('switch', { name: 'Enable Antigravity', exact: true })
    if (await enable.getAttribute('aria-checked') !== 'true') await enable.click()
    await expect(enable).toHaveAttribute('aria-checked', 'true')
    await expect(row).not.toContainText('Connecting…')

    // The sign-in method is a four-way choice, and each method shows its own steps.
    const methods = panel.getByRole('radiogroup', { name: 'Sign-in method', exact: true })
    await expect(methods.getByRole('radio')).toHaveText(['Google account', 'Gemini Enterprise', 'Gemini API key', 'Agent Platform'])
    const choose = async (name: string): Promise<void> => {
      await methods.getByRole('radio', { name, exact: true }).click()
      await expect(methods.getByRole('radio', { name, exact: true })).toHaveAttribute('aria-checked', 'true')
    }
    const googleSignIn = panel.getByRole('button', { name: 'Sign in to Antigravity with your Google account', exact: true })
    await expect(methods.getByRole('radio', { name: 'Google account', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(googleSignIn).toBeVisible()

    // Gemini Enterprise: Sign in waits for both the project and the location.
    await choose('Gemini Enterprise')
    await expect(googleSignIn).toHaveCount(0)
    const enterprise = panel.getByRole('button', { name: 'Sign in to Gemini Enterprise with Google in your browser', exact: true })
    const project = panel.getByRole('textbox', { name: 'Google Cloud project', exact: true })
    const location = panel.getByRole('textbox', { name: 'Location', exact: true })
    await expect(enterprise).toBeDisabled()
    // Leaving a field saves both, and the row holds its fields while it saves, so each is filled once the last save ends.
    await project.fill('sotto-e2e-project')
    await project.blur()
    await expect(location).toBeEnabled()
    await expect(enterprise).toBeDisabled()
    await location.fill('us-central1')
    await location.blur()
    await expect(project).toBeEnabled()
    await expect(location).toHaveValue('us-central1')
    await expect(enterprise).toBeEnabled()

    // A Gemini API key: the field is masked, and Connect waits for a key.
    await choose('Gemini API key')
    await expect(enterprise).toHaveCount(0)
    const geminiKey = panel.getByLabel('Gemini API key', { exact: true })
    await expect(geminiKey).toHaveAttribute('type', 'password')
    const saveGemini = panel.getByRole('button', { name: 'Save this Gemini API key and connect Antigravity', exact: true })
    await expect(saveGemini).toBeDisabled()
    await geminiKey.fill('not-a-real-key')
    await expect(saveGemini).toBeEnabled()
    await geminiKey.fill('')

    // Agent Platform: an API key, masked too, or a project and location.
    await choose('Agent Platform')
    const way = panel.getByRole('radiogroup', { name: 'Connect Agent Platform with', exact: true })
    await expect(way.getByRole('radio')).toHaveText(['API key', 'Project and location'])
    await expect(panel.getByLabel('Agent Platform API key', { exact: true })).toHaveAttribute('type', 'password')
    await way.getByRole('radio', { name: 'Project and location', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Connect Antigravity to Agent Platform with this project and location', exact: true })).toBeEnabled()
    journey.methods = ['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform']

    // Back on a Google account, `agy` signs in by itself once it is signed in on this computer; switching the provider off
    // and on connects again.
    await choose('Google account')
    await expect(googleSignIn).toBeVisible()
    await rm(join(root, 'script.json'))
    await enable.click()
    await expect(enable).toHaveAttribute('aria-checked', 'false')
    await enable.click()
    await expect(enable).toHaveAttribute('aria-checked', 'true')
    await expect(row).toContainText('Connected', { timeout: 30_000 })
    await expect(panel.getByRole('button', { name: 'Sign out of Antigravity on this computer', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Disconnect Antigravity', exact: true })).toBeVisible()
    await expect(googleSignIn).toHaveCount(0)
    await expect(list.getByRole('alert')).toHaveCount(0)

    // The opened, connected row at every size, in both appearances.
    for (const appearance of APPEARANCES) for (const [width, height] of SIZES) {
      await page.evaluate(value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await resizeWindow(launched, width, height)
      await expect(methods).toBeVisible()
      await showRow(row)
      await page.screenshot({ animations: 'disabled', path: join(evidence, `row-${width}-${appearance}.png`) })
      if (width === 820) expect(await clipped(page, '.providers-settings'), `Providers at ${width} in ${appearance}`).toEqual([])
      await measure('connection line', panel.locator('.provider-connection--antigravity p').first(), width, appearance)
      await measure('method line', panel.locator('.antigravity-hint').first(), width, appearance)
      await measure('chosen method', methods.getByRole('radio', { name: 'Google account', exact: true }), width, appearance)
      await measure('row status', row.locator('.provider-row__status'), width, appearance)
    }
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))

    // An Antigravity project whose new thread starts on a Google model; the sidebar shows at 1280, not 820.
    const prepared = await page.evaluate(async path => {
      const state = await window.sotto!.agents!.get()
      const antigravity = state.host.models.filter(candidate => candidate.providerId === 'antigravity')
      const makers = [...new Set(antigravity.map(candidate => candidate.source))]
      const model = antigravity.find(candidate => candidate.source === 'Google')
      if (!model) return { error: 'no Google model', makers }
      await window.sotto!.agents!.command({ type: 'configure', patch: { newThreadModelId: model.id } })
      const created = await window.sotto!.agents!.command({ type: 'create-project', provider: 'antigravity', title: 'Antigravity project', path, useExisting: true })
      return { error: created.error, makers }
    }, projectPath)
    expect(prepared).toEqual({ error: null, makers: ['Google', 'Anthropic'] })
    journey.makers = prepared.makers
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread in Antigravity project', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New thread', exact: true })).toBeVisible()

    // The menu opens on Antigravity's model makers, then a maker's models with Makers to step back.
    const chip = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await expect(chip.locator('svg.provider-mark')).toHaveAttribute('data-provider', 'antigravity')
    const menu = page.getByRole('dialog', { name: 'Choose model', exact: true })
    const makers = menu.getByRole('group', { name: 'Antigravity’s model makers', exact: true })
    for (const appearance of APPEARANCES) for (const [width, height] of SIZES) {
      await page.evaluate(value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await resizeWindow(launched, width, height)
      await chip.focus()
      await page.keyboard.press('Enter')
      await expect(makers).toBeVisible()
      await expect(makers.getByRole('button')).toHaveText([/^Google/u, /^Anthropic/u])
      const foot = menu.getByText('Every model here runs through Antigravity, on your Google account.', { exact: false })
      await expect(foot).toBeVisible()
      await page.screenshot({ animations: 'disabled', path: join(evidence, `models-${width}-${appearance}.png`) })
      if (width === 820) expect(await clipped(page, '.model-picker'), `model menu at ${width} in ${appearance}`).toEqual([])
      await measure('menu foot', foot, width, appearance)
      await measure('maker', makers.getByRole('button').first(), width, appearance)
      await makers.getByRole('button', { name: /^Show Anthropic models/u }).focus()
      await page.keyboard.press('Enter')
      const anthropic = menu.getByRole('listbox', { name: /^Anthropic models/u })
      await expect(anthropic.getByRole('option')).toHaveText(['Claude Sonnet 5.5'])
      await expect(menu.getByRole('button', { name: 'Back to Antigravity’s model makers', exact: true })).toHaveText('Makers')
      await measure('model name', anthropic.getByRole('option').first(), width, appearance)
      await page.keyboard.press('Escape')
      await expect(makers.getByRole('button', { name: /^Show Anthropic models/u })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await expect(chip).toBeFocused()
    }
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resizeWindow(launched, 1280, 800)

    // Provider default, then exactly Antigravity's four modes, each said as Antigravity doing it.
    const permissions = page.getByRole('combobox', { name: 'Thread permissions', exact: true })
    await permissions.focus()
    await page.keyboard.press('Enter')
    const modes = page.getByRole('listbox', { name: 'Thread permissions', exact: true })
    const options = modes.getByRole('option')
    await expect(options).toHaveCount(5)
    await expect(options.nth(0)).toHaveText('Provider default')
    await expect(options.nth(1)).toContainText('Antigravity asks before it edits files or runs commands')
    await expect(options.nth(2)).toContainText('Sotto answers Antigravity’s requests to change files for you.')
    await expect(options.nth(3)).toContainText('Antigravity’s own Auto decides what runs without asking.')
    await expect(options.nth(4)).toContainText('Sotto answers every Antigravity request for you')
    journey.modes = await options.evaluateAll(items => items.slice(1).map(item => item.querySelector('span,strong')?.textContent ?? item.textContent ?? ''))
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'permissions-1280-dark.png') })
    await measure('permission description', modes.locator('small').first(), 1280, 'dark')
    await page.keyboard.press('Escape')
    await expect(modes).toBeHidden()
    expect(pageErrors).toEqual([])
  } finally {
    await writeFile(join(evidence, 'contrast.json'), `${JSON.stringify(contrasts, null, 2)}\n`)
    await writeFile(join(evidence, 'journey.json'), `${JSON.stringify(journey, null, 2)}\n`)
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_ANTIGRAVITY_ROOT', previous.root], ['SOTTO_E2E_ANTIGRAVITY_EXECUTABLE', previous.executable]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
