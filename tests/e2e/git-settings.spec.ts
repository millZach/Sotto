import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// Settings → Git, the owner's pick B (grouped by moment), in the built app: every size and both rooms, the
// keyboard path through the section, the example under the style, and saves that read back.
const evidence = resolve('artifacts/git-settings')
const sizes = [[1600, 1000], [1280, 800], [820, 560]] as const

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    host.setMinimumSize(800, 540)
    host.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** Nothing overflows the form or the window, and no control is cut off at either side. */
function layoutProblems(page: Page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('.settings-scroll')!
    const panel = document.getElementById('settings-git')!
    const frame = scroll.getBoundingClientRect()
    const clipped = [...panel.querySelectorAll<HTMLElement>('select,button,textarea,dd,p,h3')]
      .filter(element => element.getClientRects().length)
      .filter(element => { const box = element.getBoundingClientRect(); return box.left < frame.left - 1 || box.right > frame.right + 1 })
      .map(element => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 60))
    return { pageOverflow: document.documentElement.scrollWidth > innerWidth, formOverflow: scroll.scrollWidth > scroll.clientWidth + 1, clipped }
  })
}

/** The contrast of each piece of the example's text against the surface it sits on. */
function exampleContrast(page: Page) {
  return page.evaluate(() => {
    // Computed colours arrive as oklab or oklch; a canvas turns any of them into sRGB bytes.
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const parse = (value: string): number[] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r!, g!, b!, a! / 255]
    }
    const background = (element: Element | null): number[] => {
      const layers: number[][] = []
      for (let node = element; node; node = node.parentElement) {
        const colour = parse(getComputedStyle(node).backgroundColor)
        if (colour[3]! > 0) layers.push(colour)
        if (colour[3] === 1) break
      }
      return layers.reverse().reduce((under, over) => under.map((channel, index) => index === 3 ? 1 : over[index]! * over[3]! + channel * (1 - over[3]!)), [0, 0, 0, 1])
    }
    const luminance = ([r, g, b]: number[]): number => {
      const linear = (channel: number): number => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!)
    }
    const example = document.querySelector('.git-settings__example')!
    const surface = background(example)
    return [...example.querySelectorAll('dt, dd, p'), ...document.querySelectorAll('.git-settings__group > h3')].map(element => {
      const text = parse(getComputedStyle(element).color)
      const blended = text.map((channel, index) => index === 3 ? 1 : channel * text[3]! + surface[index]! * (1 - text[3]!))
      const [light, dark] = [luminance(blended), luminance(element.closest('.git-settings__example') ? surface : background(element))].sort((a, b) => b - a)
      return { text: element.textContent!.slice(0, 30), ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100 }
    })
  })
}

test('Settings → Git groups every Git setting by moment, fits every size in both rooms, and saves from the keyboard', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(180_000)
  await mkdir(evidence, { recursive: true })
  const launched = await launchSotto('success')
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const settings = () => page.evaluate(() => window.sotto!.getSettings())
  try {
    await page.evaluate(async () => { await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }) })
    await page.reload()
    await resize(launched, 1280, 800)
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    const sections = page.getByRole('tablist', { name: 'Settings sections' })
    await sections.getByRole('tab', { name: 'Git', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: 'Git', exact: true })
    await expect(panel.getByRole('heading', { level: 3 })).toHaveText(['When a thread commits', 'When a pull request is made or merged', 'When you read Changes', 'In the background'])

    for (const [width, height] of sizes) {
      await resize(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
        expect(await layoutProblems(page), `${width} ${mode}`).toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
        for (const { text, ratio } of await exampleContrast(page)) expect(ratio, `${text} at ${width} ${mode}`).toBeGreaterThanOrEqual(4.5)
        await shot(page, `git-${width}-${mode}`)
        await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
        expect(await layoutProblems(page), `${width} ${mode} bottom`).toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
        await shot(page, `git-${width}-${mode}-bottom`)
      }
    }

    // The keyboard path follows the eye: the panel, then each group's controls top to bottom.
    await resize(launched, 1280, 800)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
    await sections.getByRole('tab', { name: 'Git', exact: true }).focus()
    await expect(sections.getByRole('tab', { name: 'Git', exact: true })).toBeFocused()
    const order: string[] = []
    await panel.focus()
    for (let step = 0; step < 10; step += 1) {
      await page.keyboard.press('Tab')
      order.push(await page.evaluate(() => {
        const active = document.activeElement as HTMLElement
        return active.getAttribute('aria-label') ?? (active as HTMLSelectElement).labels?.[0]?.textContent ?? active.closest('[role="radiogroup"]')?.getAttribute('aria-label') ?? ''
      }))
    }
    expect(order).toEqual([
      'Commit and pull request style', 'Follow pull request templates', 'Default merge method', 'Auto-settle merged threads',
      'Diff layout', 'Hide whitespace changes', 'Default diff file state', 'Proactive panels', 'Git fetch interval', 'Automatically pull',
    ])

    // A switch pressed from the keyboard saves, and its description says what the new value does.
    const autoPull = panel.getByRole('switch', { name: 'Automatically pull', exact: true })
    await expect(autoPull).toBeFocused()
    await expect(autoPull).toHaveAccessibleDescription(/leaves the pull to you/u)
    await page.keyboard.press('Space')
    await expect(autoPull).toHaveAttribute('aria-checked', 'true')
    await expect(autoPull).toHaveAccessibleDescription(/Fast-forward only/u)
    await expect.poll(async () => (await settings()).gitAutoPull).toBe(true)
    await page.keyboard.press('Space')
    await expect.poll(async () => (await settings()).gitAutoPull).toBe(false)
    // Arrow keys move the layout choice, and the choice saves.
    const layout = panel.getByRole('radiogroup', { name: 'Diff layout', exact: true })
    await layout.getByRole('radio', { name: 'Stacked', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(layout.getByRole('radio', { name: 'Split', exact: true })).toBeFocused()
    await expect.poll(async () => (await settings()).diffLayout).toBe('split')
    await expect(panel.getByText('Changes opens each diff split, old on the left and new on the right.')).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await settings()).diffLayout).toBe('stacked')

    // Custom instructions: the field opens under the style, the example says what it will and will not show,
    // and the text saves when typing pauses.
    const style = panel.getByRole('combobox', { name: 'Commit and pull request style', exact: true })
    const example = panel.getByRole('group', { name: 'Example', exact: true })
    await expect(example).toContainText('Let a thread name itself from its first exchange')
    await style.selectOption('conventional')
    await expect(example).toContainText('feat(threads): name a thread from its first exchange')
    await expect(style).toHaveAccessibleDescription(/starts with a type and scope/u)
    await shot(page, 'git-1280-dark-conventional')
    await style.selectOption('custom')
    await expect.poll(async () => (await settings()).gitWritingStyle).toBe('custom')
    const instructions = panel.getByRole('textbox', { name: 'Custom instructions', exact: true })
    await expect(example).toContainText('Nothing written yet')
    // The style is one Tab from the field under it, so the order still follows the eye.
    await style.focus()
    await page.keyboard.press('Tab')
    await expect(instructions).toBeFocused()
    await page.keyboard.type('Start the subject with the area in square brackets, like [threads].')
    await expect(example).toContainText('An example before your instructions')
    await expect.poll(async () => (await settings()).gitWritingInstructions).toBe('Start the subject with the area in square brackets, like [threads].')
    for (const mode of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resize(launched, width, height)
        await instructions.scrollIntoViewIfNeeded()
        expect(await layoutProblems(page), `custom ${width} ${mode}`).toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
        for (const { text, ratio } of await exampleContrast(page)) expect(ratio, `${text} custom ${width} ${mode}`).toBeGreaterThanOrEqual(4.5)
        await panel.locator('.git-settings__style').scrollIntoViewIfNeeded()
        await shot(page, `git-${width}-${mode}-custom`)
      }
    }

    // What was typed survives a reload; the style goes back to the default.
    await page.reload()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await sections.getByRole('tab', { name: 'Git', exact: true }).click()
    await expect(instructions).toHaveValue('Start the subject with the area in square brackets, like [threads].')
    await style.selectOption('repository')
    await expect(instructions).toBeHidden()
    await expect.poll(async () => (await settings()).gitWritingStyle).toBe('repository')
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
  }
})
