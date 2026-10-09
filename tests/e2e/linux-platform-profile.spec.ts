import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { evidenceDirectory } from '../fixtures/evidence'
import { E2E_TRANSCRIPT, E2E_PRESERVED_CLIPBOARD } from '../../src/shared/e2e'
import { closeSotto, finishFirstRunSetupFrom, launchSotto, openPage, reachFirstRunStep } from './support/sottoLaunch'

const captures = evidenceDirectory('artifacts/linux-hyprland-paste')

test('Linux clipboard failure keeps text in Dictate while the main window is hidden', async () => {
  test.skip(process.platform !== 'linux', 'Linux desktop clipboard')
  const launched = await launchSotto('desktop-clipboard-unavailable')
  const { page, app } = launched
  const command = (verb: string) => promisify(execFile)(join(process.cwd(), 'apps/omarchy/sotto'), ['dictation', verb], {
    env: { ...process.env, XDG_RUNTIME_DIR: launched.userData },
  })
  try {
    await reachFirstRunStep(page, 'key', { microphone: 'skip' })
    await page.getByLabel('OpenRouter API key', { exact: true }).fill('sotto-linux-clipboard-e2e')
    await page.getByRole('heading', { name: 'Connect your OpenRouter key' }).click()
    await expect(page.getByLabel('OpenRouter API key', { exact: true })).toHaveAttribute('placeholder', 'Key saved')
    await finishFirstRunSetupFrom(page, 'key', { microphone: 'skip' })
    await page.evaluate(async () => window.sotto!.updateSettings({ microphoneSkipped: false, autoPaste: true, historyEnabled: false }))
    await openPage(page, 'Dictate')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.hide())
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ mainVisible: false, clipboardText: E2E_PRESERVED_CLIPBOARD })
    // Linux compositor commands enter Sotto through its private socket, without OS keys.
    await command('start')
    await expect(page.getByRole('region', { name: 'Dictation', exact: true })).toHaveAttribute('data-status', 'listening')
    await command('stop')
    const widget = app.windows().find(w => w.url().includes('/widget.html'))!
    await expect(widget.getByRole('alert')).toContainText('Text kept in Sotto')
    await expect(widget.getByRole('alert')).toContainText('Open Sotto, then Dictate. Use Copy text or select the text there.')
    await expect(widget.getByText(/Copied — paste manually|Super\+V/)).toHaveCount(0)
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ mainVisible: false, clipboardText: E2E_PRESERVED_CLIPBOARD, pasteAttempts: 0 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.show())
    await expect(page.getByRole('textbox', { name: 'Completed dictation text' })).toHaveValue(E2E_TRANSCRIPT)
    await expect(page.getByRole('button', { name: 'Copy text' })).toBeVisible()
    await expect(page.getByText(/Super\+V/)).toHaveCount(0)
    const widgetPng = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/widget.html'))!
      return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
    })
    await mkdir(captures, { recursive: true })
    await writeFile(join(captures, 'clipboard-failure-widget.png'), Buffer.from(widgetPng, 'base64'))
    for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await page.setViewportSize({ width, height })
        await expect(page.getByRole('button', { name: 'Copy text' })).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (width === 820) {
          const png = await app.evaluate(async ({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!
            return (await window.webContents.capturePage({ x: 0, y: 0, width: 820, height: 560 }, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
          })
          await writeFile(join(captures, `clipboard-recovery-820x560-${appearance}.png`), Buffer.from(png, 'base64'))
        }
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('button', { name: 'Copy text' }).click()
      await expect(page.getByRole('article', { name: 'Recovered transcript' }).getByRole('status')).toHaveText('Copied.')
      await expect(page.getByText('Copy failed. Your text is still here. Try again or select and copy it.')).toHaveCount(0)
    }
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ pasteAttempts: 0 })
  } finally { await closeSotto(launched) }
})

test('Linux saves a key during onboarding and explains Hyprland paste', async () => {
  test.skip(process.platform !== 'linux', 'Linux desktop profile')
  const launched = await launchSotto('success')
  const { page } = launched
  try {
    await expect(page.getByRole('heading', { name: 'Talk to your computer and your coding agents' })).toBeVisible()
    expect(await page.evaluate(() => window.sotto!.platform)).toBe('linux')
    expect(await page.evaluate(() => window.sotto!.canFrostWindow)).toBe(false)
    await expect(page.locator('.app-controls')).toHaveCount(0)
    await reachFirstRunStep(page, 'key', { microphone: 'skip' })
    await page.getByLabel('OpenRouter API key', { exact: true }).fill('sotto-linux-e2e-storage-check')
    await page.getByRole('heading', { name: 'Connect your OpenRouter key' }).click()
    await expect(page.getByLabel('OpenRouter API key', { exact: true })).toHaveAttribute('placeholder', 'Key saved')
    await finishFirstRunSetupFrom(page, 'key', { microphone: 'skip' })
    await expect(page.getByRole('complementary', { name: 'Thread sidebar', exact: true })).toBeVisible()
    await expect(page.locator('.app-controls, .threads-view__winctl')).toHaveCount(0)
    expect(await page.locator('.threads-view').evaluate(element => getComputedStyle(element).getPropertyValue('--threads-winctl-inset').trim())).toBe('0px')
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Application', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Launch when you sign in' })).toBeDisabled()
    await expect(page.getByText('Starting at sign-in comes with the installed package.')).toBeVisible()
    await expect(page.getByText('Launch at sign-in could not be updated.')).toHaveCount(0)
    await openPage(page, 'Help')
    await expect(page.getByText(/Sotto .*Linux\. No account/)).toBeVisible()
    await expect(page.getByText(/Compositor bindings live in Hyprland\. Omarchy defaults: hold F9 to talk/)).toBeVisible()
    await expect(page.getByText(/Hold F9 to talk, or press Super\+Ctrl\+X to start and stop/)).toBeVisible()
    await expect(page.getByText(/Sotto copies your text, then pastes into the focused window on Hyprland, terminals included/)).toBeVisible()
    await expect(page.getByText(/use Super\+V, Omarchy’s universal paste for apps and terminals/)).toBeVisible()
    expect(await page.evaluate(() => window.sotto!.checkForUpdates())).toMatchObject({ phase: { phase: 'unsupported' } })
    await page.evaluate(async () => window.sotto!.updateSettings({ microphoneSkipped: false, autoPaste: true }))
    await openPage(page, 'Dictate')
    await expect(page.locator('.app-room__top')).toBeEmpty()
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Pasted.', exact: true })).toBeVisible()
    await expect(page.getByText(/With Sotto’s compositor bindings: hold F9 to talk/)).toBeVisible()
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ clipboardText: E2E_TRANSCRIPT, pasteAttempts: 1 })
  } finally { await closeSotto(launched) }
})

test('Linux keeps the transcript and names universal paste when paste fails', async () => {
  test.skip(process.platform !== 'linux', 'Linux desktop profile')
  const launched = await launchSotto('paste-failure')
  try {
    await expect(launched.page.getByRole('heading', { name: 'Talk to your computer and your coding agents' })).toBeVisible()
    await reachFirstRunStep(launched.page, 'key', { microphone: 'skip' })
    await launched.page.getByLabel('OpenRouter API key', { exact: true }).fill('sotto-linux-paste-fallback-e2e')
    await launched.page.getByRole('heading', { name: 'Connect your OpenRouter key' }).click()
    await expect(launched.page.getByLabel('OpenRouter API key', { exact: true })).toHaveAttribute('placeholder', 'Key saved')
    await finishFirstRunSetupFrom(launched.page, 'key', { microphone: 'skip' })
    await expect(launched.page.getByRole('complementary', { name: 'Thread sidebar', exact: true })).toBeVisible()
    await launched.page.evaluate(async () => window.sotto!.updateSettings({
      microphoneSkipped: false, autoPaste: true,
    }))
    await openPage(launched.page, 'Dictate')
    await launched.page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await launched.page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(launched.page.getByRole('heading', { name: 'Copied.', exact: true })).toBeVisible()
    await expect(launched.page.getByText(/If needed, use Super\+V, Omarchy’s universal paste/)).toBeVisible()
    const widget = launched.app.windows().find(window => window.url().includes('/widget.html'))!
    await expect(widget.getByRole('status')).toContainText('Copied — paste manually')
    await expect(widget.getByRole('status')).toContainText('Super+V to paste in apps and terminals')
    expect(await launched.page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ clipboardText: E2E_TRANSCRIPT, pasteAttempts: 1 })
  } finally { await closeSotto(launched) }
})
