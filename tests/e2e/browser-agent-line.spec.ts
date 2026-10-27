import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentMessage } from '../../src/shared/agents'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'
import { startMonitoredThread } from './support/monitoredThread'
import { resizeContentWindow } from './support/sottoWindow'
import { elementContrast } from './support/elementContrast'
import { hostKeysPerTest } from './support/hostKeys'
import { evidenceDirectory } from '../fixtures/evidence'

// The browser line (ADR-0154; Owl only): a turn's calls to Sotto's own browser fold into one quiet line that updates in
// place, "Browsing localhost:5173 · clicked in the page" while they run and "Browsed localhost:5173 · N steps" once the turn
// moves on, and a press opens the steps. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes
// artifacts/browser-agent-line.

type HostEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]
const evidence = evidenceDirectory('artifacts/browser-agent-line')
const hostKeys = hostKeysPerTest()
const key = hostKeys.key
test.beforeEach(() => { hostKeys.reset() })

const THREAD = 'workshop'
const TURN = 'browse-turn'
const SAID = 'browse-said'
const SIZES = [[1280, 800], [820, 560]] as const
const pane = (page: Page): Locator => page.locator(`section.thread-pane[data-thread-id="${key(THREAD)}"]`)
const log = (page: Page): Locator => pane(page).getByRole('log', { name: 'Thread transcript' })

async function launch(enabled: boolean): Promise<LaunchedSotto> {
  const previous = process.env.SOTTO_OWL_FEATURES
  // The slim composer stays out of it, so the composer keeps one size while the line changes.
  process.env.SOTTO_OWL_FEATURES = `quiet-browser=${enabled ? 1 : 0},composer-shrink=0`
  try { return await launchSotto() } finally { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous }
}

async function event(page: Page, value: HostEvent): Promise<void> {
  await page.evaluate(async value => { await window.sottoE2E!.agentEvent!(value) }, value)
}

const at = (second: number): string => new Date(Date.UTC(2026, 9, 27, 9, 0, second)).toISOString()
let sequence = 0
const record = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: TURN, sequence: sequence++, kind: 'tool', status: 'completed', title: 'Tool', afterMessageId: SAID, ...patch })
/** Claude Code's name for a call to Sotto's browser, with its input as the client reported it. */
const browser = (id: string, tool: string, input: unknown, patch: Partial<AgentActivity> = {}): AgentActivity =>
  record({ id, title: `mcp__sotto_browser__${tool}`, text: JSON.stringify(input), ...patch })

/** The agent's turn as it checks sign-in on the dev server, the same run the prototype plays. */
function checkingSignIn(): AgentActivity[] {
  sequence = 0
  return [
    record({ id: 'turn', kind: 'turn', title: 'Turn', status: 'running', startedAt: at(0) }),
    record({ id: 'dev', kind: 'command', title: 'Bash', command: 'npm run dev', durationMs: 2_400 }),
    browser('open', 'browser_open', { url: 'http://localhost:5173/', description: 'Check that sign-in works' }),
    browser('look', 'browser_action', { action: { type: 'inspect' } }),
    browser('scroll', 'browser_action', { action: { type: 'scroll', x: 640, y: 400, deltaX: 0, deltaY: 600 } }, { status: 'failed', error: 'The browser action did not finish. Inspect the page before trying again.' }),
    browser('sign-in', 'browser_action', { action: { type: 'click', x: 1180, y: 32 } }),
    browser('email', 'browser_action', { action: { type: 'type', text: 'zach@example.com' } }),
    browser('password', 'browser_action', { action: { type: 'type', text: 'correct horse' } }),
    browser('enter', 'browser_action', { action: { type: 'key', key: 'Enter' } }),
    browser('notes', 'browser_action', { action: { type: 'inspect' } }),
    browser('picture', 'browser_action', { action: { type: 'screenshot' } }, { status: 'running' }),
  ]
}

const messages: AgentMessage[] = [
  { id: 'browse-ask', role: 'user', text: 'Check that sign-in works on the dev server, and fix whatever breaks.', createdAt: at(0) },
  { id: SAID, role: 'assistant', text: 'I’ll start the dev server and sign in the way a person would.', createdAt: at(1) },
]

async function prepare(launched: LaunchedSotto): Promise<Page> {
  await startMonitoredThread(launched, hostKeys.read, pane)
  const { page } = launched
  await page.evaluate(() => document.fonts.ready)
  await event(page, { type: 'history', threadId: THREAD, text: '', messages, status: 'running', activities: checkingSignIn() })
  await expect(log(page).locator(`[data-message-id="${SAID}"]`)).toBeVisible()
  return page
}

async function appearance(page: Page, mode: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async mode => { await window.sotto!.updateSettings({ appearance: mode }) }, mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
}

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  const { page } = launched
  for (const [width, height] of SIZES) {
    await resizeContentWindow(launched, width, height, [700, 500])
    // Nothing in the transcript runs past its edge at either size.
    expect(await log(page).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
    for (const mode of ['dark', 'light'] as const) {
      await appearance(page, mode)
      await page.mouse.move(0, 0)
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
      await page.screenshot({ path: resolve(evidence, `${name}-${width}-${mode}.png`), animations: 'disabled', caret: 'hide' })
    }
  }
  await appearance(page, 'dark')
}

test('an agent\'s calls to Sotto\'s browser read as one line that updates in place and opens to its steps', async () => {
  await mkdir(evidence, { recursive: true })
  const launched = await launch(true)
  try {
    const page = await prepare(launched)
    const transcript = log(page)
    const line = transcript.getByRole('button', { name: 'Browsing localhost:5173 · took a picture of the page' })
    await expect(line).toHaveAttribute('aria-expanded', 'false')
    await expect(transcript.locator('.thread-browser')).toHaveCount(1)
    // With room for them, the line's words are whole, not cut short.
    expect(await line.locator('.thread-browser__words').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    // No row per call: the working line holds only the command.
    await expect(transcript.getByRole('button', { name: 'Working, 1 step so far' })).toBeVisible()
    await expect(transcript.locator('.thread-activity__row')).toHaveCount(0)
    // The dot holds still.
    await expect(line.locator('.thread-browser__dot')).toHaveCSS('animation-name', 'none')
    await capture(launched, 'running')

    // From the keyboard: the line opens on Enter to its steps, the failed one marked, and folds on Escape.
    await line.focus()
    await page.keyboard.press('Enter')
    await expect(line).toHaveAttribute('aria-expanded', 'true')
    const steps = transcript.getByRole('list', { name: 'Browsing localhost:5173' })
    await expect(steps.getByRole('listitem')).toHaveText([
      'Opened localhost:5173', 'Looked at the page', 'Could not scroll the page', 'Clicked in the page', 'Typed into the page',
      'Typed into the page', 'Pressed Enter', 'Looked at the page', 'Took a picture of the page',
    ])
    await expect(steps.locator('li[data-failed]')).toHaveText('Could not scroll the page')
    // Its muted warning ink, and every other step's words, read at 4.5:1 or better on either theme.
    for (const mode of ['dark', 'light'] as const) {
      await appearance(page, mode)
      for (const words of await steps.locator('.thread-browser__step').all()) expect(await elementContrast(words)).toBeGreaterThanOrEqual(4.5)
      expect(await elementContrast(line.locator('.thread-browser__detail'))).toBeGreaterThanOrEqual(4.5)
    }
    await appearance(page, 'dark')
    await capture(launched, 'expanded')
    await line.focus()
    await page.keyboard.press('Escape')
    await expect(line).toHaveAttribute('aria-expanded', 'false')
    await expect(line).toBeFocused()

    // The turn moves on to other work: the same line says where it browsed and how many steps it took.
    const movedOn = checkingSignIn().map(item => item.id === 'picture' ? { ...item, status: 'completed' as const } : item)
    movedOn.push(record({ id: 'fix', kind: 'file-change', title: 'Edit', status: 'completed', changes: [{ path: 'src/SignInForm.tsx', kind: 'update', diff: '-<form>\n+<form onSubmit={submit}>' }] }))
    movedOn.push(record({ id: 'test', kind: 'command', title: 'Bash', command: 'npm test -- SignInForm', status: 'running' }))
    await event(page, { type: 'stream', threadId: THREAD, messageId: SAID, text: messages[1]!.text, status: 'running', activities: movedOn })
    const browsed = transcript.getByRole('button', { name: 'Browsed localhost:5173 · 9 steps' })
    await expect(browsed).toBeVisible()
    await expect(browsed.locator('.thread-browser__dot')).toHaveCount(0)
    expect(await browsed.locator('.thread-browser__words').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await capture(launched, 'finished')
  } finally { await closeSotto(launched) }
})

test('stable keeps a row for every call to Sotto\'s browser', async () => {
  const launched = await launch(false)
  try {
    const page = await prepare(launched)
    const transcript = log(page)
    await expect(transcript.locator('.thread-browser')).toHaveCount(0)
    const working = transcript.getByRole('button', { name: 'Working, 10 steps so far' })
    await working.click()
    await expect(transcript.locator('.thread-activity__row[data-kind="tool"]')).not.toHaveCount(0)
    await expect(transcript.locator('.thread-browser')).toHaveCount(0)
  } finally { await closeSotto(launched) }
})
