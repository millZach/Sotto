import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { BrowserTask } from '../../src/shared/browser'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

const SHOTS = resolve('artifacts/agent-browser')
const GRANT_SHOTS = resolve('artifacts/browser-grant')
const CONTENT = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fieldnotes</title><style>*{box-sizing:border-box}body{margin:0;background:#f3f1e8;color:#273e34;font:16px system-ui}header{padding:20px 24px;border-bottom:1px solid #ced8c9}main{padding:24px;max-width:660px}h1{font-size:40px;font-weight:500;letter-spacing:-.04em;margin:10px 0}p{line-height:1.6;color:#546850}.landscape{height:120px;background:linear-gradient(150deg,#dbe0d0 35%,#a7b8a0 35%,#a7b8a0 57%,#688a73 57%,#688a73 76%,#294b3e 76%);margin:20px 0}button{background:#304f3d;color:white;border:0;border-radius:5px;padding:12px 18px;font:inherit}#saved{min-height:28px}</style></head><body><header>Fieldnotes</header><main><h1>Take the long way home.</h1><p>A place to save the trails you want to return to.</p><div class="landscape"></div><button id="save" onclick="document.querySelector('#saved').textContent='Trail saved';localStorage.setItem('saved','yes')">Save trail</button><p id="saved" role="status"></p></main></body></html>`
async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    host.setMinimumSize(800, 540); host.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}
async function screenshot(launched: LaunchedSotto, name: string, native: boolean): Promise<void> {
  if (!native) { await launched.page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' }); return }
  const title = `Sotto browser review ${name}`
  await launched.app.evaluate(({ BrowserWindow }, title) => {
    const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!; host.setTitle(title); host.show()
  }, title)
  const png = await launched.app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, title) => {
    const bounds = BrowserWindow.getAllWindows().find(item => item.getTitle() === title)!.getBounds()
    const scale = screen.getDisplayMatching(bounds).scaleFactor
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) } })
    const source = sources.find(item => item.name === title)
    if (!source) throw new Error('Native window capture unavailable')
    return source.thumbnail.toPNG().toString('base64')
  }, title)
  await writeFile(join(SHOTS, `${name}.png`), Buffer.from(png, 'base64'))
}

test('agents and users share the real browser page, permissions, feedback and visible checks', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(CONTENT) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Preview server unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launchSotto().catch(error => { server.close(); throw error })
  const { page } = launched
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const report: Record<string, unknown> = {}
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await resize(launched, 1280, 800); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    const agent = (name: string, args: unknown) => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args })
    const tasks = () => page.evaluate(async () => { const result = await window.sotto!.browser!.tasks({ threadId: 'workshop' }); return result.ok ? result.value : [] })
    const opening = agent('browser_open', { url, description: 'Checking that a trail can be saved' })
    const preview = page.getByRole('complementary', { name: 'Browser preview for Workshop' })
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: /Open browser task/ }).click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await expect(panel.getByText(`Open and share this page with the thread: ${url}`, { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Allow once' }).click()
    const opened = await opening
    expect(opened.isError).not.toBe(true)
    await expect(panel.getByRole('tab', { name: 'Fieldnotes' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Stop sharing' })).toBeVisible()
    const task = (await tasks())[0] as BrowserTask
    const target = { taskId: task.id, pageId: task.pageId }
    const action = (action: unknown) => agent('browser_action', { ...target, action })
    const shot = await action({ type: 'screenshot' }); expect(shot.content.some(item => item.type === 'image')).toBe(true)
    await panel.getByRole('button', { name: 'Close tools panel' }).click()
    await expect(preview.locator('img')).toBeVisible()
    const beforeHiddenCapture = await launched.app.evaluate(({ BaseWindow, BrowserWindow }) => ({ windows: BaseWindow.getAllWindows().length, focused: BrowserWindow.getFocusedWindow()?.id ?? null }))
    expect((await action({ type: 'screenshot' })).content.some(item => item.type === 'image')).toBe(true)
    expect(await launched.app.evaluate(({ BaseWindow, BrowserWindow }) => ({ windows: BaseWindow.getAllWindows().length, focused: BrowserWindow.getFocusedWindow()?.id ?? null }))).toEqual(beforeHiddenCapture)

    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await resize(launched, width!, height!)
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        const box = await preview.boundingBox(); expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width!); expect(box!.y + box!.height).toBeLessThan(height!)
        const contrast = await preview.evaluate(element => {
          const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
          const context = canvas.getContext('2d')!
          const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--tt-canvas)'; document.body.append(probe)
          const room = getComputedStyle(probe).backgroundColor; probe.remove()
          const luminance = (data: Uint8ClampedArray) => [...data].slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
          return ['.browser-corner__head > span', '.browser-corner__action > span', '.browser-corner__foot > span'].map(selector => {
            context.fillStyle = room; context.fillRect(0, 0, 1, 1)
            context.fillStyle = getComputedStyle(element).backgroundColor; context.fillRect(0, 0, 1, 1)
            const background = luminance(context.getImageData(0, 0, 1, 1).data)
            context.fillStyle = getComputedStyle(element.querySelector(selector)!).color; context.fillRect(0, 0, 1, 1)
            const foreground = luminance(context.getImageData(0, 0, 1, 1).data)
            return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05)
          })
        })
        contrast.forEach(ratio => expect(ratio).toBeGreaterThanOrEqual(4.5))
        const key = `${width}x${height}-${mode}`
        await screenshot(launched, `corner-${key}`, false)
        await preview.getByRole('button', { name: /Open browser task/ }).click()
        await expect(panel.locator('.browser-viewport')).toBeVisible()
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))) })
        const expectedBounds = await panel.locator('.browser-viewport').evaluate(element => { const rect = element.getBoundingClientRect(); const x = Math.round(rect.left), y = Math.round(rect.top); return { x, y, width: Math.round(rect.right) - x, height: Math.round(rect.bottom) - y } })
        expect(expectedBounds.height).toBeGreaterThan(100)
        await expect.poll(() => launched.app.evaluate(({ BrowserWindow, WebContentsView }) => {
          const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
          return host.contentView.children.filter(view => view instanceof WebContentsView).map(view => ({ url: (view as Electron.WebContentsView).webContents.getURL(), bounds: view.getBounds() }))
        })).toEqual([{ url, bounds: expectedBounds }])
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await screenshot(launched, `tools-${key}`, true)
        report[key] = { preview: box, contrast, viewport: await panel.locator('.browser-viewport').boundingBox() }
        await panel.getByRole('button', { name: 'Close tools panel' }).click()
      }
    }
    await resize(launched, 1280, 800)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', reducedMotion: 'on' }))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => preview.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    await preview.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(preview.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
    expect((await action({ type: 'inspect' })).isError).toBe(true)
    await preview.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(preview.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await preview.getByRole('button', { name: 'Dismiss browser preview' }).click()
    await expect(preview).toBeHidden(); expect((await tasks())[0]?.status).toBe('working')
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await panel.getByRole('combobox', { name: 'Browser viewport size' }).selectOption('390x844')
    const emulated = await launched.app.evaluate(async ({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL() === url)!.executeJavaScript('({width:innerWidth,height:innerHeight})'), url)
    expect(emulated).toEqual({ width: 390, height: 844 })
    const viewportCapture = await page.evaluate(async task => window.sotto!.browser!.capture({ threadId: task.threadId, workspaceId: task.workspaceId, pageId: task.pageId }), task)
    expect(viewportCapture.ok).toBe(true)
    if (viewportCapture.ok) {
      expect({ width: viewportCapture.value.width, height: viewportCapture.value.height }).toEqual({ width: 390, height: 844 })
      const dimensions = await page.evaluate(async source => { const image = new Image(); image.src = source; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight } }, viewportCapture.value.image)
      expect(dimensions).toEqual({ width: 390, height: 844 })
    }
    await action({ type: 'screenshot' })
    await panel.getByRole('combobox', { name: 'Browser viewport size' }).selectOption('fit')
    const inspect = await action({ type: 'inspect' })
    const text = inspect.content.find(item => item.type === 'text'); if (!text || text.type !== 'text') throw new Error('Inspection missing')
    const observation = JSON.parse(JSON.parse(text.text).output) as { elements: { tag: string; name: string; x: number; y: number; width: number; height: number }[] }
    const save = observation.elements.find(item => item.tag === 'button' && item.name === 'Save trail')!
    const click = action({ type: 'click', x: save.x + save.width / 2, y: save.y + save.height / 2 })
    await expect(panel.getByRole('group', { name: 'Browser action permission' })).toBeVisible()
    await panel.getByRole('button', { name: 'Allow once' }).click()
    expect((await click).isError).not.toBe(true)
    await expect.poll(() => launched.app.evaluate(async ({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL() === url)!.executeJavaScript("document.querySelector('#saved').textContent"), url)).toBe('Trail saved')
    await action({ type: 'screenshot' })
    await panel.getByRole('button', { name: 'Comment on page' }).click()
    const feedback = panel.getByRole('region', { name: 'Browser feedback' })
    await expect(feedback).toBeVisible()
    await screenshot(launched, 'page-feedback', false)
    const selection = feedback.getByRole('button', { name: /Select page element/ })
    await selection.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter')
    await feedback.getByRole('textbox', { name: 'Browser feedback comment' }).fill('Give the saved trail message more space.')
    await feedback.getByRole('button', { name: 'Add to draft' }).click()
    await expect(feedback).toBeHidden()
    await expect.poll(() => page.evaluate(async () => { const state = await window.sotto!.agents!.get(); return state.threadDrafts?.find(item => item.threadId === 'workshop')?.text ?? '' })).toContain('Give the saved trail message more space.')
    const draft = await page.evaluate(async () => { const state = await window.sotto!.agents!.get(); return state.threadDrafts?.find(item => item.threadId === 'workshop') })
    expect(draft?.attachments).toHaveLength(1)
    const finish = await agent('browser_finish', { ...target, status: 'completed', summary: 'Saved the trail and checked the confirmation.', unchecked: ['Reload persistence'] })
    expect(finish.isError).not.toBe(true)
    await expect(panel.getByText('Saved the trail and checked the confirmation.', { exact: true })).toBeVisible()
    await panel.locator('.browser-task__evidence summary').click()
    await expect(panel.getByText('Not checked: Reload persistence', { exact: true })).toBeVisible()
    await screenshot(launched, 'completed-check', true)
    const second = await agent('browser_start', { pageId: task.pageId, description: 'Check for a missing search field' })
    expect(second.isError).not.toBe(true)
    const nextTask = (await tasks()).find(item => item.id !== task.id)!
    const checked = await agent('browser_action', { pageId: task.pageId, taskId: nextTask.id, action: { type: 'inspect' } })
    expect(checked.isError).not.toBe(true)
    await agent('browser_finish', { pageId: task.pageId, taskId: nextTask.id, status: 'failed', summary: 'The search field is missing.', unchecked: ['Search submission'] })
    await expect(panel.getByText('The search field is missing.', { exact: true })).toBeVisible()
    await screenshot(launched, 'failed-check', true)
    await panel.getByRole('combobox', { name: 'Browser check' }).selectOption(task.id)
    await expect(panel.getByText('Saved the trail and checked the confirmation.', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(panel.getByRole('button', { name: 'Share with agent' })).toBeVisible()
    expect((await tasks())[0]?.thumbnail).toBeNull()
    expect(errors).toEqual([])
    await writeFile(join(SHOTS, 'verification.json'), JSON.stringify({ sizes: report, errors, draftAdded: true, permissionClickExecuted: true, sharedPage: task.pageId }, null, 2))
  } catch (error) {
    await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => undefined)
    console.error(await page.locator('body').innerText().catch(() => 'No renderer'))
    throw error
  } finally { await closeSotto(launched); await new Promise<void>(done => server.close(() => done())) }
})

test('a thread the user lets open pages opens them without asking, previews follow the focused thread, and previews can be turned off', async () => {
  test.setTimeout(240_000)
  await mkdir(GRANT_SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(CONTENT) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Preview server unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launchSotto().catch(error => { server.close(); throw error })
  const { page } = launched
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const shot = (name: string) => page.screenshot({ path: join(GRANT_SHOTS, `${name}.png`), animations: 'disabled' })
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await resize(launched, 1280, 800); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    const agent = (threadId: string, name: string, args: unknown) => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId, name, arguments: args })
    const tasks = (threadId: string) => page.evaluate(async threadId => { const result = await window.sotto!.browser!.tasks({ threadId }); return result.ok ? result.value : [] }, threadId)
    const deny = (threadId: string) => page.evaluate(async threadId => {
      const listed = await window.sotto!.browser!.tasks({ threadId })
      const task = listed.ok ? listed.value.find(item => item.pendingAction) : undefined
      if (!task) throw new Error('No waiting request')
      await window.sotto!.browser!.answerAction({ threadId, workspaceId: task.workspaceId, pageId: task.pageId, taskId: task.id, actionId: task.pendingAction!.id, allow: false })
    }, threadId)
    const waitingOn = async (threadId: string) => expect.poll(async () => (await tasks(threadId)).some(task => task.pendingAction !== null)).toBe(true)
    const body = (result: { content: { type: string }[] }) => JSON.parse((result.content[0] as unknown as { text: string }).text) as { approvalRequired: boolean; task: { id: string; pageId: string; pendingAction: unknown } }
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    const workshopPreview = page.getByRole('complementary', { name: 'Browser preview for Workshop' })
    const docsPreview = page.getByRole('complementary', { name: 'Browser preview for Docs' })
    const grantLine = panel.getByText('This thread may open pages without asking', { exact: true })
    const request = panel.getByRole('group', { name: 'Browser action permission' })

    // The first open asks, and the request card offers the thread-wide answer.
    const opening = agent('workshop', 'browser_open', { url, description: 'Checking the trail list' })
    await expect(workshopPreview).toBeVisible()
    await workshopPreview.getByRole('button', { name: /Open browser task/ }).click()
    await expect(request.getByRole('button')).toHaveText(['Allow once', 'Allow this thread to open pages', 'Deny'])
    await shot('request-card')
    // At the minimum window, in light, the three answers wrap inside the panel rather than clipping.
    await resize(launched, 820, 560)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    const panelBox = (await panel.boundingBox())!
    for (const button of await request.getByRole('button').all()) {
      const box = (await button.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await shot('request-card-820x560-light')
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resize(launched, 1280, 800)
    await request.getByRole('button', { name: 'Allow this thread to open pages' }).click()
    const opened = await opening
    expect(opened.isError).not.toBe(true)
    const firstTask = body(opened).task
    await expect(grantLine).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Stop sharing' })).toBeVisible()
    await shot('grant-line')
    await resize(launched, 820, 560)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(grantLine).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await shot('grant-line-820x560-light')
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resize(launched, 1280, 800)

    // Later opens and navigations run without asking; clicks still ask, with no thread-wide answer.
    const second = await agent('workshop', 'browser_open', { url: `${url}saved`, description: 'Checking saved trails' })
    expect(second.isError).not.toBe(true)
    const secondTask = body(second)
    expect(secondTask).toMatchObject({ approvalRequired: false, task: { pendingAction: null } })
    await expect(panel.getByRole('tab', { name: /Fieldnotes/ })).toHaveCount(2)
    const moved = await agent('workshop', 'browser_action', { pageId: secondTask.task.pageId, taskId: secondTask.task.id, action: { type: 'navigate', url: `${url}saved?sort=recent` } })
    expect(body(moved)).toMatchObject({ approvalRequired: false })
    // A click is requested against the settled page on show; a page still loading refuses it as changed.
    await expect.poll(() => page.evaluate(async pageId => {
      const listed = await window.sotto!.browser!.list({ threadId: 'workshop' })
      const shown = listed.ok ? listed.value.pages.find(item => item.id === pageId) : undefined
      return shown ? `${shown.status} ${shown.url}` : 'missing'
    }, secondTask.task.pageId)).toBe(`ready ${url}saved?sort=recent`)
    await expect(panel.locator('.browser-viewport')).toBeVisible()
    let clicked: Awaited<ReturnType<typeof agent>> | undefined
    const click = agent('workshop', 'browser_action', { pageId: firstTask.pageId, taskId: firstTask.id, action: { type: 'click', x: 40, y: 40 } }).then(result => { clicked = result; return result })
    await expect.poll(async () => clicked ? `returned early: ${JSON.stringify(clicked.content[0])}` : (await tasks('workshop')).some(task => task.pendingAction !== null)).toBe(true)
    await panel.getByRole('tab', { name: /waiting for your answer/ }).click()
    await expect(request.getByRole('button')).toHaveText(['Allow once', 'Deny'])
    await request.getByRole('button', { name: 'Deny' }).click()
    await click

    // Stop ends it; the next open asks again.
    await panel.getByRole('button', { name: 'Stop letting this thread open pages without asking' }).click()
    await expect(grantLine).toBeHidden()
    await expect(panel.getByRole('textbox', { name: 'Address' })).toBeFocused()
    const asksAgain = agent('workshop', 'browser_open', { url: `${url}again`, description: 'Checking again' })
    await waitingOn('workshop')
    await deny('workshop'); await asksAgain

    // Another thread's task never takes the focused thread's corner.
    await panel.getByRole('button', { name: 'Close tools panel' }).click()
    await expect(workshopPreview).toBeVisible()
    const docs = agent('docs', 'browser_open', { url, description: 'Checking the docs page' })
    await waitingOn('docs')
    await expect(docsPreview).toBeHidden()
    await expect(workshopPreview).toBeVisible()
    await shot('focused-thread-preview')
    await deny('docs'); await docs

    // The switch: no preview anywhere, and the work still shows in Tools > Browser.
    await page.getByRole('link', { name: 'Settings' }).click()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Application', exact: true }).click()
    const toggle = page.getByRole('switch', { name: 'Show browser previews' })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).showBrowserPreviews)).toBe(false)
    await toggle.scrollIntoViewIfNeeded()
    await shot('settings-switch')
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await expect(workshopPreview).toBeHidden()
    const quiet = agent('workshop', 'browser_open', { url: `${url}quiet`, description: 'Checking with previews off' })
    await waitingOn('workshop')
    await expect(workshopPreview).toBeHidden()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await panel.getByRole('tab', { name: /waiting for your answer/ }).click()
    await expect(panel.getByText(`Open and share this page with the thread: ${url}quiet`, { exact: true })).toBeVisible()
    await shot('previews-off-tools')
    await request.getByRole('button', { name: 'Deny' }).click()
    await quiet
    expect(errors).toEqual([])
    await writeFile(join(GRANT_SHOTS, 'verification.json'), JSON.stringify({ grantedOpenWithoutAsking: true, navigateWithoutAsking: true, clickStillAsked: true, stopAskedAgain: true, otherThreadPreviewHidden: true, previewsOffHidden: true, errors }, null, 2))
  } catch (error) {
    await page.screenshot({ path: join(GRANT_SHOTS, 'failure.png') }).catch(() => undefined)
    console.error(await page.locator('body').innerText().catch(() => 'No renderer'))
    throw error
  } finally { await closeSotto(launched); await new Promise<void>(done => server.close(() => done())) }
})
