// PROTOTYPE — throwaway. Screenshots each place for "Settle finished threads" in Settings, under Watcher, from a build
// made with VITE_SOTTO_PROTOTYPE=1, on the Owl track with Claude Code and Codex connected over the fake CLIs.
//
//   VITE_SOTTO_PROTOTYPE=1 npm run build && npx playwright test tests/e2e/watcher-settle-toggle.prototype.spec.ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { onReleaseTrack } from './support/releaseTrack'
import { settingsLayoutProblems, settingsTextContrast } from './support/settingsChecks'
import { closeSotto, launchSotto, openPage, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/watcher-settle-toggle-prototype')
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']

/** A fresh profile whose app finds the fake CLIs, as worker-roles.spec.ts makes it, so the role cards have models. */
async function rolesProfile() {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-watcher-settle-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'claude', 'script.json'), '{}')
  await writeFile(join(root, 'claude', 'models.json'), JSON.stringify([
    { value: 'opus', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: FIVE },
    { value: 'sonnet', displayName: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: FIVE },
    { value: 'haiku', displayName: 'Haiku 5.5', supportsEffort: false },
  ]))
  const codexModel = (model: string, displayName: string, efforts: readonly string[], isDefault = false) => ({ id: model, model, displayName, isDefault,
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ models: [codexModel('gpt-6.1-sol', 'GPT-6.1 Sol', FIVE, true),
    codexModel('gpt-6-astra', 'GPT-6 Astra', [...FIVE, 'ultra']), codexModel('gpt-6-luna', 'GPT-6 Luna', ['minimal', 'low', 'medium', 'high'])] }))
  const previous = { SOTTO_E2E_NATIVE_FIXTURE_ROOT: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  const restore = async (): Promise<void> => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await removeOwnedE2EProfile(profile)
  }
  return { profile, restore }
}

const panel = (page: Page): Locator => page.locator('#settings-watcher')

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** Nothing clipped or overflowing, and the new words at 4.5:1 against what they sit on. Soft, so every capture still runs. */
async function checked(page: Page, where: string): Promise<void> {
  expect.soft(await pageBoundProblems(page), where).toEqual([])
  expect.soft(await settingsLayoutProblems(page, 'settings-watcher', '.tt-toggle, .tt-toggle__copy, .watcher-proto__finished, .watcher-proto__finished li, .settings-group > h3, .worker-roles__reset-all, .worker-role'), where)
    .toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
  const overflow = await panel(page).evaluate(element => [...element.querySelectorAll<HTMLElement>('.tt-toggle, .tt-toggle__copy, .watcher-proto__finished, .settings-group > h3')]
    .filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.className))
  expect.soft(overflow, where).toEqual([])
  const low = (await settingsTextContrast(page, 'settings-watcher', '.tt-toggle__copy > strong, .tt-toggle__copy > .tt-field__description, .watcher-proto__finished > p, .watcher-proto__finished li, .settings-group > h3, .settings-section__heading p'))
    .filter(item => item.text.trim() && item.ratio < 4.5)
  expect.soft(low, where).toEqual([])
}

test('captures every place for Settle finished threads under Watcher', async () => {
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const { profile, restore } = await rolesProfile()
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
        const agents = window.sotto!.agents!
        const configured = await agents.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude', 'codex'], checkClientUpdates: false } })
        if (configured.error) throw new Error(configured.error)
        for (const provider of ['claude', 'codex'] as const) {
          const result = await agents.command({ type: 'connect', provider })
          if (result.error) throw new Error(result.error)
        }
      })
      await page.reload()
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
      await expect(panel(page).locator('.worker-roles__grid')).toBeVisible()
      const bar = page.getByRole('group', { name: 'Prototype variants' })
      await expect(bar).toBeVisible()
      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const variant of ['A', 'B', 'C', 'Now']) {
          while ((await bar.locator('b').textContent()) !== variant) await bar.getByRole('button', { name: 'Next variant' }).click()
          if (variant !== 'Now') await expect(panel(page).getByRole('switch', { name: 'Settle finished threads' })).toHaveAttribute('aria-checked', 'true')
          for (const mode of width === 1280 ? ['dark', 'light'] as const : ['dark'] as const) {
            await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
            await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
            await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
            await checked(page, `${variant} ${width}x${height} ${mode}`)
            await shot(page, `${variant}-${width}x${height}-${mode}`)
            if (variant === 'B') {
              // B's toggle sits under the role cards, so it gets its own capture where it is.
              await panel(page).getByRole('switch', { name: 'Settle finished threads' }).scrollIntoViewIfNeeded()
              await shot(page, `${variant}-${width}x${height}-${mode}-toggle`)
            }
          }
        }
      }
      // C with the toggle off: the list of what finished means goes away.
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
      while ((await bar.locator('b').textContent()) !== 'C') await bar.getByRole('button', { name: 'Next variant' }).click()
      await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
      const toggle = panel(page).getByRole('switch', { name: 'Settle finished threads' })
      await toggle.focus()
      await page.keyboard.press('Space')
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect(panel(page).locator('.watcher-proto__finished')).toHaveCount(0)
      await shot(page, 'C-1280x800-dark-off')
      expect(errors).toEqual([])
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})
