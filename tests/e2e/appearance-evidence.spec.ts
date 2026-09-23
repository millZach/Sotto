import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { designThreadsFixture, type E2EScenario } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { closeSotto, enableVoiceCoordinator, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Rendered evidence for ticket #73 that the pixel gate does not hold: the
 * native select popup, the widget staying on its own scheme, overlays and the
 * Threads page in the light room, and how quickly a choice repaints. Run with
 * SOTTO_APPEARANCE_EVIDENCE=1 after `npm run build`; images land in
 * artifacts/verification/phase-1-appearance.
 */
const enabled = process.env.SOTTO_APPEARANCE_EVIDENCE === '1'
/** Screen captures include whatever covers Sotto's window, so they need their own opt-in. */
const screenCaptureEnabled = process.env.SOTTO_APPEARANCE_SCREEN_CAPTURE === '1'
const evidenceRoot = resolve(process.cwd(), 'artifacts/verification/phase-1-appearance')

async function withProfile(
  settings: Partial<AppSettings>,
  run: (launched: LaunchedSotto) => Promise<void>,
  options: { readonly scenario?: E2EScenario; readonly threads?: boolean; readonly voice?: boolean } = {},
): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-appearance-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, ...settings }), 'utf8')
  // The Agents room is hidden for the beta, so the evidence that records it asks for the coordinator by name.
  if (options.voice === true) await enableVoiceCoordinator(profile)
  if (options.threads === true) {
    const fixture = designThreadsFixture()
    await writeFile(join(profile, 'agents.json'), JSON.stringify({
      configuration: { provider: 'codex', enabled: true, projectsDirectory: '', defaultModelId: 'claude:sonnet', followupLimit: 5, speak: false, speechProvider: 'system', speechVoice: 'F1', grokSpeechVoice: 'ara', wakeModelDirectory: '', wakeRuntimeDirectory: '', reasoning: 'none', reasoningModel: '', reasoningEffort: '', membershipEndpoint: '' },
      assignments: fixture.assignments.map(assignment => ({ ...assignment, contextUpdatedAt: Date.now() })),
      queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', contextSavedAt: Date.now(), outbox: [],
    }), 'utf8')
  }
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto(options.scenario ?? 'success', profile)
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

/**
 * The select popup is a separate native widget, so it is captured from the
 * screen, cropped to Sotto's window. Anything above the window is captured
 * too, so inspect these images before relying on them.
 */
async function screenCapture(launched: LaunchedSotto, name: string): Promise<void> {
  const png = await launched.app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    const bounds = window.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const scale = display.scaleFactor
    const size = { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const source = sources.find(candidate => candidate.display_id === String(display.id)) ?? sources[0]!
    const crop = source.thumbnail.crop({
      x: Math.round((bounds.x - display.bounds.x) * scale),
      y: Math.round((bounds.y - display.bounds.y) * scale),
      width: Math.round(bounds.width * scale),
      height: Math.round(bounds.height * scale),
    })
    return crop.toPNG().toString('base64')
  })
  await writeFile(resolve(evidenceRoot, `${name}.png`), Buffer.from(png, 'base64'))
}

test.describe('appearance rendered evidence', () => {
  test.skip(!enabled, 'Run with SOTTO_APPEARANCE_EVIDENCE=1')
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })

  test.beforeAll(async () => { await mkdir(evidenceRoot, { recursive: true }) })

  test('a choice repaints the room within two frames, a theme is chosen by keyboard, and both survive restart', async () => {
    await withProfile({}, async ({ page }) => {
      await page.getByRole('link', { name: 'Settings' }).click()
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
      // Time from activating Light to the root attribute and the painted canvas changing.
      const elapsed = await page.evaluate(() => new Promise<{ attribute: number; painted: number }>((done) => {
        const light = [...document.querySelectorAll<HTMLButtonElement>('#settings-appearance .theme-scheme-track__stop')].find(stop => stop.textContent?.trim() === 'Light')!
        const darkCanvas = getComputedStyle(document.body).backgroundColor
        const start = performance.now()
        let attribute = -1
        const observer = new MutationObserver(() => {
          if (document.documentElement.dataset.theme === 'light' && attribute < 0) attribute = performance.now() - start
        })
        observer.observe(document.documentElement, { attributes: true })
        light.click()
        requestAnimationFrame(() => requestAnimationFrame(() => {
          observer.disconnect()
          done({ attribute, painted: getComputedStyle(document.body).backgroundColor !== darkCanvas ? performance.now() - start : -1 })
        }))
      }))
      expect(elapsed.attribute).toBeGreaterThanOrEqual(0)
      expect(elapsed.attribute).toBeLessThan(50)
      expect(elapsed.painted).toBeGreaterThanOrEqual(0)
      await writeFile(resolve(evidenceRoot, 'switch-timing.json'), `${JSON.stringify(elapsed, null, 2)}\n`, 'utf8')
      const citrine = page.getByRole('radiogroup', { name: 'Light theme', exact: true }).getByRole('radio', { name: 'Citrine', exact: true })
      await citrine.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'citrine')
      await expect(citrine).toBeFocused()
      await shot(page, 'keyboard-theme-focus-light')
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'citrine')
    })
  })

  test('native select popups follow the room', async () => {
    test.skip(!screenCaptureEnabled, 'Run with SOTTO_APPEARANCE_SCREEN_CAPTURE=1 on an otherwise clear screen')
    for (const appearance of ['light', 'dark'] as const) {
      await withProfile({ appearance }, async (launched) => {
        const { page } = launched
        await launched.app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
          window.setAlwaysOnTop(true)
          window.show()
          window.focus()
        })
        await page.getByRole('link', { name: 'Settings' }).click()
        await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Application', exact: true }).click()
        const select = page.getByRole('combobox', { name: 'Reduced motion' })
        await select.scrollIntoViewIfNeeded()
        expect(await select.evaluate(element => getComputedStyle(element).colorScheme)).toBe(appearance)
        await select.focus()
        await page.keyboard.press('Alt+ArrowDown')
        await page.waitForTimeout(400)
        await screenCapture(launched, `native-select-open-${appearance}`)
        await page.keyboard.press('Escape')
      })
    }
  })

  test('the floating widget keeps following the system scheme whatever the room is', async () => {
    await withProfile({ appearance: 'light', lightTheme: 'tropic', darkTheme: 'tropic' }, async (launched) => {
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme', 'light')
      await expect.poll(() => launched.app.windows().some(candidate => candidate.url().endsWith('/widget.html'))).toBe(true)
      const widget = launched.app.windows().find(candidate => candidate.url().endsWith('/widget.html'))!
      await widget.waitForLoadState('domcontentloaded')
      for (const scheme of ['dark', 'light'] as const) {
        await widget.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        await expect.poll(() => widget.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(scheme === 'dark')
        await openPage(launched.page, 'Dictate')
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
        await widget.screenshot({ path: resolve(evidenceRoot, `widget-listening-system-${scheme}-room-light.png`), animations: 'disabled' })
        expect(await widget.evaluate(() => document.documentElement.dataset.themeId)).toBeUndefined()
        await widget.getByRole('button', { name: 'Cancel dictation' }).click()
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible({ timeout: 15_000 })
      }
    })
  })

  test('overlays, the Workshop sheet and the Threads page in the light room', async () => {
    await withProfile({ appearance: 'light' }, async ({ page }) => {
      await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } }); await window.sotto!.agents!.command({ type: 'connect' }) })
      await page.getByRole('tab', { name: 'Agents', exact: true }).click()
      await page.getByRole('button', { name: 'Not now', exact: true }).click()
      await page.evaluate(async () => {
        const state = await window.sotto!.agents!.get()
        const id = state.host.threads[0]!.id
        await window.sotto!.agents!.command({ type: 'assign', threadId: id })
        await window.sotto!.agents!.command({ type: 'select-thread', threadId: id })
        await window.sottoE2E!.agentEvent!({ type: 'permission', threadId: id, text: 'Allow the agent to update the project files?', requestId: 'appearance-permission' })
      })
      await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
      await shot(page, 'agents-attention-light')
      await page.getByRole('button', { name: 'Open Workshop', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Workshop' })).toBeVisible()
      await shot(page, 'agents-session-light')
    }, { voice: true })

    await withProfile({ appearance: 'light' }, async ({ page }) => {
      await openThreads(page)
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Footer links', exact: true }).click()
      await expect(page.getByLabel('Thread transcript')).toContainText('Fixing the footer links')
      await shot(page, 'threads-open-running-light')
    }, { scenario: 'design-threads', threads: true })
  })

  test('the minimum width with 150 percent page zoom in the light room', async () => {
    await withProfile({ appearance: 'light', lightTheme: 'citrine' }, async (launched) => {
      const { page } = launched
      // Page zoom shrinks the CSS viewport to about 507px, so the narrow layout
      // rules apply; display scaling at 760 keeps a 760px CSS viewport instead,
      // which the width tuples in the design gate already cover.
      await launched.app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
        window.setMinimumSize(760, 560)
        window.setContentSize(760, 720)
        window.webContents.setZoomFactor(1.5)
      })
      await expect.poll(() => page.evaluate('innerWidth')).toBeLessThan(520)
      await page.getByRole('link', { name: 'Settings' }).click()
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
      await page.mouse.move(0, 0)
      // Playwright crops zoomed pages to the unzoomed viewport, so Electron captures the page itself.
      const png = await launched.app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
        return (await window.webContents.capturePage()).toPNG().toString('base64')
      })
      await writeFile(resolve(evidenceRoot, 'width-760-zoom-150-settings-appearance-light.png'), Buffer.from(png, 'base64'))
    })
  })
})
