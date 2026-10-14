import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'
import { onReleaseTrack } from './support/releaseTrack'
import type { AgentStateBroadcast, AgentThreadsBroadcast } from '../../src/shared/agents'
import { expectPromptText, fillPrompt, promptField } from './support/prompt'

const evidence = evidenceDirectory('artifacts/window-thread-shell')

test('recovers the Owl desktop after a warm omitted-thread broadcast and renderer reload', async () => {
  await onReleaseTrack('owl', async () => {
    const launched = await launchSotto()
    const { page, app } = launched
    try {
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true })
        await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
        await window.sotto!.agents!.command({ type: 'connect' })
      })
      await page.reload()
      await openThreads(page)
      await page.getByRole('button', { name: 'Workshop', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible()
      const prompt = promptField(page)
      await fillPrompt(prompt, 'Keep this draft through a renderer reload')
      const retainedText = 'Workshop checks remain available after a reload.'
      await page.evaluate(text => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text }), retainedText)
      await expect(page.getByText(retainedText, { exact: true })).toBeVisible()
      await page.evaluate(() => {
        const observed = window as unknown as { lastThreadEnvelope?: AgentThreadsBroadcast }
        window.sotto!.agents!.onState((state: AgentStateBroadcast) => { if (!Array.isArray(state.host.threads)) observed.lastThreadEnvelope = state.host.threads })
      })
      // A normal selection changes shell facts while the unchanged thread bodies stay omitted.
      await page.getByRole('button', { name: 'Docs', exact: true }).click()
      await expect.poll(() => page.evaluate(() => (window as unknown as { lastThreadEnvelope?: AgentThreadsBroadcast }).lastThreadEnvelope?.baseRevision)).not.toBeNull()
      await expect.poll(() => page.evaluate(() => (window as unknown as { lastThreadEnvelope?: AgentThreadsBroadcast }).lastThreadEnvelope?.changed.length)).toBe(0)
      await page.getByRole('button', { name: 'Workshop', exact: true }).click()
      await expectPromptText(prompt, 'Keep this draft through a renderer reload')
      await expect(page.getByText(retainedText, { exact: true })).toBeVisible()
      await page.reload()
      await openThreads(page)
      await expect(page.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible()
      await expectPromptText(promptField(page), 'Keep this draft through a renderer reload')
      await expect(page.getByText(retainedText, { exact: true })).toBeVisible()
      for (const appearance of ['dark', 'light'] as const) for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await page.emulateMedia({ reducedMotion: width === 820 ? 'reduce' : 'no-preference' })
        await app.evaluate(({ BrowserWindow }, size) => { BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(size[0], size[1]) }, [width, height] as const)
        await expect(page.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible()
        expect(await page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        await page.screenshot({ path: join(evidence, `owl-${appearance}-${width}.png`), animations: 'disabled' })
      }
    } finally { await closeSotto(launched) }
  })
})
