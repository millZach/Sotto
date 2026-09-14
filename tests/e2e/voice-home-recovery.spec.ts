import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'
import { completeVoiceJourneySetup, openVoiceJourneyAgents } from './support/voiceJourney'

test('reveals voice drafting, pauses without loss, answers conversation and explicitly resumes saved text', async () => {
  const launched = await launchSotto()
  const { page, app } = launched
  try {
    await completeVoiceJourneySetup(page)
    await openVoiceJourneyAgents(page)
    await page.getByRole('button', { name: 'Connect providers', exact: true }).click()
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { speak: false } })
      await window.sotto!.agents!.command({ type: 'assign', threadId: 'workshop' })
      await window.sotto!.agents!.command({ type: 'compose', text: 'Keep the existing colors.' })
    })
    const speak = async (text: string) => page.evaluate(value => window.dispatchEvent(new CustomEvent('sotto:e2e:microphone', { detail: value })), text)
    await expect(page.getByRole('heading', { name: 'Say “Hey Sotto”' })).toBeVisible()
    // Disabling replies calls stopSpeaking; allow the existing 500 ms speaker-echo guard to release input.
    await page.waitForTimeout(600)
    await speak('Hey Sotto')
    await expect(page.getByRole('heading', { name: 'Drafting for Workshop' })).toBeVisible()
    await expect(page.getByText('Try “what needs my attention?”')).toHaveCount(0)
    await mkdir('artifacts/voice-home-recovery', { recursive: true })
    for (const [width, height] of [[1280, 900], [820, 560]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html'))!.setSize(...size), [width!, height!] as const)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await page.getByRole('button', { name: 'Talk to Sotto', exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: `artifacts/voice-home-recovery/drafting-${width}-${appearance}.png`, animations: 'disabled' })
      }
    }
    await page.getByRole('button', { name: 'Review draft', exact: true }).click()
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('Keep the existing colors.')
    await page.getByRole('button', { name: 'Close Workshop', exact: true }).click()
    await page.getByRole('button', { name: 'Talk to Sotto', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Draft saved. What would you like to do?', { exact: true })).toBeVisible()
    await speak('What needs my attention?')
    await expect(page.getByText('Nothing is queued for your attention.', { exact: true }).first()).toBeVisible()
    const saved = await page.evaluate(() => window.sotto!.agents!.get())
    expect(saved.threadDrafts?.find(draft => draft.threadId === 'workshop')?.text).toBe('Keep the existing colors.')
    expect(saved.host.threads.find(thread => thread.id === 'workshop')?.messages).toHaveLength(0)
    await page.getByRole('button', { name: 'Open Workshop', exact: true }).click()
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('Keep the existing colors.')
    await expect(page.getByRole('button', { name: 'Resume draft', exact: true })).toBeVisible()
    await page.screenshot({ path: 'artifacts/voice-home-recovery/paused-editor-820-light.png', animations: 'disabled' })
    await page.getByRole('button', { name: 'Resume draft', exact: true }).click()
    await page.getByLabel('Prompt', { exact: true }).fill('Keep the existing colors. Add keyboard controls.')
    await page.getByRole('button', { name: 'Close Workshop', exact: true }).click()
    await speak('Talk to Sotto.')
    await expect.poll(async () => (await page.evaluate(() => window.sotto!.agents!.get())).composing).toBe(false)
    expect((await page.evaluate(() => window.sotto!.agents!.get())).threadDrafts?.find(draft => draft.threadId === 'workshop')?.text).toBe('Keep the existing colors. Add keyboard controls.')
  } finally { await closeSotto(launched) }
})
