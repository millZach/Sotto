import { expect, test, type Page } from '@playwright/test'
import type { SottoBridge } from '../../src/shared/contracts'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto } from './support/sottoLaunch'

async function setup(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /test microphone/i }).click()
  await expect(page.getByText(/microphone ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /finish setup/i }).click()
  await page.getByRole('link', { name: 'Agents', exact: true }).click()
}

test('collects an explicit prompt, queues ready threads, and yields only the directly controlled thread', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await setup(page)
    await page.getByRole('button', { name: 'Connect T3 Code' }).click()
    await expect(page.getByText('T3 Code connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Manage Workshop', exact: true }).click()
    await page.getByRole('button', { name: 'Manage Docs', exact: true }).click()
    await page.getByRole('button', { name: 'Select Workshop', exact: true }).click()
    await page.getByLabel('Prompt').fill('Build the requested feature and run its checks.')
    await expect(page.getByRole('button', { name: 'Send it', exact: true })).toBeEnabled()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto?.agents?.get().then(s => s.host.threads.find(t => t.title === 'Workshop')?.messages.length))).toBe(0)
    await page.getByRole('button', { name: 'Send it', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto?.agents?.get().then(s => s.host.threads.find(t => t.title === 'Workshop')?.messages.length))).toBe(1)
    await page.evaluate(() => (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E?.agentEvent?.({ type: 'ready', threadId: 'workshop', text: 'Feature is ready.' }))
    await page.evaluate(() => (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E?.agentEvent?.({ type: 'ready', threadId: 'docs', text: 'Docs are ready.' }))
    await expect(page.getByText('Feature is ready.', { exact: true }).first()).toBeVisible()
    await page.getByLabel('Prompt').fill('Inspect the result before proceeding.')
    await page.evaluate(() => (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E?.agentEvent?.({ type: 'manual', threadId: 'workshop', text: 'I will handle the review.' }))
    await expect(page.getByText('Manual control · Workshop', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: 'artifacts/agent-control-smoke/agents-manual-e2e.png' })
    const widget = launched.app.windows().find((window) => window.url().endsWith('/widget.html'))
    expect(widget).toBeDefined()
    await expect(widget!.getByRole('button', { name: 'Collapse agent controls', exact: true })).toBeVisible()
    await widget!.screenshot({ path: 'artifacts/agent-control-smoke/agents-widget-e2e.png' })
    await expect(page.getByLabel('Prompt')).toHaveValue('Inspect the result before proceeding.')
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto?.agents?.get().then(s => s.assignments.find(a => a.threadId === 'docs')?.mode))).toBe('managed')
    await page.getByRole('button', { name: 'Resume management', exact: true }).first().click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto?.agents?.get().then(s => s.assignments.find(a => a.threadId === 'workshop')?.mode))).toBe('managed')
    await page.locator('.app-content').evaluate((element) => { element.scrollTop = 0 })
    await page.screenshot({ path: 'artifacts/agent-control-smoke/agents-e2e.png' })
  } finally {
    await closeSotto(launched)
  }
})

test('keeps dark agent settings and widget prompts usable at the minimum window size', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await setup(page)
    await page.evaluate(async () => {
      const bridge = (globalThis as unknown as { sotto: SottoBridge }).sotto
      await bridge.updateSettings({ theme: 'dark', reducedMotion: 'on' })
      await bridge.agents?.command({ type: 'configure', patch: { speak: false } })
    })
    await launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      main.setBounds({ ...main.getBounds(), width: 820, height: 560 })
    })
    await page.getByRole('button', { name: 'Connect T3 Code' }).click()
    await page.getByRole('button', { name: 'Manage Workshop', exact: true }).click()
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await page.getByLabel('Default projects directory').fill('D:\\Builder projects')
    await page.getByRole('button', { name: 'Save connection settings' }).click()
    await expect(page.getByText('Settings saved', { exact: true })).toBeVisible()
    expect(await page.locator('.app-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.getByLabel('Default projects directory').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'artifacts/agent-control-smoke/agents-settings-dark-minimum.png' })
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await page.getByLabel('Prompt').fill('Review this small-screen prompt.')
    const widget = launched.app.windows().find(window => window.url().endsWith('/widget.html'))!
    await expect(widget.getByRole('button', { name: 'Expand agent controls' })).toBeVisible()
    await widget.getByRole('button', { name: 'Expand agent controls' }).click()
    await expect(widget.getByLabel('Prompt')).toHaveValue('Review this small-screen prompt.')
    await widget.getByRole('button', { name: 'Send it', exact: true }).scrollIntoViewIfNeeded()
    await widget.screenshot({ path: 'artifacts/agent-control-smoke/agents-widget-dark-prompt.png' })
    await widget.getByRole('button', { name: 'Send it', exact: true }).click()
    await expect(page.getByLabel('Prompt')).toHaveValue('')
    expect(await widget.locator('.agent-widget__body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  } finally { await closeSotto(launched) }
})
