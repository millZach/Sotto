import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'
import { hostKeysPerTest } from './support/hostKeys'
import { monitorGeometry, startMonitoredThread } from './support/monitoredThread'
import { resizeContentWindow } from './support/sottoWindow'
import { evidenceDirectory } from '../fixtures/evidence'

/**
 * Lardo, the third creature (ADR-0116; the Owl feature `lardo-creature`): chosen like the others, a classic pose in each
 * of the creature's poses, a flex when a turn finishes while he is up, and a bite out of the composer thrown at the screen
 * when he is clicked, which never touches what the composer holds.
 */
type HostEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]
const evidence = evidenceDirectory('artifacts/lardo-creature')
const hostKeys = hostKeysPerTest()
const key = hostKeys.key
test.beforeEach(() => { hostKeys.reset() })
const pane = (page: Page): Locator => page.locator(`section.thread-pane[data-thread-id="${key('workshop')}"]`)
const indicator = (page: Page): Locator => pane(page).locator('.thread-monitor')
const actor = (page: Page): Locator => indicator(page).locator('.thread-monitor__actor')
const editor = (page: Page): Locator => pane(page).locator('.thread-workspace__compose .prompt-editor[contenteditable="true"]')
const agents = ['Review the diff for standards', 'Audit the renderer for performance', 'Check every claim against its callers']
  .map((label, index) => ({ id: `6f0c1a2e-8f4b-4d3c-9a1e-${String(index).padStart(12, '0')}`, label, type: 'subagent' as const }))

async function event(page: Page, value: HostEvent): Promise<void> {
  await page.evaluate(async value => { await window.sottoE2E!.agentEvent!(value) }, value)
}
const monitoring = (page: Page) => event(page, { type: 'monitoring', threadId: 'workshop', text: '', status: 'idle',
  monitoring: [{ id: '56d13d2c-f6d0-4968-a9ed-18c87a7d5b5a', label: 'Watching the build checks' }] })
const working = (page: Page) => event(page, { type: 'background-work', threadId: 'workshop', text: '', backgroundWork: [...agents], status: 'idle' })
let actions = 0
async function acting(page: Page, agoMs: number): Promise<void> {
  const activities: AgentActivity[] = [
    { id: 'wait-turn', turnId: 'wait-turn', sequence: 0, kind: 'turn', status: 'running', title: 'Turn' },
    { id: `wait-action-${++actions}`, turnId: 'wait-turn', sequence: actions, kind: 'command', status: 'running', title: 'Bash',
      command: 'npm test -- --maxWorkers=2', startedAt: new Date(Date.now() - agoMs).toISOString() },
  ]
  await event(page, { type: 'stream', threadId: 'workshop', messageId: 'wait-said', text: 'Running the suite.', status: 'running', activities })
}

/** Sotto with Lardo's Owl feature on, as an Owl build has it; `held` launches it as stable does. */
async function launch(held = false): Promise<LaunchedSotto> {
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = `lardo-creature=${held ? 0 : 1}`
  return launchSotto().finally(() => { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous })
}
async function start(launched: LaunchedSotto): Promise<void> {
  await startMonitoredThread(launched, hostKeys.read, pane)
  await launched.page.evaluate(async () => { await window.sotto!.updateSettings({ creature: 'lardo' }) })
}
async function chooseAppearance(page: Page, appearance: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
}
/** A frame as it is, mid-throw included: the throw is Web Animations, which a disabled-animations capture would finish. */
async function capture(page: Page, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await page.screenshot({ path: resolve(evidence, `${name}.png`), animations: 'allow', caret: 'hide' })
}
/** What the composer holds and where its caret is: the throw must leave every part of it as it was. */
const composerState = (page: Page) => editor(page).evaluate(element => {
  const selection = getSelection()
  return { text: element.textContent, focused: document.activeElement === element, caret: selection?.anchorOffset ?? -1,
    caretInside: selection?.anchorNode ? element.contains(selection.anchorNode) : false }
})

test('Lardo wears every pose above the composer, whole at the minimum window, in both themes', async () => {
  test.setTimeout(150_000)
  const launched = await launch()
  const { page } = launched
  try {
    await start(launched)
    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await resizeContentWindow(launched, width, height, [700, 500])
      for (const appearance of ['dark', 'light'] as const) {
        await chooseAppearance(page, appearance)
        for (const [pose, raise] of [['monitoring', () => monitoring(page)], ['working', () => working(page)], ['held', () => acting(page, 45_000)]] as const) {
          await raise()
          await expect(indicator(page)).toHaveAttribute('data-ornament', pose)
          await expect(indicator(page)).toHaveAttribute('data-creature', 'lardo')
          await expect(actor(page).locator('.lardo-t')).toHaveAttribute('d', /^M\d/u)
          if (pose === 'working') await expect(indicator(page).locator('.thread-monitor__mini')).toHaveCount(3)
          const facts = await monitorGeometry(pane(page), true)
          // He adds no control to the tab order, and stands on the composer's top edge inside the window.
          expect(facts.extraControls).toBe(0)
          expect(facts.overflow).toBeLessThanOrEqual(1)
          expect(Math.abs(facts.creature.bottom - facts.composer.top)).toBeLessThanOrEqual(1)
          expect(facts.creature.left).toBeGreaterThanOrEqual(0)
          expect(facts.task.right).toBeLessThanOrEqual(facts.width)
          if (width === 1280 || pose === 'monitoring') await capture(page, `lardo-${pose}-${appearance}-${width}x${height}`)
          if (pose === 'monitoring') await event(page, { type: 'monitoring', threadId: 'workshop', text: '', monitoring: [], status: 'idle' })
          if (pose === 'working') await event(page, { type: 'background-work', threadId: 'workshop', text: '', backgroundWork: [], status: 'idle' })
          if (pose === 'held') await event(page, { type: 'ready', threadId: 'workshop', text: 'Finished.', status: 'idle', activities: [] })
          await expect(indicator(page)).toHaveCount(0)
        }
      }
    }
  } finally { await closeSotto(launched) }
})

test('clicked, Lardo throws a bite of the composer at the screen and leaves what it holds alone', async () => {
  test.setTimeout(120_000)
  const launched = await launch()
  const { page } = launched
  try {
    await start(launched)
    await resizeContentWindow(launched, 1280, 800, [700, 500])
    await chooseAppearance(page, 'dark')
    await acting(page, 45_000)
    await expect(indicator(page)).toHaveAttribute('data-creature', 'lardo')
    await editor(page).click()
    await page.keyboard.type('Make the changelog say what each fix means')
    await page.keyboard.press('ArrowLeft')
    const before = await composerState(page)
    expect(before.focused).toBe(true)
    // His chest, a painted pixel of the vacuum: the room round him still lets clicks through.
    const box = (await actor(page).boundingBox())!
    await page.mouse.click(box.x + 40, box.y + 34)
    await expect(actor(page)).toHaveAttribute('data-cue', 'angry')
    await expect(page.locator('.lardo-throw')).toBeAttached()
    await page.waitForTimeout(500)
    await capture(page, 'lardo-throw-lift-dark-1280x800')
    // Typing carries on while he throws.
    await page.keyboard.type(' to')
    await page.waitForTimeout(350)
    await capture(page, 'lardo-throw-flight-dark-1280x800')
    await page.waitForTimeout(350)
    await capture(page, 'lardo-throw-shatter-dark-1280x800')
    await expect(page.locator('.lardo-throw')).toHaveCount(0, { timeout: 5_000 })
    await expect(actor(page)).not.toHaveAttribute('data-cue')
    const after = await composerState(page)
    expect(after).toEqual({ ...before, text: `${before.text!.slice(0, -1)} to${before.text!.slice(-1)}`, caret: before.caret + 3 })
    // The composer keeps no border or outline once it has grown back.
    const edge = await pane(page).locator('.thread-prompt').evaluate(element => {
      const style = getComputedStyle(element)
      return { border: style.borderTopColor, outline: style.outlineStyle }
    })
    expect(edge.outline).toBe('none')
    expect(edge.border).toMatch(/rgba\(0, 0, 0, 0\)|transparent/u)
  } finally { await closeSotto(launched) }
})

test('under reduced motion a click only makes him angry, and a finished turn flexes him', async () => {
  test.setTimeout(120_000)
  const launched = await launch()
  const { page } = launched
  try {
    await start(launched)
    await resizeContentWindow(launched, 1280, 800, [700, 500])
    await chooseAppearance(page, 'light')
    await working(page)
    await expect(indicator(page)).toHaveAttribute('data-creature', 'lardo')
    // A turn starts and finishes while he is up.
    await event(page, { type: 'stream', threadId: 'workshop', messageId: 'flex-said', text: 'Checking.', status: 'running', activities: [] })
    await event(page, { type: 'ready', threadId: 'workshop', text: 'Checked.', status: 'idle', activities: [] })
    await expect(actor(page)).toHaveAttribute('data-cue', 'flex')
    await page.waitForTimeout(500)
    await capture(page, 'lardo-flex-light-1280x800')
    await expect(actor(page)).not.toHaveAttribute('data-cue', { timeout: 5_000 })

    await page.emulateMedia({ reducedMotion: 'reduce' })
    const box = (await actor(page).boundingBox())!
    await page.mouse.click(box.x + 40, box.y + 34)
    await expect(actor(page)).toHaveAttribute('data-cue', 'angry')
    await expect(page.locator('.lardo-throw')).toHaveCount(0)
    await capture(page, 'lardo-angry-reduced-light-1280x800')
    await expect(actor(page)).not.toHaveAttribute('data-cue', { timeout: 5_000 })
  } finally { await closeSotto(launched) }
})

test('where Lardo is held, a saved Lardo shows as Sotto’s creature and stays saved', async () => {
  test.setTimeout(120_000)
  const launched = await launch(true)
  const { page } = launched
  try {
    await start(launched)
    await monitoring(page)
    await expect(indicator(page)).toHaveAttribute('data-creature', 'sotto')
    expect(await page.evaluate(async () => (await window.sotto!.getSettings()).creature)).toBe('lardo')
  } finally { await closeSotto(launched) }
})
