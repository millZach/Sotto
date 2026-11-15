import { expect, test, type Page } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, reachSetupStop, setupForwardButton, setupNote, setupStop } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

const SHOTS = evidenceDirectory('artifacts/setup-walk-run')

const settings = (page: Page) => page.evaluate(async () => { const all = await window.sotto!.getSettings(); return { done: all.onboardingComplete, microphoneSkipped: all.microphoneSkipped, phoneAccess: all.phoneAccess, appearance: all.appearance } })
/** Whether the note and the lit control's outline overlap; a note never covers the control it lights (ADR-0200). */
const noteOverLit = (page: Page) => page.evaluate(() => {
  const note = document.querySelector('.setup-walk__note')!.getBoundingClientRect(), lit = document.querySelector('.setup-walk__lit')?.getBoundingClientRect()
  return lit ? Math.max(0, Math.min(note.right, lit.right) - Math.max(note.left, lit.left)) * Math.max(0, Math.min(note.bottom, lit.bottom) - Math.max(note.top, lit.top)) > 0 : false
})

/**
 * First-run setup as a walk of notes over the real pages (ADR-0200), from a new profile to a first thread and on
 * through dictation, Tailscale, other computers and the iPhone, then again from Help. The home folder is a throwaway
 * one, so the project is a fixture rather than a folder of the machine's own.
 */
test('first-run setup walks a new profile to its first thread on the real pages, then on through the optional stops, and starts again from Help', async () => {
  test.setTimeout(240_000)
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sotto-setup-walk-')))
  await mkdir(join(home, 'code/sotto-site/.git'), { recursive: true })
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.USERPROFILE = home; process.env.HOME = home
  const launched = await launchSotto()
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const walk = page.locator('.setup-walk')
  const note = setupNote(page)
  const shot = (name: string) => page.screenshot({ animations: 'disabled', path: `${SHOTS}/${name}-1080x720-dark.png` })
  try {
    // An agent is installed and signed in on this computer, as on a machine that already uses one.
    await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await holdContentSize(launched, 1080, 720)

    // A new profile opens on the real Threads page, with setup's first note over it and no card or strip.
    await expect(note).toHaveAccessibleName('Talk to your computer and your coding agents')
    await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
    await expect(page.locator('.app-strip')).toHaveCount(0)
    expect(await settings(page)).toMatchObject({ done: false })
    await expect(note.getByRole('heading')).toBeFocused()
    // The look paints at once.
    await note.getByRole('radio', { name: 'Light', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await note.getByRole('radio', { name: 'Dark', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect((await settings(page)).appearance).toBe('dark')
    await shot('welcome')
    // The dimmed window takes no presses: the sidebar's Settings link is under the dim.
    const link = await page.getByRole('link', { name: 'Settings' }).boundingBox()
    await page.mouse.click(link!.x + link!.width / 2, link!.y + link!.height / 2)
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toHaveCount(0)

    // The agents stop is Settings › Providers, with its list lit and the note beside it.
    await setupForwardButton(page).click()
    expect(await setupStop(page)).toBe('agents')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await expect(page.locator('.setup-walk__lit')).toBeVisible()
    await expect(note).toContainText('is ready.')
    expect(await noteOverLit(page)).toBe(false)
    await shot('agents')
    await expect(setupForwardButton(page)).toHaveText('Continue')

    // The project stop lights the sidebar's own Add project. Its folder browser has the window to itself.
    await setupForwardButton(page).click()
    expect(await setupStop(page)).toBe('project')
    expect(await noteOverLit(page)).toBe(false)
    await shot('project')
    await page.locator('[data-setup="add-project"]').click()
    const dialog = page.getByRole('dialog', { name: /Where should this project live\?/ })
    await expect(dialog).toBeVisible()
    await expect(walk).toHaveCount(0)
    await dialog.getByRole('button', { name: 'code' }).click()
    await dialog.locator('.folder-browser__list').getByRole('button', { name: /sotto-site/ }).click()
    await dialog.getByRole('button', { name: /^(Use this folder|Open project)$/ }).click()
    await expect(dialog).toHaveCount(0)
    // Add project leaves a new thread open in the project, and the note comes back with its task done.
    await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toContainText('sotto-site')
    await expect(note).toContainText('is added.')
    await expect(setupForwardButton(page)).toHaveText('Continue')

    // The thread stop lights the open thread's composer: setup's first part is done, and the rest is optional.
    await setupForwardButton(page).click()
    expect(await setupStop(page)).toBe('thread')
    await expect(note).toHaveAccessibleName('This is a thread')
    await expect(note).toContainText('Your first thread is open. The rest is optional.')
    await expect(note.getByRole('button', { name: 'Finish here' })).toBeVisible()
    expect(await noteOverLit(page)).toBe(false)
    await shot('first-thread')
    // Tab stays with the note and the composer it lights.
    await note.getByRole('heading').focus()
    for (let presses = 0; presses < 12; presses += 1) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement?.closest('.setup-walk__note, form.thread-prompt') !== null)).toBe(true)
    }
    await expect(setupForwardButton(page)).toHaveText('Continue to dictation')

    // Dictation: Settings' own microphone test, which the walk stops as it moves on.
    await reachSetupStop(page, 'microphone')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    const microphone = page.locator('.settings-microphone-test')
    await microphone.getByRole('button', { name: 'Test microphone', exact: true }).click()
    await expect(note).toContainText('Sotto heard you. Your microphone works.')
    await expect(microphone).toHaveAttribute('data-state', 'ready')
    await shot('microphone-heard')
    await expect(setupForwardButton(page)).toHaveText('Continue')
    await setupForwardButton(page).click()
    expect(await setupStop(page)).toBe('speech-model')
    await expect(microphone).toHaveAttribute('data-state', 'closed')
    expect(await noteOverLit(page)).toBe(false)
    await shot('speech-model')

    // The shortcut stop is on the Dictate page.
    await reachSetupStop(page, 'shortcut')
    await expect(page.getByRole('region', { name: 'Dictation' })).toBeVisible()
    await shot('shortcut')

    // Elsewhere: the Tailscale row, Add host and the Phones card, on Settings › Hosts & phones.
    await reachSetupStop(page, 'tailscale')
    await expect(note).toContainText('Tailscale is not installed on this computer.')
    await reachSetupStop(page, 'computers')
    await expect(page.locator('.setup-walk__lit')).toBeVisible()
    await reachSetupStop(page, 'iphone')
    // The lit card is live: Let phones connect answers, and stays off without Tailscale.
    await page.getByRole('switch', { name: 'Let phones connect' }).click()
    await expect(page.locator('.phones-switch').getByRole('alert')).toContainText('Phones reach this computer over Tailscale, which is not installed here, so this stayed off.')
    expect((await settings(page)).phoneAccess).toBe(false)
    expect(await noteOverLit(page)).toBe(false)
    await shot('iphone')

    // The last note lists what is left and where it lives. Done saves setup's end and leaves the Threads page.
    await setupForwardButton(page).click()
    expect(await setupStop(page)).toBe('end')
    await expect(note.getByRole('listitem')).toContainText(['Tailscale joins your devices: Settings › Hosts & phones'])
    await expect(note.getByRole('listitem').filter({ hasText: 'Check your microphone' })).toHaveCount(0)
    await expect(note.getByRole('listitem').filter({ hasText: 'Add a project folder' })).toHaveCount(0)
    await shot('end')
    await setupForwardButton(page).click()
    await expect(walk).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
    // The microphone test opened the microphone, so dictation does not wait for it.
    expect(await settings(page)).toMatchObject({ done: true, microphoneSkipped: false })

    // Set up Sotto, in Help, starts the same walk again, and ending it saves nothing.
    await page.getByRole('link', { name: 'Help' }).click()
    await expect(page.getByRole('button', { name: 'Set up Sotto', exact: true })).toBeVisible()
    await shot('help')
    await page.getByRole('button', { name: 'Set up Sotto', exact: true }).click()
    await expect(note).toHaveAccessibleName('Talk to your computer and your coding agents')
    await expect(note.getByRole('button', { name: 'Skip setup' })).toBeVisible()
    // Escape ends the walk, as Skip setup does.
    await page.keyboard.press('Escape')
    await expect(walk).toHaveCount(0)
    expect(await settings(page)).toMatchObject({ done: true, microphoneSkipped: false })
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
    process.env.USERPROFILE = saved.USERPROFILE; process.env.HOME = saved.HOME
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE
    if (saved.HOME === undefined) delete process.env.HOME
    await rm(home, { recursive: true, force: true })
  }
})

test('Skip setup on the first note ends setup for good, and a walk led away by its lit control waits in the corner', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    const note = setupNote(page)
    await expect(note).toHaveAccessibleName('Talk to your computer and your coding agents')
    await note.getByRole('button', { name: 'Skip setup' }).click()
    await expect(page.locator('.setup-walk')).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
    // The microphone test never opened the microphone, so dictation waits for Settings' test.
    expect(await settings(page)).toMatchObject({ done: true, microphoneSkipped: true })
    // After a reload the profile is set up: no note comes back.
    await page.reload()
    await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
    await expect(page.locator('.setup-walk')).toHaveCount(0)

    // Started again from Help, the shortcut stop lights Dictate, which asks for the microphone test and offers Open
    // Settings. That leads to another page, so the dim lifts and the walk waits in the corner with the page live.
    await page.getByRole('link', { name: 'Help' }).click()
    await page.getByRole('button', { name: 'Set up Sotto', exact: true }).click()
    await reachSetupStop(page, 'shortcut')
    await page.getByRole('button', { name: 'Open Settings', exact: true }).click()
    const waiting = page.getByRole('region', { name: 'Setup', exact: true })
    await expect(waiting).toContainText('Setup is waiting')
    await expect(waiting).toContainText('It was on “Try the shortcut”.')
    await expect(page.locator('.setup-walk__dim')).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    // The page it was sent to takes presses: Settings' own microphone test answers.
    await page.locator('.settings-microphone-test').getByRole('button', { name: 'Test microphone', exact: true }).click()
    await expect(page.locator('.settings-microphone-test')).not.toHaveAttribute('data-state', 'idle')
    await page.screenshot({ animations: 'disabled', path: `${SHOTS}/waiting-1080x720-dark.png` })
    await waiting.getByRole('button', { name: 'Back to setup' }).click()
    await expect(setupNote(page)).toHaveAccessibleName('Try the shortcut')
    await expect(page.getByRole('region', { name: 'Dictation' })).toBeVisible()
    await setupNote(page).getByRole('button', { name: 'Skip setup' }).click()
    await expect(page.locator('.setup-walk')).toHaveCount(0)
  } finally {
    await closeSotto(launched)
  }
})
