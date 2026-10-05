import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

const LEFTOVER = 'The release notes page still links the old download host. Change every link in docs/release and the README to the new releases repository, keep the anchors as they are, and run the docs link check.'
const ARTIFACTS = 'artifacts/empty-page-saved-draft'

/**
 * Issue #736: a draft written for a thread that is no longer listed, as the coordinator's own saved state carries it
 * on the owner's machine. Every other thread of the design fixture is there, and voice stays off, as in the beta.
 */
test('the empty Threads page offers a leftover draft without asking to reconnect while connected', async () => {
  test.setTimeout(180_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-leftover-draft-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({ configuration: defaultAgentConfiguration(), assignments: [], queue: [], activeThreadId: null, activeProjectId: null,
    draft: LEFTOVER, draftThreadId: 'removed-thread', draftRequestId: null, composing: false, pendingRequest: '', outbox: [] }))
  const launched = await launchSotto('design-threads', profile)
  try {
    const { page } = launched
    await mkdir(ARTIFACTS, { recursive: true })
    await openThreads(page)

    // Before the providers connect, the page asks to reconnect and shows the draft.
    if ((await page.evaluate(async () => (await window.sotto!.agents!.get()).connection)) !== 'connected') {
      await expect(page.getByRole('heading', { name: 'Your draft is saved.' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Connect providers' })).toBeVisible()
      await page.screenshot({ path: `${ARTIFACTS}/disconnected-dark.png`, animations: 'disabled' })
    }
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'connect' }))
    const heading = page.getByRole('heading', { name: 'A draft from an earlier thread is saved.' })
    await expect(heading).toBeVisible()
    await expect(page.getByText(/Reconnect/u)).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Saved draft' })).toHaveValue(LEFTOVER)

    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expect(heading).toBeInViewport()
        await expect(page.getByRole('button', { name: 'Discard draft' })).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        // The verification note cites two of the six; the rest are checked above without keeping an image.
        if ((width === 1280 && appearance === 'dark') || (width === 820 && appearance === 'light')) {
          await page.screenshot({ path: `${ARTIFACTS}/leftover-${width}-${appearance}.png`, animations: 'disabled' })
        }
      }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await page.emulateMedia({ reducedMotion: 'reduce' })

    // Discard asks first, starts on Keep draft, and Escape keeps the draft.
    const discard = page.getByRole('button', { name: 'Discard draft' })
    await discard.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Discard this draft?' })
    await expect(dialog.getByRole('button', { name: 'Keep draft' })).toBeFocused()
    await page.screenshot({ path: `${ARTIFACTS}/discard-question-820-dark.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).draft)).toBe(LEFTOVER)

    // New thread with this draft opens a thread with the draft in its composer, and the leftover copy goes.
    await page.getByRole('button', { name: 'New thread with this draft' }).click()
    const chooser = page.getByRole('dialog', { name: 'New thread', exact: true })
    if (await chooser.isVisible().catch(() => false)) await chooser.getByRole('button', { name: /^workshop/ }).click()
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue(LEFTOVER)
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).draft)).toBe('')
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      return state.threadDrafts?.find(draft => draft.threadId === state.activeThreadId)?.text
    })).toBe(LEFTOVER)
    await page.screenshot({ path: `${ARTIFACTS}/new-thread-with-draft-820-dark.png`, animations: 'disabled' })
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
