import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import type { AgentActivity } from '../../src/shared/agentActivity'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { composerEdges } from './support/composerEdge'
import { elementContrast } from './support/elementContrast'
import { hostKeysPerTest } from './support/hostKeys'
import { onReleaseTrack } from './support/releaseTrack'
import { type LaunchedSotto, openPage, openThreads } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { seedWatcherRoom } from './support/watcherRoom'

/**
 * Tips (ADR-0159; Owl only): one quiet line under a working thread's working words, and under Watcher's, about Sotto and
 * the thread's provider. A Claude thread gets Claude's and Sotto's tips, a Codex thread Codex's and Sotto's, any other
 * provider Sotto's only, and Watcher Sotto's and its own. Hide takes a tip away for good, Settings › Threads turns them
 * off and shows hidden ones again, and stable shows none of it. Run after `npm run build`. Captures go to disposable run
 * evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/thread-tips.
 */
type HostEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]
const evidence = evidenceDirectory('artifacts/thread-tips')
const hostKeys = hostKeysPerTest()
test.beforeEach(() => { hostKeys.reset() })
test.describe.configure({ timeout: 4 * 60_000 })

/** The tips Watcher's line may show (tips.tsx, audience `watcher`). */
const WATCHER_TIPS = ['sotto.dictate', 'watcher.waiting', 'sotto.web-links', 'watcher.start-thread']
const LAUNCH = { onboardingComplete: true, appearance: 'dark', motion: 'normal', agents: 'design-threads', scenario: 'design-threads', darkTheme: 't3-code' } as const

const paneOf = (page: Page, threadId: string): Locator => page.locator(`section.thread-pane[data-thread-id="${hostKeys.key(threadId)}"]`)
const liveLine = (scope: Locator): Locator => scope.getByTestId('thread-activity-live')
const tipIn = (scope: Locator): Locator => liveLine(scope).getByRole('note', { name: 'Tip', exact: true })

async function event(page: Page, value: HostEvent): Promise<void> {
  await page.evaluate(async value => { await window.sottoE2E!.agentEvent!(value) }, value)
}

/** A turn that has just started: the prompt, the turn's own record and one step still running. */
async function startTurn(page: Page, threadId: string, turnId: string, text: string, step: string): Promise<void> {
  const activities: AgentActivity[] = [
    { id: turnId, turnId, sequence: 0, kind: 'turn', status: 'running', title: 'Turn' },
    { id: `${turnId}-step-1`, turnId, sequence: 1, kind: 'command', status: 'running', title: 'Bash', command: step, startedAt: new Date().toISOString() },
  ]
  await event(page, { type: 'manual', threadId, text, status: 'running', activities })
}

/** One more step in the same turn, which draws the working line again. */
async function anotherStep(page: Page, threadId: string, turnId: string): Promise<void> {
  const at = new Date().toISOString()
  const activities: AgentActivity[] = [
    { id: turnId, turnId, sequence: 0, kind: 'turn', status: 'running', title: 'Turn' },
    { id: `${turnId}-step-1`, turnId, sequence: 1, kind: 'command', status: 'completed', title: 'Bash', command: 'npm test -- --run tests/unit/voice', startedAt: at, completedAt: at },
    { id: `${turnId}-step-2`, turnId, sequence: 2, kind: 'command', status: 'running', title: 'Bash', command: 'npm run lint', startedAt: at },
  ]
  await event(page, { type: 'stream', threadId, messageId: `${turnId}-said`, text: 'The first play waits on the sample to decode. Checking the lint next.', status: 'running', activities })
}

async function endTurn(page: Page, threadId: string): Promise<void> {
  await event(page, { type: 'ready', threadId, text: 'Done. The preview no longer stutters on its first play.', status: 'idle', activities: [] })
}

async function selectThread(page: Page, title: string): Promise<void> {
  await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true }).click({ position: { x: 16, y: 12 } })
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

async function appearance(page: Page, mode: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async mode => { await window.sotto!.updateSettings({ appearance: mode }) }, mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
}

/**
 * Sets the window's content size and waits until it stays there. On a tiling desktop the compositor can lay the window
 * out again just after its first resize, so a size that held for one read is checked again after the layout settles.
 */
async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  const now = (): Promise<{ width: number; height: number }> => launched.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  for (let attempt = 0; attempt < 5; attempt++) {
    await resizeContentWindow(launched, width, height)
    await launched.page.waitForTimeout(500)
    const held = await now()
    if (held.width === width && held.height === height) return
  }
  expect(await now(), 'the window keeps the size it was given').toEqual({ width, height })
}

/** A capture of the whole window at the size its name gives. */
async function capture(page: Page, name: string, expected: { width: number; height: number }): Promise<void> {
  await page.mouse.move(0, 0)
  await page.waitForTimeout(250)
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), `${name} is captured at its size`).toEqual(expected)
  await page.screenshot({ path: resolve(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}
const LAPTOP = { width: 1280, height: 800 }
const MINIMUM = { width: 820, height: 560 }

/**
 * Where the tip sits against the working words: the element straight after the words, starting where they end, its
 * hook straight under where the words' line starts, the lightbulb centred on the glyphs of the tip's first word, and
 * nothing in the transcript or the tip wider than its box.
 */
async function tipLayout(scope: Locator): Promise<{ afterWords: boolean; gap: number; hookIndent: number; bulbOffset: number; tipOverflow: number; logOverflow: number; pastLog: number; detail: string }> {
  return liveLine(scope).evaluate(live => {
    const tip = live.querySelector<HTMLElement>(':scope > .thread-tip')!
    const words = live.querySelector<HTMLElement>(':scope > .thread-activity-live__line')!
    const text = tip.querySelector<HTMLElement>('.thread-tip__text')!
    const bulb = tip.querySelector<SVGElement>('.thread-tip__bulb')!.getBoundingClientRect()
    const log = live.closest<HTMLElement>('[aria-label="Thread transcript"], .thread-workspace__transcript')!
    // The first word the tip says, as the font sets it: the box from its ascent to its descent.
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT, { acceptNode: node => node.textContent!.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT })
    const first = walker.nextNode()!
    const range = document.createRange()
    const start = first.textContent!.search(/\S/u)
    range.setStart(first, start); range.setEnd(first, start + (/^\S+/u.exec(first.textContent!.slice(start))?.[0].length ?? 1))
    const glyphs = range.getClientRects()[0]!
    const tipBox = tip.getBoundingClientRect(), wordsBox = words.getBoundingClientRect(), textBox = text.getBoundingClientRect()
    const round = (value: number): number => Math.round(value * 10) / 10
    return {
      afterWords: tip.previousElementSibling === words,
      gap: Math.round(tipBox.top - wordsBox.bottom),
      // The line's content starts past its padding: the pulse when it shows, otherwise the words.
      hookIndent: round(tip.querySelector('.thread-tip__hook')!.getBoundingClientRect().left - (wordsBox.left + parseFloat(getComputedStyle(words).paddingLeft))),
      bulbOffset: round((bulb.top + bulb.bottom) / 2 - (glyphs.top + glyphs.bottom) / 2),
      tipOverflow: tip.scrollWidth - tip.clientWidth,
      logOverflow: log.scrollWidth - log.clientWidth,
      pastLog: Math.round(tipBox.right - log.getBoundingClientRect().right),
      detail: `tip ${round(tipBox.top)}..${round(tipBox.bottom)} text ${round(textBox.top)}..${round(textBox.bottom)} word ${round(glyphs.top)}..${round(glyphs.bottom)} bulb ${round(bulb.top)}..${round(bulb.bottom)} line-height ${getComputedStyle(text).lineHeight}`,
    }
  })
}

function expectUnderWords(layout: Awaited<ReturnType<typeof tipLayout>>, where: string): void {
  const context = `${where}: ${JSON.stringify(layout)}`
  expect(layout.afterWords, context).toBe(true)
  // Pulled up by its -6px margin to hook onto the words, never over them and never a line away.
  expect(layout.gap, context).toBeGreaterThanOrEqual(-8)
  expect(layout.gap, context).toBeLessThanOrEqual(4)
  expect(Math.abs(layout.hookIndent), context).toBeLessThanOrEqual(1)
  expect(Math.abs(layout.bulbOffset), context).toBeLessThanOrEqual(1.5)
  expect(layout.tipOverflow, context).toBeLessThanOrEqual(1)
  expect(layout.logOverflow, context).toBeLessThanOrEqual(1)
  expect(layout.pastLog, context).toBeLessThanOrEqual(0)
}

test.beforeAll(async () => { await mkdir(evidence, { recursive: true }) })

test('a working Claude thread shows one tip under its working words, Hide takes it away, and Settings turns tips off', async () => {
  await onReleaseTrack('owl', () => withSotto(LAUNCH, async (launched: LaunchedSotto) => {
    const { page } = launched
    await openThreads(page)
    await hostKeys.read(page)
    await size(launched, 1280, 800)
    // The rotation's first place is a Sotto tip; one on, the turn shows its provider's own (ADR-0159).
    await page.evaluate(() => localStorage.setItem('sotto.tips.next.thread:claude', '1'))
    await selectThread(page, 'Grok voice previews')
    const pane = paneOf(page, 'grok-previews')
    await startTurn(page, 'grok-previews', 'tips-turn-1', 'The voice preview stutters on its first play. Find out why and fix it.', 'npm test -- --run tests/unit/voice')
    await expect(liveLine(pane)).toBeVisible()
    const tip = tipIn(pane)
    await expect(tip).toBeVisible()
    await expect(tipIn(pane)).toHaveCount(1)
    const shown = await tip.getAttribute('data-tip')
    expect(shown, 'one place into the rotation, a Claude thread shows a Claude tip').toMatch(/^claude\./u)
    await expect(tip.getByRole('button', { name: 'Hide this tip', exact: true })).toBeVisible()
    expectUnderWords(await tipLayout(pane), '1280x800 dark')
    expect(await composerEdges(page, `section.thread-pane[data-thread-id="${hostKeys.key('grok-previews')}"]`), 'the composer has no edge while a tip shows').toEqual([])
    expect(await elementContrast(tip.locator('.thread-tip__text')), 'the tip reads at 4.5:1 in dark').toBeGreaterThanOrEqual(4.5)
    await capture(page, 'claude-1280x800-dark', LAPTOP)

    // The turn keeps its tip through a change of look.
    await appearance(page, 'light')
    await expect(tip).toHaveAttribute('data-tip', shown!)
    expectUnderWords(await tipLayout(pane), '1280x800 light')
    expect(await elementContrast(tip.locator('.thread-tip__text')), 'the tip reads at 4.5:1 in light').toBeGreaterThanOrEqual(4.5)
    await capture(page, 'claude-1280x800-light', LAPTOP)
    await appearance(page, 'dark')

    // At the window's minimum the tip wraps inside the transcript, which never scrolls sideways.
    await size(launched, 820, 560)
    await expect(tip).toHaveAttribute('data-tip', shown!)
    expectUnderWords(await tipLayout(pane), '820x560 dark')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 'the window does not scroll sideways').toBeLessThanOrEqual(0)
    await capture(page, 'claude-820x560-dark', MINIMUM)
    await size(launched, 1280, 800)

    // Reduced motion: the tip arrives without its fade.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await expect.poll(() => tip.evaluate(node => getComputedStyle(node).animationName)).toBe('none')
    expectUnderWords(await tipLayout(pane), '1280x800 dark, reduced motion')
    await capture(page, 'claude-1280x800-dark-reduced-motion', LAPTOP)
    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'system' }) })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(page.locator('html')).not.toHaveAttribute('data-reduced-motion', 'on')

    // Hide: the tip leaves, focus goes back to the working words, and the turn shows no other tip as it goes on.
    await tip.getByRole('button', { name: 'Hide this tip', exact: true }).click()
    await expect(tipIn(pane)).toHaveCount(0)
    await expect(liveLine(pane)).toBeVisible()
    await expect(liveLine(pane).locator('button.thread-activity-live__line')).toBeFocused()
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sotto.tips.setAside') ?? '[]') as string[])).toEqual([shown])
    await anotherStep(page, 'grok-previews', 'tips-turn-1')
    await expect(liveLine(pane).getByRole('button', { name: /^Working, 2 steps so far$/u })).toBeVisible()
    await page.waitForTimeout(600)
    await expect(tipIn(pane), 'a hidden tip does not come back for its turn').toHaveCount(0)

    // The next turn shows the next tip, never the hidden one.
    await endTurn(page, 'grok-previews')
    await expect(liveLine(pane)).toHaveCount(0)
    await startTurn(page, 'grok-previews', 'tips-turn-2', 'Now make the preview stop when another voice is picked.', 'rg -n "preview" src/renderer')
    await expect(tipIn(pane)).toBeVisible()
    const next = await tipIn(pane).getAttribute('data-tip')
    expect(next).toMatch(/^(claude|sotto)\./u)
    expect(next, 'a hidden tip never shows again').not.toBe(shown)

    // Settings › Threads › In a thread: the switch, and Show hidden tips again with the one hidden tip counted.
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    const settings = page.locator('#settings-agents')
    const group = settings.getByRole('region', { name: 'In a thread', exact: true })
    const toggle = group.getByRole('switch', { name: 'Show tips while threads work', exact: true })
    const again = group.getByRole('button', { name: 'Show hidden tips again', exact: true })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(again).toBeEnabled()
    await expect(group).toContainText('1 tip hidden or used.')
    // The whole group, in the middle of the page with a margin round it, so its heading and its last row are not cut.
    await group.evaluate(node => { node.scrollIntoView({ block: 'center' }) })
    await page.mouse.move(0, 0)
    await page.waitForTimeout(250)
    const box = (await group.boundingBox())!
    const top = Math.max(0, box.y - 16), bottom = Math.min(LAPTOP.height, box.y + box.height + 16)
    expect(box.y, 'the group\'s heading is in the window').toBeGreaterThanOrEqual(0)
    expect(box.y + box.height, 'the group\'s last row is in the window').toBeLessThanOrEqual(LAPTOP.height)
    await page.screenshot({ path: resolve(evidence, 'settings-threads-tips-dark.png'), animations: 'disabled', caret: 'hide',
      clip: { x: Math.max(0, box.x - 16), y: top, width: box.width + 32, height: bottom - top } })

    // Off: the working thread loses its tip and keeps its working words.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(group).toContainText('No tips under a working thread or Watcher.')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).threadTips)).toBe(false)
    await openThreads(page)
    await expect(liveLine(pane)).toBeVisible()
    await expect(tipIn(pane)).toHaveCount(0)

    // On again: the turn's own tip is back.
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).threadTips)).toBe(true)

    // Show hidden tips again clears what was hidden, and the button has nothing left to do.
    await again.click()
    await expect(again).toBeDisabled()
    await expect(group).toContainText('No tips are hidden.')
    expect(await page.evaluate(() => localStorage.getItem('sotto.tips.setAside'))).toBeNull()
    await openThreads(page)
    await expect(tipIn(pane)).toHaveAttribute('data-tip', next!)
  }))
})

test('a working Codex thread shows a Codex or Sotto tip, any other provider Sotto’s only, and Watcher its own', async () => {
  await onReleaseTrack('owl', () => withSotto(LAUNCH, async (launched: LaunchedSotto) => {
    const { page } = launched
    await openThreads(page)
    await hostKeys.read(page)
    await size(launched, 1280, 800)

    // Footer links is a Codex thread the fixture has working; one place into the rotation it shows a Codex tip.
    await page.evaluate(() => localStorage.setItem('sotto.tips.next.thread:codex', '1'))
    await selectThread(page, 'Footer links')
    const codex = paneOf(page, 'footer-links')
    await expect(tipIn(codex)).toBeVisible()
    expect(await tipIn(codex).getAttribute('data-tip'), 'a Codex thread shows a Codex tip').toMatch(/^codex\./u)
    expectUnderWords(await tipLayout(codex), 'Codex 1280x800 dark')
    await capture(page, 'codex-1280x800-dark', LAPTOP)

    // Weekly note is a Grok thread the fixture has working: Sotto's own tips only.
    await selectThread(page, 'Weekly note')
    const grok = paneOf(page, 'weekly-note')
    await expect(tipIn(grok)).toBeVisible()
    expect(await tipIn(grok).getAttribute('data-tip'), 'a Grok thread shows a Sotto tip only').toMatch(/^sotto\./u)
    expectUnderWords(await tipLayout(grok), 'Grok 1280x800 dark')
    await capture(page, 'grok-1280x800-dark', LAPTOP)

    // Watcher's own thread at work: the tip sits under Watcher's working line and is one of Watcher's.
    await seedWatcherRoom(page, { watched: ['footer-links', 'visual-gate', 'weekly-note'], idPrefix: 'tips' })
    await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
    const watcher = page.locator('#watcher-pane')
    await expect(watcher.locator('[data-message-id="tips-23"]')).toBeVisible()
    await size(launched, 1280, 800)
    await startTurn(page, 'release-notes', 'tips-watcher-turn', 'Which of my threads are still running?', 'read_thread footer-links')
    await expect(liveLine(watcher)).toBeVisible()
    await expect(tipIn(watcher)).toBeVisible()
    expect(WATCHER_TIPS, 'Watcher shows one of its own tips').toContain(await tipIn(watcher).getAttribute('data-tip'))
    expectUnderWords(await tipLayout(watcher), 'Watcher 1280x800 dark')
    await capture(page, 'watcher-1280x800-dark', LAPTOP)
    await appearance(page, 'light')
    expectUnderWords(await tipLayout(watcher), 'Watcher 1280x800 light')
    await capture(page, 'watcher-1280x800-light', LAPTOP)
  }))
})

test('stable shows no tip and no switch for them', async () => {
  await onReleaseTrack('stable', () => withSotto(LAUNCH, async (launched: LaunchedSotto) => {
    const { page } = launched
    await openThreads(page)
    await hostKeys.read(page)
    await size(launched, 1280, 800)
    await selectThread(page, 'Footer links')
    const codex = paneOf(page, 'footer-links')
    await expect(liveLine(codex)).toBeVisible()
    await page.waitForTimeout(600)
    await expect(page.locator('.thread-tip')).toHaveCount(0)
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    await expect(page.locator('#settings-agents').getByRole('switch', { name: 'Generated thread titles', exact: true })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Show tips while threads work', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Show hidden tips again', exact: true })).toHaveCount(0)
  }))
})
