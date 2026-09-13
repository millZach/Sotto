import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'

import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

/**
 * The T3-style themes journey on the real Windows Electron app: colour scheme
 * tiles, independent light and dark halves, system changes, contrast and
 * glass, the editor (cancel, save, inspector, resize), import errors, the
 * Open VSX fixture, duplicate and remove, keyboard, reduced motion, and a
 * restart. Run after `npm run build` with SOTTO_THEMES_E2E=1; images land in
 * artifacts/phase-three-themes.
 */
test.skip(process.env.SOTTO_THEMES_E2E !== '1', 'Set SOTTO_THEMES_E2E=1 after npm run build')
test.describe.configure({ mode: 'serial' })

const artifacts = resolve(process.cwd(), 'artifacts/phase-three-themes')
const SIZES = [
  { name: '1280', width: 1280, height: 860 },
  { name: '1600', width: 1600, height: 1000 },
  { name: '820x560', width: 820, height: 560 },
] as const

async function createProfile(settings: Partial<AppSettings> = {}): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-themes-'))
  // Seeded before launch, so the first frame is the finished app, not onboarding.
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, ...settings }), 'utf8')
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false },
    assignments: [], queue: [], activeThreadId: 'grok-previews', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', outbox: [],
  }), 'utf8')
  return profile
}

async function setWindowSize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    // The minimum is on the frame; lowering it lets the content be exactly the smallest supported size.
    window.setMinimumSize(400, 300)
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([width, height])
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
}

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  await page.mouse.move(1, 1)
  await settled(page)
  const path = resolve(artifacts, `${name}.png`)
  if (target) await target.screenshot({ path, caret: 'hide', animations: 'disabled' })
  else await page.screenshot({ path, caret: 'hide', animations: 'disabled' })
}

type Rgb = readonly [number, number, number]

/** The painted pixel just inside a mode tile's left edge, and the accent ink its chosen ring should use. */
async function tileRing(page: Page, tile: Locator): Promise<{ edge: Rgb, accent: Rgb }> {
  await page.mouse.move(1, 1)
  await settled(page)
  const frame = tile.locator('.theme-wireframe')
  const accent = await frame.evaluate(element => {
    const context = document.createElement('canvas').getContext('2d')!
    context.fillStyle = getComputedStyle(element).getPropertyValue('--tt-accent-text').trim() || 'transparent'
    context.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
    return [r, g, b] as const
  })
  const scale = await page.evaluate(() => window.devicePixelRatio)
  const { data, info } = await sharp(await frame.screenshot({ animations: 'disabled', caret: 'hide' })).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const offset = (Math.floor(info.height / 2) * info.width + Math.floor(scale)) * info.channels
  return { edge: [data[offset]!, data[offset + 1]!, data[offset + 2]!], accent }
}

const near = (a: Rgb, b: Rgb, tolerance = 28): boolean => a.every((channel, index) => Math.abs(channel - b[index]!) <= tolerance)

const savedSettings = (page: Page): Promise<AppSettings> => page.evaluate(async () => (await window.sotto!.getSettings()) as AppSettings)
const html = (page: Page): Locator => page.locator('html')
const canvas = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

async function openAppearance(page: Page): Promise<Locator> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  const section = page.locator('#settings-appearance')
  await section.scrollIntoViewIfNeeded()
  return section
}

test.beforeAll(async () => {
  await mkdir(artifacts, { recursive: true })
})

test('themes: halves, system, contrast, glass, editor, inspector, import, Open VSX, removal and restart', async () => {
  test.setTimeout(300_000)
  const profile = await createProfile()
  let launched: LaunchedSotto | undefined
  const notes: string[] = []
  try {
    launched = await launchSotto('phase3-workspace', profile)
    const { page } = launched
    await page.emulateMedia({ colorScheme: 'dark' })
    await setWindowSize(launched, 1600, 1000)

    // First run: Ocean for both halves, the accent picker gone.
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await expect(html(page)).toHaveAttribute('data-theme-id', 'ocean')
    const section = await openAppearance(page)
    await expect(section.getByRole('radiogroup', { name: 'Accent' })).toHaveCount(0)
    await expect(section.getByText('Choose light, dark or system, then a theme for each.')).toBeVisible()
    const cards = section.locator('.theme-grid > *')
    await expect(cards).toHaveCount(6)
    // T3's gallery track: three columns on the wide page.
    const columns = await section.locator('.theme-grid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length)
    expect(columns).toBe(3)
    const darkOcean = await canvas(page)

    // The chosen tile's ring sits inside the settings scroller.
    const darkTile = section.getByRole('button', { name: 'Use dark mode' })
    await expect(darkTile).toHaveAttribute('aria-pressed', 'true')
    const clipped = await darkTile.evaluate(tile => {
      let scroller = tile.parentElement
      while (scroller && !/(auto|scroll)/u.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
      const bounds = tile.getBoundingClientRect()
      const frame = (scroller ?? document.documentElement).getBoundingClientRect()
      return bounds.right > frame.right - 1 || bounds.left < frame.left
    })
    expect(clipped).toBe(false)
    // The ring is really painted above the tile's panes, not hidden behind them.
    const chosen = await tileRing(page, darkTile)
    expect(near(chosen.edge, chosen.accent), JSON.stringify(chosen)).toBe(true)
    notes.push(`The chosen Dark tile's edge pixel is rgb(${chosen.edge.join(', ')}), its accent ink rgb(${chosen.accent.join(', ')}).`)

    // Light and dark halves are chosen independently.
    await section.getByRole('button', { name: 'Use light mode' }).click()
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    const unchosen = await tileRing(page, darkTile)
    expect(near(unchosen.edge, unchosen.accent), JSON.stringify(unchosen)).toBe(false)
    await section.getByRole('button', { name: 'Use Grove light mode' }).click()
    await expect(html(page)).toHaveAttribute('data-theme-id', 'grove')
    await section.getByRole('button', { name: 'Use Iris dark mode' }).click()
    await expect(html(page)).toHaveAttribute('data-theme-id', 'grove')
    await expect.poll(async () => { const saved = await savedSettings(page); return [saved.appearance, saved.lightTheme, saved.darkTheme] }).toEqual(['light', 'grove', 'iris'])
    await section.getByRole('button', { name: 'Use dark mode' }).click()
    await expect(html(page)).toHaveAttribute('data-theme-id', 'iris')
    expect(await canvas(page)).not.toBe(darkOcean)

    // System follows Windows live, picking the matching half.
    await section.getByRole('button', { name: 'Follow the system appearance' }).click()
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await expect(html(page)).toHaveAttribute('data-theme-id', 'grove')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await expect(html(page)).toHaveAttribute('data-theme-id', 'iris')

    // Contrast moves ink, never the room; glass reaches floating surfaces.
    const ink = (): Promise<string> => page.evaluate(() => getComputedStyle(document.querySelector('#settings-appearance h2')!).color)
    const inkBefore = await ink()
    const roomBefore = await canvas(page)
    const contrast = section.getByLabel('Contrast', { exact: true })
    await contrast.focus()
    await page.keyboard.press('End')
    await expect(section.locator('output').first()).toHaveText('200%')
    await expect.poll(ink).not.toBe(inkBefore)
    expect(await canvas(page)).toBe(roomBefore)
    await expect.poll(async () => (await savedSettings(page)).appearanceContrast).toBe(200)
    const glass = section.getByLabel('Glass opacity', { exact: true })
    await glass.focus()
    await page.keyboard.press('Home')
    await expect(section.locator('output').nth(1)).toHaveText('40%')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-glass-opacity').trim())).toBe('40%')
    await expect.poll(async () => (await savedSettings(page)).glassOpacity).toBe(40)
    await shot(page, 'sliders-1600-dark', section.locator('.theme-slider').first().locator('xpath=..'))
    await section.getByRole('button', { name: 'Reset contrast to 100%' }).click()
    await section.getByRole('button', { name: 'Reset glass opacity to 80%' }).click()
    await expect.poll(async () => { const saved = await savedSettings(page); return [saved.appearanceContrast, saved.glassOpacity] }).toEqual([100, 80])

    // Editor: Cancel discards the painted draft; Save keeps it.
    await section.getByRole('button', { name: 'Create theme' }).click()
    const editor = page.getByRole('dialog', { name: 'Create theme' })
    await expect(editor).toBeVisible()
    await editor.getByLabel('Theme name', { exact: true }).fill('Harbor Draft')
    const saved = await canvas(page)
    await editor.getByLabel('Background hex value', { exact: true }).fill('#402030')
    await expect.poll(() => canvas(page)).not.toBe(saved)
    await expect(html(page)).toHaveAttribute('data-theme-id', '__preview')
    await editor.getByRole('button', { name: 'Cancel' }).click()
    await expect(editor).toHaveCount(0)
    await expect.poll(() => canvas(page)).toBe(saved)
    expect((await savedSettings(page)).customThemes).toEqual([])

    await section.getByRole('button', { name: 'Create theme' }).click()
    await editor.getByLabel('Theme name', { exact: true }).fill('Aurora')
    await editor.getByLabel('Background hex value', { exact: true }).fill('#18202c')
    await editor.getByRole('button', { name: 'Create theme' }).click()
    await expect(editor).toHaveCount(0)
    await expect(html(page)).toHaveAttribute('data-theme-id', 'aurora')
    await expect.poll(async () => (await savedSettings(page)).darkTheme).toBe('aurora')

    // Inspector: pick a colour from the page without pressing it, then spotlight its uses.
    await section.getByRole('button', { name: 'Edit Aurora' }).click()
    const edit = page.getByRole('dialog', { name: 'Edit theme' })
    await expect(edit).toBeVisible()
    await edit.getByRole('button', { name: 'Inspect app colors' }).click()
    await expect(edit).toContainText('Select an element · Esc to cancel')
    const heading = section.getByRole('heading', { level: 2, name: 'Appearance' })
    await heading.hover()
    await expect(page.locator('#theme-inspector-hover')).toBeVisible()
    const hoverLabel = await page.locator('#theme-inspector-hover').innerText()
    expect(hoverLabel).toBe('Text')
    notes.push(`Hovering the Appearance heading labels it "${hoverLabel}".`)
    await settled(page)
    await page.screenshot({ path: resolve(artifacts, 'inspector-hover-1600-dark.png'), caret: 'hide', animations: 'disabled' })
    const started = Date.now()
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'History', exact: true }).click()
    await expect(edit.getByRole('button', { name: 'Inspect app colors' })).toHaveAttribute('aria-pressed', 'false')
    notes.push(`A pick took ${Date.now() - started} ms end to end.`)
    // The pick did not navigate.
    await expect(heading).toBeVisible()
    expect(await page.evaluate(() => location.hash)).not.toBe('#history')
    const status = await edit.locator('.theme-editor__header p').innerText()
    expect(status).toMatch(/^[A-Z][a-z ]+ · \d+ uses?$/u)
    await expect(edit.locator('[data-theme-color-role][data-selected]')).toHaveCount(1)
    await expect.poll(() => page.locator('#theme-inspector-spotlight .theme-inspector-spotlight__glow').count()).toBeGreaterThan(0)
    await expect(page.locator('#theme-inspector-hover')).toHaveCount(0)
    notes.push(`Picking the History footer link selects "${status}".`)
    await shot(page, 'inspector-spotlight-1600-dark')

    // A label spotlights its colour; Escape clears it, then closes.
    await expect(edit.getByRole('button', { name: `Hide where ${status.split(' · ')[0]} is used` })).toHaveAttribute('aria-pressed', 'true')
    await edit.getByRole('button', { name: 'Show where Accent is used' }).click()
    await expect(edit.locator('.theme-editor__header p')).toHaveText(/^Accent · \d+ uses?$/u)
    const accentUses = Number((await edit.locator('.theme-editor__header p').innerText()).match(/(\d+)/u)![1])
    expect(accentUses).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('#theme-inspector-spotlight')).toHaveCount(0)
    await expect(edit).toBeVisible()

    // Resize from the corner grip at the smallest window, staying inside it.
    await setWindowSize(launched, 820, 560)
    const grip = edit.locator('.theme-editor__grip')
    const before = (await edit.boundingBox())!
    const handle = (await grip.boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 60, handle.y - 120, { steps: 6 })
    await page.mouse.up()
    const smaller = (await edit.boundingBox())!
    expect(smaller.width).toBeLessThan(before.width)
    expect(smaller.width).toBeGreaterThanOrEqual(280)
    expect(smaller.height).toBeGreaterThanOrEqual(220)
    await page.mouse.move(smaller.x + smaller.width - 4, smaller.y + smaller.height - 4)
    await page.mouse.down()
    await page.mouse.move(2000, 2000, { steps: 6 })
    await page.mouse.up()
    const larger = (await edit.boundingBox())!
    expect(larger.x + larger.width).toBeLessThanOrEqual(820)
    expect(larger.y + larger.height).toBeLessThanOrEqual(560)
    await expect(edit.getByRole('button', { name: 'Save changes' })).toBeInViewport()
    await expect(page.locator('.tt-toast')).toHaveCount(0, { timeout: 10_000 })
    await shot(page, 'theme-editor-resized-820x560-dark')
    await edit.getByRole('button', { name: 'Inspect app colors' }).click()
    await page.keyboard.press('Escape')
    await expect(edit.getByRole('button', { name: 'Inspect app colors' })).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Escape')
    await expect(edit).toHaveCount(0)
    await setWindowSize(launched, 1600, 1000)

    // Import: invalid JSON explains itself; nothing is saved.
    await section.getByRole('button', { name: 'Add theme' }).click()
    const add = page.getByRole('dialog', { name: 'Add a theme' })
    await expect(add).toBeVisible()
    await add.getByLabel('Theme JSON').fill('{"name": "Broken", "colors": ')
    await add.getByRole('button', { name: 'Add theme' }).click()
    await expect(add.getByRole('alert')).toBeVisible()
    notes.push(`Invalid JSON import says: "${await add.getByRole('alert').innerText()}"`)
    await shot(page, 'import-error-1600-dark', add)
    await add.getByLabel('Theme JSON').fill(JSON.stringify({ version: 1, name: 'Evil', appearance: 'dark', colors: { canvas: 'url(https://attacker.example/x.png)' } }))
    await add.getByRole('button', { name: 'Add theme' }).click()
    await expect(add.getByRole('alert')).toBeVisible()
    notes.push(`A CSS URL colour import says: "${await add.getByRole('alert').innerText()}"`)
    expect((await savedSettings(page)).customThemes.map(theme => theme.label)).toEqual(['Aurora'])

    // Open VSX through main's fixture service: search, install, one collection card.
    await add.getByLabel('Search Open VSX themes').fill('harbor')
    await expect(add.getByRole('button', { name: 'Install Harbor Theme' })).toBeVisible()
    await shot(page, 'open-vsx-results-1600-dark', add)
    await add.getByRole('button', { name: 'Install Harbor Theme' }).click()
    await expect(add).toHaveCount(0)
    await expect.poll(async () => (await savedSettings(page)).customThemes.map(theme => theme.label)).toEqual(['Aurora', 'Harbor'])
    await expect(section.getByRole('button', { name: /^Use Harbor/u }).first()).toBeVisible()

    // Duplicate, then remove with the owned half falling back to Ocean.
    await section.getByRole('button', { name: 'Duplicate Grove' }).click()
    const copy = page.getByRole('dialog', { name: 'Create theme' })
    await expect(copy.getByLabel('Theme name', { exact: true })).toHaveValue('Grove copy')
    await copy.getByRole('button', { name: 'Create theme' }).click()
    await expect(html(page)).toHaveAttribute('data-theme-id', 'grove-copy')
    await section.getByRole('button', { name: 'Remove Grove copy' }).click()
    const confirm = page.getByRole('dialog', { name: 'Remove “Grove copy”?' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(html(page)).toHaveAttribute('data-theme-id', 'grove-copy')
    await section.getByRole('button', { name: 'Remove Grove copy' }).click()
    await confirm.getByRole('button', { name: 'Remove theme' }).click()
    await expect(html(page)).toHaveAttribute('data-theme-id', 'ocean')
    await expect.poll(async () => (await savedSettings(page)).darkTheme).toBe('ocean')

    // Keyboard: a card chooses on Enter and keeps focus.
    const aurora = section.getByRole('button', { name: /^Use Aurora theme/u })
    await aurora.focus()
    await page.keyboard.press('Enter')
    await expect(html(page)).toHaveAttribute('data-theme-id', 'aurora')
    await expect(section.getByRole('button', { name: /^Use Aurora theme/u })).toBeFocused()

    // Reduced motion: no theme transitions run.
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    const duration = await section.locator('.theme-mode-tile .theme-wireframe').first().evaluate(element => getComputedStyle(element, '::after').transitionDuration)
    expect(duration.split(',').every(value => Number.parseFloat(value) <= 0.01)).toBe(true)

    // Rendered matrix: widths by scheme, settings and the Threads workspace, once notices have gone.
    await expect(page.locator('.tt-toast')).toHaveCount(0, { timeout: 10_000 })
    for (const scheme of ['light', 'dark', 'system'] as const) {
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, scheme)
      await page.emulateMedia({ colorScheme: scheme === 'light' ? 'dark' : 'light', reducedMotion: 'reduce' })
      const resolved = scheme === 'system' ? 'light' : scheme
      await expect(html(page)).toHaveAttribute('data-theme', resolved)
      for (const size of SIZES) {
        await setWindowSize(launched, size.width, size.height)
        await openAppearance(page)
        await shot(page, `themes-${size.name}-${scheme}`)
        await page.getByRole('link', { name: 'Threads', exact: true }).click()
        await shot(page, `threads-${size.name}-${scheme}`)
      }
    }
    await setWindowSize(launched, 820, 560)
    await openAppearance(page)
    await section.getByRole('button', { name: 'Create theme' }).click()
    await expect(page.getByRole('dialog', { name: 'Create theme' })).toBeInViewport()
    await shot(page, 'theme-editor-820x560-light')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark', appearanceContrast: 150 }) })
    await closeSotto(launched)
    launched = undefined

    // Restart: everything chosen above is still in force on the first frame.
    const settingsFile = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')) as AppSettings
    expect([settingsFile.lightTheme, settingsFile.darkTheme, settingsFile.appearanceContrast]).toEqual(['grove', 'aurora', 150])
    launched = await launchSotto('phase3-workspace', profile)
    await expect(html(launched.page)).toHaveAttribute('data-theme-id', 'aurora')
    await expect.poll(() => launched!.page.evaluate(() => document.documentElement.style.getPropertyValue('--theme-contrast-boost'))).toBe('50%')
    const after = await savedSettings(launched.page)
    expect(after.customThemes.map(theme => theme.label)).toEqual(['Aurora', 'Harbor'])
    expect(after).not.toHaveProperty('accent')
  } finally {
    await writeFile(resolve(artifacts, 'journey-notes.txt'), `${notes.join('\n')}\n`, 'utf8').catch(() => undefined)
    if (launched !== undefined) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})

interface QuietCounts { probes: number, spotlights: number, rootStyles: number }

/** What the page did on its own for `ms`: colour-probe spans added, spotlights drawn, root style writes. */
function quietCounts(page: Page, ms: number): Promise<QuietCounts> {
  return page.evaluate(duration => new Promise<QuietCounts>(done => {
    const counts = { probes: 0, spotlights: 0, rootStyles: 0 }
    const body = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.tagName === 'SPAN' && node.hidden) counts.probes += 1
          if (node instanceof Element && node.id === 'theme-inspector-spotlight') counts.spotlights += 1
        }
      }
    })
    body.observe(document.body, { childList: true, subtree: true })
    const root = new MutationObserver(records => { counts.rootStyles += records.length })
    root.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    setTimeout(() => { body.disconnect(); root.disconnect(); done(counts) }, duration)
  }), ms)
}

test('themes: a spotlight over a drawn diagram goes quiet, and still follows new replies', async () => {
  test.setTimeout(120_000)
  const profile = await createProfile()
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('phase3-workspace', profile)
    const { page } = launched
    await page.emulateMedia({ colorScheme: 'dark' })
    await setWindowSize(launched, 1280, 860)
    const reply = (text: string) => page.evaluate(async body => {
      const state = await window.sotto!.agents!.command({ type: 'connect' })
      const threadId = state.host.threads[0]!.id
      await window.sottoE2E!.agentEvent!({ type: 'ready', threadId, text: body })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId })
    }, text)
    await reply('```mermaid\nflowchart LR\n  A[Theme] --> B[Diagram]\n```')

    // The journey root used to reproduce the loop: editor open, back to Threads, spotlight Background.
    await openAppearance(page)
    await page.locator('#settings-appearance').getByRole('button', { name: 'Create theme' }).click()
    const editor = page.getByRole('dialog', { name: 'Create theme' })
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await expect(page.locator('.rich-diagram').last()).toHaveAttribute('data-state', 'drawn')
    await editor.getByRole('button', { name: 'Show where Background is used', exact: true }).click()
    await expect(page.locator('#theme-inspector-spotlight')).toHaveCount(1)
    await page.mouse.move(1, 1)

    // Allow the first refresh and the diagram's own read to settle, then nothing may repeat.
    await quietCounts(page, 800)
    const idle = await quietCounts(page, 2600)
    expect(idle).toEqual({ probes: 0, spotlights: 0, rootStyles: 0 })
    await shot(page, 'inspector-diagram-1280-dark')

    // A new reply is a real page change: the spotlight refreshes to include it, then goes quiet again.
    const refreshed = quietCounts(page, 1500)
    await reply('```mermaid\nflowchart TD\n  C[Reply] --> D[Refresh]\n```')
    expect((await refreshed).rootStyles).toBeGreaterThan(0)
    await expect(page.locator('.rich-diagram[data-state="drawn"]')).toHaveCount(2)
    await quietCounts(page, 800)
    expect(await quietCounts(page, 2600)).toEqual({ probes: 0, spotlights: 0, rootStyles: 0 })
    await writeFile(resolve(artifacts, 'inspector-diagram-notes.txt'), `Idle for 2600 ms with Background spotlit over a drawn diagram: ${JSON.stringify(idle)}.\nA second reply refreshed the spotlight, then the page went quiet again.\n`, 'utf8')
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})

test('themes: a minimized editor is one row that leaves Send and the footer links reachable', async () => {
  test.setTimeout(120_000)
  const profile = await createProfile()
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('phase3-workspace', profile)
    const { page } = launched
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await openAppearance(page)
    await page.locator('#settings-appearance').getByRole('button', { name: 'Create theme' }).click()
    const editor = page.getByRole('dialog', { name: 'Create theme' })
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await page.locator('.thread-prompt textarea').first().fill('Checking the theme editor stays clear')
    await editor.getByRole('button', { name: 'Minimize the theme editor' }).click()
    await expect(editor).toHaveAttribute('data-minimized', 'true')
    await expect(editor.getByRole('button', { name: 'Inspect app colors' })).toHaveCount(0)

    for (const size of [{ name: '820x560', width: 820, height: 560 }, { name: '1280', width: 1280, height: 860 }]) {
      await setWindowSize(launched, size.width, size.height)
      await settled(page)
      // The bar rests in the footer once the shell has laid out at the new size.
      await expect.poll(async () => { const box = (await editor.boundingBox())!; return box.y + box.height <= size.height && box.y >= size.height - 44 }, { message: size.name }).toBe(true)
      const bar = (await editor.boundingBox())!
      const title = (await editor.getByRole('heading', { name: 'Create theme' }).boundingBox())!
      const expand = (await editor.getByRole('button', { name: 'Expand the theme editor' }).boundingBox())!
      // One row: the title and the buttons share a line, and the bar hugs them.
      expect(Math.abs((title.y + title.height / 2) - (expand.y + expand.height / 2)), size.name).toBeLessThan(4)
      expect(bar.height, size.name).toBeLessThanOrEqual(44)
      expect(bar.x + bar.width).toBeLessThanOrEqual(size.width)

      const send = page.getByRole('button', { name: 'Send prompt' })
      const sendBox = (await send.boundingBox())!
      const links = (await page.locator('.app-footer nav').boundingBox())!
      const overlaps = (a: typeof bar, b: typeof bar) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      expect(overlaps(bar, sendBox), `${size.name} Send`).toBe(false)
      expect(overlaps(bar, links), `${size.name} footer links`).toBe(false)
      // The pointer really lands on Send and on every footer link, not on the bar.
      await send.click({ trial: true, timeout: 2000 })
      for (const link of await page.locator('.app-footer nav a').all()) await link.click({ trial: true, timeout: 2000 })
      await shot(page, `editor-minimized-threads-${size.name}-dark`)
    }

    // Still a working bar: drag it, expand it with the keyboard, close it.
    const header = editor.locator('.theme-editor__header')
    const before = (await editor.boundingBox())!
    await page.mouse.move(before.x + 30, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x - 200, before.y - 200, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => (await editor.boundingBox())!.y).toBeLessThan(before.y - 100)
    await expect(header).toBeVisible()
    await editor.getByRole('button', { name: 'Expand the theme editor' }).focus()
    await page.keyboard.press('Enter')
    await expect(editor.getByRole('button', { name: 'Inspect app colors' })).toBeVisible()
    // Expanding lands on the form's first field.
    await expect(editor.getByLabel('Theme name', { exact: true })).toBeFocused()

    // Dragged as low as it goes while minimized, then expanded, the whole panel comes back into the window.
    await setWindowSize(launched, 820, 560)
    await editor.getByRole('button', { name: 'Minimize the theme editor' }).click()
    const low = (await editor.boundingBox())!
    await page.mouse.move(low.x + 30, low.y + low.height / 2)
    await page.mouse.down()
    await page.mouse.move(40, 2000, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => (await editor.boundingBox())!.y).toBeGreaterThan(480)
    await editor.getByRole('button', { name: 'Expand the theme editor' }).click()
    await expect(editor.getByRole('button', { name: 'Save changes' }).or(editor.getByRole('button', { name: 'Create theme' }))).toBeInViewport()
    const expanded = (await editor.boundingBox())!
    expect(expanded.y).toBeGreaterThanOrEqual(0)
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(560)
    expect(expanded.height).toBeGreaterThan(300)
    await shot(page, 'editor-expanded-after-low-drag-820x560-dark')
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
