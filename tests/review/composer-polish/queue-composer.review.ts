import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads } from '../../e2e/support/sottoLaunch'
import { appTheme, evidence, focusedLabel, paneMetrics, shot, size, unreachable, windowShot, zoom, type PaneMetrics } from './support'

// Real production Electron with the E2E fixture provider (no native calls): the critic's queue journey, now asserting
// the fixed layout, copy and focus facts at 1280x800, 1600x900, the 820x560 minimum, stress sizes and zoom.

const PANE = 'section.thread-pane[data-focused]'
const QUEUED = [
  'Then run the full audio suite and paste any failures here.',
  'After that, check whether anything else relied on close-time patching of the WAV length marker, including the renderer preview path and the export dialog, and list each caller with a one-line verdict.',
  'Finally update the changelog.',
]
const PAUSE = 'The last turn did not confirm completion.'

async function start(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'teal' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
}

/** The composing user's first screen: the whole card on screen, a readable transcript, no nested scrolling. */
function expectComposable(metrics: PaneMetrics, minimumTranscript: number): void {
  expect(metrics.cardFullyVisible, JSON.stringify(metrics)).toBe(true)
  expect(metrics.outsideControls, JSON.stringify(metrics)).toEqual([])
  expect(metrics.transcriptClientHeight!, JSON.stringify(metrics)).toBeGreaterThanOrEqual(minimumTranscript)
  expect(metrics.scrollers.filter(item => !item.startsWith('thread-workspace__transcript')), JSON.stringify(metrics)).toEqual([])
  expect(metrics.fonts.prompt).toBe('16px')
}

test('queue composer: layout, copy and focus at typical, minimum, stress and zoomed sizes', async () => {
  const launched = await launchSotto()
  const { page } = launched
  const record: Record<string, unknown> = {}
  try {
    await start(page)
    await size(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('button', { name: 'Docs', exact: true }).first().click()
    const pane = page.locator(PANE)
    const prompt = pane.getByRole('textbox', { name: 'Prompt', exact: true })
    const queue = pane.getByRole('region', { name: 'Queued messages' })
    await prompt.fill('Start the long job.')
    await prompt.press('Enter')

    // Rapid queueing: Enter right after the previous row appears, and right after the direct send, is never dropped.
    const rapid: unknown[] = []
    for (const [index, text] of QUEUED.entries()) {
      await prompt.fill(text)
      await prompt.press('Enter')
      await expect(prompt).toHaveValue('', { timeout: 3000 })
      await expect(queue).toContainText(text.slice(0, 30))
      rapid.push({ index, value: await prompt.inputValue(), followups: (await page.evaluate(async () => window.sotto!.agents!.get())).followups?.map(item => item.text.slice(0, 20)) })
    }
    record.rapidQueue = rapid
    const agentState = await page.evaluate(async () => window.sotto!.agents!.get())
    record.stateAfterQueue = { followups: agentState.followups?.length, deliveries: agentState.deliveries?.map(item => item.status) }
    expect(agentState.followups?.filter(item => item.threadId === 'docs')).toHaveLength(3)
    // The just-queued message was named in the queue (it is open at this height, so the row itself is the confirmation).
    await prompt.fill('A draft I am still writing\nwith a second line, while three follow-ups wait.')

    record.typical1280 = await paneMetrics(page)
    expectComposable(record.typical1280 as PaneMetrics, 240)
    await shot(page, 'queue-1-1280x800-dark')
    await appTheme(page, 'light')
    await shot(page, 'queue-1-1280x800-light')
    await appTheme(page, 'dark')
    await size(launched, 1600, 900)
    record.wide1600 = await paneMetrics(page)
    expectComposable(record.wide1600 as PaneMetrics, 320)
    await shot(page, 'queue-2-1600x900-dark')

    // The shipped minimum: the queue rests as one line, the transcript stays readable.
    await size(launched, 820, 560)
    await expect(prompt).toBeVisible()
    record.short820 = await paneMetrics(page)
    expectComposable(record.short820 as PaneMetrics, 130)
    await expect(queue.getByRole('button', { name: /Queued 3/u })).toHaveAttribute('aria-expanded', 'false')
    await shot(page, 'queue-3-820x560-dark-collapsed')
    await appTheme(page, 'light', 'blue')
    await shot(page, 'queue-3-820x560-light-blue-collapsed')
    await appTheme(page, 'dark')

    // Pointer: open the queue; the card stays whole, the rows scroll under the queue head.
    await queue.getByRole('button', { name: /Queued 3/u }).click()
    await expect(queue.getByRole('button', { name: /Queued 3/u })).toHaveAttribute('aria-expanded', 'true')
    record.short820Expanded = await paneMetrics(page)
    expect((record.short820Expanded as PaneMetrics).cardFullyVisible).toBe(true)
    await shot(page, 'queue-4-820x560-dark-expanded')

    // Edit the long follow-up: a dialog whose actions are on screen; Escape returns focus to that row's Edit button.
    await queue.getByRole('button', { name: 'Edit queued message 2', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit queued message' })
    await expect(dialog.getByRole('textbox', { name: 'Edit queued message' })).toBeFocused()
    for (const name of ['Save', 'Cancel']) await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
    await shot(page, 'queue-5-820x560-editing-dark')
    await appTheme(page, 'light', 'blue')
    await shot(page, 'queue-5-820x560-editing-light-blue')
    await appTheme(page, 'dark')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    record.focusAfterEditEscape = await focusedLabel(page)
    expect(record.focusAfterEditEscape).toBe('button:Edit queued message 2')
    // Keyboard save: Enter saves, focus returns to the same Edit button, the text is the edited one.
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('End')
    await page.keyboard.type(' Keep it short.')
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(queue).toContainText('Keep it short.')
    record.focusAfterEditSave = await focusedLabel(page)
    expect(record.focusAfterEditSave).toBe('button:Edit queued message 2')

    // Keyboard order backwards from the prompt reaches every queue control.
    await prompt.focus()
    const order: string[] = []
    for (let step = 0; step < 14; step++) { await page.keyboard.press('Shift+Tab'); order.push(await focusedLabel(page)) }
    record.shiftTabFromPrompt = order
    await shot(page, 'queue-6-820x560-keyboard-focus-dark')
    await queue.getByRole('button', { name: /Queued 3/u }).click()

    // Stress below the minimum width.
    await size(launched, 760, 560)
    record.stress760 = await paneMetrics(page)
    expect((record.stress760 as PaneMetrics).cardFullyVisible).toBe(true)
    await shot(page, 'queue-7-760x560-dark')

    // Reduced motion: no animation on queue or composer.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await size(launched, 1280, 800)
    record.reducedMotionAnimations = [...new Set(await page.evaluate(() => [...document.querySelectorAll('.thread-followups, .thread-followup, .thread-prompt, .composer-picker')].map(element => getComputedStyle(element).animationName)))]
    expect(record.reducedMotionAnimations).toEqual(['none'])
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    // 125%: everything fits. 150% (853x533 CSS px, below the 560 minimum): everything reachable by scrolling.
    await zoom(launched, 1.25)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
    await page.waitForTimeout(200)
    record.zoom125 = await paneMetrics(page)
    expect((record.zoom125 as PaneMetrics).cardFullyVisible).toBe(true)
    expect((record.zoom125 as PaneMetrics).outsideControls).toEqual([])
    await windowShot(launched, 'queue-8-1280x800-zoom125-dark')
    await zoom(launched, 1.5)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(853)
    await page.waitForTimeout(200)
    record.zoom150 = await paneMetrics(page)
    await windowShot(launched, 'queue-8-1280x800-zoom150-dark')
    record.zoom150Unreachable = await unreachable(pane.locator('button, textarea'))
    expect(record.zoom150Unreachable).toEqual([])
    await pane.evaluate(element => { element.scrollTop = 0 })
    await zoom(launched, 1)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280)

    // Settle the turn: without native completion the queue pauses. The pause is said once; the answer stays readable.
    await prompt.fill('')
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'docs', text: 'The long job is done. Review the diff before the queue continues.' }))
    await expect(queue).toContainText('Paused')
    const pausedCopy = async () => ({
      pauseSentences: (await queue.innerText()).split(PAUSE).length - 1,
      pausedChips: await queue.getByText('Paused', { exact: true }).count(),
      answerVisible: await pane.getByText('The long job is done.', { exact: false }).isVisible(),
    })
    record.paused1280 = { metrics: await paneMetrics(page), copy: await pausedCopy() }
    expect((record.paused1280 as { copy: unknown }).copy).toMatchObject({ pauseSentences: 1, pausedChips: 1 })
    await shot(page, 'queue-9-paused-1280x800-dark')
    await size(launched, 820, 560)
    await page.waitForTimeout(300)
    record.paused820 = { metrics: await paneMetrics(page), copy: await pausedCopy() }
    expect((record.paused820 as { copy: unknown }).copy).toMatchObject({ pauseSentences: 1, pausedChips: 1 })
    await shot(page, 'queue-9-paused-820x560-dark')
    await queue.getByRole('button', { name: 'Resume queue', exact: true }).focus()
    await page.keyboard.press('Enter')
    record.focusAfterResume = await focusedLabel(page)
    await shot(page, 'queue-10-resumed-820x560-dark')
  } finally {
    await evidence('queue-composer', record)
    await closeSotto(launched)
  }
})
