import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test } from '@playwright/test'

import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

/**
 * The Frosted window setting (ADR-0048): the native window and the room agree. Where the system draws a frosted
 * material the window is clear over it and the room's canvas lets it through; where it cannot (Windows before
 * 11 22H2, the CI runner among them) the switch says so and nothing changes.
 *
 * SOTTO_FROST_EVIDENCE=1 also captures the window from the screen, so the desktop behind it shows, into
 * artifacts/frosted-window, which git ignores: the captures show the desktop behind the window, which is the owner's.
 */
const evidence = process.env.SOTTO_FROST_EVIDENCE === '1'
const evidenceRoot = resolve(process.cwd(), 'artifacts/frosted-window')

async function withProfile(settings: Partial<AppSettings>, run: (launched: LaunchedSotto) => Promise<void>): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-frost-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, ...settings }), 'utf8')
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { provider: 'codex', enabled: true, projectsDirectory: '', defaultModelId: 'claude:sonnet', followupLimit: 5, reasoning: 'none', reasoningModel: '', reasoningEffort: '', membershipEndpoint: '' },
    assignments: [],
    queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', contextSavedAt: Date.now(), outbox: [],
  }), 'utf8')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    await launched.page.emulateMedia({ reducedMotion: 'reduce' })
    await run(launched)
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
}

/** The alpha of a surface's painted background, the body's by default: 1 when solid, less where the desktop shows through. */
async function canvasAlpha(launched: LaunchedSotto, selector = 'body'): Promise<number> {
  const painted = await launched.page.evaluate(target => getComputedStyle(document.querySelector(target)!).backgroundColor, selector)
  const alpha = /\/\s*([\d.]+%?)\s*\)$/u.exec(painted)?.[1] ?? /^rgba\([^)]*,\s*([\d.]+)\)$/u.exec(painted)?.[1]
  if (alpha === undefined) return 1
  return alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha)
}

/** Holds the window above every other one while it is captured, so only the desktop shows behind it. */
async function screenCapture(launched: LaunchedSotto, name: string): Promise<void> {
  const png = await launched.app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    window.setAlwaysOnTop(true, 'screen-saver')
    window.moveTop()
    window.focus()
    await new Promise(done => setTimeout(done, 800))
    const bounds = window.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const scale = display.scaleFactor
    const size = { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const source = sources.find(candidate => candidate.display_id === String(display.id)) ?? sources[0]!
    const png = source.thumbnail.crop({
      x: Math.round((bounds.x - display.bounds.x) * scale),
      y: Math.round((bounds.y - display.bounds.y) * scale),
      width: Math.round(bounds.width * scale),
      height: Math.round(bounds.height * scale),
    }).toPNG().toString('base64')
    window.setAlwaysOnTop(false)
    return png
  })
  await writeFile(resolve(evidenceRoot, `${name}.png`), Buffer.from(png, 'base64'))
}

test.describe('frosted window', () => {
  test.describe.configure({ timeout: 3 * 60_000 })

  test('the window and the room frost together where the system can draw it, and the switch turns both back', async () => {
    await withProfile({ frostedWindow: true }, async launched => {
      const { page } = launched
      await openThreads(page)
      const supported = await page.evaluate(() => window.sotto?.canFrostWindow === true)
      if (supported) {
        await expect(page.locator('html')).toHaveAttribute('data-frost', '')
        // The cached look paints first; the saved settings, frost included, arrive a moment later.
        await expect.poll(() => canvasAlpha(launched)).toBeLessThan(1)
        // A pane's terminal drawer frosts too, more solid than the room, and its terminal lets that show.
        await page.getByText('Docs', { exact: true }).first().click()
        await page.locator('[data-pane-terminal-toggle]').first().click()
        await expect(page.locator('.pane-terminal .terminal-view')).toBeVisible()
        const room = await canvasAlpha(launched)
        await expect.poll(() => canvasAlpha(launched, '.pane-terminal')).toBeLessThan(1)
        expect(await canvasAlpha(launched, '.pane-terminal')).toBeGreaterThan(room)
        expect(await canvasAlpha(launched, '.pane-terminal .terminal-view')).toBe(0)
        await page.locator('[data-pane-terminal-toggle]').first().click()
      } else {
        await expect(page.locator('html')).not.toHaveAttribute('data-frost', /.*/u)
        await expect.poll(() => canvasAlpha(launched)).toBe(1)
      }

      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
      const frosted = page.getByRole('switch', { name: 'Frosted window' })
      if (!supported) {
        await expect(frosted).toBeDisabled()
        await expect(frosted).toHaveAccessibleDescription(/Needs Windows 11/u)
        return
      }
      await expect(page.getByRole('slider', { name: 'See-through' })).toBeVisible()
      await frosted.click()
      await expect(frosted).toHaveAttribute('aria-checked', 'false')
      await expect(page.locator('html')).not.toHaveAttribute('data-frost', /.*/u)
      await expect(page.getByRole('slider', { name: 'See-through' })).toHaveCount(0)
      await expect.poll(() => canvasAlpha(launched)).toBe(1)
      await frosted.click()
      await expect(page.locator('html')).toHaveAttribute('data-frost', '')
      await expect.poll(() => canvasAlpha(launched)).toBeLessThan(1)
    })
  })

  test('captures the frosted room from the screen', async () => {
    test.skip(!evidence, 'Run with SOTTO_FROST_EVIDENCE=1')
    await mkdir(evidenceRoot, { recursive: true })
    for (const appearance of ['dark', 'light'] as const) {
      await withProfile({ frostedWindow: true, appearance }, async launched => {
        test.skip(!(await launched.page.evaluate(() => window.sotto?.canFrostWindow === true)), 'This system cannot draw a frosted window')
        await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setSize(1280, 800))
        await openThreads(launched.page)
        await launched.page.getByRole('button', { name: /Footer links/u }).first().click().catch(() => undefined)
        await screenCapture(launched, `threads-${appearance}`)
      })
    }
  })
})
