import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from '../../e2e/support/sottoLaunch'
import { appTheme, focusedLabel, paneMetrics, size, type PaneMetrics } from './support'

// Real production Electron with the E2E fixture provider and an owned temporary profile (no native or paid calls):
// 1. a managed draft of two exact lines, one image and two queued rows keeps its prompt, image and Send it above the
//    footer at 820x560, 1280 and in a short split;
// 2. keyboard Manage keeps focus in the thread's prompt while the handoff waits and after it is refused, without taking
//    focus back from another pane the user moved to.
// Holds and failures are injected at main's IPC handler in-process, as the independent critic did.

const SHOTS = 'artifacts/phase-two-composer-final-gaps'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5FoAAAAASUVORK5CYII=', 'base64')
const DOCS = 'section.thread-pane[data-thread-id="docs"]'
const WORKSHOP = 'section.thread-pane[data-thread-id="workshop"]'
const DRAFT = 'My unsent manual draft for Docs:\n  keep  the  spacing, “quotes” and trailing space '

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' })
}
async function evidence(name: string, data: unknown): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  await writeFile(`${SHOTS}/${name}.json`, `${JSON.stringify(data, null, 2)}\n`)
}
const agents = (page: Page) => page.evaluate(async () => window.sotto!.agents!.get())

/** Hold, then optionally refuse, one command type at main's IPC handler. */
async function installDoubles(launched: LaunchedSotto): Promise<void> {
  await launched.app.evaluate(({ ipcMain }) => {
    type Rule = { name: string; type: string; threadId?: string; fail?: string; gate?: Promise<void>; release: () => void; hits: number }
    const g = globalThis as unknown as { __review?: { rules: Rule[] } }
    if (g.__review) return
    const review = { rules: [] as Rule[] }
    g.__review = review
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, payload: { type?: string; threadId?: string }) => unknown> })._invokeHandlers
    const original = handlers.get('sotto:agents:command')!
    handlers.set('sotto:agents:command', async (event, payload) => {
      const rule = review.rules.find(item => item.type === payload?.type && (item.threadId === undefined || item.threadId === payload?.threadId))
      if (rule) {
        rule.hits++
        await rule.gate
        if (rule.fail) throw new Error(rule.fail)
      }
      return original(event, payload)
    })
  })
}
async function hold(launched: LaunchedSotto, name: string, type: string, options: { threadId?: string; fail?: string; gated?: boolean } = {}): Promise<void> {
  await launched.app.evaluate((_electron, [name, type, threadId, fail, gated]) => {
    const review = (globalThis as unknown as { __review: { rules: unknown[] } }).__review
    let release = (): void => undefined
    const gate = gated ? new Promise<void>(done => { release = done }) : undefined
    review.rules.push({ name, type, hits: 0, gate, release, ...(threadId ? { threadId } : {}), ...(fail ? { fail } : {}) })
  }, [name, type, options.threadId ?? '', options.fail ?? '', options.gated ?? false] as const)
}
async function release(launched: LaunchedSotto, name: string): Promise<number> {
  return launched.app.evaluate((_electron, name) => {
    const review = (globalThis as unknown as { __review: { rules: { name: string; hits: number; release: () => void }[] } }).__review
    let hits = 0
    for (const rule of review.rules.filter(item => item.name === name)) { hits += rule.hits; rule.release(); review.rules.splice(review.rules.indexOf(rule), 1) }
    return hits
  }, name)
}

/** Samples document.activeElement every frame, since removing or disabling a focused node does not reliably fire focusout. */
async function armProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const label = (element: Element | null): string => !element || element === document.body ? '(body)'
      : `${element.tagName.toLowerCase()}:${(element.getAttribute('aria-label') || (element.id ? `#${element.id}` : '') || (element as HTMLElement).innerText || '').trim().slice(0, 30)}@${element.closest('[data-thread-id]')?.getAttribute('data-thread-id') ?? '-'}`
    const probe = { timeline: [] as string[], bodyFrames: 0, last: '', stop: false, start: performance.now() }
    ;(window as unknown as { __probe: typeof probe }).__probe = probe
    const frame = (): void => {
      const current = label(document.activeElement)
      if (current === '(body)') probe.bodyFrames++
      if (current !== probe.last) { probe.timeline.push(`${Math.round(performance.now() - probe.start)}ms ${current}`); probe.last = current }
      if (!probe.stop) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
}
const readProbe = (page: Page) => page.evaluate(() => {
  const probe = (window as unknown as { __probe: { timeline: string[]; bodyFrames: number; stop: boolean } }).__probe
  probe.stop = true
  return { timeline: probe.timeline, bodyFrames: probe.bodyFrames }
})

/** The managed card, its image and its actions sit above the footer inside the pane, and the transcript keeps room. */
async function expectManagedWhole(page: Page, pane: Locator, scope: string, minimumTranscript: number): Promise<Record<string, unknown>> {
  const metrics = await paneMetrics(page, scope)
  const facts = await pane.evaluate(element => {
    const footer = document.querySelector('.app-footer')?.getBoundingClientRect().top ?? window.innerHeight
    const rect = (target: Element | null | undefined) => { const r = target?.getBoundingClientRect(); return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) } : null }
    const image = element.querySelector('.agent-composer .screenshot-previews img')
    const send = [...element.querySelectorAll('.agent-composer button')].find(button => button.textContent?.includes('Send it'))
    return { footer: Math.round(footer), image: rect(image), figure: rect(image?.closest('figure')), send: rect(send), prompt: rect(element.querySelector('#agent-prompt')), caption: element.querySelector('.agent-composer figcaption') ? getComputedStyle(element.querySelector('.agent-composer figcaption')!).fontSize : null, remove: rect(element.querySelector('.agent-composer .screenshot-previews button')), cardParts: [...(element.querySelector('.agent-composer')?.querySelectorAll(':scope > *, :scope > .screenshot-input > *, :scope > .screenshot-input > .screenshot-input__tools > *, .agent-composer__footer > *') ?? [])].map(part => `${part.tagName.toLowerCase()}.${part.className.toString().split(' ')[0]}:${Math.round(part.getBoundingClientRect().top)}+${Math.round(part.getBoundingClientRect().height)}`) }
  })
  const context = JSON.stringify({ metrics, facts })
  expect(metrics.cardFullyVisible, context).toBe(true)
  expect(metrics.outsideControls, context).toEqual([])
  expect(metrics.scrollers.filter(item => item.startsWith('thread-pane:')), context).toEqual([])
  expect(metrics.transcriptClientHeight!, context).toBeGreaterThanOrEqual(minimumTranscript)
  expect(facts.image, context).not.toBeNull()
  expect(facts.figure!.bottom, context).toBeLessThanOrEqual(facts.footer)
  expect(facts.send!.bottom, context).toBeLessThanOrEqual(facts.footer)
  expect(facts.remove!.width, context).toBeGreaterThanOrEqual(20)
  expect(metrics.fonts.prompt, context).toBe('16px')
  await expect(pane.locator('#agent-prompt')).toHaveValue(DRAFT)
  await expect(pane.getByRole('button', { name: /Send it/u })).toBeInViewport({ ratio: 1 })
  return { metrics, facts }
}

test('keyboard Manage keeps focus through a held and a refused handoff; the managed draft with an image stays whole', async () => {
  const launched = await launchSotto()
  const { page } = launched
  const record: Record<string, unknown> = {}
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'teal' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await installDoubles(launched)
    await size(launched, 1280, 800)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await page.getByRole('button', { name: 'Docs', exact: true }).first().click()
    const pane = page.locator(DOCS)
    const manual = pane.locator('form.thread-prompt textarea')
    const managedPrompt = pane.locator('#agent-prompt')
    const manage = pane.getByRole('button', { name: 'Manage', exact: true })
    await manual.fill('Start the long job.')
    await manual.press('Enter')
    await expect(pane.getByLabel('Thread transcript')).toContainText('Start the long job.')
    for (const text of ['Queued before managing: run the tests.', 'Queued before managing: update the changelog.']) {
      await manual.fill(text)
      await manual.press('Enter')
      await expect(pane.getByRole('region', { name: 'Queued messages' })).toContainText(text)
    }
    await manual.fill(DRAFT)
    await pane.getByLabel('Screenshot files').setInputFiles({ name: 'draft-image.png', mimeType: 'image/png', buffer: PNG })
    await expect(pane.getByRole('img', { name: 'draft-image.png' })).toBeVisible()
    await expect(pane.locator('.thread-prompt__status')).toHaveCount(0)

    // The manual composer with the same draft, image and queue at the minimum size (neighbor of the managed case).
    await size(launched, 820, 560)
    record.manual820 = await paneMetrics(page, DOCS)
    await shot(page, 'gaps-0-manual-image-queue-820x560-dark')
    expect((record.manual820 as PaneMetrics).cardFullyVisible, JSON.stringify(record.manual820)).toBe(true)
    expect((record.manual820 as PaneMetrics).outsideControls, JSON.stringify(record.manual820)).toEqual([])
    await size(launched, 1280, 800)

    // Keyboard Manage while main holds the assign: focus stays in this thread's prompt; nothing else can act on the thread.
    await hold(launched, 'assign-held-refused', 'assign', { threadId: 'docs', gated: true, fail: 'REVIEW_ASSIGN_REFUSED' })
    await manage.focus()
    await armProbe(page)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    const followupsBefore = (await agents(page)).followups?.length ?? 0
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    const pending = {
      focus: await focusedLabel(page), manageDisabled: await manage.isDisabled(),
      settleDisabled: await pane.getByRole('button', { name: 'Settle', exact: true }).isDisabled(),
      submitDisabled: await pane.locator('.thread-prompt__actions button[type="submit"]').isDisabled(),
      enterSentNothing: ((await agents(page)).followups?.length ?? 0) === followupsBefore, value: await manual.inputValue(),
    }
    await shot(page, 'gaps-1-keyboard-manage-pending-1280-dark')
    record.pending = pending
    expect(pending).toMatchObject({ manageDisabled: true, settleDisabled: true, submitDisabled: true, enterSentNothing: true, value: DRAFT })
    expect(pending.focus).toMatch(/^textarea:/u)
    await expect(manual).toBeFocused()
    const hits = await release(launched, 'assign-held-refused')
    await expect(manage).toBeEnabled({ timeout: 10_000 })
    await page.waitForTimeout(1_500)
    const refused = {
      hits, probe: await readProbe(page), focus: await focusedLabel(page), value: await manual.inputValue(), managedPromptCount: await managedPrompt.count(),
      image: await pane.getByRole('img', { name: 'draft-image.png' }).count(), assignments: (await agents(page)).assignments.map(item => item.threadId),
    }
    record.refusedKeyboard = refused
    await shot(page, 'gaps-2-keyboard-manage-refused-1280-dark')
    expect(refused.probe.bodyFrames, JSON.stringify(refused)).toBe(0)
    expect(refused).toMatchObject({ value: DRAFT, managedPromptCount: 0, image: 1, assignments: [] })
    await expect(manual).toBeFocused()

    // Moved to another pane while waiting: the refusal does not take focus back.
    await size(launched, 1600, 900)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Workshop', exact: true }).hover()
    await sidebar.getByRole('button', { name: 'Open Workshop beside', exact: true }).click()
    const workshop = page.locator(WORKSHOP)
    const workshopPrompt = workshop.getByRole('textbox', { name: 'Prompt', exact: true })
    await manual.click()
    await expect(pane).toHaveAttribute('data-focused')
    await hold(launched, 'assign-away', 'assign', { threadId: 'docs', gated: true, fail: 'REVIEW_ASSIGN_REFUSED' })
    await manage.focus()
    await page.keyboard.press('Enter')
    await expect(manual).toBeFocused()
    await workshopPrompt.click()
    await workshopPrompt.fill('Workshop typing during the Docs handoff.')
    await expect(workshop.locator('.thread-prompt__actions button[type="submit"]')).toBeEnabled()
    await release(launched, 'assign-away')
    await expect(manage).toBeEnabled({ timeout: 10_000 })
    await page.waitForTimeout(600)
    record.movedAway = { focus: await focusedLabel(page), docsValue: await manual.inputValue() }
    await expect(workshopPrompt).toBeFocused()
    await shot(page, 'gaps-3-refused-after-moving-to-other-pane-1600-dark')
    await workshop.getByRole('button', { name: 'Close Workshop pane' }).click()

    // Keyboard Manage that succeeds: the managed composer takes focus with the exact text and image.
    await size(launched, 1280, 800)
    await manual.click()
    await manage.focus()
    await armProbe(page)
    await page.keyboard.press('Enter')
    await expect(managedPrompt).toBeFocused({ timeout: 10_000 })
    await page.waitForTimeout(300)
    record.managedKeyboard = { probe: await readProbe(page), focus: await focusedLabel(page) }
    expect((record.managedKeyboard as { probe: { bodyFrames: number } }).probe.bodyFrames).toBe(0)
    await expect(managedPrompt).toHaveValue(DRAFT)
    await expect(pane.getByRole('img', { name: 'draft-image.png' })).toHaveCount(1)

    // Managed text + image + queue: 1280, 820x560, both themes, then a short split with a neighbor.
    await shot(page, 'gaps-4-managed-image-queue-1280-dark')
    record.managed1280 = await expectManagedWhole(page, pane, DOCS, 160)
    await appTheme(page, 'light', 'amber')
    await shot(page, 'gaps-4-managed-image-queue-1280-light-amber')
    await appTheme(page, 'dark')
    await size(launched, 820, 560)
    await page.waitForTimeout(200)
    await shot(page, 'gaps-5-managed-image-queue-820x560-dark')
    record.managed820 = await expectManagedWhole(page, pane, DOCS, 100)
    await appTheme(page, 'light')
    await shot(page, 'gaps-5-managed-image-queue-820x560-light')
    await appTheme(page, 'dark')
    // Side by side at the default window height (1280x720) the managed card fits beside a neighbor.
    await size(launched, 1280, 720)
    await sidebar.getByRole('button', { name: 'Workshop', exact: true }).hover()
    await sidebar.getByRole('button', { name: 'Open Workshop beside', exact: true }).click()
    await expect(workshop).toHaveAttribute('data-focused')
    await workshop.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Neighbor draft.')
    await pane.getByRole('button', { name: 'Write here', exact: true }).click()
    await expect(managedPrompt).toBeFocused()
    await shot(page, 'gaps-6-managed-image-split-1280x720-dark')
    record.split1280x720 = { docs: await expectManagedWhole(page, pane, DOCS, 120), workshop: await paneMetrics(page, WORKSHOP) }
    expect((record.split1280x720 as { workshop: PaneMetrics }).workshop.cardFullyVisible).toBe(true)
    await appTheme(page, 'light', 'blue')
    await shot(page, 'gaps-6-managed-image-split-1280x720-light-blue')
    await appTheme(page, 'dark')
    // Side by side at the minimum height: the header's actions may wrap in a 486px pane, and the card still fits.
    await size(launched, 1280, 560)
    await page.waitForTimeout(200)
    await shot(page, 'gaps-6b-managed-image-split-1280x560-dark')
    record.split1280x560 = { docs: await expectManagedWhole(page, pane, DOCS, Math.floor(456 * 0.24)), workshop: await paneMetrics(page, WORKSHOP) }
    expect((record.split1280x560 as { workshop: PaneMetrics }).workshop.cardFullyVisible).toBe(true)
    await size(launched, 820, 560)
    await page.waitForTimeout(200)
    await shot(page, 'gaps-7-managed-image-split-tabs-820x560-dark')
    record.split820 = await expectManagedWhole(page, pane, DOCS, Math.floor(409 * 0.24))
  } finally {
    record.finalState = await agents(page).then(state => ({ error: state.error, assignments: state.assignments.map(item => item.threadId), draft: state.draft, attachments: state.draftAttachments?.map(item => item.name) })).catch(() => null)
    await evidence('final-gaps', record)
    await closeSotto(launched)
  }
})
