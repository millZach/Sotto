import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import type { AgentActivity, ObservedAgent } from '../../src/shared/agentActivity'

const shots = resolve('artifacts/agents-view')
async function activity(page: Page, children: ObservedAgent[]): Promise<void> {
  await page.evaluate(async agents => {
    const observedAt = new Date().toISOString()
    await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: 'The parent can finish while its agents work.', status: 'idle',
      activities: agents.map((agent, sequence): AgentActivity => ({ id: `spawn-${agent.assignmentId}`, turnId: 'turn-agents', sequence, kind: 'subagent', title: 'Spawn agent', status: 'completed', agents: [{ ...agent, observedAt }] })) })
  }, children)
}
async function size(app: LaunchedSotto, width: number, height: number): Promise<void> {
  await app.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    // Match the sidecar fixture: leave room for Windows chrome while testing exact content sizes.
    window.setMinimumSize(800, 540)
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => app.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}
const first: ObservedAgent = { id: 'claude:storage', assignmentId: 'task-storage', title: 'Retain agent history', description: 'Keep assignments through restarts and long threads.', prompt: 'Store agent tasks and results independently of ordinary activity history.', model: 'Claude Sonnet 4.6', status: 'running' }
const second: ObservedAgent = { id: 'claude:ui', assignmentId: 'task-ui', title: 'Build the Agents view', description: 'Connect the roster to the existing Tools panel.', prompt: 'Use the approved roomier rows, nested children and theme tokens.', model: 'Claude Sonnet 4.6', status: 'running' }

test('Agents follows the approved roomier view, keeps history, and reports live children independently', async () => {
  test.setTimeout(180_000)
  await mkdir(shots, { recursive: true })
  const launched = await launchSotto()
  let reopened: LaunchedSotto | undefined
  const errors: string[] = []
  launched.page.on('pageerror', error => errors.push(error.message))
  try {
    const { page } = launched
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
    })
    await page.reload()
    await expect(page.getByRole('complementary', { name: /Thread sidebar|Terminal sidebar/ })).toBeVisible()
    await openThreads(page)
    await page.evaluate(() => document.fonts.ready)
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(page.getByText('No agents spawned in this thread yet.')).toBeVisible()
    await page.screenshot({ path: join(shots, 'app-empty-dark.png') })
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await page.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    const startedAt = new Date(Date.now() - 192_000).toISOString()
    const children = [{ ...first, startedAt }, { ...second, startedAt }]
    await activity(page, children)
    await expect(page.locator('.tools-toggle__agents-dot')).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Tools', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await page.getByRole('tab', { name: 'Agents', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Browser', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toBeFocused()
    const roster = page.getByRole('list', { name: 'Spawned agents' })
    await expect(roster.locator('.subagent-item')).toHaveCount(2)
    await expect(roster).toContainText('Claude Sonnet 4.6')
    await expect(roster.getByText('Working', { exact: true })).toHaveCount(2)
    const completeFirst = { ...children[0]!, status: 'completed', completedAt: new Date().toISOString(), message: 'History survives activity eviction and restart.' }
    await activity(page, [completeFirst, children[1]!])
    await expect(roster.getByText('Finished', { exact: true })).toHaveCount(1)
    await expect(page.locator('.tools-toggle__agents-dot')).toBeVisible()
    await page.locator('[data-agent-id="claude:storage"] .subagent-head').click()
    await expect(page.locator('.subagent-details')).toContainText('History survives activity eviction and restart.')
    await page.keyboard.press('Escape')
    await expect(page.locator('.subagent-details')).toHaveCount(0)
    const completeSecond = { ...children[1]!, status: 'completed', completedAt: new Date().toISOString(), message: 'The roomier view is ready for review.' }
    await activity(page, [completeFirst, completeSecond])
    await expect(roster.getByText('Finished', { exact: true })).toHaveCount(2)
    await expect(page.locator('.tools-toggle__agents-dot')).toHaveCount(0)
    await page.screenshot({ path: join(shots, 'app-two-agents-finished-dark.png') })

    const resumed = { ...first, assignmentId: 'task-storage-2', title: 'Check history-off cleanup', description: 'Remove saved words when local history is disabled.', startedAt: new Date().toISOString() }
    const nested = { id: 'claude:keys', parentId: 'claude:ui', assignmentId: 'task-keys', title: 'Check keyboard navigation', description: 'Review tabs, focus return, and nested details.', status: 'completed', model: 'Claude Haiku 4.5', message: 'Keyboard paths verified.', startedAt, durationMs: 48_000 }
    const unknownModel = { id: 'claude:perf', assignmentId: 'task-perf', title: 'Check streaming performance', description: 'Measure updates against a large saved roster.', prompt: 'Compare the same update workload with small and large retained histories.', status: 'running', startedAt }
    const failed = { id: 'claude:privacy', assignmentId: 'task-privacy', title: 'Verify history-off cleanup', description: 'Confirm saved task text is removed.', model: 'Claude Haiku 4.5', status: 'failed', message: 'The test process stopped before it returned a result.', startedAt, durationMs: 37_000 }
    await activity(page, [resumed, completeSecond, nested, unknownModel, failed])
    await expect(roster.locator('.subagent-item')).toHaveCount(5)
    await expect(roster).toContainText('Run 2')
    await expect(roster).toContainText('Model not reported')
    await expect(page.locator('[data-agent-id="claude:keys"]')).toHaveAttribute('data-nested', 'true')
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await page.getByRole('button', { name: 'Pin to Workshop', exact: true }).click()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'docs' }) })
    await expect(page.getByText('No agents spawned in this thread yet.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pin to Workshop', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Unpin from Workshop', exact: true })).toHaveCount(0)
    await expect(page.locator('.tools-toggle__agents-dot')).toHaveCount(0)
    await page.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await expect(page.getByText('No agents spawned in this thread yet.')).toBeVisible()
    await expect(roster.locator('.subagent-item')).toHaveCount(0)
    await page.screenshot({ path: resolve('artifacts/codex-questions-thread-agents/agents-selected-docs-pinned-workshop.png'), animations: 'disabled' })
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await expect(page.locator('.tools-panel__thread-title')).toHaveText('Workshop')
    await page.getByRole('button', { name: 'Unpin from Workshop', exact: true }).click()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(page.getByText('No agents spawned in this thread yet.')).toBeVisible()
    await expect(page.locator('.tools-toggle__agents-dot')).toHaveCount(0)
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' }) })
    await expect(roster.locator('.subagent-item')).toHaveCount(5)
    await page.locator('.subagents-roster').click({ position: { x: 24, y: 3 } })
    await page.mouse.move(40, 40)
    const visualChecks: unknown[] = []
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) for (const appearance of ['dark', 'light'] as const) {
      await size(launched, width!, height!)
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      expect(await page.locator('.tools-panel__sheet').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      expect(await page.locator('.tools-rail').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      const contrast = await page.locator('.tools-panel__sheet').evaluate(panel => {
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
        const ctx = canvas.getContext('2d')!
        const background = getComputedStyle(panel).backgroundColor
        const pixel = (foreground?: string): number[] => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = background; ctx.fillRect(0, 0, 1, 1); if (foreground) { ctx.fillStyle = foreground; ctx.fillRect(0, 0, 1, 1) }; return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3) }
        const luminance = (rgb: number[]): number => rgb.map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
        const base = luminance(pixel())
        return [...panel.querySelectorAll('.subagent-title, .subagent-description, .subagent-model, .subagent-right, .tools-chrome__title, .tools-chrome__detail')].map(element => { const text = luminance(pixel(getComputedStyle(element).color)); return (Math.max(base, text) + .05) / (Math.min(base, text) + .05) })
      })
      expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5)
      visualChecks.push({ width, height, actual: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), appearance, minimumContrast: Math.min(...contrast) })
      await page.screenshot({ path: join(shots, `app-roomy-${width}-${appearance}.png`) })
    }
    const resize = page.getByRole('separator', { name: 'Resize tools panel' })
    await resize.focus()
    await page.keyboard.press('Home')
    await expect(resize).toHaveAttribute('aria-valuenow', '380')
    expect(await page.locator('.tools-panel__sheet').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    expect(await page.locator('.tools-rail').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await page.locator('.subagents-roster').click({ position: { x: 24, y: 3 } })
    await page.mouse.move(40, 40)
    await page.screenshot({ path: join(shots, 'app-roomy-tools-min-380-light.png') })
    await writeFile(join(shots, 'app-visual-checks.json'), JSON.stringify(visualChecks, null, 2))
    await page.locator('[data-agent-id="claude:storage"] .subagent-head').click()
    await expect(page.locator('.subagent-details')).toContainText('Previous assignment')
    await page.locator('.subagent-previous summary').click()
    await expect(page.locator('.subagent-previous')).toContainText('History survives activity eviction and restart.')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
    await expect(page.locator('.subagent-details')).toHaveCSS('animation-name', 'none')
    await page.screenshot({ path: join(shots, 'app-roomy-history-820-light.png') })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.evaluate(async () => { await window.sottoE2E!.agentEvent!({ type: 'disconnect', threadId: 'workshop', text: '' }) })
    await expect(page.locator('.tools-toggle__agents-dot')).toHaveCount(0)
    await expect(roster.getByText('Last seen working', { exact: true })).toHaveCount(2)
    await page.screenshot({ path: join(shots, 'app-disconnected-820-light.png') })
    await launched.app.close()
    reopened = await launchSotto('success', launched.userData)
    await openThreads(reopened.page)
    const restored = await reopened.page.evaluate(() => window.sotto!.subagents!.page({ threadId: 'workshop' }))
    expect(restored.rows).toHaveLength(5)
    expect(restored.summary.working).toBe(0)
    const old = await reopened.page.evaluate(() => window.sotto!.subagents!.assignments({ threadId: 'workshop', agentId: 'claude:storage' }))
    expect(old.assignments).toHaveLength(2)
    expect(old.assignments.some(item => item.result === 'History survives activity eviction and restart.')).toBe(true)
    await activity(reopened.page, [{ ...first, assignmentId: 'privacy-live', title: 'Private live task', prompt: 'Erase this task while retaining live status.' }])
    await expect(reopened.page.locator('.tools-toggle__agents-dot')).toBeVisible()
    for (const historyEnabled of [false, true]) {
      await reopened.page.evaluate(async enabled => { await window.sotto!.updateSettings({ historyEnabled: enabled }) }, historyEnabled)
      const retained = await reopened.page.evaluate(() => window.sotto!.subagents!.page({ threadId: 'workshop' }))
      expect(retained.summary.working).toBe(1)
      expect(retained.rows.every(row => row.status === 'running' || row.status === 'unknown')).toBe(true)
      expect(JSON.stringify(retained)).not.toContain('Private live task')
      const erased = await reopened.page.evaluate(() => window.sotto!.subagents!.assignments({ threadId: 'workshop', agentId: 'claude:storage' }))
      expect(erased.assignments.every(item => item.prompt === undefined && item.result === undefined)).toBe(true)
      await expect(reopened.page.locator('.tools-toggle__agents-dot')).toBeVisible()
    }
    expect(errors).toEqual([])
  } catch (error) { console.error({ errors, body: await launched.page.locator('body').innerText().catch(() => 'closed') }); await launched.page.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined); throw error } finally { if (reopened) await reopened.app.close(); await closeSotto(launched) }
})
