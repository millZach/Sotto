import { captureSotto } from './support/sottoCapture'
import { resizeContentWindow } from './support/sottoWindow'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { start as startFakeRunCloud } from '../fixtures/fakeRunCloud.mjs'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'
import { settingsLayoutProblems, settingsTextContrast } from './support/settingsChecks'

const SHOTS = evidenceDirectory('artifacts/cloud-iphone')
/** What in Settings > Cloud iPhone must not be cut off, and the page's own text whose contrast is measured. */
const CLOUD_CONTROLS = 'input,button,p,h3,li,[role="meter"]'
const CLOUD_TEXT = '.settings-group > h3, .settings-group__note, .tt-field__label, .tt-field__description, .cloud-iphone-usage > p, .cloud-iphone-recent span, .cloud-iphone-recent__empty, .settings-remote-status'

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await resizeContentWindow(launched, width, height, [800, 540])
}
/** The window as the user sees it, native views included. */
async function screenshot(launched: LaunchedSotto, name: string): Promise<void> {
  const title = `Sotto cloud iPhone ${name}`
  await captureSotto(launched, join(SHOTS, `${name}.png`), { mode: 'native-window', title, retries: 9, retryDelayMs: 500 })
}
async function viewerUrls(launched: LaunchedSotto): Promise<string[]> {
  return launched.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    return host.contentView.children.filter(view => view instanceof WebContentsView).map(view => (view as Electron.WebContentsView).webContents.getURL()).filter(url => url.includes('/viewer/'))
  })
}

test('an agent asks for a cloud iPhone, the user starts it in the thread, and the agent drives it while the user watches', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const fake = await startFakeRunCloud(0)
  const previous = process.env.SOTTO_RUN_CLOUD_API_URL
  process.env.SOTTO_RUN_CLOUD_API_URL = fake.url
  const launched = await launchSotto().catch(async error => { await fake.close(); throw error })
  const { page } = launched
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  let buildFile: string | undefined
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await resize(launched, 1280, 800); await openThreads(page)

    // Settings > Cloud iPhone before any session: no sessions yet. A wrong key typed there is refused and not saved, and
    // the fake's key is saved. Each state's words meet 4.5:1 in light and dark.
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Cloud iPhone', exact: true }).click()
    const cloudPanel = page.getByRole('tabpanel', { name: 'Cloud iPhone', exact: true })
    const readable = async (state: string): Promise<void> => {
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        for (const { text, ratio } of await settingsTextContrast(page, 'settings-cloud-iphone', CLOUD_TEXT)) expect(ratio, `${text} ${state} in ${mode}`).toBeGreaterThanOrEqual(4.5)
      }
      await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    }
    await expect(cloudPanel.getByText('No sessions yet.', { exact: true })).toBeVisible()
    await readable('with no sessions')
    await cloudPanel.getByLabel('Key').fill('rc_live_wrong')
    await cloudPanel.getByRole('button', { name: 'Save key', exact: true }).click()
    await expect(cloudPanel.getByRole('alert')).toBeVisible()
    expect(await page.evaluate(async () => { const result = await window.sotto!.cloudIphone!.status(); return result.ok && result.value.keySaved })).toBe(false)
    await readable('after a refused key')
    await cloudPanel.getByLabel('Key').fill(fake.key)
    await cloudPanel.getByRole('button', { name: 'Save key', exact: true }).click()
    await expect(cloudPanel.getByRole('status').filter({ hasText: 'Key saved.' })).toBeVisible()
    await expect(cloudPanel.getByRole('button', { name: 'Replace key', exact: true })).toBeVisible()
    await readable('after a saved key')
    await openThreads(page)

    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    const workingDirectory = await page.evaluate(async () => {
      const listed = await window.sotto!.browser!.list({ threadId: 'workshop' })
      return listed.ok ? listed.value.workspace.workingDirectory : null
    })
    expect(workingDirectory).not.toBeNull()
    buildFile = join(workingDirectory!, 'Daybook-simulator.zip')
    await writeFile(buildFile, 'a simulator build '.repeat(64))
    const agent = (name: string, args: unknown) => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args })
    const textOf = (result: Awaited<ReturnType<typeof agent>>): string => { const item = result.content.find(entry => entry.type === 'text'); return item?.type === 'text' ? item.text : '' }

    // The agent's request waits in the thread with the build, the price and the month's minutes; nothing is uploaded yet.
    const opening = agent('iphone_cloud_open', { buildPath: 'Daybook-simulator.zip', description: 'Checking the habit list on a native build' })
    const card = page.locator('.agent-request').filter({ hasText: 'wants to start a cloud iPhone' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('Daybook-simulator.zip')
    await expect(card).toContainText('$0.02 a minute')
    expect(fake.assets.size).toBe(0)
    await screenshot(launched, 'request-in-thread')
    await card.getByRole('button', { name: 'Start cloud iPhone' }).click()
    const opened = await opening
    expect(opened.isError).not.toBe(true)

    const phone = page.getByRole('complementary', { name: 'Cloud iPhone for Workshop' })
    await expect(phone).toBeVisible()
    await expect(phone).toContainText('cloud')
    await expect.poll(() => viewerUrls(launched)).toHaveLength(1)
    expect(fake.assets.size).toBe(1)

    // Inside the session the agent's actions run without asking.
    const inspected = await agent('iphone_cloud_action', { action: { type: 'inspect' } })
    expect(inspected.isError).not.toBe(true)
    expect((await agent('iphone_cloud_action', { action: { type: 'tap', x: 120, y: 300 } })).isError).not.toBe(true)
    expect((await agent('iphone_cloud_action', { action: { type: 'type', text: 'Read 20 pages' } })).isError).not.toBe(true)
    expect((await agent('iphone_cloud_action', { action: { type: 'key', key: 'Enter' } })).isError).not.toBe(true)
    const shot = await agent('iphone_cloud_action', { action: { type: 'screenshot' } })
    expect(shot.content.some(item => item.type === 'image')).toBe(true)
    // The typed words never reach the session's steps, only that text was entered.
    expect(textOf(shot)).not.toContain('Read 20 pages')

    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await phone.getByRole('button', { name: 'Show the cloud iPhone in Tools' }).click()
    await expect(panel.getByRole('tab', { name: 'iPhone' })).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByRole('region', { name: 'Cloud iPhone' })).toContainText('Running')

    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        const placed = await phone.boundingBox(); expect(placed).not.toBeNull()
        expect(placed!.x + placed!.width).toBeLessThanOrEqual(width); expect(placed!.y + placed!.height).toBeLessThanOrEqual(height)
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))) })
        await screenshot(launched, `running-${width}x${height}-${mode}`)
      }
    }
    await resize(launched, 1280, 800)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))

    // The agent finishes; the simulator is released and the upload deleted.
    const finished = await agent('iphone_cloud_finish', { status: 'completed', summary: 'Added a habit on the native build.', unchecked: ['Push notifications'] })
    expect(finished.isError).not.toBe(true)
    await expect.poll(() => viewerUrls(launched)).toHaveLength(0)
    expect(fake.assets.size).toBe(0)
    expect([...fake.sessions.values()].every(session => session.status === 'released')).toBe(true)

    // Settings > Cloud iPhone shows the key saved and the session's minutes.
    const status = await page.evaluate(async () => { const result = await window.sotto!.cloudIphone!.status(); return result.ok ? result.value : null })
    expect(status).toMatchObject({ keySaved: true, capMinutes: 750 })
    expect(status!.monthMinutes).toBeGreaterThanOrEqual(1)
    expect(status!.recent[0]).toMatchObject({ threadTitle: 'Workshop' })
    // Settings > Cloud iPhone shows the same, in the user's words.
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Cloud iPhone', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Cloud iPhone', exact: true })).toBeVisible()
    await expect(cloudPanel.getByRole('meter', { name: 'Cloud iPhone minutes used this month' })).toHaveAttribute('aria-valuetext', /^\d+ of 750 minutes$/u)
    // Grouped as Git is, every row the page's usual label on the left and control on the right.
    await expect(cloudPanel.getByRole('heading', { level: 3 })).toHaveText(['run.cloud', 'Spending', 'Recent sessions'])
    await expect(cloudPanel.getByLabel('Key')).toHaveAttribute('placeholder', 'Key saved')
    await expect(cloudPanel.locator('.cloud-iphone-recent li').first()).toContainText('Workshop')
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
        expect(await settingsLayoutProblems(page, 'settings-cloud-iphone', CLOUD_CONTROLS), `${width} ${mode}`).toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
        for (const { text, ratio } of await settingsTextContrast(page, 'settings-cloud-iphone', CLOUD_TEXT)) expect(ratio, `${text} at ${width} ${mode}`).toBeGreaterThanOrEqual(4.5)
        await page.mouse.move(1, 1)
        await page.screenshot({ path: join(SHOTS, `settings-${width}x${height}-${mode}.png`), animations: 'disabled', caret: 'hide' })
        await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
        expect(await settingsLayoutProblems(page, 'settings-cloud-iphone', CLOUD_CONTROLS), `${width} ${mode} bottom`).toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
        if (width === 820) await page.screenshot({ path: join(SHOTS, `settings-${width}x${height}-${mode}-bottom.png`), animations: 'disabled', caret: 'hide' })
      }
    }
    // The keyboard path follows the eye: from the key to its two buttons, then the cap and the idle minutes.
    await resize(launched, 1280, 800)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await cloudPanel.getByLabel('Key').focus()
    const order: string[] = []
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press('Tab')
      order.push(await page.evaluate(() => { const active = document.activeElement as HTMLInputElement; return active.labels?.[0]?.textContent ?? active.textContent?.trim() ?? '' }))
    }
    // Replace key waits for a new key, so it is disabled and out of the path until one is typed.
    expect(order).toEqual(['Remove key', 'Monthly cap', 'Idle sessions end after'])
    // Reduced motion: the page arrives without moving, and nothing on it animates.
    const sections = page.getByRole('tablist', { name: 'Settings sections' })
    const arrivals = async (): Promise<string[]> => cloudPanel.evaluate(panel => [getComputedStyle(panel).animationName,
      ...document.getAnimations().filter(animation => animation.effect instanceof KeyframeEffect && animation.effect.target instanceof Node && panel.contains(animation.effect.target)).map(animation => animation.playState)])
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))
    await expect(page.locator('html')).not.toHaveAttribute('data-reduced-motion', 'on')
    // Unless the computer itself asks for less motion, the page arrives as every Settings page does.
    if (!await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      await sections.getByRole('tab', { name: 'Hosts & phones', exact: true }).click()
      await sections.getByRole('tab', { name: 'Cloud iPhone', exact: true }).click()
      expect((await arrivals())[0]).toBe('settings-arrive')
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await sections.getByRole('tab', { name: 'Hosts & phones', exact: true }).click()
    await sections.getByRole('tab', { name: 'Cloud iPhone', exact: true }).click()
    expect(await arrivals()).toEqual(['none'])
    expect(await settingsLayoutProblems(page, 'settings-cloud-iphone', CLOUD_CONTROLS), 'reduced motion').toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
    await fake.close()
    if (buildFile) await rm(buildFile, { force: true })
    if (previous === undefined) delete process.env.SOTTO_RUN_CLOUD_API_URL
    else process.env.SOTTO_RUN_CLOUD_API_URL = previous
  }
})
