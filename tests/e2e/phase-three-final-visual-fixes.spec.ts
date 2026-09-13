import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { pendingRequest } from '../../src/main/agents/codexRequests'
import { defaultAgentConfiguration, type AgentRequest } from '../../src/shared/agents'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { BUILT_IN_THEMES, getThemeColorsForMode, type ThemeDefinition } from '../../src/shared/themes/library'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// The four findings of the Phase 3 final visual review, in the complete app: custom theme names in the gallery, the
// light and dark preview circles, the footer status beside a minimized theme editor, and the composer beside a pending
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

const tide = BUILT_IN_THEMES.find(theme => theme.id === 'ocean')!
const copper = BUILT_IN_THEMES.find(theme => theme.id === 'ember')!
const dark = (id: string, label: string, from: ThemeDefinition, extra: Partial<ThemeDefinition> = {}): ThemeDefinition => ({ id, label, appearance: 'dark', colors: getThemeColorsForMode(from, 'dark')!, ...extra })
const LONGEST = 'Solarized Evening Harbor for Late Review Sessions'.slice(0, 48)
const CUSTOM: ThemeDefinition[] = [
  { id: 'harbor-review', label: 'Harbor Review', appearance: 'light', colors: getThemeColorsForMode(tide, 'light')!, variants: { dark: getThemeColorsForMode(copper, 'dark')! } },
  dark('morning-harbor', 'Morning Harbor', tide),
  dark('catppuccin-macchiato', 'Catppuccin Macchiato', copper),
  dark('longest-name', LONGEST, tide),
  dark('community-frappe', 'Frappé', copper, { collection: { id: 'community.catppuccin-vsc', label: 'Catppuccin Community' } }),
  dark('community-mocha', 'Mocha', tide, { collection: { id: 'community.catppuccin-vsc', label: 'Catppuccin Community' } }),
]

/** Every card's name, actions and circles, measured where they are drawn. */
const galleryLayout = (grid: Locator) => grid.evaluate(element => {
  const box = (node: Element) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
  return [...element.querySelectorAll('.theme-card')].map(card => {
    const title = card.querySelector<HTMLButtonElement>('.theme-card__title')!
    const name = title.querySelector('.theme-card__name')!
    const actions = card.querySelector('.theme-card__actions')!
    return {
      name: name.textContent!,
      tooltip: title.title,
      accessibleName: title.getAttribute('aria-label')!,
      clipped: name.scrollHeight > name.clientHeight + 1 || name.scrollWidth > name.clientWidth + 1,
      lines: Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)),
      card: box(card), title: box(name), actions: box(actions),
      circles: [...card.querySelectorAll('.theme-circle')].map(circle => ({
        button: box(circle),
        ring: circle.querySelector('.theme-circle__ring') ? box(circle.querySelector('.theme-circle__ring')!) : null,
        badge: circle.querySelector('.theme-circle__badge') ? box(circle.querySelector('.theme-circle__badge')!) : null,
      })),
    }
  })
})

test('custom names read in full beside their actions, and each preview circle keeps its own ring and badge, at 1600, 1280 and 820', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-final-visual-fixes-themes-'))
  const settings: AppSettings = { ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', customThemes: CUSTOM, lightTheme: 'harbor-review', darkTheme: 'harbor-review' }
  await writeFile(join(profile, 'settings.json'), JSON.stringify(settings))
  const launched = await launchSotto('success', profile)
  try {
    const { page } = launched
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    const section = page.locator('#settings-appearance')
    const grid = section.locator('.theme-grid')
    const card = (label: string) => grid.locator('.theme-card').filter({ has: page.locator('.theme-card__name', { hasText: new RegExp(`^${label}$`, 'u') }) })
    const notes: Record<string, unknown> = {}

    for (const [width, height] of SIZES) {
      await size(launched, width, height)
      await grid.scrollIntoViewIfNeeded()
      const layout = await galleryLayout(grid)
      expect(layout.map(item => item.name)).toEqual(['Sotto', 'Rose', 'Fern', 'Tide', 'Copper', 'Dusk', 'Harbor Review', 'Morning Harbor', 'Catppuccin Macchiato', LONGEST, 'Catppuccin Community'])
      for (const item of layout) {
        const where = `${item.name} at ${width}: ${JSON.stringify(item)}`
        // 1. Every name up to two lines reads whole; only the 48-character maximum may clamp, and its tooltip and
        // accessible name still carry it. The name never runs under the (invisible until hover) actions.
        if (item.name !== LONGEST) expect(item.clipped, where).toBe(false)
        expect(item.lines, where).toBeLessThanOrEqual(2)
        expect(item.tooltip, where).toBe(item.name)
        expect(item.accessibleName, where).toContain(item.name)
        expect(intersects(item.title, item.actions), where).toBe(false)
        expect(inside(item.actions, item.card), where).toBe(true)
        // 2. T3's separate circles: 10px apart, each ring and badge inside its own circle and clear of the other.
        if (item.circles.length === 2) {
          const [first, second] = item.circles as [typeof item.circles[0], typeof item.circles[0]]
          expect(Math.round(second.button.left - first.button.right), where).toBe(10)
          for (const [own, other] of [[first, second], [second, first]] as const) {
            for (const mark of [own.ring, own.badge]) {
              if (mark === null) continue
              expect(inside(mark, own.button), where).toBe(true)
              expect(intersects(mark, other.button), where).toBe(false)
            }
          }
        }
      }
      notes[`${width}`] = layout.filter(item => item.card.top >= 0).map(item => ({ name: item.name, lines: item.lines, clipped: item.clipped, title: Math.round(item.title.width), actionsWrapped: item.actions.bottom <= item.title.top + 1 }))
      // The review's example: at 1600 and 1280, "Morning Harbor" was 89px of 114px.
      expect(layout.find(item => item.name === 'Morning Harbor')!.clipped).toBe(false)
      await card('Harbor Review').scrollIntoViewIfNeeded()
      await page.mouse.move(1, 1)
      await shot(page, `gallery-custom-${width}-dark`)
    }

    // Both halves chosen on one card, close up, beside the review's Tide capture.
    await size(launched, 1600, 1000)
    await card('Harbor Review').scrollIntoViewIfNeeded()
    await page.mouse.move(1, 1)
    await shot(page, 'card-harbor-review-both-halves-1600-dark', card('Harbor Review'))
    await card('Tide').getByRole('button', { name: 'Use Tide theme' }).click()
    await expect(card('Tide').locator('.theme-circle__badge')).toHaveCount(2)
    await page.mouse.move(1, 1)
    await shot(page, 'card-tide-both-halves-1600-dark', card('Tide'))

    // Keyboard: from a long name to each of its actions, which show while focus is inside the card.
    const long = card('Catppuccin Macchiato')
    await long.scrollIntoViewIfNeeded()
    const title = long.getByRole('button', { name: 'Use Catppuccin Macchiato theme', exact: true })
    await title.focus()
    for (const action of ['Duplicate Catppuccin Macchiato', 'Edit Catppuccin Macchiato', 'Export Catppuccin Macchiato', 'Remove Catppuccin Macchiato']) {
      await page.keyboard.press('Tab')
      await expect(long.getByRole('button', { name: action, exact: true })).toBeFocused()
      await expect(long.locator('.theme-card__actions')).toHaveCSS('opacity', '1')
    }
    await shot(page, 'card-long-name-keyboard-remove-1600-dark', long)
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Enter')
    const editor = page.getByRole('dialog', { name: 'Edit theme' })
    await expect(editor).toBeVisible()
    await editor.getByRole('button', { name: 'Close the theme editor' }).click()
    await expect(editor).toHaveCount(0)
    // Pointer: the title uses the theme.
    await title.click()
    await expect.poll(async () => (await page.evaluate(async () => (await window.sotto!.getSettings()) as AppSettings)).darkTheme).toBe('catppuccin-macchiato')

    await appearance(page, 'light')
    await page.emulateMedia({ colorScheme: 'light' })
    for (const [width, height] of [[1280, 860], [820, 560]] as const) {
      await size(launched, width, height)
      await card('Harbor Review').scrollIntoViewIfNeeded()
      await card('Morning Harbor').hover()
      await shot(page, `gallery-custom-hover-${width}-light`)
    }
    test.info().annotations.push({ type: 'gallery', description: JSON.stringify(notes) })
  } finally { await closeSotto(launched) }
})

// ---------------------------------------------------------------------------------------------------------------------
// 3: the footer status beside a minimized editor

test('the footer status ends before a minimized editor docked in the footer, beside the links, Send and the live page', async () => {
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
    const folder = await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      const state = await agents.command({ type: 'connect' })
      const thread = state.host.threads.find(item => item.id === 'workshop')!
      return state.host.projects.find(project => project.id === thread.projectId)!.path
    })
    await mkdir(folder, { recursive: true })
    const editor = page.getByRole('dialog', { name: 'Create theme' })
    const footer = page.locator('.app-footer')
    const status = footer.locator('.app-footer__status')
    const panel = page.getByRole('complementary', { name: 'Tools' })

    await size(launched, 1280, 860)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await panel.getByRole('tab', { name: 'Browser' }).click()
    const addressBar = panel.getByRole('textbox', { name: 'Address for a new page' })
    await addressBar.fill(`127.0.0.1:${address.port}`)
    await addressBar.press('Enter')
    await expect(panel.getByRole('tab', { name: /Atlas preview/u })).toBeVisible()
    await expect.poll(async () => (await hostViews(app)).length).toBe(1)

    const openMinimized = async (): Promise<void> => {
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Create theme', exact: true }).click()
      await expect(editor).toBeVisible()
      await page.getByRole('link', { name: 'Threads', exact: true }).click()
      await editor.getByRole('button', { name: 'Minimize the theme editor' }).click()
      await expect(editor).toHaveAttribute('data-minimized', 'true')
    }

    /** Docked in the footer: the status's text ends 12px before the bar, the links and Send are uncovered, the page is shown. */
    const expectDocked = async (label: string): Promise<Record<string, unknown>> => {
      await expect.poll(() => footer.evaluate(element => element.style.getPropertyValue('--theme-editor-reserve'))).not.toBe('')
      const [bar, box, links, text] = [await rect(editor), await rect(footer), await rect(footer.locator('nav')), await status.evaluate(element => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const words = range.getBoundingClientRect()
        const own = element.getBoundingClientRect()
        const padding = parseFloat(getComputedStyle(element.parentElement!).paddingRight)
        return { right: Math.min(words.right, own.right), ownRight: own.right, ellipsized: element.scrollWidth > element.clientWidth, title: element.title, full: element.textContent!, padding }
      })]
      const where = `${label}: ${JSON.stringify({ bar, box, links, text })}`
      expect(bar.top >= box.top - 0.5 && bar.bottom <= box.bottom + 0.5, where).toBe(true)
      expect(text.ownRight, where).toBeLessThanOrEqual(bar.left - 11.5)
      expect(links.right, where).toBeLessThan(bar.left)
      // An ellipsized status keeps its whole sentence for the pointer and for assistive technology.
      if (text.ellipsized) expect(text.title, where).toBe(text.full)
      // Send stays reachable, not under the bar.
      const send = page.getByRole('button', { name: /^(Send|Queue) prompt$/u }).first()
      expect(intersects(await rect(send), bar), where).toBe(false)
      // The live page is shown whenever the bar is clear of it (main reattaches it a moment after a resize).
      const viewport = await rect(panel.locator('.browser-viewport'))
      await expect.poll(async () => (await hostViews(app)).length, where).toBe(intersects(bar, viewport) ? 0 : 1)
      return { bar: Math.round(bar.left), statusRight: Math.round(text.ownRight), ellipsized: text.ellipsized, reserve: text.padding }
    }

    const geometry: Record<string, unknown> = {}
    await openMinimized()
    for (const [width, height] of SIZES) {
      await size(launched, width, height)
      geometry[`${width}`] = await expectDocked(`${width}x${height} dark`)
      await composed(launched, `footer-status-beside-minimized-editor-${width}-dark`)
    }
    // At the minimum size the sentence ends in an ellipsis where it once ran under the bar mid-word.
    expect((geometry['820'] as { ellipsized: boolean }).ellipsized).toBe(true)

    // Dragged away, the bar no longer reserves the footer: the status gets its full width back.
    const header = editor.locator('.theme-editor__header h2')
    const grip = await rect(header)
    await page.mouse.move(grip.left + 12, grip.top + grip.height / 2)
    await page.mouse.down()
    for (let step = 1; step <= 10; step++) await page.mouse.move(grip.left + 12 - step * 30, grip.top + grip.height / 2 - step * 25)
    await page.mouse.up()
    await expect.poll(() => footer.evaluate(element => element.style.getPropertyValue('--theme-editor-reserve'))).toBe('')
    await expect.poll(() => footer.evaluate(element => getComputedStyle(element).paddingRight)).toBe('22px')
    await composed(launched, 'footer-status-after-bar-dragged-820-dark')
    // Expanded and closed: nothing is left reserved.
    await editor.getByRole('button', { name: 'Expand the theme editor' }).click()
    await editor.getByRole('button', { name: 'Close the theme editor' }).click()
    await expect(editor).toHaveCount(0)
    await expect.poll(() => footer.evaluate(element => getComputedStyle(element).paddingRight)).toBe('22px')

    await appearance(page, 'light')
    await openMinimized()
    geometry['820-light'] = await expectDocked('820x560 light')
    await composed(launched, 'footer-status-beside-minimized-editor-820-light')
    // Keyboard: from the footer's last link, Tab still reaches the bar's buttons, and Close restores the footer.
    await footer.getByRole('link', { name: 'Help', exact: true }).focus()
    await editor.getByRole('button', { name: 'Expand the theme editor' }).focus()
    await page.keyboard.press('Tab')
    await expect(editor.getByRole('button', { name: 'Close the theme editor' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(editor).toHaveCount(0)
    await expect.poll(() => footer.evaluate(element => getComputedStyle(element).paddingRight)).toBe('22px')
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
    await size(launched, 1600, 1000)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    const panes = page.getByRole('group', { name: 'Thread panes' })
    const pane = (id: string) => panes.locator(`section.thread-pane[data-thread-id="${id}"]`)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    for (const title of ['Footer links', 'Weekly note', 'Visual gate flake']) {
      await sidebar.getByRole('button', { name: title, exact: true }).hover()
      await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click()
    }
    await expect(panes.locator('section.thread-pane[role="region"]:not([data-hidden])')).toHaveCount(4)
    const gate = pane('visual-gate')
    const prompt = gate.getByRole('textbox', { name: 'Prompt', exact: true })
    await expect(prompt).toHaveAttribute('placeholder', INSTRUCTION)
    // The Send button still says why it is off.
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
