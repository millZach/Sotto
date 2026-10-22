import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AgentActivity, ObservedAgent } from '../../src/shared/agentActivity'
import { AGENT_FORK_GONE, START_HANDOVER_CLOSE } from '../../src/shared/threadStarts'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { textContrast } from './support/textContrast'

/**
 * Continue an agent as its own thread (#1028), as Zach picked it in the continue prototype (variant B, in place): a
 * finished agent's row in Agents opens a form in place; a Codex agent is forked by Codex and its new thread opens with
 * Sotto's note; a Claude Code agent's new thread starts from a thin handover that goes with the first message; Codex
 * refusing an agent it no longer has offers the thin handover instead. Stable shows none of it.
 */
const shots = evidenceDirectory('artifacts/continue-agent-thread')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const

const codexAgents: ObservedAgent[] = [
  { id: 'codex-agent-perf', assignmentId: 'perf-1', title: 'Check streaming performance', description: 'Time each chunk from decode to the player.', model: 'GPT-5.4', status: 'completed',
    message: 'The player waits on a 64 KB buffer before it starts; the decoder is not the slow part. Halving the buffer cuts first sound from 410 ms to 190 ms.', durationMs: 193_000 },
  { id: 'codex-agent-decode', assignmentId: 'decode-1', title: 'Measure decode time', description: 'Decode a 40 MB WAV and report the slowest step.', model: 'GPT-5.4', status: 'running' },
  { id: 'codex-agent-copies', assignmentId: 'copies-1', title: 'Look for extra copies', description: 'Find buffers copied more than once.', model: 'GPT-5.4', status: 'completed',
    message: 'One copy in resample() is avoidable; the other two are needed.', durationMs: 160_000 },
]
const claudeAgent: ObservedAgent = { id: 'claude-agent-verify', assignmentId: 'verify-1', title: 'Verify history-off cleanup', description: 'Confirm saved task text is removed.',
  prompt: 'Confirm that saved task text is removed from threads.sqlite when history is turned off, and that nothing else is.', model: 'Sonnet 4.5', status: 'completed',
  message: 'Confirmed. Turning history off removes saved task text and leaves drafts and settings alone. Two tests cover it.', durationMs: 424_000 }

async function agents(page: Page, threadId: string, children: readonly ObservedAgent[], text: string): Promise<void> {
  await page.evaluate(async ({ threadId, children, text }) => {
    const observedAt = new Date().toISOString()
    await window.sottoE2E!.agentEvent!({ type: 'ready', threadId, text, status: 'idle',
      activities: children.map((agent, sequence): AgentActivity => ({ id: `spawn-${agent.assignmentId}`, turnId: 'turn-agents', sequence, kind: 'subagent', title: 'Spawn agent', status: 'completed',
        agents: [{ ...agent, observedAt, startedAt: new Date(Date.now() - 200_000).toISOString() }] })) })
  }, { threadId, children, text })
}

async function launch(enabled: boolean): Promise<LaunchedSotto> {
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = `continue-agent-thread=${enabled ? 1 : 0}`
  try { return await launchSotto('phase3-workspace') } finally { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous }
}

async function ready(launched: LaunchedSotto, threadId: string): Promise<void> {
  const { page } = launched
  await page.evaluate(async threadId => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
    await window.sotto!.agents!.command({ type: 'select-thread', threadId })
  }, threadId)
  await page.reload()
  await openThreads(page)
  await page.evaluate(() => document.fonts.ready)
}

async function openAgents(page: Page): Promise<void> {
  if (await page.getByRole('complementary', { name: 'Tools', exact: true }).count() === 0) await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
}

/** Nothing outside the window or the panel, and the text 4.5:1 on what it sits on, at every size and in both themes. */
async function judge(launched: LaunchedSotto, name: string, region: string, selector: string, checks: unknown[]): Promise<void> {
  const { page } = launched
  for (const [width, height] of SIZES) for (const appearance of ['dark', 'light'] as const) {
    await resizeContentWindow(launched, width, height, [800, 540])
    await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    const overflow = await page.locator(region).first().evaluate(element => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    const contrast = await textContrast(page.locator(region).first(), selector, true)
    expect(contrast.length).toBeGreaterThan(0)
    const lowest = Math.min(...contrast.map(item => item.ratio))
    expect(lowest, JSON.stringify(contrast.filter(item => item.ratio < 4.5))).toBeGreaterThanOrEqual(4.5)
    checks.push({ name, width, height, appearance, lowestContrast: lowest })
    // The form's own actions in view, as focus puts them when it opens.
    const form = page.locator('.agent-continue__form .agent-continue__actions')
    if (await form.count()) await form.last().evaluate(element => element.scrollIntoView({ block: 'nearest' }))
    await page.mouse.move(2, 2)
    await page.screenshot({ path: join(shots, `${name}-${width}x${height}-${appearance}.png`) })
  }
  await resizeContentWindow(launched, 1280, 800, [800, 540])
  await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
}

test('a Codex agent forks into a thread of its own from its row, and one Codex no longer has offers a thin handover', async () => {
  test.setTimeout(240_000)
  await mkdir(shots, { recursive: true })
  const launched = await launch(true)
  const errors: string[] = []
  launched.page.on('pageerror', error => errors.push(error.message))
  const checks: unknown[] = []
  try {
    const { page } = launched
    await ready(launched, 'release-notes')
    await agents(page, 'release-notes', codexAgents, 'Two of the three agents have finished. The player’s start-up buffer is the slow part.')
    await openAgents(page)
    const roster = page.getByRole('list', { name: 'Spawned agents' })
    await expect(roster.locator('.subagent-item')).toHaveCount(3)

    // A working agent is refused before any press.
    await page.locator('[data-agent-id="codex-agent-decode"] .subagent-head').click()
    const decodeContinue = page.getByRole('button', { name: 'Continue Measure decode time as its own thread' })
    await expect(decodeContinue).toHaveAttribute('aria-disabled', 'true')
    await expect(page.locator('[data-agent-id="codex-agent-decode"]')).toContainText('It’s still working. Continue it once it finishes.')
    await page.locator('[data-agent-id="codex-agent-decode"] .subagent-head').click()

    // The form opens in place from the keyboard, and Escape puts it away with focus back on the press.
    await page.locator('[data-agent-id="codex-agent-perf"] .subagent-head').click()
    const press = page.getByRole('button', { name: 'Continue Check streaming performance as its own thread' })
    await press.focus()
    await page.keyboard.press('Enter')
    const form = page.getByRole('region', { name: 'Fork it into a new Codex thread' })
    await expect(form).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start the thread' })).toBeFocused()
    await expect(form).toContainText('Codex keeps the task encrypted')
    await expect(form.getByRole('combobox', { name: 'Model for the forked thread' })).toBeVisible()
    await expect(form.getByRole('combobox', { name: 'Working copy for the new thread' })).toHaveValue('shared')
    await expect(form).toContainText('This computer')
    await judge(launched, 'codex-choose', '.tools-panel__sheet', '.agent-continue__form h4, .agent-continue__form p, .agent-continue__where, .subagent-title, .subagent-description, .tt-button', checks)
    await page.keyboard.press('Escape')
    await expect(form).toHaveCount(0)
    await expect(press).toBeFocused()
    await expect(page.locator('.subagent-details')).toHaveCount(1)

    // Codex no longer has an agent: the row says so and offers a thin handover, and nothing was made.
    const before = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.length)
    await page.locator('[data-agent-id="codex-agent-perf"] .subagent-head').click()
    await page.locator('[data-agent-id="codex-agent-copies"] .subagent-head').click()
    await page.evaluate(async text => { await window.sottoE2E!.agentEvent!({ type: 'fork-refuse', threadId: 'release-notes', text }) }, AGENT_FORK_GONE)
    await page.getByRole('button', { name: 'Continue Look for extra copies as its own thread' }).click()
    await page.getByRole('button', { name: 'Start the thread' }).click()
    const gone = page.getByRole('region', { name: 'Codex can’t fork this agent' })
    await expect(gone).toContainText('Codex no longer has this agent’s conversation, so nothing was made.')
    await expect(page.getByRole('button', { name: 'Start from a handover' })).toBeFocused()
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.length)).toBe(before)
    // The refusal is said in the row it was asked from, not as the window's banner.
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).error)).toBeNull()
    await expect(page.locator('.thread-transcript').first()).not.toContainText('Codex no longer has this agent’s conversation')
    await judge(launched, 'codex-gone', '.tools-panel__sheet', '.agent-continue__form h4, .agent-continue__form p, .tt-button', checks)
    await page.keyboard.press('Escape')
    await expect(gone).toHaveCount(0)

    // Codex forks the finished agent; its thread opens with Sotto's note and the agent's own reply.
    await page.locator('[data-agent-id="codex-agent-copies"] .subagent-head').click()
    await page.locator('[data-agent-id="codex-agent-perf"] .subagent-head').click()
    await page.getByRole('button', { name: 'Continue Check streaming performance as its own thread' }).click()
    await page.getByRole('button', { name: 'Start the thread' }).click()
    const pane = page.locator('.thread-transcript').first()
    const note = page.getByRole('note').filter({ hasText: 'forked the agent' })
    await expect(note).toContainText('Codex forked the agent Check streaming performance from Release notes 1.4 into this thread')
    await expect(note).toContainText('Sotto can’t show it here')
    await expect(pane).toContainText('Halving the buffer cuts first sound from 410 ms to 190 ms.')
    const forked = await page.evaluate(async () => { const state = await window.sotto!.agents!.get(); return state.host.threads.find(thread => thread.id === state.activeThreadId) })
    expect(forked).toMatchObject({ title: 'Check streaming performance', startedFrom: { threadId: expect.stringMatching(/release-notes$/u), from: 'agent', route: 'fork' } })
    await page.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await judge(launched, 'codex-started', '.thread-transcript', '.thread-start-note p, .thread-start-note strong, .thread-message p, .thread-start-note__open', checks)
    // The note opens the thread the agent came from.
    await note.getByRole('button', { name: 'Open Release notes 1.4' }).click()
    await expect.poll(async () => page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId)).toMatch(/release-notes$/u)
    expect(errors).toEqual([])
  } finally {
    await writeFile(join(shots, 'codex-checks.json'), JSON.stringify(checks, null, 2)).catch(() => undefined)
    await closeSotto(launched)
  }
})

test('a Claude Code agent starts a thread from a thin handover that goes with its first message', async () => {
  test.setTimeout(240_000)
  await mkdir(shots, { recursive: true })
  const launched = await launch(true)
  const errors: string[] = []
  launched.page.on('pageerror', error => errors.push(error.message))
  const checks: unknown[] = []
  try {
    const { page } = launched
    await ready(launched, 'grok-previews')
    await agents(page, 'grok-previews', [claudeAgent], 'The agent finished. History-off cleanup is right.')
    await openAgents(page)
    await page.locator('[data-agent-id="claude-agent-verify"] .subagent-head').click()
    await page.getByRole('button', { name: 'Continue Verify history-off cleanup as its own thread' }).click()
    const form = page.getByRole('region', { name: 'Continue it from a handover' })
    await expect(form).toContainText('This handover is thin.')
    await expect(form).toContainText('Carries the task and the result.')
    await judge(launched, 'claude-choose', '.tools-panel__sheet', '.agent-continue__form h4, .agent-continue__form p, .agent-continue__where, .tt-button', checks)
    await page.getByRole('button', { name: 'Start the thread' }).click()
    const card = page.getByRole('article', { name: 'Handover this thread started from' })
    await expect(card).toContainText('From the agent Verify history-off cleanup in Grok voice previews. Context, not a new request.')
    await expect(card).toContainText('Handover, thin')
    await expect(page.getByRole('note').filter({ hasText: 'Continued from the agent' })).toContainText('Continued from the agent Verify history-off cleanup in Grok voice previews.')
    // The words are read only on request, from the keyboard, and Escape folds them again.
    const read = card.getByRole('button', { name: 'Read the handover, word for word' })
    await read.focus()
    await page.keyboard.press('Enter')
    const words = card.getByRole('region', { name: 'The handover, word for word' })
    await expect(words).toContainText('This handover is thin.')
    await expect(words).toContainText(claudeAgent.prompt!)
    await expect(words).toContainText(claudeAgent.message!)
    await page.getByRole('button', { name: 'Close tools panel', exact: true }).click()
    await judge(launched, 'claude-started', '.thread-transcript', '.thread-start-note p, .thread-start-handover__lead, .thread-start-handover__ledger, .thread-start-handover__text, .thread-message__tag', checks)
    await words.focus()
    await page.keyboard.press('Escape')
    await expect(words).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Read the handover, word for word' })).toBeFocused()

    // The first message carries the handover ahead of the words; the conversation shows the two apart.
    const threadId = await page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId!)
    await page.evaluate(async threadId => {
      await window.sotto!.agents!.command({ type: 'manual-send', threadId, draftId: crypto.randomUUID(), text: 'Add a test for the drafts.' })
    }, threadId)
    await expect(page.locator('.thread-message[data-role="user"]').filter({ hasText: 'Add a test for the drafts.' })).toBeVisible()
    await expect(page.getByRole('article', { name: 'Handover this thread started from' })).toContainText('Carried the task and the result.')
    const detail = await page.evaluate(async threadId => window.sotto!.agents!.threadDetail!(threadId), threadId)
    const sent = detail!.messages.find(message => message.role === 'user')!
    expect(sent.text).toBe('Add a test for the drafts.')
    expect(sent.handover!.text).toContain(START_HANDOVER_CLOSE)
    expect(sent.handover!.text).toContain(claudeAgent.message!)
    await judge(launched, 'claude-sent', '.thread-transcript', '.thread-start-handover__lead, .thread-start-handover__ledger, .thread-message p', checks)
    expect(errors).toEqual([])
  } finally {
    await writeFile(join(shots, 'claude-checks.json'), JSON.stringify(checks, null, 2)).catch(() => undefined)
    await closeSotto(launched)
  }
})

test('stable shows no way to continue an agent', async () => {
  test.setTimeout(120_000)
  const launched = await launch(false)
  try {
    const { page } = launched
    await ready(launched, 'release-notes')
    await agents(page, 'release-notes', codexAgents, 'Two of the three agents have finished.')
    await openAgents(page)
    await page.locator('[data-agent-id="codex-agent-perf"] .subagent-head').click()
    await expect(page.locator('.subagent-details')).toContainText('Halving the buffer')
    await expect(page.getByRole('button', { name: /as its own thread/u })).toHaveCount(0)
    const refused = await page.evaluate(async () => window.sotto!.agents!.command({ type: 'continue-agent', threadId: 'release-notes', agentId: 'codex-agent-perf', newThreadId: crypto.randomUUID() }))
    expect(refused.error).toMatch(/Sotto Owl/u)
  } finally { await closeSotto(launched) }
})
