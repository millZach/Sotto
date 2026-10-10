import { expectPromptText, fillPrompt, promptField } from './support/prompt'
import { agentState } from './support/agentAccess'
import { ownedE2EProfile } from './support/e2eProfile'
import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { hostKeys } from './support/hostKeys'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

test('the full workspace inserts provider-native skills and retains selections without submitting work', async () => {
  test.setTimeout(60_000)
  const profileOwner = await ownedE2EProfile({ prefix: 'sotto-e2e-phase3-skills-' })
  try {
    const profile = profileOwner.directory
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', accent: 'teal' }))
    const launched = await launchSotto('phase3-workspace', profile)
    const { page } = launched
    try {
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'teal' })
        await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
        await window.sotto!.agents!.command({ type: 'connect' })
        await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'grok-previews' })
      })
      // Panes and drafts are keyed by the host that owns their thread; select-thread still takes the bare ID.
      const key = await hostKeys(page)
      await openThreads(page)
      const before = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.map(thread => [thread.id, thread.messages.length]))
      for (const [threadId, token] of [['grok-previews', '/review'], ['release-notes', '$review'], ['benchmark', '/review']] as const) {
        await page.evaluate(async threadId => window.sotto!.agents!.command({ type: 'select-thread', threadId }), threadId)
        const pane = page.locator(`section.thread-pane[data-thread-id="${key(threadId)}"]`)
        const prompt = promptField(pane)
        await fillPrompt(prompt, '$rev')
        const skills = pane.getByRole('listbox', { name: 'Skills' })
        await expect(skills).toBeVisible()
        await expect(skills.getByRole('option')).toHaveCount(1)
        await expect(skills.getByRole('option').locator('.composer-picker__name')).toHaveText('review')
        await prompt.press('Tab')
        await expectPromptText(prompt, `${token} `)
        await expect(prompt.locator('[data-skill-token]')).toHaveAttribute('data-skill-token', token)
        await expect.poll(() => page.evaluate(async threadId => {
          const state = await window.sotto!.agents!.get()
          return state.threadDrafts?.find(draft => draft.threadId === threadId)?.skills?.map(skill => skill.name)
        }, key(threadId))).toEqual(['review'])
      }
      await page.evaluate(async () => window.sotto!.agents!.command({ type: 'select-thread', threadId: 'grok-previews' }))
      const prompt = promptField(page.locator(`section.thread-pane[data-thread-id="${key('grok-previews')}"]`))
      await expectPromptText(prompt, '/review ')
      await expect(prompt.locator('[data-skill-token="/review"]')).toHaveCount(1)
      // Append to the chosen atom; replacing the entire field would deliberately remove its selection.
      await prompt.press('End')
      await prompt.pressSequentially('$plan')
      await expectPromptText(prompt, '/review $plan')
      const plan = page.getByRole('listbox', { name: 'Skills' }).getByRole('option')
      await expect(plan).toHaveAttribute('aria-disabled', 'true')
      await expect(page.getByText(/takes one skill per message/)).toBeVisible()
      const state = await agentState(page)
      expect(state.host.threads.map(thread => [thread.id, thread.messages.length])).toEqual(before)
      expect(state).not.toHaveProperty('assignments')
    } finally { await closeSotto(launched) }
  } finally { await profileOwner.dispose() }
})
