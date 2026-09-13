import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// Phase 3 UI in the complete app: AppShell, renderer, preload, IPC and the production tools and personal chat services
// are real. Coding providers and the personal Codex connection come from the explicit unpackaged E2E provider fixtures;
// no native account or installed client runs. Profiles, working copies and the local page are owned temporaries.

const run = promisify(execFile)
const SHOTS = resolve(process.cwd(), 'artifacts/phase-three-ui')
type Mode = 'dark' | 'light'

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

async function theme(page: Page, mode: Mode): Promise<void> {
  await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
}

/** Nothing on the page scrolls sideways, and the named elements sit wholly inside the window. */
async function expectContained(page: Page, selectors: readonly string[]): Promise<void> {
  const report = await page.evaluate(selectors => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    outside: selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
      const box = element.getBoundingClientRect()
      return box.left < -1 || box.top < -1 || box.right > window.innerWidth + 1 || box.bottom > window.innerHeight + 1 ? `${selector} ${JSON.stringify(box)}` : null
    }).filter(Boolean)),
  }), selectors)
  expect(report.overflow).toBeLessThanOrEqual(0)
  expect(report.outside).toEqual([])
}

/** The smallest rendered text in the Phase 3 surfaces on screen, with where it is, so no new label drops below 12px. */
async function smallestText(page: Page): Promise<{ size: number; where: string }> {
  return page.evaluate(() => {
    let smallest = { size: Infinity, where: '' }
    for (const element of document.querySelectorAll<HTMLElement>('.tools-panel *, .personal-chats *, [role="menu"] *')) {
      const text = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join('').trim()
      const box = element.getBoundingClientRect()
      if (!text || box.width === 0 || box.height === 0 || getComputedStyle(element).visibility === 'hidden' || element.closest('[aria-hidden="true"], .xterm-accessibility, .xterm-helpers')) continue
      const size = Number.parseFloat(getComputedStyle(element).fontSize)
      if (size < smallest.size) smallest = { size, where: `${element.className || element.tagName}: ${text.slice(0, 30)}` }
    }
    return smallest
  })
}

async function shoot(page: Page, name: string, modes: readonly Mode[] = ['dark', 'light']): Promise<void> {
  const text = await smallestText(page)
  expect(text.size, `${name}: ${text.where}`).toBeGreaterThanOrEqual(12)
  for (const mode of modes) {
    await theme(page, mode)
    await page.screenshot({ path: join(SHOTS, `${name}-${mode}.png`), animations: 'disabled' })
  }
  await theme(page, 'dark')
}

async function hostViews(app: ElectronApplication): Promise<{ url: string; bounds: Electron.Rectangle }[]> {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    return host.contentView.children.filter(view => view instanceof WebContentsView).map(view => ({ url: (view as Electron.WebContentsView).webContents.getURL(), bounds: view.getBounds() }))
  })
}

test('reviews changes, runs a terminal and browses a local page for a real working copy, by pointer and keyboard', async () => {
  test.setTimeout(240_000)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Atlas preview</title><body style="margin:0;font:600 28px system-ui;background:#1f6feb;color:white;display:grid;place-items:center;height:100vh">Atlas local app</body>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The local page has no port.')
  const url = `http://127.0.0.1:${address.port}/`

  const launched = await launchSotto('success', await ownedProfile('sotto-e2e-phase3-ui-tools-'))
  const { app, page } = launched
  try {
    // The fixture's Workshop thread works in a real folder inside the owned profile; it becomes a Git working copy here.
    const folder = await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      const state = await agents.command({ type: 'connect' })
      const thread = state.host.threads.find(item => item.id === 'workshop')!
      return state.host.projects.find(project => project.id === thread.projectId)!.path
    })
    expect(folder.startsWith(launched.userData)).toBe(true)
    await mkdir(join(folder, 'src'), { recursive: true })
    const git = (args: string[]) => run('git', args, { cwd: folder, windowsHide: true, timeout: 15_000 })
    await git(['init', '--quiet'])
    await writeFile(join(folder, 'src/app.ts'), "export function greet(name: string): string {\n  return 'Hello ' + name\n}\n")
    await writeFile(join(folder, 'old.txt'), 'Retired notes.\n')
    await writeFile(join(folder, 'README.md'), '# Atlas\n')
    await git(['add', '.'])
    await git(['-c', 'user.name=Sotto verification', '-c', 'user.email=verification@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Owned fixture'])
    await writeFile(join(folder, 'src/app.ts'), 'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n\nexport const version = 2\n')
    await rm(join(folder, 'old.txt'))
    await writeFile(join(folder, 'CHANGELOG.md'), '## 2\n\n- Friendlier greeting\n')
    await page.evaluate(async url => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', status: 'idle',
      text: `The greeting is friendlier now. The dev server is at [the Atlas preview](${url}), and the change is ready to review.` }), url)
    await resize(launched, 1280, 860)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible()

    // Keyboard: the header toggle opens Tools with focus on its tabs; arrows move between surfaces.
    const toggle = page.getByRole('button', { name: 'Tools', exact: true })
    await toggle.focus()
    await page.keyboard.press('Enter')
    const panel = page.getByRole('complementary', { name: 'Tools' })
    await expect(panel.getByRole('tab')).toHaveText(['Files', 'Changes', 'Terminal', 'Browser'])
    await expect(panel.getByRole('tab', { name: 'Files' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(panel.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true')

    const files = panel.getByRole('listbox', { name: 'Changed files' })
    await expect(files.getByRole('option')).toHaveCount(3)
    await expect(files).toContainText('app.ts')
    await expect(files).toContainText('CHANGELOG.md')
    await expect(files).toContainText('old.txt')
    await files.getByRole('option', { name: /^app\.ts/u }).focus()
    await page.keyboard.press('Enter')
    const diff = panel.getByRole('region', { name: 'Changes in src/app.ts' })
    await expect(diff).toContainText('return `Hello, ${name}!`')
    await expect(diff).toContainText("return 'Hello ' + name")
    await expectContained(page, ['.tools-panel', '.thread-workspace__compose'])
    await shoot(page, 'changes-diff-1280')
    await resize(launched, 1600, 1000)
    await shoot(page, 'changes-diff-1600', ['dark'])
    await resize(launched, 820, 560)
    await expect(diff).toBeVisible()
    // In the short window the diff, not the file list, takes the panel; the selected file stays in view above it.
    const heights = await panel.evaluate(element => ({ list: element.querySelector('.changes-list')!.getBoundingClientRect().height, diff: element.querySelector('.changes-diff__body')!.getBoundingClientRect().height }))
    expect(heights.diff).toBeGreaterThan(heights.list * 2)
    expect(await files.evaluate(list => {
      const box = list.getBoundingClientRect()
      const row = list.querySelector('[aria-selected="true"]')!.getBoundingClientRect()
      return row.top >= box.top - 1 && row.bottom <= box.bottom + 1
    })).toBe(true)
    await expectContained(page, ['.tools-panel'])
    await shoot(page, 'changes-diff-820x560')
    await panel.getByRole('button', { name: 'Close diff' }).click()
    await expect(files.getByRole('option', { name: /^app\.ts/u })).toBeFocused()
    await resize(launched, 1280, 860)

    // Terminal: a real shell in the working copy, typed into by keyboard.
    await panel.getByRole('tab', { name: 'Terminal' }).click()
    await panel.getByRole('button', { name: 'Start terminal' }).click()
    const screen = panel.locator('.xterm-rows')
    await expect(screen).toBeVisible()
    await panel.locator('.xterm').click()
    await page.keyboard.type('echo SOTTO_UI_TERMINAL_OK')
    await page.keyboard.press('Enter')
    await expect.poll(async () => ((await screen.innerText()).match(/SOTTO_UI_TERMINAL_OK/gu) ?? []).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
    // The shell starts in the thread's working copy: a relative redirect lands in that folder.
    await page.keyboard.type('echo started here > terminal-proof.txt')
    await page.keyboard.press('Enter')
    await expect.poll(() => stat(join(folder, 'terminal-proof.txt')).then(() => true, () => false), { timeout: 20_000 }).toBe(true)
    // No part of the terminal paints outside the theme: xterm's own #000 viewport must not show under the last row.
    expect(await panel.locator('.xterm-viewport').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await shoot(page, 'terminal-1280')
    await resize(launched, 820, 560)
    await expectContained(page, ['.tools-panel', '.terminal-view'])
    await shoot(page, 'terminal-820x560')
    await resize(launched, 1280, 860)

    // Browser: an address typed and opened by keyboard mounts the native page exactly over the viewport.
    await panel.getByRole('tab', { name: 'Browser' }).click()
    const addressBar = panel.getByRole('textbox', { name: /^Address/u })
    await addressBar.fill(`127.0.0.1:${address.port}`)
    await addressBar.press('Enter')
    await expect(panel.getByRole('tab', { name: /Atlas preview/u })).toBeVisible()
    await expect.poll(async () => (await hostViews(app)).filter(view => view.url === url).length).toBe(1)
    const viewport = await panel.locator('.browser-viewport').evaluate(element => {
      const box = element.getBoundingClientRect()
      return { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }
    })
    await expect.poll(async () => (await hostViews(app)).find(view => view.url === url)?.bounds).toEqual(viewport)
    expect(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)?.getTitle(), url)).toBe('Atlas preview')
    await page.screenshot({ path: join(SHOTS, 'browser-dom-without-native-view-1280-dark.png') })
    // Playwright's page capture cannot include the native view; its own capture is saved beside it.
    const pixels = await app.evaluate(async ({ webContents }, url) => {
      const image = await webContents.getAllWebContents().find(contents => contents.getURL() === url)!.capturePage()
      return image.toPNG().toString('base64')
    }, url)
    await writeFile(join(SHOTS, 'browser-native-page-1280.png'), Buffer.from(pixels, 'base64'))

    // A menu over the transcript sends the page aside; the per-link menu opens the link in this thread's browser.
    const link = page.getByLabel('Thread transcript', { exact: true }).getByRole('link', { name: 'the Atlas preview' })
    await link.focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem')).toHaveText(['Open in Sotto browser', 'Open in system browser', 'Copy link'])
    await expect(menu.getByRole('menuitem', { name: 'Open in Sotto browser' })).toBeFocused()
    await expect.poll(async () => (await hostViews(app)).length).toBe(0)
    await expect(panel.getByText('The page steps aside while a menu or dialog is open.')).toBeVisible()
    await page.screenshot({ path: join(SHOTS, 'link-menu-1280-dark.png') })
    await page.keyboard.press('Escape')
    await expect(link).toBeFocused()
    await expect.poll(async () => (await hostViews(app)).filter(view => view.url === url).length).toBe(1)
    await page.keyboard.press('Shift+F10')
    await page.keyboard.press('Enter')
    await expect(panel.getByRole('tab', { name: /Atlas preview/u })).toHaveCount(2)
    await expect.poll(async () => (await hostViews(app)).filter(view => view.url === url).length).toBe(1)

    // Reduced motion reaches the new surfaces: the link menu and the page loading bar do not animate.
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await link.focus()
    await page.keyboard.press('Shift+F10')
    expect(await menu.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    await page.keyboard.press('Escape')
    await resize(launched, 820, 560)
    await expectContained(page, ['.tools-panel', '.browser-toolbar'])
    await shoot(page, 'browser-dom-820x560')
  } finally {
    await closeSotto(launched)
    await rm(launched.userData, { recursive: true, force: true }).catch(() => undefined)
    await new Promise<void>(done => server.close(() => done()))
  }
})

test('starts, continues and resumes a project-free chat, by keyboard, across disconnect, restart and changed defaults', async () => {
  test.setTimeout(240_000)
  const profile = await ownedProfile('sotto-e2e-phase3-ui-chats-')
  let launched = await launchSotto('success', profile)
  try {
    let page = launched.page
    const before = await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: 'low' } })
      const state = await agents.command({ type: 'connect' })
      return { projects: state.host.projects.map(project => project.id), threads: state.host.threads.map(thread => thread.id) }
    })
    await resize(launched, 1280, 860)
    await page.getByRole('link', { name: 'Chats', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Chats', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('heading', { name: 'Talk it through with Sotto' })).toBeVisible()
    await expectContained(page, ['.personal-chats .thread-nav', '.personal-chat'])
    await shoot(page, 'chats-empty-1280')

    const start = page.getByRole('region', { name: 'Chat' }).getByRole('button', { name: 'New chat' })
    await start.focus()
    await page.keyboard.press('Enter')
    const composer = page.getByRole('textbox', { name: 'Message' })
    await expect(composer).toBeFocused()
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible()
    await page.keyboard.type('Plan a quiet weekend near the coast')
    await page.keyboard.press('Enter')
    const transcript = page.getByLabel('Chat transcript', { exact: true })
    await expect(transcript.getByRole('heading', { name: 'A saved conversation' })).toBeVisible()
    await expect(transcript.locator('.thread-message[data-role="user"]')).toHaveCount(1)
    await expect(composer).toHaveValue('')
    await expect(page.getByRole('heading', { name: 'Plan a quiet weekend near the coast', level: 2 })).toBeVisible()

    await page.keyboard.type('Second thought: $brai')
    const skills = page.getByRole('listbox', { name: 'Skills' })
    await expect(skills.getByRole('option')).toContainText('$brainstorm')
    await page.keyboard.press('Enter')
    await expect(composer).toHaveValue('Second thought: $brainstorm ')
    await page.keyboard.type('the trains')
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.sotto!.personalChats!.get()
      const chat = state.chats.find(item => item.id === state.selectedChatId)!
      return { text: chat.draft.text, skills: chat.draft.skills.map(skill => skill.name) }
    })).toEqual({ text: 'Second thought: $brainstorm the trains', skills: ['brainstorm'] })
    await expectContained(page, ['.thread-prompt', '.personal-chats .thread-nav'])
    await shoot(page, 'chat-conversation-1280')
    await resize(launched, 1600, 1000)
    await shoot(page, 'chat-conversation-1600', ['dark'])
    await resize(launched, 820, 560)
    await expectContained(page, ['.thread-prompt', '.thread-prompt__actions'])
    await expect(transcript).toBeVisible()
    expect(await transcript.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(150)
    await shoot(page, 'chat-conversation-820x560')
    await composer.fill('Second thought: $brai')
    await expect(skills).toBeVisible()
    await expectContained(page, ['.skill-picker', '.thread-prompt'])
    await page.screenshot({ path: join(SHOTS, 'chat-skill-picker-820x560-dark.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await composer.fill('Second thought: the trains')
    await resize(launched, 1280, 860)

    // Disconnecting only ends the personal connection: the draft stays and sending says why it waits.
    await page.getByRole('button', { name: 'Disconnect' }).click()
    await expect(page.locator('.thread-workspace__tag', { hasText: 'Codex disconnected' })).toBeVisible()
    await expect(page.getByText('Connect Codex to send. Your draft stays here.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled()
    await page.keyboard.press('Enter')
    await shoot(page, 'chat-disconnected-1280', ['dark'])
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.personalChats!.get()).chats[0]!.draft.text)).toBe('Second thought: the trains')

    // Restart: the chat, its history and its draft come back; nothing became project work.
    await closeSotto(launched)
    launched = await launchSotto('success', profile)
    page = launched.page
    await resize(launched, 1280, 860)
    await page.getByRole('link', { name: 'Chats', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Plan a quiet weekend near the coast', level: 2 })).toBeVisible()
    await expect(page.getByLabel('Chat transcript', { exact: true }).getByRole('heading', { name: 'A saved conversation' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Second thought: the trains')
    await page.getByRole('button', { name: 'Connect Codex' }).click()
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
    const after = await page.evaluate(async () => {
      const state = await window.sotto!.agents!.command({ type: 'connect' })
      return { projects: state.host.projects.map(project => project.id), threads: state.host.threads.map(thread => thread.id), assignments: state.assignments.length }
    })
    expect(after).toEqual({ ...before, assignments: 0 })

    // A different coordinator: saved chats stay readable and stay with Codex; new chats explain where to change it.
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'configure', patch: { reasoning: 'claude', reasoningModel: 'changed-default' } }))
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await page.getByRole('link', { name: 'Chats', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Chats' }).getByRole('button', { name: 'New chat' })).toBeDisabled()
    await expect(page.getByText(/Select Codex in coordinator settings for new chats/u)).toBeVisible()
    await expect(page.getByText('Codex · test')).toBeVisible()
    await expectContained(page, ['.personal-chats .thread-nav', '.thread-prompt'])
    await shoot(page, 'chats-unsupported-default-1280')
    await resize(launched, 820, 560)
    await shoot(page, 'chats-unsupported-default-820x560')
    await page.getByRole('button', { name: 'Coordinator settings' }).click()
    // A fresh profile meets the working-preferences questions first; the agent configuration waits behind them.
    await page.getByRole('button', { name: 'Not now' }).click()
    await expect(page.getByRole('dialog', { name: 'Agent configuration' })).toBeVisible()
  } finally { await closeSotto(launched); await rm(profile, { recursive: true, force: true }).catch(() => undefined) }
})
