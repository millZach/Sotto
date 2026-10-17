import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AgentMessage } from '../../src/shared/agents'
import { START_HANDOVER_CLOSE } from '../../src/shared/threadStarts'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { textContrast } from './support/textContrast'

/**
 * Fork from here (#1028, E5b), as Zach picked it in the continue prototype (variant B, in place): a reply's Fork from here
 * draws its card into the transcript under that reply, with everything below it marked as not carried. Claude Code forks
 * with its own copy of the conversation; Grok Build has none, so its fork starts from a handover that goes with the first
 * message. Stable shows none of it.
 */
const shots = evidenceDirectory('artifacts/fork-from-here')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const at = (minute: number): string => new Date(Date.now() - (60 - minute) * 60_000).toISOString()
const conversation = (prefix: string): AgentMessage[] => [
  { id: `${prefix}-1`, role: 'user', text: 'The WAV preview stalls after two seconds. Find out why, fix it and run the tests.', createdAt: at(1) },
  { id: `${prefix}-2`, role: 'assistant', text: 'Fixed. The length marker in the header was written once, before any audio arrived, so players stopped after the first chunk. It is now patched after every chunk, and the three new tests pass.', createdAt: at(5) },
  { id: `${prefix}-3`, role: 'user', text: 'Paste the full test output and the diff so I can check them.', createdAt: at(10) },
  { id: `${prefix}-4`, role: 'assistant', text: 'Here are the full test output and the diff of both files.', createdAt: at(12) },
]

async function launch(enabled: boolean): Promise<LaunchedSotto> {
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = `continue-agent-thread=${enabled ? 1 : 0}`
  try { return await launchSotto('phase3-workspace') } finally { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous }
}

async function ready(launched: LaunchedSotto, threadId: string, prefix: string): Promise<void> {
  const { page } = launched
  await page.evaluate(async threadId => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
    await window.sotto!.agents!.command({ type: 'select-thread', threadId })
  }, threadId)
  await page.evaluate(async ({ threadId, messages }) => { await window.sottoE2E!.agentEvent!({ type: 'history', threadId, text: '', status: 'idle', messages }) }, { threadId, messages: conversation(prefix) })
  await page.reload()
  await openThreads(page)
  await page.evaluate(() => document.fonts.ready)
}

async function judge(launched: LaunchedSotto, name: string, selector: string, checks: unknown[]): Promise<void> {
  const { page } = launched
  for (const [width, height] of SIZES) for (const appearance of ['dark', 'light'] as const) {
    await resizeContentWindow(launched, width, height, [800, 540])
    await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    const transcript = page.locator('.thread-transcript').first()
    expect(await transcript.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const contrast = await textContrast(transcript, selector, true)
    expect(contrast.length).toBeGreaterThan(0)
    const lowest = Math.min(...contrast.map(item => item.ratio))
    expect(lowest, JSON.stringify(contrast.filter(item => item.ratio < 4.5))).toBeGreaterThanOrEqual(4.5)
    checks.push({ name, width, height, appearance, lowestContrast: lowest })
    const card = page.locator('.fork-card')
    if (await card.count()) await card.first().evaluate(element => element.scrollIntoView({ block: 'center' }))
    await page.mouse.move(2, 2)
    await page.screenshot({ path: join(shots, `${name}-${width}x${height}-${appearance}.png`) })
  }
  await resizeContentWindow(launched, 1280, 800, [800, 540])
  await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
}

test('Claude Code forks a thread at a reply into a thread of its own, and leaves what follows where it was', async () => {
  test.setTimeout(240_000)
  await mkdir(shots, { recursive: true })
  const launched = await launch(true)
  const errors: string[] = []
  launched.page.on('pageerror', error => errors.push(error.message))
  const checks: unknown[] = []
  try {
    const { page } = launched
    await ready(launched, 'grok-previews', 'claude')
    const reply = page.locator('[data-message-id="claude-2"]')
    await reply.hover()
    const press = reply.getByRole('button', { name: /^Fork from here/u })
    await press.focus()
    await page.keyboard.press('Enter')
    const card = page.getByRole('region', { name: 'Fork from here' })
    await expect(card).toContainText('A new Claude Code thread with everything above this line, through Claude Code’s own fork.')
    await expect(card).toContainText('Files aren’t rewound')
    await expect(card.getByRole('button', { name: 'Fork' })).toBeFocused()
    await expect(page.getByText('Not carried: this stays in Grok voice previews')).toBeVisible()
    await expect(page.locator('[data-message-id="claude-3"]')).toHaveAttribute('data-not-carried', 'true')
    await judge(launched, 'claude-choose', '.fork-card h4, .fork-card p, .fork-card__stays, .thread-message p', checks)
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
    await expect(press).toBeFocused()

    await press.click()
    await page.getByRole('region', { name: 'Fork from here' }).getByRole('button', { name: 'Fork' }).click()
    const forked = await expect.poll(async () => page.evaluate(async () => { const state = await window.sotto!.agents!.get(); return state.host.threads.find(thread => thread.id === state.activeThreadId)?.title })).toBe('Fork of Grok voice previews')
    void forked
    const note = page.getByRole('note').filter({ hasText: 'Forked from' })
    await expect(note).toContainText('Forked from Grok voice previews at Claude Code’s reply')
    await expect(note).toContainText('Files weren’t rewound.')
    const pane = page.locator('.thread-transcript').first()
    await expect(pane).toContainText('It is now patched after every chunk')
    await expect(pane).not.toContainText('Paste the full test output')
    await judge(launched, 'claude-forked', '.thread-start-note p, .thread-message p', checks)
    expect(errors).toEqual([])
  } finally {
    await writeFile(join(shots, 'claude-checks.json'), JSON.stringify(checks, null, 2)).catch(() => undefined)
    await closeSotto(launched)
  }
})

test('a Grok Build fork starts from a handover of the conversation up to the reply, with its first message', async () => {
  test.setTimeout(240_000)
  await mkdir(shots, { recursive: true })
  const launched = await launch(true)
  const checks: unknown[] = []
  try {
    const { page } = launched
    await ready(launched, 'benchmark', 'grok')
    const reply = page.locator('[data-message-id="grok-2"]')
    await reply.hover()
    await reply.getByRole('button', { name: /^Fork from here/u }).click()
    const card = page.getByRole('region', { name: 'Fork from here' })
    await expect(card).toContainText('Grok Build has no fork of its own, so the new Grok Build thread starts from a handover of this conversation up to')
    await judge(launched, 'grok-choose', '.fork-card h4, .fork-card p, .fork-card__stays', checks)
    await card.getByRole('button', { name: 'Start the Grok Build thread' }).click()
    const handover = page.getByRole('article', { name: 'Handover this thread started from' })
    await expect(handover).toContainText('From Benchmark rerun, up to Grok Build’s reply. Context, not a new request. It goes with your first message.')
    await handover.getByRole('button', { name: 'Read the handover, word for word' }).click()
    await expect(handover.getByRole('region', { name: 'The handover, word for word' })).toContainText('It is now patched after every chunk')
    await expect(handover.getByRole('region', { name: 'The handover, word for word' })).not.toContainText('Paste the full test output')
    await judge(launched, 'grok-started', '.thread-start-note p, .thread-start-handover__lead, .thread-start-handover__ledger, .thread-start-handover__text', checks)
    const threadId = await page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId!)
    await page.evaluate(async threadId => {
      await window.sotto!.agents!.command({ type: 'manual-send', threadId, draftId: crypto.randomUUID(), text: 'Add a test for a stream that ends mid-chunk.' })
    }, threadId)
    await expect(page.locator('.thread-message[data-role="user"]').filter({ hasText: 'Add a test for a stream that ends mid-chunk.' })).toBeVisible()
    const detail = await page.evaluate(async threadId => window.sotto!.agents!.threadDetail!(threadId), threadId)
    const sent = detail!.messages.find(message => message.role === 'user')!
    expect(sent.text).toBe('Add a test for a stream that ends mid-chunk.')
    expect(sent.handover!.text).toContain(START_HANDOVER_CLOSE)
  } finally {
    await writeFile(join(shots, 'grok-checks.json'), JSON.stringify(checks, null, 2)).catch(() => undefined)
    await closeSotto(launched)
  }
})

test('stable offers no Fork from here', async () => {
  test.setTimeout(120_000)
  const launched = await launch(false)
  try {
    await ready(launched, 'grok-previews', 'claude')
    const page: Page = launched.page
    await page.locator('[data-message-id="claude-2"]').hover()
    await expect(page.getByRole('button', { name: /^Fork from here/u })).toHaveCount(0)
    const refused = await page.evaluate(async () => window.sotto!.agents!.command({ type: 'fork-thread', threadId: 'grok-previews', messageId: 'claude-2', newThreadId: crypto.randomUUID() }))
    expect(refused.error).toMatch(/Sotto Owl/u)
  } finally { await closeSotto(launched) }
})
