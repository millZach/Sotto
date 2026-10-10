import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { closeSotto, launchSotto, sottoWidget } from './support/sottoLaunch'

for (const mode of ['resting', 'hidden', 'expanded', 'expanded-hidden'] as const) test(`dictation hotkey preserves the native text target and caret from ${mode}`, async () => {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-focus-' })).directory
  await writeFile(join(profile, 'widget-placement.json'), JSON.stringify({ version: 3, placement: { edge: 'right' } }))
  const launched = await launchSotto('success', profile)
  const { app, page } = launched
  let targetApp: ElectronApplication | undefined
  try {
    await page.evaluate(async mode => {
      await window.sotto!.updateSettings({ onboardingComplete: true, showWidgetWhenIdle: mode !== 'hidden', reducedMotion: 'on' })
    }, mode)
    await page.reload()
    const widget = await sottoWidget(app)
    await expect(widget.getByTestId('widget-sliver')).toBeVisible()
    if (mode === 'expanded' || mode === 'expanded-hidden') {
      await widget.getByTestId('widget-sliver').hover()
      await expect(widget.getByTestId('widget-sliver')).toHaveAttribute('data-expanded', 'true')
    }
    if (mode === 'expanded-hidden') {
      await page.evaluate(() => window.sotto!.updateSettings({ showWidgetWhenIdle: false }))
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/widget.html'))!.isVisible())).toBe(false)
    }
    // Separate process: activation changes within Sotto must not steal focus
    // from the external app into which the user is dictating.
    targetApp = await electron.launch({ args: [resolve('tests/fixtures/focusTarget.mjs')], env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined)) })
    const targetPage = await targetApp.firstWindow()
    await targetPage.waitForLoadState('domcontentloaded')
    await targetApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus())
    await targetPage.getByRole('textbox').focus()
    await targetPage.getByRole('textbox').evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(7, 7))
    await targetPage.evaluate(() => {
      document.documentElement.dataset.blurEvents = '0'
      window.addEventListener('blur', () => {
        document.documentElement.dataset.blurEvents = String(Number(document.documentElement.dataset.blurEvents) + 1)
      })
    })
    const focusState = () => targetApp!.evaluate(async ({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0]!
      return { focused: target.isFocused(), caret: await target.webContents.executeJavaScript('({ hasFocus: document.hasFocus(), start: document.querySelector("textarea").selectionStart, end: document.querySelector("textarea").selectionEnd, blurEvents: Number(document.documentElement.dataset.blurEvents) })') }
    })
    await expect.poll(focusState).toEqual({ focused: true, caret: { hasFocus: true, start: 7, end: 7, blurEvents: 0 } })
    await page.evaluate(() => window.sottoE2E!.triggerShortcut())
    await expect(widget.locator('.widget-shell')).toHaveAttribute('data-status', 'listening')
    expect(await focusState()).toEqual({ focused: true, caret: { hasFocus: true, start: 7, end: 7, blurEvents: 0 } })
    await page.evaluate(() => window.sottoE2E!.triggerShortcut())
    await expect(widget.locator('.widget-shell')).toHaveAttribute('data-status', 'success')
    expect(await focusState()).toEqual({ focused: true, caret: { hasFocus: true, start: 7, end: 7, blurEvents: 0 } })
  } finally { await targetApp?.close(); await closeSotto(launched); await removeOwnedE2EProfile(profile) }
})
