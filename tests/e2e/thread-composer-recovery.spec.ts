import { join } from 'node:path'
import { evidenceDirectory } from '../fixtures/evidence'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

test('permissions keep composer focus and failed answers remain on their own thread', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Keep this draft')
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'permission', threadId: 'workshop', requestId: 'focus-permission', text: 'Allow this command?' }))
    await expect(prompt).toHaveAttribute('readonly', '')
    await expect(prompt).toBeEnabled()
    await expect(prompt).toBeFocused()
    await prompt.pressSequentially('blocked')
    await expect(prompt).toHaveValue('Keep this draft')
    await prompt.press('Enter')
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled()
    await prompt.press('Tab')
    await expect(prompt).not.toBeFocused()
    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(prompt).not.toHaveAttribute('readonly')
    await prompt.fill('Editing resumes')
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'question', threadId: 'workshop', requestId: 'recovery-question', text: 'Which direction?' }))
    const answer = page.getByRole('textbox', { name: 'Your answer', exact: true })
    await answer.fill('Go left')
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'reject', threadId: 'workshop', text: 'The answer was refused.' }))
    await answer.press('Enter')
    const failure = page.getByRole('alert').filter({ hasText: 'The answer was refused. It is back in the composer.' })
    await expect(failure).toContainText('It is back in the composer.')
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(failure).toHaveCount(0)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(failure).toContainText('The answer was refused.')
    await expect(answer).toHaveValue('Go left')
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
        await resizeWindow(launched, width!, height!)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expect(failure).toBeVisible()
        await expect(answer).toBeVisible()
        await page.screenshot({ animations: 'disabled', path: join(evidenceDirectory('artifacts/crossing'), `pkg-43-${appearance}-${width}.png`) })
      }
    }
    await answer.fill('Go right')
    await expect(failure).toHaveCount(0)
    await answer.press('Enter')
    await expect(answer).toHaveCount(0)
  } finally { await closeSotto(launched) }
})
