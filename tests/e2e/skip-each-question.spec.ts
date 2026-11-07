import { agentState } from './support/agentAccess'
import { join } from 'node:path'
import { evidenceDirectory } from '../fixtures/evidence'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { AgentRequest, AgentState } from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/skip-each-question')

// Zach's pick on November 6, 2026 (ADR-0135): a card of several questions has a Skip on each question its provider can take a
// skip of on its own, and Skip the rest once one is answered. The app is real end to end; only the provider's effects come
// from the unpackaged E2E host, which takes the answer and lets the request go.

const asked: AgentRequest = {
  id: 'login-questions', kind: 'question', text: 'Three questions', options: [], skippable: true, questions: [
    { id: '0', header: 'Approach', question: 'Fix the login on staging now, or wait for the auth rewrite?', multiSelect: false, allowFreeText: true, prose: true, skippable: true,
      options: [{ id: 'Fix it now (recommended)', label: 'Fix it now (recommended)', description: 'A small patch to the session check.' }, { id: 'Wait for the rewrite', label: 'Wait for the rewrite', description: 'Leave staging as it is until the new auth lands.' }] },
    { id: '1', header: 'Key', question: 'Which key should staging use?', multiSelect: false, allowFreeText: true, prose: true, skippable: true,
      options: [{ id: 'The staging key', label: 'The staging key' }, { id: 'A new key just for staging', label: 'A new key just for staging' }] },
    { id: '2', header: 'Tests', question: 'Which pages should I test afterwards?', multiSelect: true, allowFreeText: false, skippable: true,
      options: [{ id: 'Sign in', label: 'Sign in' }, { id: 'Sign up', label: 'Sign up' }, { id: 'Password reset', label: 'Password reset' }] },
  ],
}

async function prepare(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await openThreads(page)
}

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

const pending = async (page: Page): Promise<string[] | undefined> => {
  const snapshot: AgentState = await agentState(page)
  const id = snapshot.hostId ? hostEntityKey(snapshot.hostId, 'workshop') : 'workshop'
  return snapshot.host.threads.find(thread => thread.id === id)?.requests.map(request => request.id)
}

let launched: LaunchedSotto | undefined
test.afterEach(async () => { if (launched) await closeSotto(launched); launched = undefined })

test('answers one question, skips the rest, and sends', async () => {
  test.setTimeout(120_000)
  launched = await launchSotto()
  const { page, app } = launched
  await prepare(page)
  await resize(app, page, 1280, 800)
  await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Workshop', exact: true }).click()
  await page.evaluate(async request => window.sottoE2E!.agentEvent!({ type: 'question', threadId: 'workshop', text: request.text, request, status: 'running' }), asked)
  await expect.poll(() => pending(page)).toEqual([asked.id])
  const card = page.locator('.thread-workspace__compose .thread-questions .agent-request')
  await expect(card).toBeVisible()
  await expect(card.getByRole('button', { name: 'Skip the rest' })).toHaveCount(0)
  await page.screenshot({ path: join(evidence, 'card-1280x800-dark.png'), animations: 'disabled' })

  await card.getByRole('radio', { name: /Wait for the rewrite/u }).click()
  await card.getByRole('button', { name: 'Skip the rest' }).click()
  await expect(card.getByText('Skipped.')).toHaveCount(2)
  await expect(card.getByText('Ready to send · 2 skipped')).toBeVisible()
  await expect(card.getByRole('checkbox', { name: 'Sign in' })).toHaveCount(0)
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resize(app, page, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      expect(await card.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await card.getByText('Skipped.').first().scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(evidence, `skipped-${width}x${height}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await resize(app, page, 1280, 800)
  await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })

  // Answer it brings one back, and its Skip folds it again.
  await card.getByRole('button', { name: 'Answer this question: Which key should staging use?' }).click()
  await expect(card.getByRole('radio', { name: 'The staging key' })).toBeVisible()
  await card.getByRole('button', { name: 'Skip this question: Which key should staging use?' }).click()
  await expect(card.getByRole('button', { name: 'Answer this question: Which key should staging use?' })).toBeFocused()

  await card.getByRole('button', { name: 'Send answers' }).click()
  await expect.poll(() => pending(page)).toEqual([])
  await expect(card).toHaveCount(0)
})
