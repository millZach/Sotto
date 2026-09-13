import { expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('the full workspace inserts provider-native skills and retains selections without submitting work', async () => {
  test.setTimeout(60_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase3-skills-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', accent: 'teal' }))
  const launched = await launchSotto('phase3-workspace', profile)
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'teal' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'grok-previews' })
    })
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    const before = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.map(thread => [thread.id, thread.messages.length]))
    for (const [threadId, token] of [['grok-previews', '/review'], ['release-notes', '$review'], ['benchmark', '/review']] as const) {
      await page.evaluate(async threadId => window.sotto!.agents!.command({ type: 'select-thread', threadId }), threadId)
      const pane = page.locator(`section.thread-pane[data-thread-id="${threadId}"]`)
      const prompt = pane.getByRole('textbox', { name: 'Prompt', exact: true })
      await prompt.fill('$rev')
      const skills = pane.getByRole('listbox', { name: 'Skills' })
      await expect(skills).toBeVisible()
      await expect(skills.getByRole('option')).toHaveCount(1)
      await expect(skills.getByRole('option')).toContainText(token)
      await prompt.press('Tab')
      await expect(prompt).toHaveValue(`${token} `)
      await expect.poll(() => page.evaluate(async threadId => {
        const state = await window.sotto!.agents!.get()
        return state.threadDrafts?.find(draft => draft.threadId === threadId)?.skills?.map(skill => skill.name)
      }, threadId)).toEqual(['review'])
    }
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'select-thread', threadId: 'grok-previews' }))
    const prompt = page.locator('section.thread-pane[data-thread-id="grok-previews"]').getByRole('textbox', { name: 'Prompt', exact: true })
    await expect(prompt).toHaveValue('/review ')
    await prompt.fill('/review $plan')
    const plan = page.getByRole('listbox', { name: 'Skills' }).getByRole('option')
    await expect(plan).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByText(/takes one skill per message/)).toBeVisible()
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state.host.threads.map(thread => [thread.id, thread.messages.length])).toEqual(before)
    expect(state.assignments).toEqual([])
  } finally { await closeSotto(launched) }
})
