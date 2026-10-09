import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const LEFTOVER = 'The release notes page still links the old download host. Change every link in docs/release and the README to the new releases repository, keep the anchors as they are, and run the docs link check.'
const ARTIFACTS = evidenceDirectory('artifacts/empty-page-saved-draft')

/**
 * A profile whose coordinator saved state holds LEFTOVER, written for `draftThreadId`, beside the design fixture's
 * threads. Agent control starts off, so the providers stay disconnected until the spec connects them, and the
 * current project is workshop, so a new thread opens there without asking. Voice stays off, as in the beta.
 */
async function launchWithDraft(draftThreadId: string, run: (launched: LaunchedSotto) => Promise<void>): Promise<void> {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-leftover-draft-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({ configuration: defaultAgentConfiguration(), assignments: [], queue: [], activeThreadId: null, activeProjectId: 'workshop',
    draft: LEFTOVER, draftThreadId, draftRequestId: null, composing: false, pendingRequest: '', outbox: [] }))
  const launched = await launchSotto('design-threads', profile)
  try {
    await mkdir(ARTIFACTS, { recursive: true })
    await openThreads(launched.page)
    await run(launched)
  } finally {
    await closeSotto(launched)
    await removeOwnedE2EProfile(profile)
  }
}

const connection = (page: Page): Promise<string> => page.evaluate(async () => (await window.sotto!.agents!.get()).connection)
const connect = async (page: Page): Promise<void> => {
  await page.evaluate(async () => window.sotto!.agents!.command({ type: 'connect' }))
  await expect.poll(() => connection(page)).toBe('connected')
}

/** At each of the three sizes, in light and dark: the heading and both buttons in view, nothing scrolling sideways. */
async function checkSizes(launched: LaunchedSotto, controls: readonly Locator[], capture: (width: number, appearance: 'dark' | 'light') => string | null): Promise<void> {
  const { page } = launched
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resizeWindow(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      for (const control of controls) await expect(control).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const name = capture(width, appearance)
      if (name !== null) await page.screenshot({ path: `${ARTIFACTS}/${name}.png`, animations: 'disabled' })
    }
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
}

/** Issue #736: a draft written for a thread that is no longer listed, as the coordinator's saved state carried it on the owner's machine. */
test('the empty Threads page offers a leftover draft without asking to reconnect while connected', async () => {
  test.setTimeout(180_000)
  await launchWithDraft('removed-thread', async launched => {
    const { page } = launched
    // Before the providers connect, the page asks to reconnect and shows the draft.
    expect(await connection(page)).toBe('disconnected')
    await expect(page.getByRole('heading', { name: 'Your draft is saved.' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect providers' })).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS}/disconnected-dark.png`, animations: 'disabled' })

    await connect(page)
    const heading = page.getByRole('heading', { name: 'A draft from an earlier thread is saved.' })
    const move = page.getByRole('button', { name: 'New thread with this draft' })
    const discard = page.getByRole('button', { name: 'Discard draft' })
    await expect(heading).toBeVisible()
    await expect(page.getByText(/Reconnect/u)).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Saved draft' })).toHaveValue(LEFTOVER)
    // The note cites two of the six; the rest are checked without keeping an image.
    await checkSizes(launched, [heading, move, discard], (width, appearance) =>
      (width === 1280 && appearance === 'dark') || (width === 820 && appearance === 'light') ? `leftover-${width}-${appearance}` : null)
    await page.emulateMedia({ reducedMotion: 'reduce' })

    // Discard asks first, starts on Keep draft, and Escape keeps the draft and returns to the button.
    await discard.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Discard this draft?' })
    await expect(dialog.getByRole('button', { name: 'Keep draft' })).toBeFocused()
    await page.screenshot({ path: `${ARTIFACTS}/discard-question-820-dark.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(discard).toBeFocused()
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).draft)).toBe(LEFTOVER)

    // New thread with this draft opens a thread in the current project with the draft in its composer, and the leftover copy goes.
    await move.click()
    const prompt = page.getByRole('textbox', { name: 'Prompt' })
    await expect(prompt).toHaveValue(LEFTOVER)
    await expect(prompt).toBeFocused()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).draft)).toBe('')
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      return state.threadDrafts?.find(draft => draft.threadId === state.activeThreadId)?.text
    })).toBe(LEFTOVER)
    await page.screenshot({ path: `${ARTIFACTS}/new-thread-with-draft-820-dark.png`, animations: 'disabled' })
  })
})

test('the empty Threads page offers to open the thread a saved draft is still listed for', async () => {
  test.setTimeout(180_000)
  await launchWithDraft('footer-links', async launched => {
    const { page } = launched
    await connect(page)
    const heading = page.getByRole('heading', { name: 'Your draft for Footer links is saved.' })
    const open = page.getByRole('button', { name: 'Open thread' })
    await expect(heading).toBeVisible()
    await expect(page.getByText(/Reconnect/u)).toHaveCount(0)
    await checkSizes(launched, [heading, open, page.getByRole('button', { name: 'Discard draft' })], (width, appearance) =>
      width === 820 && appearance === 'dark' ? 'listed-820-dark' : null)
    await open.click()
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused()
  })
})
