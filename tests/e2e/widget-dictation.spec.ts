import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

import { E2E_TRANSCRIPT } from '../../src/shared/e2e'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, reachFirstRunStep, sottoWidget } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/widget-dictation')

test('dictation reveals the widget, delivers text and hides the widget again', async () => {
  test.setTimeout(60_000)
  const launched = await launchSotto('success')
  const { app, page } = launched
  const visible = () => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/widget.html'))?.isVisible(),
  )
  try {
    await mkdir(evidence, { recursive: true })
    await reachFirstRunStep(page, 'shortcut', { microphone: 'test' })
    await page.evaluate(() => window.sotto!.updateSettings({ showWidgetWhenIdle: false, autoPaste: true, reducedMotion: 'on' }))
    await expect.poll(visible).toBe(false)
    const target = page.getByLabel('Paste test')
    await target.focus()
    await page.evaluate(() => window.sottoE2E!.triggerShortcut())
    await expect.poll(visible).toBe(true)
    const widget = app.windows().find(window => window.url().endsWith('/widget.html'))!
    await expect(widget.locator('.widget-shell')).toHaveAttribute('data-status', 'listening')
    await widget.screenshot({ path: join(evidence, 'widget-listening.png') })

    await page.evaluate(() => window.sottoE2E!.triggerShortcut())
    await expect(target).toHaveValue(E2E_TRANSCRIPT)
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({
      clipboardText: E2E_TRANSCRIPT, pasteAttempts: 1,
    })
    await page.screenshot({ path: join(evidence, 'text-delivered.png') })
    await expect.poll(visible, { timeout: 15_000 }).toBe(false)
    await expect(widget.locator('.widget-shell')).toHaveAttribute('data-status', 'idle')
  } catch (error) {
    await page.screenshot({ path: join(evidence, 'failed-main.png') }).catch(() => undefined)
    await app.windows().find(window => window.url().endsWith('/widget.html'))
      ?.screenshot({ path: join(evidence, 'failed-widget.png') }).catch(() => undefined)
    throw error
  } finally {
    await closeSotto(launched)
  }
})

test('starts and stops dictation from the floating widget', async () => {
  const launched = await launchSotto()
  try {
    await launched.page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
    const widget = await sottoWidget(launched.app)
    await expect(widget.getByTestId('widget-sliver')).toBeVisible()
    await widget.getByTestId('widget-sliver').click()
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await widget.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(widget.locator('.widget-shell[data-status="success"]')).toBeVisible()
  } finally { await closeSotto(launched) }
})
