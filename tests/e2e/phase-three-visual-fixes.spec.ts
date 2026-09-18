import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// Two visual review findings in the complete app: the native browser page beside a minimized theme editor, and a personal
// message Codex did not take. AppShell, renderer, preload, IPC, the theme editor and the production browser and personal
// chat services are real. Coding providers and the personal Codex connection are the unpackaged E2E fixtures; no native
// account or installed client runs. Profiles, working copies and the local page are owned temporaries.
// Page captures omit the native WebContentsView, so every image here is the composed window from desktopCapturer.

const SHOTS = resolve(process.cwd(), 'artifacts/phase-three-visual-fixes')
type Mode = 'dark' | 'light'
type Box = { x: number; y: number; width: number; height: number }

async function ownedProfile(prefix: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', accent: 'blue' }))
  return profile
}

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

async function appearance(page: Page, mode: Mode): Promise<void> {
  await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
}

/** The window as it is on screen, native page included. */
async function composed(launched: LaunchedSotto, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  const title = `Sotto visual fixes ${name}`
  await launched.app.evaluate(({ BrowserWindow }, title) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    window.setTitle(title)
    window.show()
  }, title)
  await new Promise(done => setTimeout(done, 700))
  const png = await launched.app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, title) => {
    const bounds = BrowserWindow.getAllWindows().find(candidate => candidate.getTitle() === title)!.getBounds()
    const scale = screen.getDisplayMatching(bounds).scaleFactor
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) } })
    const source = sources.find(candidate => candidate.name === title)
    if (!source) throw new Error(`No window capture named ${title}`)
    return source.thumbnail.toPNG().toString('base64')
  }, title)
  await writeFile(join(SHOTS, `${name}.png`), Buffer.from(png, 'base64'))
}

async function hostViews(app: ElectronApplication): Promise<{ url: string; id: number; bounds: Electron.Rectangle }[]> {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    return host.contentView.children.filter(view => view instanceof WebContentsView)
      .map(view => ({ url: (view as Electron.WebContentsView).webContents.getURL(), id: (view as Electron.WebContentsView).webContents.id, bounds: view.getBounds() }))
  })
}

async function box(locator: Locator): Promise<Box> {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  })
}

const nativeBounds = (rect: Box): Box => {
  const x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y))
  return { x, y, width: Math.round(rect.x + rect.width) - x, height: Math.round(rect.y + rect.height) - y }
}
const intersects = (a: Box, b: Box): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

test('shows the live page beside a minimized theme editor, and steps aside under it or while it is expanded', async () => {
  test.setTimeout(240_000)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Atlas preview</title><body style="margin:0;font:600 22px system-ui;background:#1f6feb;color:white;display:grid;place-content:center;gap:16px;height:100vh">Atlas local app<input aria-label="Note" style="font:16px system-ui;padding:6px"></body>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The local page has no port.')
  const url = `http://127.0.0.1:${address.port}/`

  const launched = await launchSotto('success', await ownedProfile('sotto-e2e-phase3-visual-fixes-browser-'))
  const { app, page } = launched
  try {
    const folder = await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      const state = await agents.command({ type: 'connect' })
      const thread = state.host.threads.find(item => item.id === 'workshop')!
      return state.host.projects.find(project => project.id === thread.projectId)!.path
    })
    expect(folder.startsWith(launched.userData)).toBe(true)
    await mkdir(folder, { recursive: true })
    // Anything that would open outside Sotto is recorded instead of launched.
    const watchingExternal = await app.evaluate(({ shell }) => {
      const record = globalThis as unknown as { externalOpens: string[] }
      record.externalOpens = []
      try { shell.openExternal = async (target: string) => { record.externalOpens.push(target) }; return true } catch { return false }
    })
    const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

    await resize(launched, 820, 560)
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools' })
    await panel.getByRole('tab', { name: 'Browser' }).click()
    const addressBar = panel.getByRole('textbox', { name: 'Address for a new page' })
    await addressBar.fill(`127.0.0.1:${address.port}`)
    await addressBar.press('Enter')
    await expect(panel.getByRole('tab', { name: /Atlas preview/u })).toBeVisible()
    await expect.poll(async () => (await hostViews(app)).length).toBe(1)
    const [original] = await hostViews(app)
    expect(original!.url).toBe(url)
    // State only this live page holds: a typed note and the moment it loaded.
    const pageState = () => app.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('({ note: document.querySelector("input").value, born: performance.timeOrigin, url: location.href })'), original!.id)
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('document.querySelector("input").value = "Kept while the editor moves"'), original!.id)
    const before = await pageState()
    expect(before.note).toBe('Kept while the editor moves')

    const editor = page.getByRole('dialog', { name: 'Create theme' })
    const viewportLocator = panel.locator('.browser-viewport')
    const openMinimizedEditor = async (): Promise<void> => {
      // At the minimum width an open Tools panel has the sidebar's place, and with it the page links: Tools steps
      // aside for the trip to Settings and comes back with the editor.
      const toolsHidSidebar = !(await page.locator('.thread-nav').isVisible())
      if (toolsHidSidebar) await page.getByRole('button', { name: 'Tools', exact: true }).click()
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
      await page.getByRole('button', { name: 'Create theme', exact: true }).click()
      await expect(editor).toBeVisible()
      await openThreads(page)
      if (toolsHidSidebar) await page.getByRole('button', { name: 'Tools', exact: true }).click()
      await expect(viewportLocator).toBeVisible()
      // Expanded, the editor sends the page aside as any dialog does.
      await expect.poll(async () => (await hostViews(app)).length).toBe(0)
      await editor.getByRole('button', { name: 'Minimize the theme editor' }).click()
      await expect(editor).toHaveAttribute('data-minimized', 'true')
    }
    await openMinimizedEditor()

    const header = editor.locator('.theme-editor__header h2')
    const dragBarTo = async (x: number, y: number, samples?: () => Promise<void>): Promise<void> => {
      const bar = await box(editor)
      const grip = await box(header)
      const start = { x: grip.x + 12, y: grip.y + grip.height / 2 }
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      for (let step = 1; step <= 12; step++) {
        await page.mouse.move(start.x + (x - bar.x) * step / 12, start.y + (y - bar.y) * step / 12)
        await samples?.()
      }
      await page.mouse.up()
    }
    /** Where the bar sits wholly beside the page: left of the viewport, else above it. */
    const clearSpot = async (): Promise<{ x: number; y: number }> => {
      const bar = await box(editor), viewport = nativeBounds(await box(viewportLocator))
      const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      const left = viewport.x - bar.width - 16
      if (left >= 8) return { x: left, y: Math.min(Math.max(8, viewport.y + 60), size.height - bar.height - 8) }
      if (viewport.y - bar.height - 16 >= 8) return { x: 8, y: viewport.y - bar.height - 16 }
      throw new Error(`No spot beside the page for the bar at ${size.width}x${size.height}: ${JSON.stringify({ bar, viewport })}`)
    }
    /** The page shows exactly when the bar is clear of it, and main draws it at the viewport. */
    const expectPageFollowsBar = async (): Promise<boolean> => {
      await expect.poll(async () => {
        const bar = await box(editor), viewport = nativeBounds(await box(viewportLocator))
        const views = await hostViews(app)
        return intersects(bar, viewport) ? views.length === 0 : views.length === 1 && JSON.stringify(views[0]!.bounds) === JSON.stringify(viewport)
      }).toBe(true)
      return intersects(await box(editor), nativeBounds(await box(viewportLocator)))
    }

    // Its resting spot is the theme owner's choice, so only the rule is checked there.
    const restingOverlaps = await expectPageFollowsBar()
    const resting = await box(editor)
    await composed(launched, 'editor-minimized-resting-820x560-dark')

    // Beside the page: the page is back and live, and stays attached while the bar moves within the clear area.
    const spot = await clearSpot()
    await dragBarTo(spot.x, spot.y)
    expect(await expectPageFollowsBar()).toBe(false)
    const wiggle: number[] = []
    const clear = await box(editor)
    await dragBarTo(clear.x, Math.max(8, clear.y - 24), async () => { wiggle.push((await hostViews(app)).length) })
    expect(await expectPageFollowsBar()).toBe(false)
    expect(wiggle.every(count => count === 1)).toBe(true)
    const stillFor = []
    for (let sample = 0; sample < 6; sample++) { stillFor.push(JSON.stringify(await hostViews(app))); await new Promise(done => setTimeout(done, 100)) }
    expect(new Set(stillFor).size).toBe(1)
    await composed(launched, 'editor-minimized-beside-page-820x560-dark')

    // Dragged over the page: the page steps aside, so nothing native is drawn over the bar.
    const viewport = nativeBounds(await box(viewportLocator))
    const bar = await box(editor)
    await dragBarTo(Math.max(8, viewport.x + (viewport.width - bar.width) / 2), viewport.y + viewport.height / 2 - bar.height / 2)
    expect(await expectPageFollowsBar()).toBe(true)
    await expect(panel.getByText('The page steps aside while a menu or dialog is open.')).toBeVisible()
    await composed(launched, 'editor-minimized-over-page-820x560-dark')

    // Back beside it, then expanded there: expanded covers regardless of where it was.
    const again = await clearSpot()
    await dragBarTo(again.x, again.y)
    expect(await expectPageFollowsBar()).toBe(false)
    await editor.getByRole('button', { name: 'Expand the theme editor' }).click()
    await expect.poll(async () => (await hostViews(app)).length).toBe(0)
    await composed(launched, 'editor-expanded-820x560-dark')
    await editor.getByRole('button', { name: 'Minimize the theme editor' }).click()
    expect(await expectPageFollowsBar()).toBe(false)

    // A wider window moves the page; the rule holds for wherever the bar and page now are.
    await resize(launched, 1280, 860)
    const wideOverlaps = await expectPageFollowsBar()
    if (wideOverlaps) { const wide = await clearSpot(); await dragBarTo(wide.x, wide.y); expect(await expectPageFollowsBar()).toBe(false) }
    await composed(launched, 'editor-minimized-beside-page-1280-dark')
    const closeEditor = async (): Promise<void> => {
      await editor.getByRole('button', { name: 'Close the theme editor' }).click()
      await expect(editor).toHaveCount(0)
      await expect.poll(async () => (await hostViews(app)).length).toBe(1)
    }
    await closeEditor()

    // Light: the open editor previews its own draft, so the mode is chosen before the editor opens.
    for (const [width, height, name] of [[1280, 860, '1280'], [820, 560, '820x560']] as const) {
      await resize(launched, width, height)
      await appearance(page, 'light')
      await openMinimizedEditor()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      if (await expectPageFollowsBar()) { const light = await clearSpot(); await dragBarTo(light.x, light.y); expect(await expectPageFollowsBar()).toBe(false) }
      await composed(launched, `editor-minimized-beside-page-${name}-light`)
      if (name === '820x560') {
        const page820 = nativeBounds(await box(viewportLocator)), bar820 = await box(editor)
        await dragBarTo(Math.max(8, page820.x + (page820.width - bar820.width) / 2), page820.y + page820.height / 2 - bar820.height / 2)
        expect(await expectPageFollowsBar()).toBe(true)
        await composed(launched, 'editor-minimized-over-page-820x560-light')
      }
      await closeEditor()
      await appearance(page, 'dark')
    }

    // The same live page throughout: same contents, same load, same note, no new window and nothing opened outside.
    const [after] = await hostViews(app)
    expect(after!.id).toBe(original!.id)
    expect(await pageState()).toEqual(before)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowsBefore)
    if (watchingExternal) expect(await app.evaluate(() => (globalThis as unknown as { externalOpens: string[] }).externalOpens)).toEqual([])
    test.info().annotations.push({ type: 'geometry', description: JSON.stringify({ resting, restingOverlaps, wideOverlaps, watchingExternal }) })
  } finally {
    await closeSotto(launched)
    await rm(launched.userData, { recursive: true, force: true }).catch(() => undefined)
    await new Promise(done => server.close(done))
  }
})

test('keeps a failed personal message and Edit in composer ahead of a long diagnostic, which stays under Details', async () => {
  test.setTimeout(180_000)
  const profile = await ownedProfile('sotto-e2e-phase3-visual-fixes-chat-')
  const launched = await launchSotto('success', profile)
  const { page } = launched
  const diagnostic = String.raw`Codex App Server turn/start failed: EPERM: operation not permitted, open 'C:\Users\reader\AppData\Roaming\Sotto\personal-chats\codex-home\sessions\2026\09\13\rollout-2026-09-13T14-10-00-019a4c1e-7d2b-7c11-9d4e-51f0f5c7b2aa.jsonl.tmp-4812-1757790000000'`
  try {
    await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: 'low' } })
    })
    await resize(launched, 1280, 860)
    await page.getByRole('link', { name: 'Chats', exact: true }).click()
    await page.getByRole('region', { name: 'Chat' }).getByRole('button', { name: 'New chat' }).click()
    const composer = page.getByRole('textbox', { name: 'Message' })
    await expect(composer).toBeFocused()
    await page.keyboard.type('Plan a quiet weekend near the coast')
    await page.keyboard.press('Enter')
    const transcript = page.getByLabel('Chat transcript', { exact: true })
    await expect(transcript.getByRole('heading', { name: 'A saved conversation' })).toBeVisible()

    // The fixture refuses the next native send with the long diagnostic, after the service has saved the submission.
    await page.evaluate(async text => {
      const chatId = (await window.sotto!.personalChats!.get()).chats[0]!.id
      await window.sottoE2E!.agentEvent!({ scope: 'personal', type: 'reject', threadId: chatId, text })
    }, diagnostic)
    await page.keyboard.type('Book the ferry with $brai')
    await expect(page.getByRole('listbox', { name: 'Skills' }).getByRole('option')).toContainText('$brainstorm')
    await page.keyboard.press('Enter')
    await page.keyboard.type('for Saturday')
    const original = 'Book the ferry with $brainstorm for Saturday'
    await expect(composer).toHaveValue(original)
    await page.keyboard.press('Enter')
    await expect(composer).toHaveValue('')
    const pending = transcript.getByRole('article', { name: 'Pending message' })
    await expect(pending.locator('.thread-message__status')).toHaveText('Not sent', { timeout: 15_000 })
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.personalChats!.get()).chats[0]!.submissions.at(-1)!.error)).toBe(diagnostic)
    await page.keyboard.type('Also check the weather')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.personalChats!.get()).chats[0]!.draft.text)).toBe('Also check the weather')

    const reason = pending.getByText('Codex did not take this message.', { exact: true })
    const edit = pending.getByRole('button', { name: 'Edit in composer' })
    const summary = pending.locator('summary', { hasText: 'Details' })
    const raw = pending.locator('.personal-chat__diagnostic pre')
    await expect(reason).toBeVisible()
    await expect(raw).toBeHidden()
    await composed(launched, 'chat-not-sent-1280-dark')

    await resize(launched, 820, 560)
    for (const mode of ['dark', 'light'] as const) {
      await appearance(page, mode)
      await transcript.evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect(pending.getByText(original)).toBeInViewport()
      await expect(pending.locator('.thread-message__status')).toBeInViewport()
      await expect(reason).toBeInViewport()
      await expect(edit).toBeInViewport()
      await composed(launched, `chat-not-sent-820x560-${mode}`)
    }
    await appearance(page, 'dark')

    // Keyboard: Details follows Edit in composer, opens with Enter, and holds the whole diagnostic as selectable text.
    await edit.focus()
    await page.keyboard.press('Tab')
    await expect(summary).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(pending.locator('details')).toHaveAttribute('open', '')
    await expect(raw).toBeVisible()
    await expect(raw).toHaveText(diagnostic)
    expect(await raw.evaluate(element => getComputedStyle(element).userSelect)).not.toBe('none')
    expect(await pending.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
    await expect(summary).toBeInViewport()
    await expect(edit).toBeInViewport()
    await composed(launched, 'chat-not-sent-details-820x560-dark')
    await appearance(page, 'light')
    await composed(launched, 'chat-not-sent-details-820x560-light')
    await appearance(page, 'dark')

    // Opening Details sent nothing; Edit in composer adds the message and its skill after the newer draft, still unsent.
    await page.keyboard.press('Shift+Tab')
    await expect(edit).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(composer).toHaveValue(`Also check the weather\n\n${original}`)
    await expect(composer).toBeFocused()
    await expect(pending.getByText('It is in the composer.')).toBeVisible()
    await expect(raw).toHaveText(diagnostic)
    await expect.poll(() => page.evaluate(async () => {
      const chat = (await window.sotto!.personalChats!.get()).chats[0]!
      return { text: chat.draft.text, skills: chat.draft.skills.map(skill => skill.name), sends: chat.submissions.filter(item => item.text.startsWith('Book the ferry')).length }
    })).toEqual({ text: `Also check the weather\n\n${original}`, skills: ['brainstorm'], sends: 1 })
    await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport()
    await composed(launched, 'chat-not-sent-recovered-820x560-dark')
  } finally {
    await closeSotto(launched)
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
})
