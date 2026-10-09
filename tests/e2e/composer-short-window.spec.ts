import { expect, test, type Locator, type Page } from '@playwright/test'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5FoAAAAASUVORK5CYII=', 'base64')
const DRAFT = 'My unsent draft:\n  keep  the  spacing, “quotes” and trailing space '
// Panes are keyed by the host that owns their thread; main's bridge still takes the bare thread ID.
let hostId: string | undefined
const pane = (page: Page, id: string) => page.locator(`section.thread-pane[data-thread-id="${hostEntityKey(hostId, id)}"]`)

async function start(launched: LaunchedSotto): Promise<void> {
  await launched.page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'teal', threadTitles: false })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await launched.page.reload()
  hostId = await launched.page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
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

/**
 * The card with its prompt, image and submit action sits above the window's
 * bottom edge, and the pane itself does not scroll. The Threads page owns the
 * whole window now, so the bottom edge is the limit the composer has to respect.
 */
async function expectCardWhole(page: Page, threadId: string, submit: RegExp, withImage = true): Promise<void> {
  // The text can arrive before its image when a composer mounts; measure once both are shown.
  if (withImage) await expect(pane(page, threadId).locator('.thread-prompt .screenshot-previews img')).toBeVisible()
  await page.waitForTimeout(100)
  const facts = await pane(page, threadId).evaluate((element, source) => {
    const limit = window.innerHeight
    const card = element.querySelector('.thread-prompt')!
    const image = card.querySelector('.screenshot-previews img')
    const action = [...card.querySelectorAll('button')].find(button => new RegExp(source, 'u').test(button.getAttribute('aria-label') ?? button.textContent ?? ''))
    const bottom = (target: Element | null | undefined) => target ? Math.round(target.getBoundingClientRect().bottom) : null
    return {
      limit: Math.round(limit), card: bottom(card), image: bottom(image), action: bottom(action), meta: bottom(element.querySelector('.thread-pane__meta')),
      promptFont: getComputedStyle(card.querySelector('textarea')!).fontSize,
      controls: [...element.querySelectorAll('.thread-workspace__actions .tt-button')].map(button => ({ height: button.getBoundingClientRect().height, font: getComputedStyle(button).fontSize })),
      paneScroll: element.scrollHeight - element.clientHeight, transcript: element.querySelector('[aria-label="Thread transcript"]')!.clientHeight,
    }
  }, submit.source)
  const context = JSON.stringify(facts)
  if (withImage) expect(facts.image, context).not.toBeNull()
  expect(facts.action, context).not.toBeNull()
  expect(facts.card!, context).toBeLessThanOrEqual(facts.limit)
  expect(facts.action!, context).toBeLessThanOrEqual(facts.limit)
  expect(facts.paneScroll, context).toBeLessThanOrEqual(1)
  expect(facts.transcript, context).toBeGreaterThanOrEqual(90)
  // The row under the composer, where compaction's result is said, fits inside the window as well. It has height only
  // side by side, where it holds one line open, or once compaction has something to say.
  expect(facts.meta, context).not.toBeNull()
  expect(facts.meta!, context).toBeLessThanOrEqual(facts.limit)
  expect(facts.promptFont).toBe('15px')
  for (const control of facts.controls) { expect(Math.round(control.height)).toBeGreaterThanOrEqual(34); expect(control.font).toBe('14px') }
  const name = await page.evaluate(() => `${innerWidth}x${innerHeight}`)
  await page.screenshot({ path: `test-results/issue74-ui-captures/composer/${name}-${threadId}-manual.png`, animations: 'disabled' })
}

async function attachDraft(thread: Locator, prompt: Locator): Promise<void> {
  await prompt.fill(DRAFT)
  await thread.getByLabel('Screenshot files').setInputFiles({ name: 'draft-image.png', mimeType: 'image/png', buffer: PNG })
  await expect(thread.getByRole('img', { name: 'draft-image.png' })).toBeVisible()
}

test('one attached image keeps the prompt and its action above the window edge at 820x560 and in a short split', async () => {
  test.setTimeout(180_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await start(launched)
    await size(launched, 1280, 800)
    await openThreads(page)
    await open(page, 'Docs')
    const docs = pane(page, 'docs')
    const docsManual = docs.locator('form.thread-prompt textarea')
    await docsManual.fill('Start the long job.')
    await docsManual.press('Enter')
    await expect(docs.getByLabel('Thread transcript')).toContainText('Start the long job.')
    for (const text of ['Queued first.', 'Queued second.']) {
      await docsManual.fill(text)
      // The transcript shows the optimistic send before main admits the running
      // turn. Build the layout fixture only once the next prompt can be queued.
      await expect(docs.getByRole('button', { name: 'Queue prompt', exact: true })).toBeEnabled()
      await docsManual.press('Enter')
      await expect(docs.getByRole('region', { name: 'Queued messages' })).toContainText(text)
    }
    await size(launched, 820, 560)

    await open(page, 'Workshop')
    const workshop = pane(page, 'workshop')
    await attachDraft(workshop, workshop.locator('form.thread-prompt textarea'))
    await expectCardWhole(page, 'workshop', /^Send prompt$/u)
    await open(page, 'Docs')
    await attachDraft(docs, docsManual)
    await expectCardWhole(page, 'docs', /^Queue prompt$/u)

    // Side by side at the minimum height, with its neighbor.
    await size(launched, 1280, 560)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Workshop', exact: true }).hover()
    await sidebar.getByRole('button', { name: 'Open Workshop beside', exact: true }).click()
    await expect(workshop).toHaveAttribute('data-focused')
    await docsManual.focus()
    await expect(docsManual).toBeFocused()
    await expectCardWhole(page, 'docs', /^Queue prompt$/u)
    // The neighbor's own (now empty) composer stays whole too.
    await expectCardWhole(page, 'workshop', /^Send prompt$/u)
    // Narrow split tabs at 820x560.
    await size(launched, 820, 560)
    await expectCardWhole(page, 'docs', /^Queue prompt$/u)
  } finally {
    await closeSotto(launched)
  }
})
