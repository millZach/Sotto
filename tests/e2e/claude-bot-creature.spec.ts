import { startMonitoredThread, monitorGeometry } from './support/monitoredThread'
import { resizeContentWindow } from './support/sottoWindow'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentMessage } from '../../src/shared/agents'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'
import { hostKeysPerTest } from './support/hostKeys'
import { evidenceDirectory } from '../fixtures/evidence'
import { expectPaintedInside, paintedBounds } from './support/paintedBounds'
import { expectReadoutUnfilled, paintedUnderReadout, readoutContrast, type ReadoutContrast } from './support/readout'

/** Claude bot, the second creature: chosen in Settings → Appearance, worn in every pose above the composer. */
type HostEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]
const evidence = evidenceDirectory('artifacts/claude-bot-creature')
const monitorTask = { id: '56d13d2c-f6d0-4968-a9ed-18c87a7d5b5a', label: 'Watching the build checks' }
const agents = ['Review the diff for standards', 'Audit the renderer for performance', 'Check every claim against its callers']
  .map((label, index) => ({ id: `6f0c1a2e-8f4b-4d3c-9a1e-${String(index).padStart(12, '0')}`, label, type: 'subagent' as const }))
const hostKeys = hostKeysPerTest()
const key = hostKeys.key
test.beforeEach(() => { hostKeys.reset() })
const pane = (page: Page): Locator => page.locator(`section.thread-pane[data-thread-id="${key('workshop')}"]`)
const indicator = (page: Page): Locator => pane(page).locator('.thread-monitor')
const readout = (page: Page): Locator => indicator(page).locator('.thread-monitor__task')

async function event(page: Page, value: HostEvent): Promise<void> {
  await page.evaluate(async value => { await window.sottoE2E!.agentEvent!(value) }, value)
}

async function monitoring(page: Page, tasks = [monitorTask]): Promise<void> {
  await event(page, { type: 'monitoring', threadId: 'workshop', text: '', monitoring: tasks, status: 'idle' })
}

async function working(page: Page): Promise<void> {
  await event(page, { type: 'background-work', threadId: 'workshop', text: '', backgroundWork: [...agents], status: 'idle' })
}

/** A live turn held on one command that started `agoMs` ago; each call is a new record (see thread-held.spec.ts). */
let actions = 0
async function acting(page: Page, agoMs: number): Promise<void> {
  const startedAt = new Date(Date.now() - agoMs).toISOString()
  const activities: AgentActivity[] = [
    { id: 'wait-turn', turnId: 'wait-turn', sequence: 0, kind: 'turn', status: 'running', title: 'Turn' },
    { id: `wait-action-${++actions}`, turnId: 'wait-turn', sequence: actions, kind: 'command', status: 'running', title: 'Bash', command: 'npm test -- --maxWorkers=2', startedAt },
  ]
  await event(page, { type: 'stream', threadId: 'workshop', messageId: 'wait-said', text: 'Running the suite.', status: 'running', activities })
}

async function idle(page: Page): Promise<void> {
  await event(page, { type: 'ready', threadId: 'workshop', text: 'Finished.', status: 'idle', activities: [] })
}

async function chooseCreature(page: Page, creature: 'sotto' | 'claude'): Promise<void> {
  await page.evaluate(async creature => { await window.sotto!.updateSettings({ creature }) }, creature)
}

async function chooseAppearance(page: Page, appearance: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
}

async function savedCreature(page: Page): Promise<string> {
  return page.evaluate(async () => (await window.sotto!.getSettings()).creature)
}

async function start(launched: LaunchedSotto): Promise<void> {
  await startMonitoredThread(launched, hostKeys.read, pane)
}

async function contentSize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await resizeContentWindow(launched, width, height, [700, 500])
}

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await page.mouse.move(0, 0)
  await page.screenshot({ path: resolve(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** The bot is drawn, Sotto's creature is not. */
async function expectClaude(page: Page): Promise<void> {
  await expect(indicator(page)).toHaveAttribute('data-creature', 'claude')
  await expect(indicator(page).locator('.bot-b').first()).toBeAttached()
  await expect(indicator(page).locator('.thread-monitor__ink')).toHaveCount(0)
}

async function expectWhole(page: Page): Promise<void> {
  const facts = await monitorGeometry(pane(page), true)
  expect(facts.creature.left).toBeGreaterThanOrEqual(facts.track.left - 1)
  expect(facts.creature.right).toBeLessThanOrEqual(facts.task.left + 2)
  expect(Math.abs(facts.creature.bottom - facts.composer.top)).toBeLessThanOrEqual(1)
  expect(facts.extraControls).toBe(0)
  expect(facts.overflow).toBeLessThanOrEqual(1)
  for (const bounds of [facts.monitor, facts.composer, facts.creature, facts.task]) {
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(facts.width)
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.bottom).toBeLessThanOrEqual(facts.height)
  }
}

/** Sample rendered frames: the creature moves on a throttled RAF loop, not a CSS animation. */
async function motionPositions(page: Page): Promise<number> {
  return indicator(page).locator('.thread-monitor__actor').evaluate(async element => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const positions = new Set<string>()
    const began = performance.now()
    await new Promise<void>(resolve => {
      const sample = (): void => {
        positions.add(getComputedStyle(element).transform)
        if (performance.now() - began < 1_000) requestAnimationFrame(sample)
        else resolve()
      }
      sample()
    })
    return positions.size
  })
}

test('Settings → Appearance switches the creature, saves it and keeps it across a reload', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => { await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' }) })
    await page.reload()
    // Reduced motion holds the walking previews still for the captures.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const openAppearance = async (): Promise<Locator> => {
      await page.getByRole('link', { name: 'Settings' }).click()
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
      const group = page.getByRole('group', { name: 'Creature', exact: true })
      await expect(group).toBeVisible()
      await group.evaluate(element => element.closest('.creature-choice')!.scrollIntoView({ block: 'center' }))
      return group
    }
    let group = await openAppearance()
    const buttons = group.getByRole('button')
    await expect(buttons).toHaveCount(2)
    const sotto = buttons.nth(0)
    const claude = buttons.nth(1)
    await expect(sotto).toHaveAccessibleName('Use Sotto as the creature, currently active')
    await expect(sotto).toHaveAttribute('aria-pressed', 'true')
    await expect(claude).toHaveAccessibleName('Use Claude bot as the creature')
    await expect(claude).toHaveAttribute('aria-pressed', 'false')

    await group.getByRole('button', { name: 'Use Claude bot as the creature', exact: true }).click()
    await expect(claude).toHaveAttribute('aria-pressed', 'true')
    await expect(claude).toHaveAccessibleName('Use Claude bot as the creature, currently active')
    await expect(sotto).toHaveAttribute('aria-pressed', 'false')
    await expect(sotto).toHaveAccessibleName('Use Sotto as the creature')
    await expect.poll(() => savedCreature(page)).toBe('claude')
    await capture(page, 'appearance-creature-dark-claude-1280x800')

    await page.reload()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    group = await openAppearance()
    await expect(group.getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true')
    expect(await savedCreature(page)).toBe('claude')

    await chooseAppearance(page, 'light')
    // Keyboard: focus and Enter chooses, focus and Space chooses.
    await group.getByRole('button').nth(0).focus()
    await page.keyboard.press('Enter')
    await expect(group.getByRole('button').nth(0)).toHaveAttribute('aria-pressed', 'true')
    await expect(group.getByRole('button').nth(0)).toBeFocused()
    await expect.poll(() => savedCreature(page)).toBe('sotto')
    await capture(page, 'appearance-creature-light-sotto-1280x800')
    await group.getByRole('button').nth(1).focus()
    await page.keyboard.press('Space')
    await expect(group.getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true')
    await expect(group.getByRole('button').nth(0)).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => savedCreature(page)).toBe('claude')
  } finally { await closeSotto(launched) }
})

test('the creature above the composer follows the setting in every pose', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await start(launched)
    await chooseCreature(page, 'claude')
    const poses: [string, () => Promise<void>][] = [
      ['monitoring', () => monitoring(page)],
      ['working', () => working(page)],
      ['held', () => acting(page, 45_000)],
    ]
    for (const [pose, raise] of poses) {
      await chooseCreature(page, 'claude')
      await raise()
      await expect(indicator(page)).toHaveAttribute('data-ornament', pose)
      await expectClaude(page)
      if (pose === 'working') await expect(indicator(page).locator('.thread-monitor__mini')).toHaveCount(3)
      // Flipping back redraws the same pose as Sotto's creature, in place.
      await chooseCreature(page, 'sotto')
      await expect(indicator(page)).toHaveAttribute('data-creature', 'sotto')
      await expect(indicator(page)).toHaveAttribute('data-ornament', pose)
      await expect(indicator(page)).toHaveCount(1)
      await expect(indicator(page).locator('.bot-b')).toHaveCount(0)
      await expect(indicator(page).locator('.thread-monitor__ink').first()).toBeAttached()
      // Clear the pose so the next one raises from nothing.
      if (pose === 'monitoring') await monitoring(page, [])
      if (pose === 'working') await event(page, { type: 'background-work', threadId: 'workshop', text: '', backgroundWork: [], status: 'idle' })
      if (pose === 'held') await idle(page)
      await expect(indicator(page)).toHaveCount(0)
    }
  } finally { await closeSotto(launched) }
})

const at = (minute: number): string => new Date(Date.now() - (60 - minute) * 60_000).toISOString()
const paragraph = 'The length marker in the header was written once, before any audio arrived, so players stopped after the first chunk; it is now patched after every chunk and the new tests cover a stall, a resume and an empty file. '
const transcript: AgentMessage[] = Array.from({ length: 8 }, (_, index) => ({
  id: `readout-${index}`, role: index % 2 === 0 ? 'user' : 'assistant', text: paragraph.repeat(index % 2 === 0 ? 1 : 4).trim(), createdAt: at(index + 1),
}))

test('the readout is words on the room', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await start(launched)
    await chooseCreature(page, 'claude')
    await event(page, { type: 'history', threadId: 'workshop', text: '', status: 'idle', messages: transcript })
    await expect(pane(page).locator('.thread-workspace__transcript')).toContainText(paragraph.slice(0, 60))
    const ratios: Record<string, ReadoutContrast> = {}
    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await contentSize(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await chooseAppearance(page, appearance)
        await monitoring(page)
        await expect(indicator(page)).toBeVisible()
        await expectReadoutUnfilled(readout(page))
        const [box, scroller] = await Promise.all([readout(page).boundingBox(), pane(page).locator('.thread-workspace__transcript').boundingBox()])
        // Words with no fill must not sit over the transcript's text either.
        const overlaps = box!.x < scroller!.x + scroller!.width && scroller!.x < box!.x + box!.width
          && box!.y < scroller!.y + scroller!.height && scroller!.y < box!.y + box!.height
        expect(overlaps, JSON.stringify({ box, scroller })).toBe(false)
        const ratio = await readoutContrast(readout(page))
        ratios[`${appearance}-${width}x${height}`] = ratio
        expect(ratio.label).toBeGreaterThanOrEqual(4.5)
        expect(ratio.status).toBeGreaterThanOrEqual(4.5)
        // The surface measured is the one painted under the words, not the composer's fill.
        const painted = await paintedUnderReadout(page, readout(page))
        for (const [index, channel] of painted.entries()) expect(Math.abs(channel - ratio.surface[index]!), JSON.stringify({ painted, surface: ratio.surface })).toBeLessThanOrEqual(3)
        if (appearance === 'dark' && width === 820) await capture(page, 'readout-dark-820x560')
      }
    }
    await writeFile(resolve(evidence, 'readout-contrast.json'), `${JSON.stringify(ratios, null, 2)}\n`, 'utf8')
  } finally { await closeSotto(launched) }
})

/**
 * What the bot paints stays in its box in every pose: a full 14 s monitoring cycle (out facing right, the inspection at the
 * far end, back mirrored, the rest), working, the whole 6 s sand period with its flip, and each reduced-motion stance.
 * Sampled in real time over whole cycles rather than with a faked clock, so the app's own timers are left alone.
 */
async function expectPaintedEveryPose(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await monitoring(page, [])
  await expect(indicator(page)).toHaveCount(0)
  await monitoring(page)
  await expectClaude(page)
  const cycle = await expectPaintedInside(indicator(page), 14_500)
  expect(cycle.mirrored).toBeGreaterThan(0)
  expect(cycle.frames - cycle.mirrored).toBeGreaterThan(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => motionPositions(page)).toBe(1)
  await expectPaintedInside(indicator(page))
  await monitoring(page, [])
  await expect(indicator(page)).toHaveCount(0)

  for (const [pose, raise, ms, clear] of [
    ['working', () => working(page), 2_000, () => event(page, { type: 'background-work', threadId: 'workshop', text: '', backgroundWork: [], status: 'idle' })],
    ['held', () => acting(page, 45_000), 6_500, () => idle(page)],
  ] as const) {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await raise()
    await expect(indicator(page)).toHaveAttribute('data-ornament', pose)
    await expectClaude(page)
    await expectPaintedInside(indicator(page), ms)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => motionPositions(page)).toBe(1)
    await expectPaintedInside(indicator(page))
    await clear()
    await expect(indicator(page)).toHaveCount(0)
  }
  await monitoring(page)
  await expect(indicator(page)).toBeVisible()
}

test('Claude bot fits every supported size in both themes and honours both reduced-motion settings', async () => {
  test.setTimeout(420_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await start(launched)
    await chooseCreature(page, 'claude')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await monitoring(page)
    await expectClaude(page)
    expect(await motionPositions(page)).toBeGreaterThan(1)
    for (const appearance of ['dark', 'light'] as const) {
      await chooseAppearance(page, appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await contentSize(launched, width, height)
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await monitoring(page, [])
        await expect(indicator(page)).toHaveCount(0)
        await monitoring(page)
        await expectClaude(page)
        await expectWhole(page) // Newly mounted, at the beginning of the walk.
        if (`${appearance}-${width}` === 'dark-1280' || `${appearance}-${width}` === 'light-820') await capture(page, `claude-monitoring-${appearance}-${width}x${height}`)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        // clientWidth and the two-pixel walking grid each round at fractional Windows scaling.
        await expect.poll(() => indicator(page).locator('.thread-monitor__actor').evaluate(element => {
          const actor = element.getBoundingClientRect()
          const track = element.parentElement!.getBoundingClientRect()
          return Math.abs(actor.right - track.right)
        })).toBeLessThanOrEqual(2)
        await expectWhole(page) // Inspection pose at the far end of the track.
        if (width !== 1600) await expectPaintedEveryPose(page)
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await motionPositions(page)).toBe(1)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    expect(await motionPositions(page)).toBe(1)
    // The painted-bounds check bites: a bot pushed inside its box, with the loop frozen, is caught.
    const pushed = await paintedBounds(indicator(page), 0, 'translate(12 0)')
    expect(pushed.right, JSON.stringify(pushed)).toBeGreaterThan(81)
    expect(pushed.outermost.length).toBeGreaterThan(0)
    await expectPaintedInside(indicator(page))
    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'system' }) })

    await chooseAppearance(page, 'dark')
    await contentSize(launched, 1280, 800)
    await monitoring(page, [])
    await working(page)
    await expect(indicator(page)).toHaveAttribute('data-ornament', 'working')
    await expectClaude(page)
    await expect(indicator(page).locator('.thread-monitor__mini')).toHaveCount(3)
    await expectWhole(page)
    await capture(page, 'claude-working-dark-1280x800')
    await event(page, { type: 'background-work', threadId: 'workshop', text: '', backgroundWork: [], status: 'idle' })
    await expect(indicator(page)).toHaveCount(0)
    await acting(page, 45_000)
    await expect(indicator(page)).toHaveAttribute('data-ornament', 'held')
    await expectClaude(page)
    await expectWhole(page)
    await capture(page, 'claude-held-dark-1280x800')
  } finally { await closeSotto(launched) }
})
