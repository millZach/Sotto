import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto, launchSottoWithVoice, openThreads, paneMenuAction, userMessageTexts, type LaunchedSotto } from './support/sottoLaunch'

type HostEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]
const evidence = resolve('artifacts/process-creature')
const longTask = { id: '295a79c7-ae96-4126-b926-f724eb24483b', label: 'Watching the pull request checks while the build and integration suites finish. '.repeat(4).slice(0, 240).trimEnd() }
const secondTask = { id: '9460a2b0-2368-4cc0-8fe8-91a0144d6b87', label: 'Watching the deployment result' }
const monitorTask = { id: '56d13d2c-f6d0-4968-a9ed-18c87a7d5b5a', label: 'Watching the build checks' }
const pane = (page: Page): Locator => page.locator('section.thread-pane[data-thread-id="workshop"]')
const indicator = (page: Page): Locator => pane(page).locator('.thread-monitor')

async function event(page: Page, value: HostEvent): Promise<void> {
  await page.evaluate(async value => { await window.sottoE2E!.agentEvent!(value) }, value)
}

async function monitoring(page: Page, tasks = [monitorTask]): Promise<void> {
  await event(page, { type: 'monitoring', threadId: 'workshop', text: '', monitoring: tasks, status: 'idle' })
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

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await page.screenshot({ path: resolve(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

async function expectWhole(page: Page): Promise<void> {
  const facts = await pane(page).evaluate(element => {
    const monitor = element.querySelector('.thread-monitor')!
    const composer = element.querySelector('.thread-prompt, .agent-composer')!
    const rect = (target: Element) => {
      const value = target.getBoundingClientRect()
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom }
    }
    return {
      width: innerWidth, height: innerHeight, monitor: rect(monitor), composer: rect(composer), creature: rect(monitor.querySelector('.thread-monitor__creature')!),
      overflow: element.scrollWidth - element.clientWidth,
      track: rect(monitor.querySelector('.thread-monitor__track')!), task: rect(monitor.querySelector('.thread-monitor__task')!),
      extraControls: monitor.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]').length,
    }
  })
  expect(facts.creature.left).toBeGreaterThanOrEqual(facts.track.left - 1)
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

async function contrastRatios(page: Page): Promise<{ label: number; status: number }> {
  return indicator(page).locator('.thread-monitor__task').evaluate(element => {
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
    const contrast = (selector: string): number => {
      const text = luminance(getComputedStyle(element.querySelector(selector)!).color)
      return (Math.max(surface, text) + 0.05) / (Math.min(surface, text) + 0.05)
    }
    return { label: contrast('.thread-monitor__label'), status: contrast('.thread-monitor__status') }
  })
}

/** Sample rendered frames: the pixel creature moves on a throttled RAF loop, not a CSS animation. */
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

test('confirmed monitoring appears without a buffer and never follows ordinary commands or unattended process text', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await start(launched)
    const prompt = pane(page).locator('form.thread-prompt textarea')
    await event(page, { type: 'ready', threadId: 'workshop', text: 'Running a command.', status: 'running' })
    await expect(indicator(page)).toHaveCount(0)
    await event(page, { type: 'ready', threadId: 'workshop', text: 'The development server is running in the background.', status: 'idle' })
    await expect(indicator(page)).toHaveCount(0)
    await monitoring(page, [])
    await expect(indicator(page)).toHaveCount(0)
    await prompt.fill('Keep this draft while watching.')
    await monitoring(page)
    // Shorter than the rejected ten-second buffer; this is a UI response deadline, not a timed sleep.
    await expect(indicator(page)).toBeVisible({ timeout: 3_000 })
    await expect(indicator(page)).toHaveAttribute('role', 'status')
    await expect(indicator(page).locator('.thread-monitor__task')).toContainText(monitorTask.label)
    await expect(prompt).toHaveValue('Keep this draft while watching.')
    await expect(prompt).toBeFocused()
    const creature = await indicator(page).locator('.thread-monitor__creature').elementHandle()
    await monitoring(page, [{ ...monitorTask, label: 'Watching the next build check' }])
    expect(await creature!.evaluate(element => element === document.querySelector('.thread-monitor__creature'))).toBe(true)
    await expect(indicator(page)).toContainText('Watching the next build check')
    await prompt.press('Enter')
    await expect.poll(() => userMessageTexts(page, 'workshop')).toContain('Keep this draft while watching.')
    await monitoring(page, [])
    await expect(indicator(page)).toHaveCount(0)

    for (const kind of ['question', 'permission'] as const) {
      await monitoring(page)
      await expect(indicator(page)).toBeVisible()
      await event(page, { type: kind, threadId: 'workshop', requestId: `monitor-${kind}`, text: `Please answer this ${kind}.` })
      await expect(indicator(page)).toHaveCount(0)
      await expect(pane(page)).toContainText(`Please answer this ${kind}.`)
      // Fixture reset only; observing never supplies an answer or approves a permission.
      await event(page, { type: 'history', threadId: 'workshop', text: '', messages: [] })
    }
    await monitoring(page)
    await expect(indicator(page)).toBeVisible()
    await event(page, { type: 'disconnect', threadId: 'workshop', text: '' })
    await expect(indicator(page)).toHaveCount(0)
  } finally { await closeSotto(launched) }
})

test('process perch fits every supported size in light and dark and honors both reduced-motion settings', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await start(launched)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await monitoring(page)
    await expect(indicator(page)).toBeVisible()
    expect(await motionPositions(page)).toBeGreaterThan(1)
    const contrasts: Record<string, { label: number; status: number }> = {}
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      contrasts[appearance] = await contrastRatios(page)
      expect(contrasts[appearance]!.label).toBeGreaterThanOrEqual(4.5)
      expect(contrasts[appearance]!.status).toBeGreaterThanOrEqual(4.5)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await contentSize(launched, width, height)
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await monitoring(page, [])
        await expect(indicator(page)).toHaveCount(0)
        await monitoring(page)
        await expect(indicator(page)).toBeVisible()
        await expectWhole(page) // Newly mounted, at the beginning of the walk.
        await capture(page, `${appearance}-${width}x${height}`)
        await monitoring(page, [longTask, secondTask])
        const task = indicator(page).locator('.thread-monitor__task')
        await expect(task).toHaveAttribute('title', `${longTask.label}\n${secondTask.label}`)
        await expect(indicator(page).locator('.thread-monitor__label')).toHaveText(longTask.label)
        await expect(indicator(page).locator('.thread-monitor__status')).toHaveText('Monitoring 2 tasks')
        await page.emulateMedia({ reducedMotion: 'reduce' })
        // clientWidth and the two-pixel walking grid each round at fractional Windows scaling.
        await expect.poll(() => indicator(page).locator('.thread-monitor__actor').evaluate(element => {
          const actor = element.getBoundingClientRect()
          const track = element.parentElement!.getBoundingClientRect()
          return Math.abs(actor.right - track.right)
        })).toBeLessThanOrEqual(2)
        await expectWhole(page) // Inspection pose at the far end of the track.
        await capture(page, `${appearance}-${width}x${height}-long-multiple`)
        await monitoring(page)

      }
    }
    await writeFile(resolve(evidence, 'contrast.json'), `${JSON.stringify(contrasts, null, 2)}\n`, 'utf8')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await motionPositions(page)).toBe(1)
    await expect(indicator(page).locator('.thread-monitor__creature')).toBeVisible()
    await capture(page, 'system-reduced-motion')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    expect(await motionPositions(page)).toBe(1)
    await capture(page, 'app-reduced-motion')
  } finally { await closeSotto(launched) }
})

test('managed composer keeps its draft and send action usable under the process perch', async () => {
  test.setTimeout(120_000)
  const launched = await launchSottoWithVoice()
  const { page } = launched
  try {
    await start(launched)
    await contentSize(launched, 820, 560)
    await paneMenuAction(pane(page), 'Manage')
    const prompt = pane(page).locator('#agent-prompt')
    await prompt.fill('Continue after the build checks.')
    await monitoring(page)
    await expect(indicator(page)).toBeVisible()
    await expect(prompt).toHaveValue('Continue after the build checks.')
    await expectWhole(page)
    await capture(page, 'managed-minimum')
    await pane(page).getByRole('button', { name: 'Send it', exact: true }).click()
    await expect.poll(() => userMessageTexts(page, 'workshop')).toContain('Continue after the build checks.')
    await monitoring(page, [])
    await expect(indicator(page)).toHaveCount(0)
  } finally { await closeSotto(launched) }
})
