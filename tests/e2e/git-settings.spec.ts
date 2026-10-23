import { resizeContentWindow } from './support/sottoWindow'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'
import { settingsLayoutProblems, settingsTextContrast } from './support/settingsChecks'

// Settings → Git & worktrees, the owner's pick B (grouped by moment), in the built app: every size and both rooms, the
// keyboard path through the section, the example under the style, and saves that read back.
const evidence = evidenceDirectory('artifacts/git-settings')
const sizes = [[1600, 1000], [1280, 800], [820, 560]] as const
/** What must not be cut off, and the text whose contrast is measured: the example's and the groups' own. */
const GIT_CONTROLS = 'select,button,textarea,dd,p,h3'
const GIT_TEXT = '.git-settings__example dt, .git-settings__example dd, .git-settings__example p, .settings-group > h3, .settings-group__note'

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await resizeContentWindow(launched, width, height, [800, 540])
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

test('Settings → Git & worktrees groups every Git setting by moment, fits every size in both rooms, and saves from the keyboard', async () => {
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
    await sections.getByRole('tab', { name: 'Git & worktrees', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: 'Git & worktrees', exact: true })
    await expect(panel.getByRole('heading', { level: 3 })).toHaveText(['Removing worktrees', 'When a thread commits', 'When a pull request is made or merged', 'When you read Changes', 'In the background'])

    for (const [width, height] of sizes) {
      await resize(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
        expect(await settingsLayoutProblems(page, 'settings-git', GIT_CONTROLS), `${width} ${mode}`).toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
        for (const { text, ratio } of await settingsTextContrast(page, 'settings-git', GIT_TEXT)) expect(ratio, `${text} at ${width} ${mode}`).toBeGreaterThanOrEqual(4.5)
        await shot(page, `git-${width}-${mode}`)
        await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
        expect(await settingsLayoutProblems(page, 'settings-git', GIT_CONTROLS), `${width} ${mode} bottom`).toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
        await shot(page, `git-${width}-${mode}-bottom`)
      }
    }

    // The keyboard path follows the eye: the panel, then each group's controls top to bottom.
    await resize(launched, 1280, 800)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
    await sections.getByRole('tab', { name: 'Git & worktrees', exact: true }).focus()
    await expect(sections.getByRole('tab', { name: 'Git & worktrees', exact: true })).toBeFocused()
    const order: string[] = []
    await panel.focus()
    for (let step = 0; step < 17; step += 1) {
      await page.keyboard.press('Tab')
      order.push(await page.evaluate(() => {
        const active = document.activeElement as HTMLElement
        return active.getAttribute('aria-label') ?? (active as HTMLSelectElement).labels?.[0]?.textContent ?? active.closest('[role="radiogroup"]')?.getAttribute('aria-label') ?? ''
      }))
    }
    expect(order).toEqual([
      'Remove idle worktrees after', 'Remove a worktree when its thread is settled', 'Remove a worktree once its commits are in the default branch',
      'Remove a worktree when its pull request is merged',
      'Commit and pull request style', 'Generated commit messages',
      'Generated pull request text', 'Follow pull request templates', 'Default merge method', 'Auto-settle merged threads', 'Let agents babysit pull requests',
      'Diff layout', 'Hide whitespace changes', 'Default diff file state', 'Proactive panels', 'Git fetch interval', 'Automatically pull',
    ])

    // A switch pressed from the keyboard saves, and its description says what the new value does.
    const autoPull = panel.getByRole('switch', { name: 'Automatically pull', exact: true })
    await expect(autoPull).toBeFocused()
    await expect(autoPull).toHaveAccessibleDescription(/leaves the pull to you/u)
    await page.keyboard.press('Space')
    await expect(autoPull).toHaveAttribute('aria-checked', 'true')
    await expect(autoPull).toHaveAccessibleDescription(/Fast-forwards a clean folder/u)
    await expect.poll(async () => (await settings()).gitAutoPull).toBe(true)
    await page.keyboard.press('Space')
    await expect.poll(async () => (await settings()).gitAutoPull).toBe(false)
    // Arrow keys move the layout choice, and the choice saves.
    const layout = panel.getByRole('radiogroup', { name: 'Diff layout', exact: true })
    await layout.getByRole('radio', { name: 'Stacked', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(layout.getByRole('radio', { name: 'Split', exact: true })).toBeFocused()
    await expect.poll(async () => (await settings()).diffLayout).toBe('split')
    await expect(panel.getByText('Old on the left, new on the right.')).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await settings()).diffLayout).toBe('stacked')

    // Custom instructions: the field opens under the style, the example says what it will and will not show,
    // and the text saves when typing pauses.
    const style = panel.getByRole('combobox', { name: 'Commit and pull request style', exact: true })
    const example = panel.getByRole('group', { name: 'Example', exact: true })
    await expect(example).toContainText('Let a thread name itself from its first exchange')
    await style.selectOption('conventional')
    await expect(example).toContainText('feat(threads): name a thread from its first exchange')
    await expect(style).toHaveAccessibleDescription(/start with a type and scope/u)
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
        expect(await settingsLayoutProblems(page, 'settings-git', GIT_CONTROLS), `custom ${width} ${mode}`).toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
        for (const { text, ratio } of await settingsTextContrast(page, 'settings-git', GIT_TEXT)) expect(ratio, `${text} custom ${width} ${mode}`).toBeGreaterThanOrEqual(4.5)
        await panel.locator('.git-settings__style').scrollIntoViewIfNeeded()
        await shot(page, `git-${width}-${mode}-custom`)
      }
    }

    // What was typed survives a reload; the style goes back to the default.
    await page.reload()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await sections.getByRole('tab', { name: 'Git & worktrees', exact: true }).click()
    await expect(instructions).toHaveValue('Start the subject with the area in square brackets, like [threads].')
    await style.selectOption('repository')
    await expect(instructions).toBeHidden()
    await expect.poll(async () => (await settings()).gitWritingStyle).toBe('repository')
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
  }
})
