import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { start as startFakeRunCloud } from '../fixtures/fakeRunCloud.mjs'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const SHOTS = evidenceDirectory('artifacts/cloud-iphone')

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    host.setMinimumSize(800, 540); host.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}
/** The window as the user sees it, native views included. */
async function screenshot(launched: LaunchedSotto, name: string): Promise<void> {
  const title = `Sotto cloud iPhone ${name}`
  await launched.app.evaluate(({ BrowserWindow }, title) => {
    const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!; host.setTitle(title); host.show()
  }, title)
  const png = await launched.app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, title) => {
    const bounds = BrowserWindow.getAllWindows().find(item => item.getTitle() === title)!.getBounds()
    const scale = screen.getDisplayMatching(bounds).scaleFactor
    // The OS window manager can be slow to register the retitled window under load; a reached deadline costs nothing.
    for (let attempt = 0; ; attempt++) {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) } })
      const source = sources.find(item => item.name === title)
      if (source) return source.thumbnail.toPNG().toString('base64')
      if (attempt >= 9) throw new Error('Native window capture unavailable')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }, title)
  await writeFile(join(SHOTS, `${name}.png`), Buffer.from(png, 'base64'))
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
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await resize(launched, 1280, 800); await openThreads(page)

    // Settings > Cloud iPhone: a wrong key is not saved; the fake's key is.
    const saved = await page.evaluate(async key => {
      const bridge = window.sotto!.cloudIphone!
      const wrong = await bridge.setKey({ value: 'rc_live_wrong' })
      const right = await bridge.setKey({ value: key })
      return { wrong: wrong.ok && wrong.value, right: right.ok && right.value }
    }, fake.key)
    expect(saved.wrong).toMatchObject({ saved: false })
    expect(saved.right).toEqual({ saved: true, problem: null })

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
    await expect(page.getByRole('meter', { name: /minutes/u }).first()).toBeVisible()
    for (const mode of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
      await page.screenshot({ path: join(SHOTS, `settings-${mode}.png`), animations: 'disabled' })
    }
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
    await fake.close()
    if (buildFile) await rm(buildFile, { force: true })
    if (previous === undefined) delete process.env.SOTTO_RUN_CLOUD_API_URL
    else process.env.SOTTO_RUN_CLOUD_API_URL = previous
  }
})
