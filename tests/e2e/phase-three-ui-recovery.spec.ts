import { createServer } from 'node:http'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'
import { forceDomTerminalRenderer } from './support/terminal'

// Recovery states of the Phase 3 tools and Chats in the complete app. AppShell, renderer, preload, IPC and the production
// browser, terminal and personal chat services are real. Coding providers and the personal Codex connection come from the
// explicit unpackaged E2E fixtures; no native account or installed client runs. Each refusal is produced for real: the
// browser's working folder is moved away, and the personal fixture's own storage is made unwritable so its send fails
// after the service has accepted it. The terminal selection check writes explicit Ocean roles to isolate color conversion
// and contrast. phase-three-ui-final-fixes.spec.ts separately verifies the retained terminal through real theme controls.

const SHOTS = resolve(process.cwd(), 'artifacts/phase-three-ui-recovery')
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

async function appearance(page: Page, mode: Mode): Promise<void> {
  await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
}

async function shoot(page: Page, name: string, modes: readonly Mode[] = ['dark', 'light']): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  for (const mode of modes) {
    await appearance(page, mode)
    await page.screenshot({ path: join(SHOTS, `${name}-${mode}.png`), animations: 'disabled' })
  }
  await appearance(page, 'dark')
}

async function hostViews(app: ElectronApplication): Promise<{ url: string; bounds: Electron.Rectangle }[]> {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    return host.contentView.children.filter(view => view instanceof WebContentsView).map(view => ({ url: (view as Electron.WebContentsView).webContents.getURL(), bounds: view.getBounds() }))
  })
}

async function workshop(launched: LaunchedSotto): Promise<{ folder: string; panel: Locator }> {
  const { page } = launched
  const folder = await page.evaluate(async () => {
    const agents = window.sotto!.agents!
    await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
    const state = await agents.command({ type: 'connect' })
    const thread = state.host.threads.find(item => item.id === 'workshop')!
    return state.host.projects.find(project => project.id === thread.projectId)!.path
  })
  expect(folder.startsWith(launched.userData)).toBe(true)
  await resize(launched, 1280, 860)
  await page.getByRole('link', { name: 'Threads', exact: true }).click()
  await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  return { folder, panel: page.getByRole('complementary', { name: 'Tools' }) }
}

test('explains a page main refused to show, and shows it again on Try again once the folder is back', async () => {
  test.setTimeout(180_000)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Atlas preview</title><body style="margin:0;font:600 28px system-ui;background:#1f6feb;color:white;display:grid;place-items:center;height:100vh">Atlas local app</body>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The local page has no port.')
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launchSotto('success', await ownedProfile('sotto-e2e-phase3-ui-refused-'))
  const { app, page } = launched
  let moved: string | null = null
  try {
    const { folder, panel } = await workshop(launched)
    await panel.getByRole('tab', { name: 'Browser' }).click()
    await panel.getByRole('textbox', { name: 'Address for a new page' }).fill(url)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await hostViews(app)).filter(view => view.url === url).length, { timeout: 20_000 }).toBe(1)

    // The folder goes away, and the panel's rectangle changes: main refuses to place the page and says why.
    moved = `${folder}-moved`
    await rename(folder, moved)
    await resize(launched, 1200, 860)
    const refused = panel.locator('.browser-page').getByRole('alert')
    await expect(refused).toContainText('This page could not be shown.', { timeout: 15_000 })
    await expect(refused).toContainText('The working folder is not available.')
    await expect(refused).not.toContainText('Files')
    await expect(refused.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(refused.getByRole('button', { name: 'Open in system browser' })).toBeVisible()
    // No native page is left over the explanation, so the page capture shows what is on screen.
    expect(await hostViews(app)).toEqual([])
    await shoot(page, 'browser-refused-1200')
    await resize(launched, 820, 560)
    await expect(refused.getByRole('button', { name: 'Try again' })).toBeInViewport()
    await shoot(page, 'browser-refused-820x560', ['dark'])
    // Still refused at a new size: the refusal holds until the reader asks again.
    expect(await hostViews(app)).toEqual([])

    await rename(moved, folder)
    moved = null
    await refused.getByRole('button', { name: 'Try again' }).click()
    await expect(panel.locator('.browser-page').getByRole('alert')).toHaveCount(0)
    const viewport = await panel.locator('.browser-viewport').evaluate(element => {
      const box = element.getBoundingClientRect()
      return { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.right) - Math.round(box.left), height: Math.round(box.bottom) - Math.round(box.top) }
    })
    await expect.poll(() => hostViews(app), { timeout: 15_000 }).toEqual([{ url, bounds: viewport }])
  } finally {
    if (moved !== null) await rename(moved, moved.slice(0, -'-moved'.length)).catch(() => undefined)
    await closeSotto(launched)
    await new Promise(done => server.close(done))
    await rm(launched.userData, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('recovers a message Codex did not take into the composer, after a newer draft, without sending it again', async () => {
  test.setTimeout(180_000)
  const profile = await ownedProfile('sotto-e2e-phase3-ui-failed-send-')
  const launched = await launchSotto('success', profile)
  const { page } = launched
  const native = join(profile, 'e2e-personal-native.json')
  try {
    await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: 'low' } })
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

    // The fixture provider can no longer save its conversation, so the next send fails after main accepted it.
    await rm(native, { force: true })
    await mkdir(native)
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
    await expect(pending).toContainText(original)
    await expect(pending).not.toContainText('Edit it in the composer')
    await expect(composer).toHaveValue('')

    // A newer draft, typed after the failure.
    await composer.click()
    await page.keyboard.type('Also check the weather')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.personalChats!.get()).chats[0]!.draft.text)).toBe('Also check the weather')
    const recover = pending.getByRole('button', { name: 'Edit in composer' })
    await expect(recover).toBeVisible()
    await shoot(page, 'chat-not-sent-1280')
    await recover.click()

    await expect(composer).toHaveValue(`Also check the weather\n\n${original}`)
    await expect(composer).toBeFocused()
    await expect(pending.getByText('It is in the composer.')).toBeVisible()
    await expect.poll(() => page.evaluate(async () => {
      const chat = (await window.sotto!.personalChats!.get()).chats[0]!
      return { text: chat.draft.text, skills: chat.draft.skills.map(skill => skill.name), sends: chat.submissions.filter(item => item.text.startsWith('Book the ferry')).length }
    })).toEqual({ text: `Also check the weather\n\n${original}`, skills: ['brainstorm'], sends: 1 })
    await shoot(page, 'chat-not-sent-recovered-1280')
    await resize(launched, 820, 560)
    await expect(pending.getByText('It is in the composer.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport()
    await shoot(page, 'chat-not-sent-recovered-820x560', ['dark'])

    // Sending it again is the reader's choice, and goes through once the provider can save again.
    await rm(native, { recursive: true, force: true })
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(composer).toHaveValue('')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.personalChats!.get()).chats[0]!.submissions.at(-1)!.status), { timeout: 15_000 }).toBe('accepted')
  } finally {
    await rm(native, { recursive: true, force: true }).catch(() => undefined)
    await closeSotto(launched)
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
})

/** Ocean's terminal roles from the theme engine's tokens.css, and its contrast properties, per mode. */
const OCEAN: Record<Mode, Record<string, string>> = {
  dark: {
    '--theme-terminal-background': 'oklch(0.242641 0.024125 250.573)', '--theme-terminal-foreground': 'oklch(0.990339 0.008411 325.64)',
    '--theme-terminal-cursor': 'oklch(0.758933 0.105833 241.548)', '--theme-terminal-selection': 'oklch(0.439946 0.0561 243.479)',
    '--theme-terminal-scrollbar': 'oklch(0.58613 0.012959 267.22)', '--theme-terminal-scrollbar-hover': 'oklch(0.681569 0.010909 276.465)',
    '--theme-contrast-target': 'white',
  },
  light: {
    '--theme-terminal-background': 'oklch(0.974199 0.002856 241.597)', '--theme-terminal-foreground': 'oklch(0.222003 0.03479 328.979)',
    '--theme-terminal-cursor': 'oklch(0.536684 0.120219 247.01)', '--theme-terminal-selection': 'oklch(0.895373 0.023469 241.913)',
    '--theme-terminal-scrollbar': 'oklch(0.826271 0.006191 305.456)', '--theme-terminal-scrollbar-hover': 'oklch(0.756866 0.008685 313.721)',
    '--theme-contrast-target': 'black',
  },
}
/** The semantic terminal variables exactly as tokens.css derives them. */
const ROLES = {
  '--tt-terminal-background': 'var(--theme-terminal-background)',
  '--tt-terminal-foreground': 'color-mix(in oklab, color-mix(in oklab, var(--theme-terminal-foreground) var(--theme-contrast-base), var(--theme-terminal-background)), var(--theme-contrast-target) var(--theme-contrast-boost))',
  '--tt-terminal-cursor': 'var(--theme-terminal-cursor)',
  '--tt-terminal-selection': 'var(--theme-terminal-selection)',
  '--tt-terminal-scrollbar': 'var(--theme-terminal-scrollbar)',
  '--tt-terminal-scrollbar-hover': 'var(--theme-terminal-scrollbar-hover)',
}

async function paintTheme(page: Page, mode: Mode, themeId: string, values: Record<string, string>): Promise<void> {
  await page.evaluate(([mode, themeId, values]) => {
    const root = document.documentElement
    root.dataset.theme = mode
    root.dataset.themeId = themeId
    for (const [name, value] of Object.entries(values)) root.style.setProperty(name, value)
  }, [mode, themeId, values] as const)
}

/** The sRGB the page paints for a CSS colour, independently of the terminal's own resolver. */
function painted(page: Page, css: string): Promise<string> {
  return page.evaluate(css => {
    const probe = document.body.appendChild(document.createElement('div'))
    probe.style.background = css
    const context = document.createElement('canvas').getContext('2d')!
    context.fillStyle = getComputedStyle(probe).backgroundColor
    probe.remove()
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return `#${[r, g, b].map(channel => channel!.toString(16).padStart(2, '0')).join('')}`
  }, css)
}

interface Selected { readonly background: string; readonly color: string; readonly contrast: number }

/** The first selected cell's colours in a terminal row, as xterm rendered them, or null when nothing there is selected. */
function readSelected(row: Element): Selected | null {
  const cell = [...row.querySelectorAll<HTMLElement>('span')].find(span => span.style.backgroundColor !== '')
  if (!cell) return null
  const style = getComputedStyle(cell)
  const channels = (value: string): number[] => (value.match(/\d+(?:\.\d+)?/gu) ?? []).slice(0, 3).map(Number)
  const luminance = (value: string): number => {
    const [r = 0, g = 0, b = 0] = channels(value).map(channel => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const hex = (value: string): string => `#${channels(value).map(channel => channel.toString(16).padStart(2, '0')).join('')}`
  const [light = 0, dark = 0] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a)
  return { background: hex(style.backgroundColor), color: hex(style.color), contrast: Math.round((light + 0.05) / (dark + 0.05) * 100) / 100 }
}

function near(actual: string | undefined, expected: string, tolerance = 3): boolean {
  if (!actual) return false
  const channels = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
  const a = channels(actual), b = channels(expected)
  return a.every((value, index) => Math.abs(value - b[index]!) <= tolerance)
}

/** The most common colour in a capture of the element: for the terminal, the field behind its rows. */
async function fieldColor(locator: Locator): Promise<string> {
  const { data, info } = await sharp(await locator.screenshot({ animations: 'disabled' })).raw().toBuffer({ resolveWithObject: true })
  const counts = new Map<string, number>()
  for (let index = 0; index < data.length; index += info.channels) {
    const key = `#${[data[index]!, data[index + 1]!, data[index + 2]!].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
}

test('repaints a running terminal with the DOM fallback for theme, same-mode colour and contrast changes, with selected text readable', async () => {
  test.setTimeout(180_000)
  const launched = await launchSotto('success', await ownedProfile('sotto-e2e-phase3-ui-terminal-theme-'))
  const { page } = launched
  try {
    await forceDomTerminalRenderer(page)
    const { panel } = await workshop(launched)
    await panel.getByRole('tab', { name: 'Terminal' }).click()
    await panel.getByRole('button', { name: 'Start terminal' }).click()
    const screen = panel.locator('.xterm-rows')
    await expect(screen).toBeVisible()
    await panel.locator('.xterm').click()
    await page.keyboard.type('echo SOTTOPROBE')
    await page.keyboard.press('Enter')
    await expect.poll(async () => ((await screen.innerText()).match(/SOTTOPROBE/gu) ?? []).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
    await panel.locator('.xterm').evaluate(element => { element.dataset.probe = 'same-terminal' })
    const tab = await panel.locator('.terminal-tabs__tab[aria-selected="true"]').getAttribute('id')
    const view = panel.locator('.terminal-view')
    const row = panel.locator('.xterm-rows > div').filter({ hasText: /^SOTTOPROBE\s*$/u }).last()
    await mkdir(SHOTS, { recursive: true })

    /** The field and selection match the theme; xterm may raise foreground contrast to keep text readable. */
    const expectSelection = async (): Promise<Selected> => {
      const want = { background: await painted(page, 'var(--tt-terminal-selection)'), color: await painted(page, 'var(--tt-terminal-foreground)'), field: await painted(page, 'var(--tt-terminal-background)') }
      await expect.poll(async () => near(await fieldColor(view), want.field), { message: `field ${want.field}` }).toBe(true)
      let seen: Selected | null = null
      await expect.poll(async () => {
        seen = await row.evaluate(readSelected)
        return near(seen?.background, want.background) && (seen?.contrast ?? 0) >= 4.5
      }, { message: `selection ${JSON.stringify(want)}` }).toBe(true)
      return seen!
    }
    const box = (await row.locator('span').first().boundingBox())!
    const select = () => page.mouse.dblclick(box.x + 30, box.y + box.height / 2)

    // Ocean dark, as the theme engine applies it.
    await paintTheme(page, 'dark', 'ocean', { ...OCEAN.dark, '--theme-contrast-base': '100%', '--theme-contrast-boost': '0%', ...ROLES })
    await select()
    const dark = await expectSelection()
    expect(dark.contrast, JSON.stringify(dark)).toBeGreaterThanOrEqual(4.5)
    await view.screenshot({ path: join(SHOTS, 'terminal-ocean-selected-dark.png'), animations: 'disabled' })

    // Same mode and theme, editor changes with the word still selected: field and selection, foreground, then contrast.
    await paintTheme(page, 'dark', 'ocean', { '--theme-terminal-background': 'oklch(0.2 0.03 160)', '--theme-terminal-selection': 'oklch(0.5 0.09 160)' })
    await expectSelection()
    await paintTheme(page, 'dark', 'ocean', { '--theme-terminal-foreground': 'oklch(0.72 0.02 160)' })
    const dimmer = await expectSelection()
    await paintTheme(page, 'dark', 'ocean', { '--theme-contrast-boost': '60%' })
    const boosted = await expectSelection()
    // Both colors can reach the same minimum-contrast floor; the boost must not reduce readability.
    expect(boosted.contrast, `${JSON.stringify(dimmer)} -> ${JSON.stringify(boosted)}`).toBeGreaterThanOrEqual(dimmer.contrast)
    await view.screenshot({ path: join(SHOTS, 'terminal-edited-selected-dark.png'), animations: 'disabled' })

    // Ocean light.
    await paintTheme(page, 'light', 'ocean', { ...OCEAN.light, '--theme-contrast-boost': '0%' })
    const light = await expectSelection()
    expect(light.contrast, JSON.stringify(light)).toBeGreaterThanOrEqual(4.5)
    await view.screenshot({ path: join(SHOTS, 'terminal-ocean-selected-light.png'), animations: 'disabled' })
    await page.screenshot({ path: join(SHOTS, 'terminal-ocean-panel-1280-light.png'), animations: 'disabled' })

    // The same xterm and shell throughout: its element, its tab, its earlier output, and it still runs commands.
    await expect(panel.locator('.xterm')).toHaveAttribute('data-probe', 'same-terminal')
    expect(await panel.locator('.terminal-tabs__tab[aria-selected="true"]').getAttribute('id')).toBe(tab)
    await panel.locator('.xterm').click()
    await page.keyboard.type('echo AFTERTHEME')
    await page.keyboard.press('Enter')
    await expect.poll(async () => { const text = await screen.innerText(); return text.includes('SOTTOPROBE') && (text.match(/AFTERTHEME/gu) ?? []).length >= 2 }, { timeout: 20_000 }).toBe(true)
  } finally {
    await closeSotto(launched)
    await rm(launched.userData, { recursive: true, force: true }).catch(() => undefined)
  }
})
