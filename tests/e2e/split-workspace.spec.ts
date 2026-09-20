import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openThreads, userMessageTexts, type LaunchedSotto } from './support/sottoLaunch'

async function size(launched: LaunchedSotto, width: number, height = 1000): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    // 760 is a test-only stress width below the shipped 820 minimum.
    window.setMinimumSize(760, 700)
    window.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => window.innerWidth)).toBe(width)
}

async function capture(page: Page, name: string): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'teal' }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await page.screenshot({ path: `artifacts/crossing/split-${name}-${appearance}.png`, animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', accent: 'teal' }))
}

const threadStatus = (page: Page, id: string) => page.evaluate(async threadId => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === threadId)!.status, id)

test('two threads split the workspace and stay independent through resize, narrow focus and close', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-split-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', accent: 'teal' }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false },
    assignments: [], queue: [], activeThreadId: 'grok-previews', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', outbox: [],
  }))
  const launched = await launchSotto('design-threads', profile)
  const { page } = launched
  try {
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    await size(launched, 1600)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    const panes = page.getByRole('group', { name: 'Thread panes' })
    // Panes are regions side by side and tab panels in narrow focus, so select them by thread.
    const previews = panes.locator('section.thread-pane[data-thread-id="grok-previews"]')
    await expect(previews.getByRole('heading', { name: 'Grok voice previews' })).toBeVisible()

    // Drag a thread from another project onto the right half of the workspace.
    const footerRow = sidebar.getByRole('button', { name: 'Footer links', exact: true })
    const box = (await previews.boundingBox())!
    await footerRow.hover()
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 4 })
    await page.mouse.move(box.x + box.width * 0.78, box.y + box.height * 0.5, { steps: 8 })
    await expect(page.getByText('Open on the right', { exact: true })).toBeVisible()
    await page.screenshot({ path: 'artifacts/crossing/split-drop-target-dark.png', animations: 'disabled' })
    await page.mouse.up()

    const footer = panes.locator('section.thread-pane[data-thread-id="footer-links"]')
    await expect(panes.getByRole('region', { name: 'Footer links', exact: true })).toBeVisible()
    await expect(panes.locator('section.thread-pane[role="region"]:not([data-hidden])')).toHaveCount(2)
    await expect(footer).toHaveAttribute('data-focused')
    await expect.poll(async () => (await page.evaluate(async () => window.sotto!.agents!.get())).activeThreadId).toBe('footer-links')
    const divider = page.getByRole('separator', { name: 'Resize panes' })
    await expect(divider).toHaveAttribute('aria-valuenow', '50')
    const [left, right] = [(await previews.boundingBox())!, (await footer.boundingBox())!]
    expect(Math.abs(left.width - right.width)).toBeLessThanOrEqual(1)
    // A pane this narrow gives up its project crumb; the project still names the pane for assistive technology.
    await expect(footer.locator('.thread-workspace__crumb')).toContainText('sotto-site')
    await expect(previews.locator('.thread-workspace__crumb')).toContainText('workshop')

    // Each pane writes to its own thread; a send in one leaves the other's draft where it was.
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'footer-links', text: 'Footer links are ready for review.' }))
    const previewsPrompt = previews.getByRole('textbox', { name: 'Prompt', exact: true })
    const footerPrompt = footer.getByRole('textbox', { name: 'Prompt', exact: true })
    await previewsPrompt.fill('Keep this draft with the previews thread.')
    await expect(previews).toHaveAttribute('data-focused')
    await footerPrompt.fill('Check the footer link targets.')
    await expect(footer).toHaveAttribute('data-focused')
    await footerPrompt.press('Enter')
    await expect(footer.getByLabel('Thread transcript')).toContainText('Check the footer link targets.')
    await expect(previews.getByLabel('Thread transcript')).not.toContainText('Check the footer link targets.')
    await expect(previewsPrompt).toHaveValue('Keep this draft with the previews thread.')
    await expect(footerPrompt).toHaveValue('')
    const afterSend = await page.evaluate(async () => window.sotto!.agents!.get())
    await expect.poll(async () => (await userMessageTexts(page, 'footer-links')).filter(text => text === 'Check the footer link targets.')).toHaveLength(1)
    expect((await userMessageTexts(page, 'grok-previews')).some(text => text.includes('footer link targets'))).toBe(false)
    expect(afterSend.assignments).toHaveLength(0)
    await expect.poll(() => threadStatus(page, 'footer-links')).toBe('running')
    await footerPrompt.fill('Next: compare the mobile footer.')
    await capture(page, 'two-panes')

    // Keyboard resize, then F6 between panes.
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(divider).toHaveAttribute('aria-valuenow', '60')
    await page.screenshot({ path: 'artifacts/crossing/split-divider-focus-dark.png', animations: 'disabled' })
    await footerPrompt.focus()
    await page.keyboard.press('F6')
    await expect(previewsPrompt).toBeFocused()
    await expect(previews).toHaveAttribute('data-focused')
    await expect.poll(async () => (await page.evaluate(async () => window.sotto!.agents!.get())).activeThreadId).toBe('grok-previews')

    // The shipped minimum width shows one pane at a time and keeps the arrangement for later.
    await size(launched, 820, 800)
    const tabs = page.getByRole('tablist', { name: 'Open panes' })
    await expect(tabs).toBeVisible()
    await expect(divider).toHaveCount(0)
    await expect(tabs.getByRole('tab', { name: 'Grok voice previews' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#thread-pane-footer-links')).toHaveAttribute('inert')
    await capture(page, 'narrow-focus')
    await tabs.getByRole('tab', { name: 'Footer links' }).click()
    await expect(footerPrompt).toBeVisible()
    await expect(footerPrompt).toHaveValue('Next: compare the mobile footer.')
    await expect(previewsPrompt).toBeHidden()
    await size(launched, 760, 760)
    await page.screenshot({ path: 'artifacts/crossing/split-narrow-760-dark.png', animations: 'disabled' })
    await size(launched, 1600)
    await expect(divider).toHaveAttribute('aria-valuenow', '60')
    await expect(previewsPrompt).toHaveValue('Keep this draft with the previews thread.')

    // Closing a pane closes the view only: the agent keeps running and the thread stays in the sidebar.
    await footer.getByRole('button', { name: 'Close Footer links pane' }).click()
    await expect(panes.locator('section.thread-pane[role="region"]:not([data-hidden])')).toHaveCount(1)
    await expect(divider).toHaveCount(0)
    expect(await threadStatus(page, 'footer-links')).toBe('running')
    await expect.poll(async () => (await page.evaluate(async () => window.sotto!.agents!.get())).activeThreadId).toBe('grok-previews')
    await expect(sidebar.getByRole('button', { name: 'Footer links', exact: true })).toBeVisible()
    await sidebar.getByRole('button', { name: 'Footer links', exact: true }).hover()
    await sidebar.getByRole('button', { name: 'Open Footer links beside', exact: true }).click()
    await expect(panes.locator('section.thread-pane[role="region"]:not([data-hidden])')).toHaveCount(2)
    await expect(footerPrompt).toHaveValue('Next: compare the mobile footer.')

    // Larger text scaling at a typical laptop width.
    await size(launched, 1280, 900)
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.webContents.setZoomFactor(1.25))
    // Wait for the zoomed layout: 1280 device pixels hold 1024 CSS pixels, which is narrow focus beside the sidebar.
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
    await expect(tabs).toBeVisible()
    await expect(footer.getByRole('button', { name: 'Close Footer links pane' })).toBeInViewport()
    // Playwright's capture does not follow Electron's zoom factor, so the window captures itself.
    const zoomed = await launched.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.webContents.capturePage()).toPNG().toString('base64'))
    await writeFile('artifacts/crossing/split-scale-125-dark.png', Buffer.from(zoomed, 'base64'))
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.webContents.setZoomFactor(1))
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
