import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// The thread composer at the shipped 820x560 minimum and in a short split, and keyboard focus through usage, Write here and a
// refused Manage. Holds and refusals are injected at main's IPC handler in-process; no product code is changed for it.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5FoAAAAASUVORK5CYII=', 'base64')
const DRAFT = 'My unsent draft:\n  keep  the  spacing, “quotes” and trailing space '
const pane = (page: Page, id: string) => page.locator(`section.thread-pane[data-thread-id="${id}"]`)
const agents = (page: Page) => page.evaluate(async () => window.sotto!.agents!.get())

async function start(launched: LaunchedSotto): Promise<void> {
  await launched.page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'teal' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await launched.page.reload()
}

async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    // The shipped minimum is enforced on the outer frame; lower it so the content is exactly the size under test.
    window.setMinimumSize(700, 500)
    window.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)).toBe(`${width}x${height}`)
  await launched.page.waitForTimeout(200)
}

async function open(page: Page, title: string): Promise<void> {
  await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true }).click()
}

/** The card with its prompt, image and submit action sits above the app footer, and the pane itself does not scroll. */
async function expectCardWhole(page: Page, threadId: string, submit: RegExp, withImage = true): Promise<void> {
  // The text can arrive before its image when a composer mounts; measure once both are shown.
  if (withImage) await expect(pane(page, threadId).locator('.thread-prompt .screenshot-previews img, .agent-composer .screenshot-previews img')).toBeVisible()
  await page.waitForTimeout(100)
  const facts = await pane(page, threadId).evaluate((element, source) => {
    const footer = document.querySelector('.app-footer')!.getBoundingClientRect().top
    const card = element.querySelector('.thread-prompt, .agent-composer')!
    const image = card.querySelector('.screenshot-previews img')
    const action = [...card.querySelectorAll('button')].find(button => new RegExp(source, 'u').test(button.getAttribute('aria-label') ?? button.textContent ?? ''))
    const bottom = (target: Element | null | undefined) => target ? Math.round(target.getBoundingClientRect().bottom) : null
    return {
      footer: Math.round(footer), card: bottom(card), image: bottom(image), action: bottom(action), usage: bottom(element.querySelector('.thread-usage')),
      promptFont: getComputedStyle(card.querySelector('textarea')!).fontSize,
      controls: [...element.querySelectorAll('.thread-workspace__actions .tt-button')].map(button => ({ height: button.getBoundingClientRect().height, font: getComputedStyle(button).fontSize })),
      paneScroll: element.scrollHeight - element.clientHeight, transcript: element.querySelector('[aria-label="Thread transcript"]')!.clientHeight,
    }
  }, submit.source)
  const context = JSON.stringify(facts)
  if (withImage) expect(facts.image, context).not.toBeNull()
  expect(facts.action, context).not.toBeNull()
  expect(facts.card!, context).toBeLessThanOrEqual(facts.footer)
  expect(facts.action!, context).toBeLessThanOrEqual(facts.footer)
  expect(facts.paneScroll, context).toBeLessThanOrEqual(1)
  expect(facts.transcript, context).toBeGreaterThanOrEqual(90)
  expect(facts.usage!, context).toBeLessThanOrEqual(facts.footer)
  expect(facts.promptFont).toBe('16px')
  for (const control of facts.controls) { expect(Math.round(control.height)).toBeGreaterThanOrEqual(34); expect(control.font).toBe('14px') }
  const name = await page.evaluate(() => `${innerWidth}x${innerHeight}`)
  const mode = await pane(page, threadId).locator('.agent-composer').count() ? 'managed' : 'manual'
  await page.screenshot({ path: `test-results/issue74-ui-captures/composer/${name}-${threadId}-${mode}.png`, animations: 'disabled' })
}

async function attachDraft(thread: Locator, prompt: Locator): Promise<void> {
  await prompt.fill(DRAFT)
  await thread.getByLabel('Screenshot files').setInputFiles({ name: 'draft-image.png', mimeType: 'image/png', buffer: PNG })
  await expect(thread.getByRole('img', { name: 'draft-image.png' })).toBeVisible()
}

test('one attached image keeps the prompt and its action above the footer at 820x560 and in a short split', async () => {
  test.setTimeout(180_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await start(launched)
    await size(launched, 1280, 800)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await open(page, 'Docs')
    const docs = pane(page, 'docs')
    const docsManual = docs.locator('form.thread-prompt textarea')
    await docsManual.fill('Start the long job.')
    await docsManual.press('Enter')
    await expect(docs.getByLabel('Thread transcript')).toContainText('Start the long job.')
    for (const text of ['Queued first.', 'Queued second.']) {
      await docsManual.fill(text)
      await docsManual.press('Enter')
      await expect(docs.getByRole('region', { name: 'Queued messages' })).toContainText(text)
    }
    await size(launched, 820, 560)

    // Without a queue: manual, then managed.
    await open(page, 'Workshop')
    const workshop = pane(page, 'workshop')
    await attachDraft(workshop, workshop.locator('form.thread-prompt textarea'))
    await expectCardWhole(page, 'workshop', /^Send prompt$/u)
    await workshop.getByRole('button', { name: 'Manage', exact: true }).click()
    await expect(workshop.locator('#agent-prompt')).toHaveValue(DRAFT)
    await expectCardWhole(page, 'workshop', /Send it/u)
    // One saved draft is Sotto's at a time; clear this one so Docs' managed composer can hold its own.
    await workshop.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(workshop.locator('#agent-prompt')).toHaveValue('')
    await workshop.getByRole('button', { name: 'Stop managing', exact: true }).click()
    await expect(workshop.locator('form.thread-prompt textarea')).toBeVisible()

    // With two queued rows: manual, then managed.
    await open(page, 'Docs')
    await attachDraft(docs, docsManual)
    await expectCardWhole(page, 'docs', /^Queue prompt$/u)
    await docs.getByRole('button', { name: 'Manage', exact: true }).click()
    await expect(docs.locator('#agent-prompt')).toHaveValue(DRAFT)
    await expectCardWhole(page, 'docs', /Send it/u)

    // Side by side at the minimum height, with its neighbor.
    await size(launched, 1280, 560)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Workshop', exact: true }).hover()
    await sidebar.getByRole('button', { name: 'Open Workshop beside', exact: true }).click()
    await expect(workshop).toHaveAttribute('data-focused')
    await docs.getByRole('button', { name: 'Write here', exact: true }).click()
    await expect(docs.locator('#agent-prompt')).toBeFocused()
    await expectCardWhole(page, 'docs', /Send it/u)
    // The neighbor's own (now empty) composer stays whole too.
    await expectCardWhole(page, 'workshop', /^Send prompt$/u, false)
    // Narrow split tabs at 820x560.
    await size(launched, 820, 560)
    await expectCardWhole(page, 'docs', /Send it/u)
  } finally {
    await closeSotto(launched)
  }
})

/** Samples document.activeElement every frame: a focused node that is disabled or removed does not reliably fire focusout. */
async function armProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = { bodyFrames: 0, stop: false }
    ;(window as unknown as { __probe: typeof probe }).__probe = probe
    const frame = (): void => { if (document.activeElement === document.body || !document.activeElement) probe.bodyFrames++; if (!probe.stop) requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
  })
}
const bodyFrames = (page: Page) => page.evaluate(() => { const probe = (window as unknown as { __probe: { bodyFrames: number; stop: boolean } }).__probe; probe.stop = true; return probe.bodyFrames })

test('keyboard focus stays put through usage details, Write here, and a refused Manage', async () => {
  test.setTimeout(180_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await start(launched)
    await size(launched, 1600, 900)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await open(page, 'Docs')
    const docs = pane(page, 'docs')
    await docs.getByRole('button', { name: 'Manage', exact: true }).click()
    await expect(docs.locator('#agent-prompt')).toBeFocused()
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Workshop', exact: true }).hover()
    await sidebar.getByRole('button', { name: 'Open Workshop beside', exact: true }).click()
    const workshop = pane(page, 'workshop')
    const workshopPrompt = workshop.locator('form.thread-prompt textarea')
    await workshopPrompt.click()
    await expect(workshop).toHaveAttribute('data-focused')

    // Usage details follow the composer now. Shift+Tab from the divider reaches them and keeps focus there.
    const messages = (await agents(page)).host.threads.find(thread => thread.id === 'docs')!.messages.length
    await page.getByRole('separator', { name: 'Resize panes' }).focus()
    await armProbe(page)
    await page.keyboard.press('Shift+Tab')
    await expect(docs).toHaveAttribute('data-focused')
    await expect(docs.locator('.thread-usage summary')).toBeFocused()
    expect(await bodyFrames(page)).toBe(0)
    // Keyboard entry into the managed pane selects it, so its composer is already in place of Write here.
    await expect(docs.locator('#agent-prompt')).toBeVisible()
    // Focusing Write here from the other pane must also hold that button through pane activation until Enter is pressed.
    await workshopPrompt.click()
    const writeHere = docs.getByRole('button', { name: 'Write here', exact: true })
    await armProbe(page)
    await writeHere.focus()
    await page.waitForTimeout(300)
    await expect(writeHere).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(docs.locator('#agent-prompt')).toBeFocused()
    expect(await bodyFrames(page)).toBe(0)
    expect((await agents(page)).host.threads.find(thread => thread.id === 'docs')!.messages.length).toBe(messages)

    // Keyboard Manage on Workshop while main holds the assign and then refuses it.
    await workshopPrompt.click()
    await workshopPrompt.fill('Workshop draft kept through a refusal.')
    await launched.app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, payload: { type?: string; threadId?: string }) => unknown> })._invokeHandlers
      const original = handlers.get('sotto:agents:command')!
      let release = (): void => undefined
      const gate = new Promise<void>(done => { release = done })
      ;(globalThis as unknown as { __releaseAssign: () => void }).__releaseAssign = release
      handlers.set('sotto:agents:command', async (event, payload) => {
        if (payload?.type === 'assign' && payload.threadId === 'workshop') { await gate; throw new Error('REFUSED_FOR_TEST') }
        return original(event, payload)
      })
    })
    const manage = workshop.getByRole('button', { name: 'Manage', exact: true })
    await manage.focus()
    await armProbe(page)
    await page.keyboard.press('Enter')
    await expect(manage).toBeDisabled()
    await expect(workshopPrompt).toBeFocused()
    await expect(workshop.getByRole('button', { name: 'Settle', exact: true })).toBeDisabled()
    await expect(workshop.locator('.thread-prompt__actions button[type="submit"]')).toBeDisabled()
    await page.keyboard.press('Enter')
    await launched.app.evaluate(() => (globalThis as unknown as { __releaseAssign: () => void }).__releaseAssign())
    await expect(manage).toBeEnabled({ timeout: 10_000 })
    await page.waitForTimeout(300)
    await expect(workshopPrompt).toBeFocused()
    await expect(workshopPrompt).toHaveValue('Workshop draft kept through a refusal.')
    expect(await bodyFrames(page)).toBe(0)
    expect((await agents(page)).assignments.map(item => item.threadId)).not.toContain('workshop')
    expect((await agents(page)).host.threads.find(thread => thread.id === 'workshop')!.messages.some(message => message.text.includes('kept through a refusal'))).toBe(false)
  } finally {
    await closeSotto(launched)
  }
})
