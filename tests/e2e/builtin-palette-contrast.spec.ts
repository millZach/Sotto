import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { ownedE2EProfile } from './support/e2eProfile'
import { measurePaintedPair } from './support/paintedPair'
import { evidenceDirectory } from '../fixtures/evidence'
import { launchSotto, closeSotto, firstSottoWindow, openThreads, toggleTools } from './support/sottoLaunch'
import { promptField, fillPrompt } from './support/prompt'
import { contrastRatio } from '../../src/shared/themes/color'
import { BUILT_IN_THEMES } from '../../src/shared/themes/library'

/**
 * Captures the surfaces #936 fixes, in every built-in half, for the before-and-after page
 * (docs/prototypes/builtin-palette-contrast-prototype.html). Run it through
 * tools/capture-builtin-palette-contrast.mjs, which owns the nested display and a private session bus;
 * every capture is grim on the nested output.
 */
test('captures the built-in palettes\' text surfaces on the owned nested display', async () => {
  test.skip(process.platform !== 'linux' || process.env.SOTTO_PALETTE_CONTRAST_EVIDENCE !== '1', 'Run tools/capture-builtin-palette-contrast.mjs in its owned nested sandbox')
  test.setTimeout(300_000)
  const evidence = evidenceDirectory('artifacts/builtin-palette-contrast')
  await mkdir(evidence, { recursive: true })
  const profile = await ownedE2EProfile({ settings: { onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' } })
  const home = join(profile.directory, 'home')
  // The folder browser lists the home folder: two folders, one a Git checkout so its tag shows.
  await mkdir(join(home, 'code/.git'), { recursive: true })
  await mkdir(join(home, 'notes'), { recursive: true })
  const launched = await launchSotto('success', profile.directory, {
    createProfile: async () => profile.directory, removeProfile: async () => {}, firstWindow: firstSottoWindow,
    launch: (options = {}) => electron.launch({ ...options, args: ['--ozone-platform=wayland', '--password-store=basic', ...options.args!], env: { ...options.env, HOME: home } }),
  })
  const { page } = launched
  const errors: string[] = [], measurements: unknown[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    execFileSync('hyprctl', ['dismissnotify'], { env: process.env })
    const folder = await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      const state = await window.sotto!.agents!.command({ type: 'connect' })
      return state.host.projects[0]!.path
    })
    expect(folder.startsWith(profile.directory)).toBe(true)
    await mkdir(folder, { recursive: true })
    const git = (args: string[]) => execFileSync('git', args, { cwd: folder })
    git(['init', '--quiet', '-b', 'main'])
    await writeFile(join(folder, 'colours.txt'), 'First line\nOld line\nLast line\n')
    git(['add', '.'])
    git(['-c', 'user.name=Sotto verification', '-c', 'user.email=verification@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Keep the original lines'])
    await writeFile(join(folder, 'colours.txt'), 'First line\nNew line\nLast line\n')
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await fillPrompt(promptField(page), 'Check the text colours')
    await promptField(page).press('Enter')
    await expect(page.locator('.thread-message[data-role="user"] time').first()).toBeVisible()

    const pid = launched.app.process().pid
    const windowGeometry = () => {
      const clients = JSON.parse(execFileSync('hyprctl', ['-j', 'clients'], { env: process.env, encoding: 'utf8' })) as Array<{ pid: number; at: [number, number]; size: [number, number] }>
      const client = clients.find(item => item.pid === pid) ?? (clients.length === 1 ? clients[0] : undefined)
      if (!client) throw new Error('The Sotto window is not on the nested display')
      return [...client.at, ...client.size].join(',')
    }
    const settled = async (elements: Locator[]) => {
      // The compositor presents a frame or two after the page paints; grim reads what it has presented.
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(undefined)))))
      await page.waitForTimeout(300)
      const boxes = await Promise.all(elements.map(async element => { await expect(element).toBeInViewport(); return (await element.boundingBox())! }))
      return { geometry: windowGeometry(), boxes: JSON.stringify(boxes), parsed: boxes }
    }
    const capture = async (name: string, ...elements: Locator[]) => {
      // Retake until the window and the elements hold still across the capture, so the crop is what it names.
      for (let attempt = 0; ; attempt++) {
        const before = await settled(elements)
        const [x, y] = before.geometry.split(',').map(Number) as [number, number]
        const left = Math.floor(Math.min(...before.parsed.map(box => box.x))) - 6, top = Math.floor(Math.min(...before.parsed.map(box => box.y))) - 6
        const right = Math.ceil(Math.max(...before.parsed.map(box => box.x + box.width))) + 6, bottom = Math.ceil(Math.max(...before.parsed.map(box => box.y + box.height))) + 6
        execFileSync('grim', ['-g', `${x + left},${y + top} ${right - left}x${bottom - top}`, join(evidence, `${name}.png`)], { env: process.env })
        const after = await settled(elements)
        if (after.geometry === before.geometry && after.boxes === before.boxes) return
        if (attempt === 4) throw new Error(`${name} kept moving while it was captured`)
      }
    }
    const record = async (half: string, surface: string, element: Locator) => {
      await expect(element).toBeInViewport()
      const pair = await measurePaintedPair(element)
      measurements.push({ half, surface, ...pair, ratio: contrastRatio(pair.foreground, pair.background) })
    }
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    const lines = panel.getByRole('grid', { name: 'Lines of colours.txt' })

    // At this size the sidebar, the thread and the docked Tools panel stand side by side, so Tools stays open.
    await toggleTools(page)
    const changesTab = panel.getByRole('tab', { name: 'Changes', exact: true })
    await changesTab.click()
    const expand = panel.getByRole('button', { name: 'Expand colours.txt', exact: true })
    await expect(expand.or(lines)).toBeVisible()
    if (await expand.isVisible()) await expand.click()
    await expect(lines).toBeVisible()
    await expect(page.locator('.thread-nav__row[data-current]').first()).toBeVisible()

    for (const theme of BUILT_IN_THEMES) for (const appearance of ['light', 'dark'] as const) {
      const half = `${theme.id}-${appearance}`
      await page.evaluate(async ({ appearance, id }) => window.sotto!.updateSettings({ appearance, lightTheme: id, darkTheme: id }), { appearance, id: theme.id })
      await expect(page.locator('html')).toHaveAttribute('data-theme-id', theme.id)
      await page.mouse.move(2, 450)

      // The thread list, with the current row and its neighbours, and the user's bubble.
      const current = page.locator('.thread-nav__row[data-current]').first()
      await expect(current).toBeVisible()
      const rows = page.locator('.thread-nav__row').filter({ visible: true })
      const index = await current.evaluate(row => [...document.querySelectorAll('.thread-nav__row')].filter(item => (item as HTMLElement).offsetParent !== null).indexOf(row))
      await capture(`${half}-sidebar`, ...[index - 1, index, index + 1].filter(at => at >= 0).map(at => rows.nth(at)))
      await record(half, 'selected sidebar row: time', current.locator('.thread-nav__time'))
      const bubble = page.locator('.thread-message[data-role="user"]').first()
      await capture(`${half}-bubble`, bubble)
      await record(half, 'message bubble: time', bubble.locator('time'))

      // Strong hover: the folder browser's highlighted choice, with its muted Git tag.
      await page.getByRole('button', { name: 'Add project', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: /Where should this project live\?/ })
      const choices = dialog.locator('.new-thread-choice')
      await expect(choices.first()).toHaveAttribute('data-highlighted')
      await capture(`${half}-strong-hover`, choices.first(), choices.nth(1))
      await record(half, 'strong hover: Git tag', choices.first().locator('.folder-browser__tag'))
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      // Changes: every line picked, then the pointer moved off so the selection, not the hover, paints.
      const picked = lines.locator('[data-position]')
      await picked.first().click()
      await picked.last().click({ modifiers: ['Shift'] })
      await changesTab.hover()
      for (const kind of ['context', 'add', 'remove']) await expect(lines.locator(`[data-position][data-kind="${kind}"]`).first()).toHaveAttribute('aria-selected', 'true')
      await capture(`${half}-changes`, lines)
      for (const kind of ['context', 'add', 'remove']) {
        const row = lines.locator(`[data-position][data-kind="${kind}"]`).first()
        await record(half, `selected Changes ${kind}: number`, row.locator('.changes-line__number').filter({ hasText: /\d/u }).first())
        if (kind !== 'context') await record(half, `selected Changes ${kind}: sign`, row.locator('.changes-line__sign'))
      }
      // Escape in the lines lets go of the picked lines, ready for the next half.
      await page.keyboard.press('Escape')
      await expect(picked.first()).not.toHaveAttribute('aria-selected', 'true')
    }
    expect(errors).toEqual([])
    await writeFile(join(evidence, 'measurements.json'), JSON.stringify({ measurements, errors }, null, 2) + '\n')
  } catch (error) {
    execFileSync('grim', [join(evidence, 'failure.png')], { env: process.env })
    await writeFile(join(evidence, 'failure.txt'), await page.locator('body').innerText())
    throw error
  } finally { await closeSotto(launched); await profile.dispose() }
})
