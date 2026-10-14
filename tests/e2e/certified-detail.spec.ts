import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, completeFirstRunSetup, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/certified-detail')
test.describe.configure({ mode: 'serial' })

for (const enabled of [false, true]) test(`streamed words and activity stay whole with the detail cost gate ${enabled ? 'on' : 'off'}`, async () => {
  test.setTimeout(120_000)
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = `streaming-publish-cost=${enabled ? 1 : 0}`
  const launched = await launchSotto()
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    expect(await page.evaluate(async () => {
      const status = await window.sotto!.getUpdateStatus()
      return 'owlFeatures' in status ? status.owlFeatures?.['streaming-publish-cost'] : undefined
    })).toBe(enabled)
    await completeFirstRunSetup(page)
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible()
    // Native provider traffic alone is scripted; the built main, workspace, bridge and renderer run.
    const activity: AgentActivity = { id: 'inspection', turnId: 'prompt', sequence: 0, afterMessageId: 'prompt', kind: 'command', status: 'running', title: 'Inspect streamed output', command: 'echo synthetic', output: 'First output' }
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'workshop', status: 'running', text: '', messages: [{ id: 'prompt', role: 'user', text: 'Inspect this streamed reply.', createdAt: '2026-10-13T00:00:00.000Z' }] }))
    for (let chunk = 0; chunk < 6; chunk++) {
      await page.evaluate(async ({ activity, chunk }) => window.sottoE2E!.agentEvent!({ type: 'stream', threadId: 'workshop', messageId: 'reply', status: 'running', text: 'First' + ' streamed words'.repeat(chunk + 1), activities: [{ ...activity, output: 'First output' + ' streamed output'.repeat(chunk + 1) }] }), { activity, chunk })
      await expect(page.getByRole('log', { name: 'Thread transcript' })).toContainText('First' + ' streamed words'.repeat(chunk + 1))
    }
    const log = page.getByRole('log', { name: 'Thread transcript' })
    await log.getByRole('button', { name: /echo synthetic/ }).click()
    await expect(log.getByLabel('output code block')).toContainText('First output' + ' streamed output'.repeat(6))
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await mkdir(evidence, { recursive: true })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) for (const appearance of ['dark', 'light'] as const) {
      await resizeWindow(launched, width!, height!)
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      expect(await page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.screenshot({ animations: 'disabled', path: join(evidence, `${enabled ? 'owl' : 'stable'}-${appearance}-${width}.png`) })
    }
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
    if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES
    else process.env.SOTTO_OWL_FEATURES = previous
  }
})
