import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// The Tools panel's working-folder row in a short window, and a running terminal under the real theme controls, in the
// complete app. AppShell, renderer, preload, IPC, the settings store, the theme engine and the production tools services
// are real. Coding providers come from the explicit unpackaged E2E fixtures; no native account or installed client runs.
// Profiles and working copies are owned temporaries.

const run = promisify(execFile)
const SHOTS = resolve(process.cwd(), 'artifacts/phase-three-ui-final-fixes')
type Mode = 'dark' | 'light'

async function ownedProfile(prefix: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', lightTheme: 'ocean', darkTheme: 'ocean' }))
  return profile
}

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

async function shoot(page: Page, name: string, modes: readonly Mode[] = ['dark', 'light']): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  for (const mode of modes) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), mode)
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
    await page.screenshot({ path: join(SHOTS, `${name}-${mode}.png`), animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
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

test('keeps the working folder to one row in a short window, so an open diff has the panel', async () => {
  test.setTimeout(180_000)
  const launched = await launchSotto('success', await ownedProfile('sotto-e2e-phase3-ui-short-path-'))
  const { page } = launched
  try {
    const { folder, panel } = await workshop(launched)
    await mkdir(join(folder, 'src'), { recursive: true })
    const git = (args: string[]) => run('git', args, { cwd: folder, windowsHide: true, timeout: 15_000 })
    await git(['init', '--quiet'])
    await writeFile(join(folder, 'src/app.ts'), "export function greet(name: string): string {\n  return 'Hello ' + name\n}\n")
    await git(['add', '.'])
    await git(['-c', 'user.name=Sotto verification', '-c', 'user.email=verification@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Owned fixture'])
    await writeFile(join(folder, 'src/app.ts'), [
      'export function greet(name: string): string {', '  return `Hello, ${name}!`', '}', '',
      'export function farewell(name: string): string {', '  return `Goodbye, ${name}.`', '}', '',
      'export const version = 2', '',
    ].join('\n'))

    await panel.getByRole('tab', { name: 'Changes' }).click()
    await panel.getByRole('listbox', { name: 'Changed files' }).getByRole('option', { name: /^app\.ts/u }).click()
    const diff = panel.getByRole('region', { name: 'Changes in src/app.ts' })
    await expect(diff).toContainText('return `Goodbye, ${name}.`')
    const path = panel.locator('.tools-panel__path-text')
    const measure = () => path.evaluate(element => ({
      height: element.getBoundingClientRect().height, clipped: element.scrollWidth > element.clientWidth + 1,
      text: element.textContent, title: element.getAttribute('title'),
    }))

    // A tall window shows the whole folder, wrapped between folder names.
    const tall = await measure()
    expect(tall.height).toBeGreaterThan(30)
    expect(tall.clipped).toBe(false)

    await resize(launched, 820, 560)
    await expect(diff).toBeVisible()
    const short = await measure()
    // One row: the folder's start is ellipsized, and the whole path is still its text and its title.
    expect(short.height).toBeLessThanOrEqual(20)
    expect(short.clipped).toBe(true)
    expect(short.text).toBe(folder)
    expect(short.title).toBe(folder)
    // The end nearest the work is the part left in view.
    const shown = await path.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const box = element.getBoundingClientRect()
      const rects = [...range.getClientRects()]
      return { right: box.right - Math.max(...rects.map(rect => rect.right)), left: Math.min(...rects.map(rect => rect.left)) < box.left - 1 }
    })
    expect(shown.left).toBe(true)
    expect(Math.abs(shown.right)).toBeLessThanOrEqual(2)

    const copy = panel.getByRole('button', { name: 'Copy working folder path' })
    await expect(copy).toBeInViewport()
    await expect(panel.getByRole('button', { name: /: working folder$/u })).toBeInViewport()
    await expect(panel.getByRole('button', { name: 'Pin to Workshop' })).toBeInViewport()
    const heights = await panel.evaluate(element => ({
      identity: element.querySelector('.tools-panel__identity')!.getBoundingClientRect().height,
      diff: element.querySelector('.changes-diff__body')!.getBoundingClientRect().height,
    }))
    expect(heights.identity).toBeLessThanOrEqual(100)
    expect(heights.diff).toBeGreaterThanOrEqual(190)
    await shoot(page, 'tools-path-diff-820x560')

    await copy.click()
    await expect(panel.getByRole('status')).toHaveText('Path copied')
    expect(await launched.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(folder)

    await resize(launched, 1280, 860)
    expect((await measure()).clipped).toBe(false)
    await shoot(page, 'tools-path-diff-1280', ['light'])
  } finally {
    await closeSotto(launched)
    await rm(launched.userData, { recursive: true, force: true }).catch(() => undefined)
  }
})

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

test('repaints one running terminal through the theme gallery and live editor, and stills its cursor under reduced motion', async () => {
  test.setTimeout(240_000)
  const launched = await launchSotto('success', await ownedProfile('sotto-e2e-phase3-ui-terminal-controls-'))
  const { page } = launched
  try {
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
    await mkdir(SHOTS, { recursive: true })

    const threads = async (): Promise<void> => {
      await page.getByRole('link', { name: 'Threads', exact: true }).click()
      await expect(view).toBeVisible()
      await expect(panel.locator('.xterm')).toHaveAttribute('data-probe', 'same-terminal')
    }
    const settings = async (): Promise<void> => {
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
    }
    /** The field xterm draws matches what the page paints for the terminal role now, and reports it. */
    const expectField = async (): Promise<string> => {
      const want = await painted(page, 'var(--tt-terminal-background)')
      await expect.poll(async () => near(await fieldColor(view), want), { message: `field ${want}` }).toBe(true)
      return want
    }

    await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'ocean')
    const ocean = await expectField()

    // The gallery: another built-in theme for both halves.
    await settings()
    await page.getByRole('button', { name: 'Use Copper theme', exact: true }).click()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme-id', 'ocean')
    await threads()
    const emberField = await expectField()
    expect(near(emberField, ocean, 8)).toBe(false)

    // Light mode from the gallery's own tile.
    await settings()
    await page.getByRole('button', { name: 'Use light mode', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await threads()
    const emberLight = await expectField()
    expect(near(emberLight, emberField, 8)).toBe(false)
    await settings()
    await page.getByRole('button', { name: 'Use dark mode', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // The live editor: a terminal background typed in Advanced paints the running terminal while the editor stays open.
    await page.getByRole('button', { name: 'Create theme', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Create theme' })
    await expect(editor).toBeVisible()
    await editor.getByRole('switch', { name: 'Use advanced theme colors' }).check()
    const hex = editor.getByRole('textbox', { name: 'Terminal background hex value' })
    await hex.fill('#3a1f2b')
    await hex.press('Enter')
    await threads()
    await expect(editor).toBeVisible()
    await editor.getByRole('button', { name: 'Minimize the theme editor' }).click()
    expect(await expectField()).toBe('#3a1f2b')
    await page.screenshot({ path: join(SHOTS, 'terminal-live-editor-1280-dark.png'), animations: 'disabled' })

    // Closing without saving puts the saved theme back on the same terminal.
    await editor.getByRole('button', { name: 'Close the theme editor' }).click()
    await expect(editor).toHaveCount(0)
    expect(near(await expectField(), emberField)).toBe(true)

    // Reduced motion from Settings stills the cursor of the same terminal, and Follow system lets it blink again.
    const cursor = panel.locator('.xterm-rows .xterm-cursor')
    await panel.locator('.xterm').click()
    await expect(cursor).toHaveClass(/xterm-cursor-blink/u)
    await settings()
    const motion = page.getByLabel('Reduced motion')
    await motion.selectOption('on')
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await threads()
    await panel.locator('.xterm').click()
    // xterm draws the focused block cursor once the click has reached its textarea.
    await expect(cursor).toHaveClass(/xterm-cursor-block/u)
    await expect(cursor).not.toHaveClass(/xterm-cursor-blink/u)
    // A solid cursor: one fill through more than a whole blink cycle. xterm replaces row spans as it redraws, so each
    // sample reads whichever cursor is in the rows at that moment.
    const fills = await screen.evaluate(async rows => {
      const seen = new Set<string>()
      for (let sample = 0; sample < 24; sample++) {
        const current = rows.querySelector('.xterm-cursor')
        if (current) seen.add(getComputedStyle(current).backgroundColor)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return [...seen]
    })
    expect(fills).toHaveLength(1)
    expect(fills[0]).not.toBe('rgba(0, 0, 0, 0)')
    await settings()
    await motion.selectOption('system')
    await expect(page.locator('html')).not.toHaveAttribute('data-reduced-motion', 'on')
    await threads()
    await panel.locator('.xterm').click()
    await expect(cursor).toHaveClass(/xterm-cursor-blink/u)

    // The same xterm and shell throughout: its element, its tab, its earlier output, and it still runs commands.
    expect(await panel.locator('.terminal-tabs__tab[aria-selected="true"]').getAttribute('id')).toBe(tab)
    await page.keyboard.type('echo AFTERTHEME')
    await page.keyboard.press('Enter')
    await expect.poll(async () => { const text = await screen.innerText(); return text.includes('SOTTOPROBE') && (text.match(/AFTERTHEME/gu) ?? []).length >= 2 }, { timeout: 20_000 }).toBe(true)
    await view.screenshot({ path: join(SHOTS, 'terminal-after-themes-dark.png'), animations: 'disabled' })
  } finally {
    await closeSotto(launched)
    await rm(launched.userData, { recursive: true, force: true }).catch(() => undefined)
  }
})
