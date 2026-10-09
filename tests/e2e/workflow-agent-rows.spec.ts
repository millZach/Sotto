import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import type { AgentActivity, ObservedAgent } from '../../src/shared/agentActivity'
import { evidenceDirectory } from '../fixtures/evidence'

// Every capture of the run; docs/verification/workflow-agent-rows.md cites copies in artifacts/workflow-agent-rows/.
const shots = evidenceDirectory('artifacts/workflow-agent-rows-run')
const started = new Date(Date.now() - 15 * 60_000).toISOString()
const workflow: ObservedAgent = { id: 'claude-agent-flow', assignmentId: 'claude-task-wf', kind: 'workflow', title: 'Implement the phase 1 perf issues', description: 'phase-1-perf',
  prompt: 'Implement the phase 1 perf issues, #311 to #316, one agent per issue, each in its own worktree.', message: 'Three agents have finished; one failed.', status: 'running', startedAt: started }
const labels = ['#311 311-thread-command-lanes', '#312 312-history-recency-on-view', '#313 313-command-reply-shell', '#314 314-linear-frame-parser', '#315 315-screenshot-size-first', '#316 316-previews-after-accept']
const statuses = ['failed', 'completed', 'running', 'completed', 'completed', 'running']
const members: ObservedAgent[] = labels.map((title, index) => ({ id: `claude-agent-flow:agent-${index + 1}`, assignmentId: `claude-task-wf:agent-${index + 1}`, parentId: workflow.id, title,
  prompt: `Implement ${title.split(' ')[0]} in .worktrees/${title.split(' ')[1]} and open a pull request when the gates pass.`, status: statuses[index]!,
  model: index === 4 ? 'claude-sonnet-5' : 'claude-opus-5-5[1m]', startedAt: started,
  ...(statuses[index] === 'running' ? {} : { durationMs: (5 + index) * 60_000, completedAt: new Date(Date.parse(started) + (5 + index) * 60_000).toISOString() }),
  ...(statuses[index] === 'failed' ? { message: 'Stopped after the integration suite failed twice. The branch has the work so far; nothing was pushed.' } : statuses[index] === 'completed' ? { message: `Opened #35${index}. The gates pass.` } : {}) }))
const progress = (agents: readonly ObservedAgent[]) => ({ total: agents.length, working: agents.filter(agent => agent.status === 'running').length, completed: agents.filter(agent => agent.status === 'completed').length,
  failed: agents.filter(agent => agent.status === 'failed').length, interrupted: 0 })
const solo: ObservedAgent = { id: 'claude-agent-solo', assignmentId: 'task-solo', title: 'Find where the roster draws nested rows', description: 'Search the renderer for how the Agents tab nests agents.', model: 'claude-haiku-4-5', status: 'completed', startedAt: started, durationMs: 64_000, message: 'AgentsSurface nests rows by parentId.' }

async function report(page: Page, run: ObservedAgent, agents: ObservedAgent[]): Promise<void> {
  await page.evaluate(async ({ run, agents, solo }) => {
    const observedAt = new Date().toISOString()
    const activities: AgentActivity[] = [
      { id: 'spawn-solo', turnId: 'turn-agents', sequence: 0, kind: 'subagent', title: 'Agent', status: 'completed', agents: [{ ...solo, observedAt }] },
      { id: 'claude-task-wf', turnId: 'turn-agents', sequence: 1, kind: 'subagent', title: run.title!, status: run.status === 'running' ? 'running' : 'completed', agents: [run, ...agents].map(agent => ({ ...agent, observedAt })) },
    ]
    await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: 'The workflow runs its agents.', status: 'idle', activities })
  }, { run: { ...run, progress: progress(agents) }, agents, solo })
}
async function size(app: LaunchedSotto, width: number, height: number): Promise<void> {
  await app.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(800, 540)
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => app.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}
async function minimumContrast(page: Page): Promise<number> {
  return page.locator('.tools-panel__sheet').evaluate(panel => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
    const ctx = canvas.getContext('2d')!
    const background = getComputedStyle(panel).backgroundColor
    const pixel = (foreground?: string): number[] => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = background; ctx.fillRect(0, 0, 1, 1); if (foreground) { ctx.fillStyle = foreground; ctx.fillRect(0, 0, 1, 1) }; return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3) }
    const luminance = (rgb: number[]): number => rgb.map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
    const base = luminance(pixel())
    return Math.min(...[...panel.querySelectorAll('.subagent-title, .subagent-kind, .subagent-count, .subagent-model, .subagent-right, .subagent-workflow__facts, .subagent-workflow__heading, .tools-chrome__title, .tools-chrome__detail, .tools-chrome__button')]
      .map(element => { const text = luminance(pixel(getComputedStyle(element).color)); return (Math.max(base, text) + .05) / (Math.min(base, text) + .05) }))
  })
}

test('a workflow is one roster row with a strip, and its page lists each of its agents', async () => {
  test.setTimeout(180_000)
  await mkdir(shots, { recursive: true })
  const launched = await launchSotto()
  const errors: string[] = []
  launched.page.on('pageerror', error => errors.push(error.message))
  try {
    const { page } = launched
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
    })
    await page.reload()
    await openThreads(page)
    await page.evaluate(() => document.fonts.ready)
    await size(launched, 1600, 1000)
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()

    // Every agent working: the workflow is one row, and the chrome counts its six agents and the other one.
    const working = members.map(member => ({ ...member, status: 'running', message: undefined, durationMs: undefined, completedAt: undefined }))
    await report(page, workflow, working)
    const roster = page.getByRole('list', { name: 'Spawned agents' })
    const row = page.getByRole('button', { name: /^Open the workflow Implement the phase 1 perf issues/ })
    await expect(row).toBeVisible()
    await expect(roster.locator(':scope > li')).toHaveCount(2)
    await expect(page.locator('.tools-chrome__title')).toHaveText('7 agents')
    await expect(page.locator('.tools-chrome__detail')).toHaveText('6 working')
    await expect(roster.getByText('#311 311-thread-command-lanes')).toHaveCount(0)
    await expect(page.getByRole('img', { name: '0 of 6 finished, 6 working' })).toBeVisible()

    // One agent finishing leaves the run working; the strip and count follow each agent.
    await report(page, workflow, members)
    const strip = page.getByRole('img', { name: '3 of 6 finished · 1 failed'.replace(' · ', ', ') + ', 2 working' })
    await expect(strip).toBeVisible()
    await expect(strip.locator('i')).toHaveCount(6)
    expect(await strip.locator('i').evaluateAll(segments => segments.map(segment => segment.getAttribute('data-status')))).toEqual(statuses)
    await expect(row).toContainText('Working')
    await page.mouse.move(10, 10)
    await page.screenshot({ path: join(shots, 'roster-strip-1600-dark.png'), animations: 'disabled' })

    // The workflow page: "All agents" takes focus; each agent is its own row with its own task and result.
    await row.click()
    const back = page.getByRole('button', { name: 'Back to all agents' })
    await expect(back).toBeFocused()
    await expect(page.locator('.tools-chrome__title')).toHaveText('Implement the phase 1 perf issues')
    await expect(page.locator('.subagent-workflow__facts')).toContainText('claude-opus-5-5[1m], claude-sonnet-5')
    await expect(page.locator('.subagent-workflow')).toContainText('Implement the phase 1 perf issues, #311 to #316')
    const agents = page.getByRole('list', { name: 'Agents' })
    await expect(agents.locator('.subagent-item')).toHaveCount(6)
    await agents.getByRole('button', { name: /#311 311-thread-command-lanes/ }).click()
    await expect(agents.locator('.subagent-details')).toContainText('What happened')
    await expect(agents.locator('.subagent-details')).toContainText('Stopped after the integration suite failed twice.')
    await page.mouse.move(10, 10)

    // The roster row and the workflow page at every size, dark and light: no sideways scroll, readable text.
    const checks: unknown[] = []
    const check = async (view: string, width: number, height: number, appearance: string): Promise<void> => {
      expect(await page.locator('.tools-panel__sheet').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      expect(await page.locator('.subagents-roster').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      const contrast = await minimumContrast(page)
      expect(contrast).toBeGreaterThanOrEqual(4.5)
      checks.push({ view, width, height, appearance, minimumContrast: contrast })
      await page.mouse.move(10, 10)
      await page.screenshot({ path: join(shots, `${view}-${width}-${appearance}.png`), animations: 'disabled' })
    }
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) for (const appearance of ['dark', 'light'] as const) {
      await size(launched, width, height)
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await back.click()
      await expect(row).toBeFocused()
      await check('roster-strip', width, height, appearance)
      await row.click()
      await agents.getByRole('button', { name: /#311 311-thread-command-lanes/ }).click()
      await expect(agents.locator('.subagent-details')).toContainText('What happened')
      await check('workflow-page', width, height, appearance)
    }

    // Tools at its narrowest: the back button keeps its icon, and nothing overflows.
    const resize = page.getByRole('separator', { name: 'Resize tools panel' })
    await resize.focus()
    await page.keyboard.press('Home')
    await expect(resize).toHaveAttribute('aria-valuenow', '380')
    expect(await page.locator('.tools-panel__sheet').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    expect(await page.locator('.subagents-roster').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await page.mouse.move(10, 10)
    await page.screenshot({ path: join(shots, 'workflow-page-tools-380-light.png'), animations: 'disabled' })

    // Escape closes the open agent first, then leaves the page and returns to the workflow's row.
    await agents.getByRole('button', { name: /#311 311-thread-command-lanes/ }).focus()
    await page.keyboard.press('Escape')
    await expect(agents.locator('.subagent-details')).toHaveCount(0)
    await expect(back).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()
    await expect(page.getByRole('complementary', { name: 'Tools', exact: true })).toBeVisible()
    await page.screenshot({ path: join(shots, 'roster-strip-tools-380-light.png'), animations: 'disabled' })

    // Reduced motion stops the working segments' pulse; with motion on they breathe.
    await expect(page.locator('.subagent-strip > i[data-status="running"]').first()).not.toHaveCSS('animation-name', 'none')
    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
    await expect(page.locator('.subagent-strip > i[data-status="running"]').first()).toHaveCSS('animation-name', 'none')

    // The run's own notification settles it: "Finished", with the count carrying the failure.
    const settled = members.map(member => member.status === 'running' ? { ...member, status: 'completed', message: 'Opened a pull request.', durationMs: 20 * 60_000 } : member)
    await report(page, { ...workflow, status: 'completed', message: 'Five of six pull requests opened.' }, settled)
    await expect(page.getByRole('button', { name: 'Open the workflow Implement the phase 1 perf issues: 5 of 6 finished, 1 failed, Finished' })).toBeVisible()
    await expect(page.locator('.tools-chrome__detail')).toHaveText('None working')
    await page.screenshot({ path: join(shots, 'roster-strip-finished-380-light-reduced.png'), animations: 'disabled' })
    await writeFile(join(shots, 'checks.json'), JSON.stringify(checks, null, 2))
    expect(errors).toEqual([])
  } catch (error) { await launched.page.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined); throw error } finally { await closeSotto(launched) }
})
