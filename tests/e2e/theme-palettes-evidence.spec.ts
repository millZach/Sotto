import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { designThreadsFixture } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { BUILT_IN_THEMES } from '../../src/shared/themes/library'
import { closeSotto, launchSotto, openPage, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Rendered evidence for Sotto's own palettes and the Light and Dark columns (ADR-0024): the Appearance page at
 * the three review sizes in both rooms, the Threads page in every built-in half, and the mark on the default theme
 * wearing the app icon. Run with SOTTO_THEME_EVIDENCE=1 after `npm run build`; images land in
 * artifacts/verification/sotto-palettes.
 */
const enabled = process.env.SOTTO_THEME_EVIDENCE === '1'
const evidenceRoot = resolve(process.cwd(), 'artifacts/verification/sotto-palettes')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const

async function withProfile(
  settings: Partial<AppSettings>,
  run: (launched: LaunchedSotto) => Promise<void>,
  options: { readonly threads?: boolean } = {},
): Promise<void> {
  const threads = options.threads === true
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-palettes-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, ...settings }), 'utf8')
  if (threads) {
    const fixture = designThreadsFixture()
    await writeFile(join(profile, 'agents.json'), JSON.stringify({
      configuration: { provider: 'codex', enabled: true, projectsDirectory: '', defaultModelId: 'claude:sonnet', followupLimit: 5, speak: false, speechProvider: 'system', speechVoice: 'F1', grokSpeechVoice: 'ara', wakeModelDirectory: '', wakeRuntimeDirectory: '', reasoning: 'none', reasoningModel: '', reasoningEffort: '', membershipEndpoint: '' },
      assignments: fixture.assignments.map(assignment => ({ ...assignment, contextUpdatedAt: Date.now() })),
      queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', contextSavedAt: Date.now(), outbox: [],
    }), 'utf8')
  }
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto(threads ? 'design-threads' : 'success', profile)
    await launched.page.emulateMedia({ reducedMotion: 'reduce' })
    await run(launched)
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: resolve(evidenceRoot, `${name}.png`), caret: 'hide', animations: 'disabled' })
}

async function openAppearance(page: Page): Promise<void> {
  await openPage(page, 'Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
  await expect(page.getByRole('radiogroup', { name: 'Dark theme' })).toBeVisible()
}

async function paint(page: Page, id: string): Promise<void> {
  await page.evaluate(async theme => { await window.sotto!.updateSettings({ lightTheme: theme, darkTheme: theme }) }, id)
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', id)
}

test.describe('Sotto palettes rendered evidence', () => {
  test.skip(!enabled, 'Run with SOTTO_THEME_EVIDENCE=1')
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })

  test.beforeAll(async () => { await mkdir(evidenceRoot, { recursive: true }) })

  for (const appearance of ['dark', 'light'] as const) {
    test(`the Appearance page fits at every review size, ${appearance}`, async () => {
      await withProfile({ appearance }, async (launched) => {
        const { page } = launched
        await openAppearance(page)
        for (const [width, height] of SIZES) {
          await resizeWindow(launched, width, height)
          // Nothing in the columns may be wider than the page lets it be.
          const overflow = await page.evaluate(() => [...document.querySelectorAll('.theme-half, .theme-scheme-track, .theme-settings__bar')]
            .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className))
          expect(overflow).toEqual([])
          await page.locator('#settings-appearance').evaluate(element => element.scrollIntoView({ block: 'start' }))
          await shot(page, `appearance-${width}x${height}-${appearance}`)
        }
      })
    })

    test(`every built-in paints the Threads page, ${appearance}`, async () => {
      await withProfile({ appearance }, async (launched) => {
        const { page } = launched
        await resizeWindow(launched, 1600, 1000)
        await openThreads(page)
        const thread = page.getByRole('button', { name: 'Visual gate flake', exact: true })
        await thread.click()
        await expect(thread).toHaveAttribute('aria-current', 'page')
        for (const theme of BUILT_IN_THEMES) {
          await paint(page, theme.id)
          await shot(page, `threads-${theme.id}-${appearance}`)
        }
      }, { threads: true })
    })
  }

  test('the mark is the app icon on the default theme and follows the accent on another', async () => {
    await withProfile({ appearance: 'dark' }, async ({ page }) => {
      await openAppearance(page)
      const mark = page.locator('.theme-live-preview__app-icon')
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async mode => { await window.sotto!.updateSettings({ appearance: mode }) }, appearance)
        await expect(page.locator('html')).toHaveAttribute('data-brand', 'app-icon')
        await expect(mark).toHaveAttribute('data-tile', '#47b8a9')
        await expect(mark).toHaveAttribute('data-glyph', '#000000')
      }
      await paint(page, 'citrine')
      await expect(page.locator('html')).not.toHaveAttribute('data-brand', /./u)
      await expect(mark).not.toHaveAttribute('data-tile', '#47b8a9')
      await shot(page, 'appearance-citrine-light')
    })
  })
})
