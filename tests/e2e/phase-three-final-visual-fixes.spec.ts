import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { pendingRequest } from '../../src/main/agents/codexRequests'
import { defaultAgentConfiguration, type AgentRequest } from '../../src/shared/agents'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { BUILT_IN_THEMES, getThemeColorsForMode, type ThemeDefinition } from '../../src/shared/themes/library'
import { hostKeys } from './support/hostKeys'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// The four findings of the Phase 3 final visual review, in the complete app: custom theme names in the picker, the
// Light and Dark columns, a minimized theme editor beside the page links, and the composer beside a pending
// permission. AppShell, renderer, preload, IPC, the theme editor and the browser service are real; providers are the
// E2E fixtures. Profiles and the local page are owned temporaries. Images land in artifacts/phase-three-final-visual-fixes.
const SHOTS = resolve(process.cwd(), 'artifacts/phase-three-final-visual-fixes')
type Mode = 'dark' | 'light'
interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly width: number; readonly height: number }
const SIZES = [[1600, 1000], [1280, 860], [820, 560]] as const

async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    // The shipped minimum is an outer size; relax it slightly so the content area can be exactly 820x560.
    window.setMinimumSize(800, 540)
    window.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)).toBe(`${width}x${height}`)
}

async function appearance(page: Page, mode: Mode): Promise<void> {
  await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
}

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const path = join(SHOTS, `${name}.png`)
  if (target) await target.screenshot({ path, animations: 'disabled', caret: 'hide' })
  else await page.screenshot({ path, animations: 'disabled', caret: 'hide' })
}

/** The window as it is on screen, native page included (page captures omit the WebContentsView). */
async function composed(launched: LaunchedSotto, name: string): Promise<void> {
  const title = `Sotto final visual fixes ${name}`
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

const rect = (locator: Locator): Promise<Rect> => locator.evaluate(element => {
  const box = element.getBoundingClientRect()
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
})
const intersects = (a: Rect, b: Rect): boolean => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5
const inside = (inner: Rect, outer: Rect): boolean => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5

async function hostViews(app: ElectronApplication): Promise<Electron.Rectangle[]> {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    return host.contentView.children.filter(view => view instanceof WebContentsView).map(view => view.getBounds())
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// 1 and 2: the gallery

const nocturne = BUILT_IN_THEMES.find(theme => theme.id === 'nocturne')!
const tropic = BUILT_IN_THEMES.find(theme => theme.id === 'tropic')!
const dark = (id: string, label: string, from: ThemeDefinition, extra: Partial<ThemeDefinition> = {}): ThemeDefinition => ({ id, label, appearance: 'dark', colors: getThemeColorsForMode(from, 'dark')!, ...extra })
const LONGEST = 'Solarized Evening Harbor for Late Review Sessions'.slice(0, 48)
const CUSTOM: ThemeDefinition[] = [
  { id: 'harbor-review', label: 'Harbor Review', appearance: 'light', colors: getThemeColorsForMode(nocturne, 'light')!, variants: { dark: getThemeColorsForMode(tropic, 'dark')! } },
  dark('morning-harbor', 'Morning Harbor', nocturne),
  dark('catppuccin-macchiato', 'Catppuccin Macchiato', tropic),
  dark('longest-name', LONGEST, nocturne),
  dark('community-frappe', 'Frappé', tropic, { collection: { id: 'community.catppuccin-vsc', label: 'Catppuccin Community' } }),
  dark('community-mocha', 'Mocha', nocturne, { collection: { id: 'community.catppuccin-vsc', label: 'Catppuccin Community' } }),
]
const BUILT_IN_NAMES = ['Sotto', 'Hush', 'Linen', 'Nocturne', 'Tropic', 'Citrine']

/** Every option in one half's column, measured where it is drawn. */
const columnLayout = (column: Locator) => column.evaluate(element => {
  const box = (node: Element) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
  return [...element.querySelectorAll<HTMLButtonElement>('.theme-option')].map(option => {
    const name = option.querySelector('.theme-option__name')!
    return {
      name: name.textContent!,
      tooltip: option.title,
      clipped: name.scrollWidth > name.clientWidth + 1,
      lines: Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)),
      option: box(option), title: box(name), chord: box(option.querySelector('.theme-chord')!),
    }
  })
})

/** Every row of Your themes: its name, its modes line, a chord per half it carries, and its actions. */
const ownLayout = (list: Locator) => list.evaluate(element => {
  const box = (node: Element) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
  return [...element.querySelectorAll('.theme-own__row')].map(row => {
    const name = row.querySelector('.theme-own__name')!
    const actions = row.querySelector('.theme-own__actions')!
    return {
      id: row.getAttribute('data-theme-row')!,
      name: name.textContent!,
      tooltip: (name as HTMLElement).title,
      modes: row.querySelector('.theme-own__modes')!.textContent!,
      chords: row.querySelectorAll('.theme-chords > .theme-chord').length,
      clipped: name.scrollWidth > name.clientWidth + 1,
      lines: Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)),
      row: box(row), title: box(name), actions: box(actions),
    }
  })
})

test('custom names read in full in their own rows, and each half lists the themes that paint it, at 1600, 1280 and 820', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-final-visual-fixes-themes-'))
  const settings: AppSettings = { ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', customThemes: CUSTOM, lightTheme: 'harbor-review', darkTheme: 'harbor-review' }
  await writeFile(join(profile, 'settings.json'), JSON.stringify(settings))
  const launched = await launchSotto('success', profile)
  try {
    const { page } = launched
    await page.emulateMedia({ colorScheme: 'dark' })
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
    const section = page.locator('#settings-appearance')
    const halves = section.locator('.theme-halves')
    const column = (half: 'light' | 'dark') => section.locator(`.theme-half[data-half="${half}"] .theme-half__options`)
    const own = section.getByRole('list', { name: 'Your themes' })
    const row = (id: string) => own.locator(`li[data-theme-row="${id}"]`)
    const notes: Record<string, unknown> = {}

    for (const [width, height] of SIZES) {
      await size(launched, width, height)
      await halves.scrollIntoViewIfNeeded()
      // Each half lists the built-ins in picker order, then the custom themes that carry that half.
      expect((await columnLayout(column('light'))).map(item => item.name)).toEqual([...BUILT_IN_NAMES, 'Harbor Review'])
      const layout = await columnLayout(column('dark'))
      expect(layout.map(item => item.name)).toEqual([...BUILT_IN_NAMES, 'Harbor Review', 'Morning Harbor', 'Catppuccin Macchiato', LONGEST, 'Frappé', 'Mocha'])
      for (const item of layout) {
        const where = `${item.name} at ${width}: ${JSON.stringify(item)}`
        // 1. A column is narrow, so a long name is cut to one line rather than wrapped or spilled, and its tooltip
        // still carries it whole. The name never runs back over the colour strip or out of its option.
        expect(item.lines, where).toBe(1)
        expect(item.tooltip, where).toBe(item.name)
        expect(intersects(item.title, item.chord), where).toBe(false)
        expect(inside(item.title, item.option), where).toBe(true)
        // The review's finding was a name squeezed by what sits beside it; here it keeps most of the option.
        expect(item.title.width, where).toBeGreaterThanOrEqual(70)
      }
      // 2. The saved themes keep their own row: a chord per half they carry, the name clear of the actions.
      const rows = await ownLayout(own)
      expect(rows.map(item => item.id)).toEqual(CUSTOM.map(theme => theme.id))
      expect(rows.map(item => item.modes)).toEqual(['Light and dark', 'Dark only', 'Dark only', 'Dark only', 'Dark only · Catppuccin Community', 'Dark only · Catppuccin Community'])
      for (const item of rows) {
        const where = `${item.name} at ${width}: ${JSON.stringify(item)}`
        expect(item.lines, where).toBe(1)
        expect(item.tooltip, where).toBe(item.name)
        expect(item.chords, where).toBe(item.modes.startsWith('Light and dark') ? 2 : 1)
        expect(intersects(item.title, item.actions), where).toBe(false)
        expect(inside(item.actions, item.row), where).toBe(true)
        expect(item.title.width, where).toBeGreaterThanOrEqual(150)
      }
      notes[`${width}`] = { options: layout.map(item => ({ name: item.name, clipped: item.clipped, title: Math.round(item.title.width) })), rows: rows.map(item => ({ name: item.name, clipped: item.clipped, title: Math.round(item.title.width) })) }
      // The review's example: the row is the wide reading of a name, so "Morning Harbor" reads whole there.
      expect(rows.find(item => item.name === 'Morning Harbor')!.clipped, `${width}`).toBe(false)
      await page.mouse.move(1, 1)
      await shot(page, `gallery-custom-${width}-dark`)
    }

    // One theme chosen for both halves, the two columns close up.
    await size(launched, 1600, 1000)
    await halves.scrollIntoViewIfNeeded()
    await page.mouse.move(1, 1)
    await shot(page, 'columns-harbor-review-both-halves-1600-dark', halves)
    for (const half of ['light', 'dark'] as const) await column(half).getByRole('radio', { name: 'Nocturne', exact: true }).click()
    for (const half of ['light', 'dark'] as const) await expect(column(half).getByRole('radio', { name: 'Nocturne', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.mouse.move(1, 1)
    await shot(page, 'columns-nocturne-both-halves-1600-dark', halves)

    // Keyboard: from a long name's first action along the rest of its row.
    const long = row('catppuccin-macchiato')
    await long.scrollIntoViewIfNeeded()
    const edit = long.getByRole('button', { name: 'Edit Catppuccin Macchiato', exact: true })
    await edit.focus()
    for (const action of ['Duplicate Catppuccin Macchiato', 'Export Catppuccin Macchiato', 'Remove Catppuccin Macchiato']) {
      await page.keyboard.press('Tab')
      const button = long.getByRole('button', { name: action, exact: true })
      await expect(button).toBeFocused()
      await expect(button).toBeVisible()
    }
    await shot(page, 'own-long-name-keyboard-remove-1600-dark', long)
    await edit.focus()
    await page.keyboard.press('Enter')
    const editor = page.getByRole('dialog', { name: 'Edit theme' })
    await expect(editor).toBeVisible()
    await expect(editor.getByLabel('Theme name', { exact: true })).toBeFocused()
    // Escape and the Close button both hand focus back to the Edit button that opened the editor.
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(edit).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(editor).toBeVisible()
    await editor.getByRole('button', { name: 'Close the theme editor' }).focus()
    await page.keyboard.press('Enter')
    await expect(editor).toHaveCount(0)
    await expect(edit).toBeFocused()
    // Pointer: the Dark column uses the theme for the dark half.
    await column('dark').getByRole('radio', { name: 'Catppuccin Macchiato', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(async () => (await window.sotto!.getSettings()) as AppSettings)).darkTheme).toBe('catppuccin-macchiato')

    await appearance(page, 'light')
    await page.emulateMedia({ colorScheme: 'light' })
    for (const [width, height] of [[1280, 860], [820, 560]] as const) {
      await size(launched, width, height)
      await row('morning-harbor').scrollIntoViewIfNeeded()
      await row('morning-harbor').hover()
      await shot(page, `gallery-custom-hover-${width}-light`)
    }
    test.info().annotations.push({ type: 'gallery', description: JSON.stringify(notes) })
  } finally { await closeSotto(launched) }
})

// ---------------------------------------------------------------------------------------------------------------------
// 3: a minimized editor beside the sidebar foot's page links

test('a minimized editor rests at the window edge, clear of the sidebar foot links, Send and the live page', async () => {
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Atlas preview</title><body style="margin:0;font:600 22px system-ui;background:#1f6feb;color:white;display:grid;place-content:center;height:100vh">Atlas local app</body>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The local page has no port.')
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-final-visual-fixes-footer-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
  const launched = await launchSotto('success', profile)
  const { app, page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    // The renderer's state keys threads and projects by the host that owns them.
    const key = await hostKeys(page)
    const folder = await page.evaluate(async workshop => {
      const state = await window.sotto!.agents!.get()
      const thread = state.host.threads.find(item => item.id === workshop)!
      return state.host.projects.find(project => project.id === thread.projectId)!.path
    }, key('workshop'))
    await mkdir(folder, { recursive: true })
    const editor = page.getByRole('dialog', { name: 'Create theme' })
    // The Threads page owns the whole window now, so there is no footer to dock into: the minimized bar rests at the
    // window's own bottom-right, and what it has to stay clear of is the sidebar foot's page links and the composer's Send.
    const pageLinks = page.locator('.thread-nav__foot')
    const panel = page.getByRole('complementary', { name: 'Tools' })

    await size(launched, 1280, 860)
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await panel.getByRole('tab', { name: 'Browser' }).click()
    const addressBar = panel.getByRole('textbox', { name: 'Address for a new page' })
    await addressBar.fill(`127.0.0.1:${address.port}`)
    await addressBar.press('Enter')
    await expect(panel.getByRole('tab', { name: /Atlas preview/u })).toBeVisible()
    await expect.poll(async () => (await hostViews(app)).length).toBe(1)

    const openMinimized = async (): Promise<void> => {
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
      await expect(panel.locator('.browser-viewport')).toBeVisible()
      await editor.getByRole('button', { name: 'Minimize the theme editor' }).click()
      await expect(editor).toHaveAttribute('data-minimized', 'true')
    }

    /** Resting at the window's bottom-right: the sidebar foot's page links and Send are uncovered, and the page is shown. */
    const expectDocked = async (label: string): Promise<Record<string, unknown>> => {
      const [bar, links, box] = [await rect(editor), await rect(pageLinks), await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))]
      const where = `${label}: ${JSON.stringify({ bar, links, box })}`
      // Inside the window, hugging the bottom-right corner it docks to.
      expect(bar.bottom <= box.height && bar.right <= box.width && bar.bottom >= box.height - 88, where).toBe(true)
      expect(intersects(bar, links), where).toBe(false)
      // Send stays reachable, not under the bar.
      const send = page.getByRole('button', { name: /^(Send|Queue) prompt$/u }).first()
      expect(intersects(await rect(send), bar), where).toBe(false)
      // The live page is shown whenever the bar is clear of it (main reattaches it a moment after a resize).
      const viewport = await rect(panel.locator('.browser-viewport'))
      await expect.poll(async () => (await hostViews(app)).length, where).toBe(intersects(bar, viewport) ? 0 : 1)
      return { bar: Math.round(bar.left), bottomGap: Math.round(box.height - bar.bottom), rightGap: Math.round(box.width - bar.right) }
    }

    const geometry: Record<string, unknown> = {}
    await openMinimized()
    for (const [width, height] of SIZES) {
      await size(launched, width, height)
      geometry[`${width}`] = await expectDocked(`${width}x${height} dark`)
      await composed(launched, `footer-status-beside-minimized-editor-${width}-dark`)
    }

    // Dragged away, the bar leaves its resting place and stays a working bar.
    const header = editor.locator('.theme-editor__header h2')
    const grip = await rect(header)
    await page.mouse.move(grip.left + 12, grip.top + grip.height / 2)
    await page.mouse.down()
    for (let step = 1; step <= 10; step++) await page.mouse.move(grip.left + 12 - step * 30, grip.top + grip.height / 2 - step * 25)
    await page.mouse.up()
    await expect.poll(async () => (await rect(editor)).top).toBeLessThan(grip.top - 100)
    await composed(launched, 'footer-status-after-bar-dragged-820-dark')
    // Expanded and closed: nothing is left behind.
    await editor.getByRole('button', { name: 'Expand the theme editor' }).click()
    await editor.getByRole('button', { name: 'Close the theme editor' }).click()
    await expect(editor).toHaveCount(0)

    await appearance(page, 'light')
    await openMinimized()
    geometry['820-light'] = await expectDocked('820x560 light')
    await composed(launched, 'footer-status-beside-minimized-editor-820-light')
    // Keyboard: from the sidebar foot's last page link, Tab still reaches the bar's buttons, and Close puts it away.
    // (At 820 with Tools open the sidebar has stepped aside, foot and all, so the walk starts at the bar.)
    const help = pageLinks.getByRole('link', { name: 'Help', exact: true })
    if (await help.isVisible()) await help.focus()
    await editor.getByRole('button', { name: 'Expand the theme editor' }).focus()
    await page.keyboard.press('Tab')
    await expect(editor.getByRole('button', { name: 'Close the theme editor' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(editor).toHaveCount(0)
    test.info().annotations.push({ type: 'footer', description: JSON.stringify(geometry) })
  } finally {
    await closeSotto(launched)
    await new Promise(done => server.close(done))
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// 4: the composer beside a pending permission, with the compact Grid/Row switch and a structured form

const INSTRUCTION = 'Allow or deny the request above to continue.'
const formMessage = 'The release-notes server needs a publishing target before it drafts v0.9.'
const codexForm = (): AgentRequest => pendingRequest('release-notes', 'mcpServer/elicitation/request', {
  threadId: 'native-thread', itemId: 'mcp-call-7', mode: 'form', message: formMessage,
  requestedSchema: { type: 'object', required: ['channel'], properties: {
    channel: { type: 'string', title: 'Channel', description: 'Where should the notes go?', oneOf: [{ const: 'blog', title: 'Blog post' }, { const: 'email', title: 'Email digest' }] },
  } },
}, 'native-thread')!.request

/** How often the composer states the instruction, counting its placeholder. */
const composerSays = (pane: Locator) => pane.locator('form.thread-prompt').evaluate((form, instruction) => {
  const prompt = form.querySelector('textarea')!
  return (form.textContent!.split(instruction).length - 1) + (prompt.placeholder === instruction ? 1 : 0)
}, INSTRUCTION)

/** Deny and Allow come into view uncovered from the keyboard. */
async function expectDecisionReachable(page: Page, pane: Locator): Promise<void> {
  const card = pane.locator('.agent-request[data-kind="permission"]')
  for (const name of ['Deny', 'Allow']) {
    const button = card.getByRole('button', { name, exact: true })
    await button.focus()
    await expect.poll(() => button.evaluate(element => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) && box.bottom <= window.innerHeight
    })).toBe(true)
  }
}

test('the composer beside a pending permission says to allow or deny once, through the grid, the compact row and a structured form', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-final-visual-fixes-requests-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false },
    assignments: [], queue: [], activeThreadId: 'grok-previews', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', outbox: [],
  }))
  const launched = await launchSotto('design-threads', profile)
  try {
    const { page } = launched
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    // Panes are keyed by the host that owns their thread; test events still take the bare ID.
    const key = await hostKeys(page)
    // A working thread with nothing to send shows Stop in Send's place, and the prompt is off while a permission is
    // pending, so the draft is written before the pane opens: with something to send, Send (here Queue) comes back.
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'save-thread-draft', composer: 'manual', threadId: 'visual-gate',
      draftId: crypto.randomUUID(), text: 'Check the flaky capture once the request is answered.', attachments: [], requestId: null }))
    await size(launched, 1600, 1000)
    await openThreads(page)
    const panes = page.getByRole('group', { name: 'Thread panes' })
    const pane = (id: string) => panes.locator(`section.thread-pane[data-thread-id="${key(id)}"]`)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    for (const title of ['Footer links', 'Weekly note', 'Visual gate flake']) {
      await sidebar.getByRole('button', { name: title, exact: true }).hover()
      await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click()
    }
    await expect(panes.locator('section.thread-pane[role="region"]:not([data-hidden])')).toHaveCount(4)
    const gate = pane('visual-gate')
    const prompt = gate.getByRole('textbox', { name: 'Prompt', exact: true })
    await expect(prompt).toHaveAttribute('placeholder', INSTRUCTION)
    // The Send button still says why it is off, and the held draft stays in the prompt.
    await expect(prompt).toHaveValue('Check the flaky capture once the request is answered.')
    await expect(gate.getByRole('button', { name: /^(Send|Queue) prompt$/u })).toHaveAttribute('title', INSTRUCTION)

    for (const [width, height, name] of [[1600, 1000, '1600'], [1280, 800, '1280x800']] as const) {
      await size(launched, width, height)
      expect(await composerSays(gate)).toBe(1)
      await expectDecisionReachable(page, gate)
      await gate.locator('.agent-request[data-kind="permission"]').evaluate(element => element.scrollIntoView({ block: 'start' }))
      await expect(gate.locator('.agent-request[data-kind="permission"] .agent-request__head')).toBeInViewport()
      await shot(page, `permission-grid-${name}-dark`)
    }

    // The compact row at 1280, then back to the grid from the keyboard.
    const tabs = page.getByRole('tablist', { name: 'Open panes' })
    const toggle = gate.getByRole('button', { name: 'Single row' })
    await toggle.click()
    await expect(tabs).toBeVisible()
    expect(await composerSays(gate)).toBe(1)
    await expectDecisionReachable(page, gate)
    await shot(page, 'permission-row-compact-1280x800-dark')
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(tabs).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    for (const mode of ['dark', 'light'] as const) {
      await appearance(page, mode)
      await size(launched, 820, 560)
      await expect(tabs).toBeVisible()
      await tabs.getByRole('tab', { name: 'Visual gate flake' }).click()
      expect(await composerSays(gate)).toBe(1)
      await expectDecisionReachable(page, gate)
      await shot(page, `permission-compact-820x560-${mode}`)
    }
    await appearance(page, 'dark')

    // A structured form in the same window: its explanation shows once in its card, and the composer says only
    // that the question is answered above.
    await page.evaluate(async request => window.sottoE2E!.agentEvent!({ type: request.kind, threadId: 'footer-links', text: request.text, request, status: 'running' }), codexForm())
    await size(launched, 1280, 800)
    const links = pane('footer-links')
    const form = links.locator('.agent-request')
    await expect(form.locator('.agent-request__text')).toHaveText(formMessage)
    expect(await form.evaluate((element, message) => element.textContent!.split(message).length - 1, formMessage)).toBe(1)
    const linkComposer = links.locator('form.thread-prompt')
    const placeholder = await linkComposer.locator('textarea').getAttribute('placeholder')
    const statusText = await linkComposer.locator('.thread-prompt__status').allTextContents()
    expect(statusText.filter(text => text === placeholder)).toEqual([])
    await form.evaluate(element => element.scrollIntoView({ block: 'start' }))
    await shot(page, 'form-and-permission-grid-1280x800-dark')
    test.info().annotations.push({ type: 'form-composer', description: JSON.stringify({ placeholder, statusText }) })
  } finally { await closeSotto(launched) }
})
