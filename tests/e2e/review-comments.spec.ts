import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, userMessageTexts, type LaunchedSotto } from './support/sottoLaunch'

// Review comments (#270) in the real window: lines picked in Changes, a comment written under them, the chip on
// the composer, and the prompt that carries it. Git and the working folder belong to the launch helper's
// disposable profile; the coding provider is the E2E fixture, which records the text it was sent.
const run = promisify(execFile)
const SHOTS = resolve(process.cwd(), 'artifacts/review-comments-run')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const

const BEFORE = [
  "import { play, readKey, speak } from './audio'", '', 'const SAMPLE = \'Hello from Sotto.\'', '', '/** Plays a short sample in the chosen voice. */',
  'export async function preview(voice: string) {', "  const key = await readKey('xai')", '  const clip = await speak(voice, SAMPLE)', '  await play(clip)', '  return { ok: true }', '}', '',
].join('\n')
const AFTER = [
  "import { play, readKey, speak } from './audio'", '', 'const SAMPLE = \'Hello from Sotto.\'', '', '/** Plays a short sample in the chosen voice. */',
  'export async function preview(voice: string) {', "  const key = await readKey('xai')", '  if (!key) return { ok: false }', '  const clip = await speak(voice, SAMPLE, 2)',
  '  const stop = await play(clip)', '  setTimeout(stop, 2000)', '  return { ok: true }', '}', '',
].join('\n')

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(800, 540)
    window.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}

/** Every layout box that runs past the window's right edge, so a capture is also a clipping check. */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.changes-comment, .changes-comment-pill__button, .review-chip, .thread-prompt')]
    .filter(element => element.getBoundingClientRect().right > innerWidth + 1).map(element => element.className))
}

test('a review comment goes from Changes to the composer and out with the next prompt', async () => {
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const launched = await launchSotto()
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const folder = await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false } })
      const state = await agents.command({ type: 'connect' })
      const thread = state.host.threads.find(item => item.id === (state.hostId === undefined ? 'workshop' : `host:${state.hostId}:workshop`))!
      return state.host.projects.find(project => project.id === thread.projectId)!.path
    })
    expect(folder.startsWith(launched.userData)).toBe(true)
    const git = (args: string[]) => run('git', args, { cwd: folder, windowsHide: true, timeout: 15_000 })
    await mkdir(join(folder, 'src'), { recursive: true })
    await git(['init', '--quiet', '-b', 'main'])
    await writeFile(join(folder, 'src/voice.ts'), BEFORE)
    await git(['add', '.'])
    await git(['-c', 'user.name=Sotto verification', '-c', 'user.email=verification@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Voice preview'])
    await writeFile(join(folder, 'src/voice.ts'), AFTER)

    await page.reload()
    await resize(launched, 1280, 800)
    await openThreads(page)
    await page.evaluate(() => document.fonts.ready)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tab', { name: 'Changes', exact: true }).click()
    const lines = panel.getByRole('grid', { name: 'Lines of src/voice.ts' })
    await expect(lines).toContainText('setTimeout(stop, 2000)')

    // The mouse: a click picks a line, Shift+click extends, and Comment opens the draft under them.
    await lines.locator('[data-position][data-new-line="8"]').click()
    await lines.locator('[data-position][data-new-line="9"]').click({ modifiers: ['Shift'] })
    await expect(lines.locator('[aria-selected="true"]')).toHaveCount(2)
    await panel.getByRole('button', { name: 'Comment on voice.ts L8 to L9' }).click()
    const draft = panel.getByRole('textbox', { name: 'Comment on voice.ts L8 to L9' })
    await expect(draft).toBeFocused()
    await draft.fill('Say why it returns early. Without a key the user hears nothing.')
    for (const [width, height] of SIZES) {
      await resize(launched, width, height)
      await panel.locator('.changes-comment--draft').scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(SHOTS, `draft-${width}x${height}-dark.png`) })
      expect(await overflow(page), `${width}x${height}`).toEqual([])
    }
    await resize(launched, 1280, 800)
    await panel.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Delete comment on voice.ts L8 to L9' })).toBeVisible()

    // The keyboard: Tab reaches the file's lines, the arrows walk, Enter comments, Ctrl+Enter adds.
    await expect(lines.locator('[data-position][tabindex="0"]')).toHaveCount(1)
    await lines.locator('[data-position][tabindex="0"]').focus()
    await page.keyboard.press('Home')
    const removed = lines.locator('[data-position][data-old-line="8"][data-kind="remove"]')
    for (let step = 0; step < 6 && !await removed.evaluate(element => element === document.activeElement); step++) await page.keyboard.press('ArrowDown')
    await expect(removed).toBeFocused()
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Enter')
    const second = panel.getByRole('textbox', { name: 'Comment on voice.ts L8 to L9 (before)' })
    await expect(second).toBeFocused()
    await page.keyboard.type('The old call played the whole clip.')
    await page.keyboard.press('Control+Enter')
    await expect(panel.getByRole('button', { name: 'Delete comment on voice.ts L8 to L9 (before)' })).toBeVisible()
    await expect(lines.locator('[data-position][data-old-line="9"][data-kind="remove"]')).toBeFocused()

    const pane = page.locator('section.thread-pane').filter({ has: page.getByRole('textbox', { name: 'Prompt', exact: true }) }).first()
    const chips = pane.getByRole('list', { name: 'Review comments' })
    await expect(chips.getByRole('listitem')).toHaveText(['voice.ts L8 to L9: Say why it returns early. Without a key the user hears nothing.', 'voice.ts L8 to L9 (before): The old call played the whole clip.'])
    for (const mode of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
      for (const [width, height] of SIZES) {
        await resize(launched, width, height)
        await chips.scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(SHOTS, `waiting-${width}x${height}-${mode}.png`) })
        expect(await overflow(page), `${width}x${height} ${mode}`).toEqual([])
      }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on', appearance: 'dark' }))
    await resize(launched, 1280, 800)
    await page.screenshot({ path: join(SHOTS, 'waiting-1280x800-dark-reduced-motion.png') })

    // Removing a chip takes the comment off the diff too.
    await chips.getByRole('button', { name: 'Remove comment on voice.ts L8 to L9 (before)' }).click()
    await expect(panel.getByRole('button', { name: 'Delete comment on voice.ts L8 to L9 (before)' })).toHaveCount(0)

    const prompt = pane.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Tighten this before we merge.')
    await prompt.press('Enter')
    const sent = [
      'Tighten this before we merge.', '',
      'Comment on `src/voice.ts L8 to L9`:', '', 'Say why it returns early. Without a key the user hears nothing.', '',
      '```diff', '+  if (!key) return { ok: false }', '+  const clip = await speak(voice, SAMPLE, 2)', '```',
    ].join('\n')
    await expect.poll(() => userMessageTexts(page, 'workshop')).toContain(sent)
    await expect(chips).toHaveCount(0)
    await expect(panel.locator('.changes-comment--marker')).toHaveCount(0)
    await expect(prompt).toHaveValue('')
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))
    for (const mode of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
      await page.screenshot({ path: join(SHOTS, `sent-1280x800-${mode}.png`) })
    }
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
  }
})
