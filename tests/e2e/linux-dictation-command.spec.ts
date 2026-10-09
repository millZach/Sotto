import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, firstRunForwardButton, launchSotto, openPage, reachFirstRunStep, skipThreadsTour } from './support/sottoLaunch'

const run = promisify(execFile)
const sizes = [[1600, 1000], [1280, 800], [820, 560]] as const

async function checkOnboardingLayout(page: Page, words: RegExp, buttonName: string | RegExp): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height })
      await expect(page.getByText(words)).toBeVisible()
      const next = page.getByRole('button', { name: buttonName, exact: true })
      await next.scrollIntoViewIfNeeded()
      await expect(next).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 })
}

test('compositor commands reach Linux dictation and Settings explains the bindings', async () => {
  test.skip(process.platform !== 'linux', 'Linux compositor commands')
  const launched = await launchSotto('success')
  const captures = join(process.cwd(), 'artifacts/linux-hyprland-paste')
  await mkdir(captures, { recursive: true })
  const { page, userData } = launched
  const capture = async (name: string): Promise<void> => {
    const viewport = page.viewportSize()!
    // Wayland suspends frame callbacks while the live session is locked.
    // Electron's native capture keeps painting without sending compositor keys.
    const image = await launched.app.evaluate(async ({ BrowserWindow }, size) => {
      const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!
      const frame = await main.webContents.capturePage({ x: 0, y: 0, ...size }, { stayHidden: true, stayAwake: true })
      return { png: frame.toPNG().toString('base64'), size: frame.getSize() }
    }, viewport)
    expect(image.size).toEqual(viewport)
    await writeFile(join(captures, name), Buffer.from(image.png, 'base64'))
  }
  const command = async (verb: string, at?: bigint): Promise<void> => {
    await run(join(process.cwd(), 'apps/omarchy/sotto'), ['dictation', verb, ...(at === undefined ? [] : ['--at', String(at)])], { env: { ...process.env, XDG_RUNTIME_DIR: userData } })
  }
  try {
    await expect(page.getByText(/Hold F9 to talk after installing/)).toBeVisible()
    await checkOnboardingLayout(page, /Hold F9 to talk after installing/, 'Get started')
    await reachFirstRunStep(page, 'key', { microphone: 'skip' })
    await page.getByLabel('OpenRouter API key', { exact: true }).fill('sotto-linux-command-e2e')
    await page.getByRole('heading', { name: 'Connect your OpenRouter key' }).click()
    await expect(page.getByLabel('OpenRouter API key', { exact: true })).toHaveAttribute('placeholder', 'Key saved')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByText(/Install Sotto’s compositor bindings in Hyprland/)).toBeVisible()
    await checkOnboardingLayout(page, /Install Sotto’s compositor bindings in Hyprland/, /^(Continue|Skip for now)$/)
    await page.setViewportSize({ width: 820, height: 560 })
    await capture('onboarding-820x560-light.png')
    await page.setViewportSize({ width: 1280, height: 800 })
    for (let step = 0; step < 4; step++) await firstRunForwardButton(page).click()
    await page.getByRole('button', { name: 'Finish setup' }).focus()
    await page.keyboard.press('Enter')
    await skipThreadsTour(page)
    await page.evaluate(async () => window.sotto!.updateSettings({ microphoneSkipped: false }))
    await openPage(page, 'Dictate')
    const room = page.getByRole('region', { name: 'Dictation', exact: true })
    await command('stop')
    await expect(room).toHaveAttribute('data-status', 'idle')
    const at = BigInt(Date.now()) * 1_000_000n
    await command('stop', at)
    await command('start', at - 15_000_000n)
    await expect(room).toHaveAttribute('data-status', 'idle')
    const widget = launched.app.windows().find(window => window.url().includes('/widget.html'))!
    await expect(widget.locator('.widget-sliver__prompt-keys')).toHaveText('F9 to talk')
    await command('start')
    await expect(room).toHaveAttribute('data-status', 'listening')
    await expect(page.getByText(/Sotto copies, then pastes into the focused window on Hyprland/)).toBeVisible()
    await expect(widget.getByRole('status')).toContainText('Release F9 or press Super+Ctrl+X to finish')
    await command('start')
    await expect(room).toHaveAttribute('data-status', 'listening')
    await command('stop')
    await expect(room).toHaveAttribute('data-status', 'success')
    await command('toggle')
    await expect(room).toHaveAttribute('data-status', 'listening')
    await command('toggle')
    await expect(room).toHaveAttribute('data-status', 'success')
    await command('start')
    await expect(room).toHaveAttribute('data-status', 'listening')
    await command('cancel')
    await expect(room).toHaveAttribute('data-status', 'cancelled')
    await page.evaluate(async () => window.sotto!.updateSettings({ autoPaste: false }))
    await command('start')
    await expect(room).toHaveAttribute('data-status', 'listening')
    await expect(page.getByText(/Sotto copies your text. Paste with Super\+V, Omarchy’s universal paste/)).toBeVisible()
    await command('stop')
    await expect(page.getByRole('heading', { name: 'Copied.', exact: true })).toBeVisible()
    await page.evaluate(async () => window.sotto!.updateSettings({ autoPaste: true }))
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true }).click()
    await expect(page.getByText('Compositor bindings', { exact: true })).toBeVisible()
    await expect(page.getByText(/Compositor bindings live in Hyprland/)).toBeVisible()
    await expect(page.getByLabel('Global shortcut', { exact: true })).toHaveCount(0)
    await page.getByRole('tab', { name: 'Output', exact: true }).click()
    await expect(page.getByText(/Paste into the focused window on Hyprland, terminals included/)).toBeVisible()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true }).click()
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
      for (const [width, height] of sizes) {
        // Hyprland owns the native tiled window's bounds; check the renderer at each required size.
        await page.setViewportSize({ width, height })
        expect(await page.evaluate(() => innerWidth)).toBe(width)
        await expect(page.getByText(/Compositor bindings live in Hyprland/)).toBeVisible()
        await page.getByRole('tab', { name: 'Output', exact: true }).click()
        await expect(page.getByText(/Paste into the focused window on Hyprland, terminals included/)).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (width === 820 && appearance === 'dark') await capture('settings-820x560-dark.png')
        await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true }).click()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await openPage(page, 'Dictate')
        const hint = page.getByText(/With Sotto’s compositor bindings: hold F9 to talk/)
        await expect(hint).toBeVisible()
        const bounds = await hint.boundingBox()
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
        if (width === 820 && appearance === 'light') await capture('dictate-820x560-light.png')
        await openPage(page, 'Settings')
      }
    }
  } finally { await closeSotto(launched) }
})
