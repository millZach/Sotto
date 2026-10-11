import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import fixtures from '../fixtures/omarchy-themes.json'
import { ownedE2EProfile } from './support/e2eProfile'
import { launchSotto, closeSotto, firstSottoWindow, openThreads, openPage } from './support/sottoLaunch'
import { promptField, fillPrompt } from './support/prompt'
import { resizeContentWindow } from './support/sottoWindow'
import { contrastRatio } from '../../src/shared/themes/color'
import { BUILT_IN_THEMES } from '../../src/shared/themes/library'
import { OMARCHY_THEME_ID } from '../../src/shared/themes/omarchy'

/** Read real CSS colours and composite the ancestors and the row's selection image. */
async function measure(element: Locator) {
  return element.evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)))
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    const color = (value: string) => {
      if (!CSS.supports('color', value)) throw new Error(`Unsupported measured colour: ${value}`)
      // Chromium resolves a translucent sRGB mix as color(srgb ... / alpha).
      const srgb = /^color\(srgb ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+)(?: \/ ([\d.e+-]+))?\)$/u.exec(value)
      if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: Number(srgb[4] ?? 1) }
      context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      const data = context.getImageData(0, 0, 1, 1).data
      return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! / 255 }
    }
    const over = (top: ReturnType<typeof color>, bottom: ReturnType<typeof color>) => ({
      r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
    })
    const ancestors: Element[] = []
    for (let at: Element | null = element; at; at = at.parentElement) ancestors.unshift(at)
    let background = color('black')
    const paint: Array<{ element: string; background: string; image: string }> = []
    for (const ancestor of ancestors) {
      const style = getComputedStyle(ancestor)
      if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none') paint.push({ element: ancestor.className, background: style.backgroundColor, image: style.backgroundImage })
      background = over(color(style.backgroundColor), background)
      if (style.backgroundImage.startsWith('linear-gradient(')) {
        // The row images use two identical colours; keep nested colour commas intact.
        const body = style.backgroundImage.slice('linear-gradient('.length)
        let depth = 0, end = 0
        for (; end < body.length; end++) {
          if (body[end] === '(') depth++
          if (body[end] === ')') depth--
          if (body[end] === ',' && depth === 0) break
        }
        background = over(color(body.slice(0, end)), background)
      }
    }
    const foreground = color(getComputedStyle(element).color)
    return { foreground, background: { r: Math.round(background.r), g: Math.round(background.g), b: Math.round(background.b) }, paint }
  })
}

test('Omarchy muted text reads on real selected rows, hover rows, bubbles and layered Changes lines', async () => {
  test.skip(process.platform !== 'linux' || process.env.SOTTO_OMARCHY_MUTED_EVIDENCE !== '1', 'Run tools/verify-omarchy-muted-surfaces.mjs in its owned nested sandbox')
  test.setTimeout(180_000)
  const evidence = process.env.SOTTO_MUTED_EVIDENCE_DIRECTORY!
  const profile = await ownedE2EProfile({ settings: { onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' } })
  const home = join(profile.directory, 'home'), current = join(home, '.local/state/omarchy/current')
  await mkdir(join(current, 'theme'), { recursive: true })
  const selectOmarchy = async (slug: keyof typeof fixtures.themes) => {
    await writeFile(join(current, 'theme.name'), slug)
    await writeFile(join(current, 'theme/sotto.json'), JSON.stringify(fixtures.themes[slug].rendered))
  }
  await selectOmarchy('tokyo-night')
  const launched = await launchSotto('success', profile.directory, {
    createProfile: async () => profile.directory, removeProfile: async () => {}, firstWindow: firstSottoWindow,
    launch: (options = {}) => electron.launch({ ...options, args: ['--ozone-platform=wayland', '--password-store=basic', ...options.args!], env: { ...options.env, HOME: home } }),
  })
  const { page } = launched
  const errors: string[] = [], measurements: unknown[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
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
    await resizeContentWindow(launched, 1600, 1000)
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await fillPrompt(promptField(page), 'Check the text colours')
    await promptField(page).press('Enter')
    await expect(page.locator('.thread-message[data-role="user"] time').first()).toBeVisible()
    // Drive the real Appearance choice once before switching the owned file live.
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
    await page.getByRole('radiogroup', { name: 'Dark theme' }).getByRole('radio', { name: /^Omarchy Tokyo Night$/ }).click()
    await openThreads(page)
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tab', { name: 'Changes', exact: true }).click()
    await panel.getByRole('button', { name: 'Expand colours.txt', exact: true }).click()
    const lines = panel.getByRole('grid', { name: 'Lines of colours.txt' })
    const record = async (theme: string, group: string, surface: string, element: Locator) => {
      const pair = await measure(element)
      const ratio = contrastRatio(pair.foreground, pair.background)
      measurements.push({ theme, group, surface, ...pair, ratio })
      if (group === 'Omarchy') expect(ratio, `${theme}: ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    const collect = async (theme: string, group: string) => {
      // Narrow nested outputs hide the sidebar while Tools is open. Drive each
      // surface where it is visible, rather than sampling hidden sidebar nodes.
      await page.getByRole('button', { name: 'Tools', exact: true }).click()
      await expect(page.locator('.thread-nav__row[data-current]').first()).toBeVisible()
      await record(theme, group, 'selected sidebar row', page.locator('.thread-nav__row[data-current] .thread-nav__time').first())
      const hoverRow = page.locator('.thread-nav__row:not([data-current])').filter({ visible: true }).first()
      await hoverRow.hover()
      await record(theme, group, 'hovered sidebar row', hoverRow.locator('.thread-nav__time'))
      await record(theme, group, 'message bubble', page.locator('.thread-message[data-role="user"] time').first())
      await page.getByRole('button', { name: 'Tools', exact: true }).click()
      const expand = panel.getByRole('button', { name: 'Expand colours.txt', exact: true })
      if (await expand.isVisible()) await expand.click()
      for (const kind of ['context', 'add', 'remove']) {
        const row = lines.locator(`[data-position][data-kind="${kind}"]`).first()
        await row.hover()
        await record(theme, group, `hovered Changes ${kind}`, row.locator('.changes-line__number').filter({ hasText: /\d/u }).first())
        await row.click()
        await expect(row).toHaveAttribute('aria-selected', 'true')
        // The hovered selector is more specific than selection. Move the pointer
        // away so this samples the 22% picked wash, rather than hover again.
        await panel.getByRole('tab', { name: 'Changes', exact: true }).hover()
        await expect(row).toHaveCSS('background-image', /\/ 0\.22\)/u)
        await record(theme, group, `selected Changes ${kind}`, row.locator('.changes-line__number').filter({ hasText: /\d/u }).first())
      }
    }
    for (const slug of Object.keys(fixtures.themes) as Array<keyof typeof fixtures.themes>) {
      await selectOmarchy(slug)
      const appearance = fixtures.themes[slug].rendered.appearance as 'light' | 'dark'
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance, lightTheme: '__omarchy', darkTheme: '__omarchy' }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme-id', OMARCHY_THEME_ID)
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).omarchyTheme?.sourceName)).toBe(slug.split('-').map(word => word[0]!.toUpperCase() + word.slice(1)).join(' '))
      await collect(slug, 'Omarchy')
      if (slug === 'tokyo-night' || slug === 'catppuccin-latte') execFileSync('grim', [join(evidence, `changes-${slug}.png`)], { env: process.env })
    }
    for (const theme of BUILT_IN_THEMES) for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate(async ({ appearance, id }) => window.sotto!.updateSettings({ appearance, lightTheme: id, darkTheme: id }), { appearance, id: theme.id })
      await expect(page.locator('html')).toHaveAttribute('data-theme-id', theme.id)
      await collect(`${theme.label} ${appearance}`, 'Built-in')
    }
    expect(errors).toEqual([])
    await writeFile(join(evidence, 'browser-measurements.json'), JSON.stringify({ measurements, errors }, null, 2) + '\n')
  } catch (error) {
    execFileSync('grim', [join(evidence, 'sandbox/failure.png')], { env: process.env })
    await writeFile(join(evidence, 'sandbox/failure.txt'), await page.locator('body').innerText())
    throw error
  } finally { await closeSotto(launched); await profile.dispose() }
})
