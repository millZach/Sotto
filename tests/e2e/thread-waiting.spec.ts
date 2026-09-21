import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

type HostEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]
const evidence = resolve('artifacts/waiting-creature')
/** Mirrors WAITING_AFTER_MS. A copy, so a change to the rule has to be made deliberately here too. */
const WAITING_AFTER_MS = 20_000
const command = 'npm test -- --maxWorkers=2'
const watch = { id: '56d13d2c-f6d0-4968-a9ed-18c87a7d5b5a', label: 'Watching the build checks' }
const pane = (page: Page): Locator => page.locator('section.thread-pane[data-thread-id="workshop"]')
const ornament = (page: Page): Locator => pane(page).locator('.thread-monitor')
const waiting = (page: Page): Locator => pane(page).locator('.thread-monitor[data-waiting]')

async function event(page: Page, value: HostEvent): Promise<void> {
  await page.evaluate(async value => { await window.sottoE2E!.agentEvent!(value) }, value)
}

/**
 * A live turn held on one running action that started `agoMs` ago. Synthetic activity only: this is the
 * same `activities` every adapter writes, which is why the ornament needs no monitor lifecycle event.
 *
 * Each call is a new record, because `mergeAgentActivities` keeps the first `startedAt` it saw for an ID.
 * Reusing one would measure every wait in this file from the first injection.
 */
let actions = 0
async function acting(page: Page, agoMs: number, patch: Partial<AgentActivity> = {}): Promise<void> {
  const startedAt = new Date(Date.now() - agoMs).toISOString()
  const activities: AgentActivity[] = [
    { id: 'wait-turn', turnId: 'wait-turn', sequence: 0, kind: 'turn', status: 'running', title: 'Turn' },
    { id: `wait-action-${++actions}`, turnId: 'wait-turn', sequence: actions, kind: 'command', status: 'running', title: 'Bash', command, startedAt, ...patch },
  ]
  await event(page, { type: 'stream', threadId: 'workshop', messageId: 'wait-said', text: 'Running the suite.', status: 'running', activities })
}

async function idle(page: Page): Promise<void> {
  await event(page, { type: 'ready', threadId: 'workshop', text: 'Finished.', status: 'idle', activities: [] })
}

async function start(launched: LaunchedSotto): Promise<void> {
  await launched.page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await launched.page.reload()
  await openThreads(launched.page)
  await launched.page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Workshop', exact: true }).click()
  await expect(pane(launched.page)).toBeVisible()
}

async function contentSize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const main = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'))!
    main.setMinimumSize(700, 500)
    main.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}

/** Sand falling is the pose's only motion, so the sand is what says whether it is animating. */
async function sandFrames(page: Page): Promise<number> {
  return waiting(page).locator('.thread-monitor__creature').evaluate(async element => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const shapes = new Set<string>()
    const began = performance.now()
    await new Promise<void>(resolve => {
      const sample = (): void => {
        shapes.add([...element.querySelectorAll('path')].map(path => path.getAttribute('d')).join('|'))
        if (performance.now() - began < 1_200) requestAnimationFrame(sample)
        else resolve()
      }
      sample()
    })
    return shapes.size
  })
}

async function expectWhole(page: Page): Promise<void> {
  const facts = await pane(page).evaluate(element => {
    const monitor = element.querySelector('.thread-monitor')!
    const composer = element.querySelector('.thread-prompt, .agent-composer')!
    const rect = (target: Element): { left: number; right: number; top: number; bottom: number } => {
      const value = target.getBoundingClientRect()
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom }
    }
    return {
      width: innerWidth, height: innerHeight, monitor: rect(monitor), composer: rect(composer),
      creature: rect(monitor.querySelector('.thread-monitor__creature')!),
      task: rect(monitor.querySelector('.thread-monitor__task')!),
      overflow: element.scrollWidth - element.clientWidth,
      extraControls: monitor.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]').length,
    }
  })
  expect(facts.creature.right).toBeLessThanOrEqual(facts.task.left + 2)
  expect(Math.abs(facts.creature.bottom - facts.composer.top)).toBeLessThanOrEqual(1)
  expect(facts.extraControls).toBe(0)
  expect(facts.overflow).toBeLessThanOrEqual(1)
  for (const bounds of [facts.monitor, facts.composer, facts.creature]) {
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(facts.width)
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.bottom).toBeLessThanOrEqual(facts.height)
  }
}

test('the hourglass waits out the threshold, names the command, and yields to a confirmed watch', async () => {
  test.setTimeout(180_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await start(launched)
    const prompt = pane(page).locator('form.thread-prompt textarea')

    // A command that has only just started says nothing; so does one that finished quickly.
    await acting(page, 0)
    await expect(waiting(page)).toHaveCount(0)
    await acting(page, 2_000, { kind: 'tool', title: 'Read', command: undefined })
    await expect(waiting(page)).toHaveCount(0)
    await idle(page)
    await expect(ornament(page)).toHaveCount(0)

    // Reasoning is the model working, not waiting, however long it runs.
    await acting(page, WAITING_AFTER_MS + 5_000, { kind: 'reasoning', title: 'Reasoning', command: undefined })
    await expect(waiting(page)).toHaveCount(0)

    // A draft survives the ornament arriving, exactly as it does for the walk.
    await prompt.fill('Keep this draft while waiting.')
    await acting(page, WAITING_AFTER_MS - 2_000)
    await expect(waiting(page)).toHaveCount(0)
    // The threshold passes on its own timer; the deadline is a UI response budget, not a timed sleep.
    await expect(waiting(page)).toBeVisible({ timeout: 15_000 })
    await expect(waiting(page)).toHaveAttribute('role', 'status')
    await expect(waiting(page).locator('.thread-monitor__label')).toHaveText(command)
    await expect(waiting(page).locator('.thread-monitor__status')).toContainText('Waiting')
    await expect(prompt).toHaveValue('Keep this draft while waiting.')

    // The clock counts up without replacing the creature, so the sand keeps running across the update.
    const creature = await waiting(page).locator('.thread-monitor__creature').elementHandle()
    await expect(waiting(page).locator('.thread-monitor__status')).toContainText(/Waiting · \S/u)
    expect(await creature!.evaluate(element => element === document.querySelector('.thread-monitor[data-waiting] .thread-monitor__creature'))).toBe(true)

    // A provider-confirmed watch is the stronger claim: it takes the one track the composer reserves.
    await event(page, { type: 'monitoring', threadId: 'workshop', text: '', monitoring: [watch], status: 'running' })
    await expect(waiting(page)).toHaveCount(0)
    await expect(ornament(page)).toBeVisible()
    await expect(ornament(page).locator('.thread-monitor__status')).toHaveText('Monitoring')
    await event(page, { type: 'monitoring', threadId: 'workshop', text: '', monitoring: [], status: 'running' })
    await expect(waiting(page)).toBeVisible()

    // Anything that needs the user, and anything that ends the turn, clears the track.
    for (const kind of ['question', 'permission'] as const) {
      await event(page, { type: kind, threadId: 'workshop', requestId: `waiting-${kind}`, text: `Please answer this ${kind}.` })
      await expect(ornament(page)).toHaveCount(0)
      // Fixture reset only; observing never supplies an answer or approves a permission.
      await event(page, { type: 'history', threadId: 'workshop', text: '', messages: [] })
      await acting(page, WAITING_AFTER_MS + 1_000)
      await expect(waiting(page)).toBeVisible()
    }
    await idle(page)
    await expect(ornament(page)).toHaveCount(0)
    await acting(page, WAITING_AFTER_MS + 1_000)
    await expect(waiting(page)).toBeVisible()
    await event(page, { type: 'disconnect', threadId: 'workshop', text: '' })
    await expect(ornament(page)).toHaveCount(0)
  } finally { await closeSotto(launched) }
})

test('the hourglass fits every supported size in light and dark and holds still for reduced motion', async () => {
  test.setTimeout(180_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await start(launched)
    await mkdir(evidence, { recursive: true })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await acting(page, WAITING_AFTER_MS + 1_000)
    await expect(waiting(page)).toBeVisible()
    expect(await sandFrames(page)).toBeGreaterThan(1)

    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      const contrast = await waiting(page).locator('.thread-monitor__task').evaluate(element => {
        const context = document.createElement('canvas').getContext('2d')!
        const background = getComputedStyle(element).backgroundColor
        const luminance = (color: string): number => {
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = background
          context.fillRect(0, 0, 1, 1)
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          const pixel = context.getImageData(0, 0, 1, 1).data
          if (pixel[3] !== 255) throw new Error('Contrast requires an opaque readout background.')
          const linear = [...pixel].slice(0, 3).map(value => {
            const channel = value / 255
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
          })
          return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
        }
        const surface = luminance(background)
        const ratio = (selector: string): number => {
          const text = luminance(getComputedStyle(element.querySelector(selector)!).color)
          return (Math.max(surface, text) + 0.05) / (Math.min(surface, text) + 0.05)
        }
        return { label: ratio('.thread-monitor__label'), status: ratio('.thread-monitor__status') }
      })
      expect(contrast.label).toBeGreaterThanOrEqual(4.5)
      expect(contrast.status).toBeGreaterThanOrEqual(4.5)

      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await contentSize(launched, width, height)
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await idle(page)
        await expect(ornament(page)).toHaveCount(0)
        await acting(page, WAITING_AFTER_MS + 1_000)
        await expect(waiting(page)).toBeVisible()
        await expectWhole(page)
        await page.screenshot({ path: resolve(evidence, `${appearance}-${width}x${height}.png`), animations: 'disabled', caret: 'hide' })

        // A long command still fits: the readout ellipsizes and nothing under it is covered.
        await acting(page, WAITING_AFTER_MS + 1_000, { command: `${command} --reporter=verbose --testNamePattern="${'very long pattern '.repeat(8)}"` })
        await expect(waiting(page)).toBeVisible()
        await expectWhole(page)
      }
    }

    // Both reduced-motion settings hold one pose; the sand stops where it is.
    await contentSize(launched, 1280, 800)
    await acting(page, WAITING_AFTER_MS + 1_000)
    await expect(waiting(page)).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await sandFrames(page)).toBe(1)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    expect(await sandFrames(page)).toBe(1)
    await page.screenshot({ path: resolve(evidence, 'reduced-motion.png'), animations: 'disabled', caret: 'hide' })
  } finally { await closeSotto(launched) }
})
