import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSottoWithVoice, openThreads } from '../../e2e/support/sottoLaunch'
import { appTheme, evidence, focusedLabel, paneMetrics, shot, size, type PaneMetrics } from './support'

// Real production Electron with the E2E fixture provider: a manual draft and queue through Manage, typing while
// managed, Stop managing, a split with an unfocused managed pane and Write here, and a reload.

const agents = (page: Page) => page.evaluate(async () => window.sotto!.agents!.get())
const DOCS = 'section.thread-pane[data-thread-id="docs"]'

test('handoff keeps one saved draft, focuses the mounted composer and keeps the managed card whole', async () => {
  const launched = await launchSottoWithVoice()
  const { page } = launched
  const record: Record<string, unknown> = {}
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'teal' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await size(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('button', { name: 'Docs', exact: true }).first().click()
    const pane = page.locator(DOCS)
    const manual = pane.locator('form.thread-prompt textarea')
    const managedPrompt = pane.locator('#agent-prompt')
    await manual.fill('Start the long job.')
    await manual.press('Enter')
    await expect(pane.getByLabel('Thread transcript')).toContainText('Start the long job.')
    for (const text of ['Queued before managing: run the tests.', 'Queued before managing: update the changelog.']) {
      await manual.fill(text)
      await manual.press('Enter')
      await expect(pane.getByRole('region', { name: 'Queued messages' })).toContainText(text)
    }

    // Typed immediately before Manage, without waiting for the debounced save.
    await manual.fill('My unsent manual draft for Docs.')
    await pane.getByRole('button', { name: 'Manage', exact: true }).click()
    await expect(managedPrompt).toBeVisible()
    await expect(managedPrompt).toHaveValue('My unsent manual draft for Docs.')
    await expect(managedPrompt).toBeFocused()
    record.onManage = { focus: await focusedLabel(page), value: await managedPrompt.inputValue(), queue: await pane.getByRole('region', { name: 'Queued messages' }).innerText() }
    record.managed1280 = await paneMetrics(page, DOCS)
    await shot(page, 'handoff-1-managed-1280')

    await managedPrompt.fill('My unsent manual draft for Docs. Coordinator note typed while managed.')
    await page.waitForTimeout(600)
    record.managedTyped1280 = await paneMetrics(page, DOCS)
    expect((record.managedTyped1280 as PaneMetrics).cardFullyVisible).toBe(true)
    expect((record.managedTyped1280 as PaneMetrics).outsideControls).toEqual([])
    await shot(page, 'handoff-2-managed-typed-1280')
    await size(launched, 820, 560)
    record.managedTyped820 = await paneMetrics(page, DOCS)
    await shot(page, 'handoff-2-managed-typed-820x560-dark')
    expect((record.managedTyped820 as PaneMetrics).cardFullyVisible).toBe(true)
    expect((record.managedTyped820 as PaneMetrics).outsideControls).toEqual([])
    await expect(pane.getByRole('button', { name: /Send it/u })).toBeInViewport({ ratio: 1 })
    await appTheme(page, 'light', 'blue')
    await shot(page, 'handoff-2-managed-typed-820x560-light-blue')
    await appTheme(page, 'dark')
    await size(launched, 1280, 800)

    // Stop managing: the manual composer shows the same current draft and has focus.
    await pane.getByRole('button', { name: 'Stop managing', exact: true }).click()
    await expect(manual).toBeVisible()
    await expect(manual).toBeFocused()
    await expect(manual).toHaveValue('My unsent manual draft for Docs. Coordinator note typed while managed.')
    const released = await agents(page)
    record.afterStop = { focus: await focusedLabel(page), value: await manual.inputValue(), threadDraft: released.threadDrafts?.find(item => item.threadId === 'docs')?.text ?? null, followups: released.followups?.map(item => item.text) }
    await shot(page, 'handoff-3-after-stop-managing-1280')

    // Split: the managed pane unfocused shows its queue and a notice; Write here focuses its managed composer.
    await pane.getByRole('button', { name: 'Manage', exact: true }).click()
    await expect(managedPrompt).toBeFocused()
    await size(launched, 1600, 900)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Workshop', exact: true }).hover()
    await sidebar.getByRole('button', { name: 'Open Workshop beside', exact: true }).click()
    const workshop = page.locator('section.thread-pane[data-thread-id="workshop"]')
    await expect(workshop).toHaveAttribute('data-focused')
    record.splitUnfocused1600 = { docs: await paneMetrics(page, DOCS), workshop: await paneMetrics(page, 'section.thread-pane[data-thread-id="workshop"]') }
    await shot(page, 'handoff-4-split-unfocused-managed-1600')
    await pane.getByRole('button', { name: 'Write here', exact: true }).click()
    await expect(pane).toHaveAttribute('data-focused')
    await expect(managedPrompt).toBeFocused()
    await expect(managedPrompt).toHaveValue('My unsent manual draft for Docs. Coordinator note typed while managed.')
    record.writeHere = { focus: await focusedLabel(page), metrics: await paneMetrics(page, DOCS) }
    await shot(page, 'handoff-5-split-write-here-1600')
    // Keyboard: Write here with Enter from the other pane's side.
    await workshop.locator('form.thread-prompt textarea').click()
    await expect(workshop).toHaveAttribute('data-focused')
    const keyed = pane.getByRole('button', { name: 'Write here', exact: true })
    await keyed.focus()
    // The pane takes the selection, but the focused button stays so Enter uses it instead of sending the managed draft.
    await expect(pane).toHaveAttribute('data-focused')
    await expect(keyed).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(managedPrompt).toBeFocused()
    record.keyboardWriteHere = { focus: await focusedLabel(page), error: (await agents(page)).error, value: await managedPrompt.inputValue() }
    expect((record.keyboardWriteHere as { error: unknown }).error).toBeNull()

    // Minimum size split: narrow tabs, the managed pane with its queue.
    await size(launched, 820, 560)
    record.splitNarrow820 = await paneMetrics(page)
    await shot(page, 'handoff-6-split-narrow-managed-820x560')
    expect((record.splitNarrow820 as PaneMetrics).cardFullyVisible).toBe(true)

    // Stop managing by keyboard, then reload: the manual composer restores the same draft.
    await pane.getByRole('button', { name: 'Stop managing', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(manual).toBeFocused()
    record.splitNarrowManual820 = await paneMetrics(page)
    expect((record.splitNarrowManual820 as PaneMetrics).cardFullyVisible).toBe(true)
    expect((record.splitNarrowManual820 as PaneMetrics).outsideControls).toEqual([])
    await shot(page, 'handoff-7-split-narrow-manual-queue-820x560')
    const beforeReload = await manual.inputValue()
    await page.waitForTimeout(600)
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Docs', exact: true }).first().click()
    await expect(page.locator(DOCS).locator('form.thread-prompt textarea')).toHaveValue(beforeReload)
    record.reload = { beforeReload, afterReload: await page.locator(DOCS).locator('form.thread-prompt textarea').inputValue(), followups: (await agents(page)).followups?.map(item => [item.text, item.status]) }
  } finally {
    record.finalState = await agents(page).then(state => ({ error: state.error, busy: state.globalLaneBusy, assignments: state.assignments.map(item => item.threadId), activeThreadId: state.activeThreadId, drafts: state.threadDrafts })).catch(() => null)
    await evidence('managed-handoff', record)
    await closeSotto(launched)
  }
})
