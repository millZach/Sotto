import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { hostKeysPerTest } from './support/hostKeys'
import { expectPromptText, fillPrompt } from './support/prompt'
import { closeSotto, launchSotto, openThreads, userMessageTexts, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

// Reply quotes (ADR-0129; Owl only, the user's pick A and 1 of docs/prototypes/reply-quote-prototype.html): words
// dragged over in an agent's reply offer Add to prompt above them, the press or Ctrl+Shift+A puts them on the composer
// as a chip, and the next prompt carries them as plain text ahead of the user's message. Captures go to disposable run
// evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/reply-quote.

const evidence = evidenceDirectory('artifacts/reply-quote')
const hostKeys = hostKeysPerTest()
const key = hostKeys.key
test.beforeEach(() => { hostKeys.reset() })

const THREAD = 'grok-previews'
const FIRST = `${THREAD}-quote-1`
const SECOND = `${THREAD}-quote-3`
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const CHORD = process.platform === 'darwin' ? 'Meta+Shift+A' : 'Control+Shift+A'

async function launch(enabled: boolean): Promise<LaunchedSotto> {
  const previous = process.env.SOTTO_OWL_FEATURES
  // The slim composer stays out of it, so the composer keeps one size while the transcript scrolls.
  process.env.SOTTO_OWL_FEATURES = `reply-quote=${enabled ? 1 : 0},composer-shrink=0`
  try { return await launchSotto('design-threads') } finally { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous }
}

async function prepare(launched: LaunchedSotto): Promise<Page> {
  const { page } = launched
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'blue', reducedMotion: 'system' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await hostKeys.read(page)
  await openThreads(page)
  await page.evaluate(() => document.fonts.ready)
  await page.getByRole('button', { name: 'Grok voice previews', exact: true }).click({ position: { x: 16, y: 12 } })
  await expect(page.getByRole('heading', { name: 'Grok voice previews', exact: true })).toBeVisible()
  // Two exchanges, so a selection can run from one reply into the next.
  await page.evaluate(async ([threadId, first, second]) => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 9, minute)).toISOString()
    // Earlier turns above, so the replies can be scrolled to the top of the transcript.
    const earlier = Array.from({ length: 6 }, (_, index) => ({ id: `${threadId}-earlier-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
      text: index % 2 ? 'The preview plays a two-second sample through the selected voice, and the key stays in the system keychain rather than settings.json.'
        : 'Can the preview button sit beside each voice?', createdAt: new Date(Date.UTC(2026, 9, 24, 8, index)).toISOString() }))
    await window.sottoE2E!.agentEvent!({ type: 'history', threadId, text: '', messages: [...earlier,
      { id: `${threadId}-quote-0`, role: 'user' as const, text: 'Why does the composer lose its draft when I switch threads?', createdAt: at(0) },
      { id: first, role: 'assistant' as const, createdAt: at(1), text: [
        'The draft lives in the thread draft store, keyed by thread ID, so switching threads should keep it. The loss comes from the editor: it mounts again for each thread, and its first effect writes its empty text back to the store before the saved draft has been read.',
        'There are two ways to fix it. Read the saved draft synchronously when the editor mounts, so the first render already has it. Or skip the write-back until the editor has seen one edit of the user’s.',
        'The first is smaller and keeps one source of truth.',
      ].join('\n\n') },
      { id: `${threadId}-quote-2`, role: 'user' as const, text: 'Does dictation go through the same path?', createdAt: at(2) },
      { id: second, role: 'assistant' as const, createdAt: at(3), text: 'Yes. Dictation writes through the same effect, so a dictation landing during the mount could still be dropped by the second fix.' },
      // Later turns below, so the first reply can be scrolled up to the top of the transcript.
      ...Array.from({ length: 6 }, (_, index) => ({ id: `${threadId}-later-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
        text: index % 2 ? 'The key now stays in the system keychain, and settings.json keeps only the voice. Nothing else in the window changed, and the preview still plays for two seconds.'
          : 'Anything else to change?', createdAt: new Date(Date.UTC(2026, 9, 24, 10, index)).toISOString() })),
    ] })
  }, [THREAD, FIRST, SECOND] as const)
  await expect(page.locator(`[data-message-id="${SECOND}"]`)).toBeVisible()
  return page
}

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

const paneOf = (page: Page): Locator => page.locator(`section.thread-pane[data-thread-id="${key(THREAD)}"]`)
const logOf = (page: Page): Locator => paneOf(page).locator('[aria-label="Thread transcript"]')
const addButton = (page: Page): Locator => paneOf(page).getByRole('button', { name: 'Add to prompt' })
const chipsOf = (page: Page): Locator => paneOf(page).getByRole('list', { name: 'Quotes from replies' })

interface Box { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/** Where some words sit on screen, found by their text in a message. */
async function wordsBox(page: Page, messageId: string, words: string): Promise<Box> {
  return page.evaluate(([messageId, words]) => {
    const body = document.querySelector(`.thread-message[data-message-id="${messageId}"] .rich-message`)!
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(words)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + words.length)
      const rect = range.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }
    throw new Error(`No “${words}” in ${messageId}`)
  }, [messageId, words] as const)
}

/** A mouse drag from the start of `from` to the end of `to`, as a reader selects. */
async function drag(page: Page, from: Box, to: Box): Promise<void> {
  await page.mouse.move(from.left + 1, (from.top + from.bottom) / 2)
  await page.mouse.down()
  await page.mouse.move((from.left + to.right) / 2, (from.top + to.bottom) / 2, { steps: 4 })
  await page.mouse.move(to.right - 1, (to.top + to.bottom) / 2, { steps: 4 })
  await page.mouse.up()
}

async function select(page: Page, messageId: string, from: string, to: string = from): Promise<void> {
  await drag(page, await wordsBox(page, messageId, from), await wordsBox(page, messageId, to))
}

/** The button against the selection and the transcript: it must sit beside the words and inside the transcript. */
async function placement(page: Page): Promise<{ button: Box; selection: Box; log: Box }> {
  return paneOf(page).evaluate(pane => {
    const box = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
    return {
      button: box(pane.querySelector('.reply-quote-pop')!.getBoundingClientRect()),
      selection: box(document.getSelection()!.getRangeAt(0).getBoundingClientRect()),
      log: box(pane.querySelector('[aria-label="Thread transcript"]')!.getBoundingClientRect()),
    }
  })
}

function expectInside(where: { button: Box; log: Box }, context: string): void {
  expect(where.button.top, context).toBeGreaterThanOrEqual(where.log.top)
  expect(where.button.bottom, context).toBeLessThanOrEqual(where.log.bottom)
  expect(where.button.left, context).toBeGreaterThanOrEqual(where.log.left)
  expect(where.button.right, context).toBeLessThanOrEqual(where.log.right)
}

/** Every layout box that runs past the window's edges, so a capture is also a clipping check. */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.reply-quote-pop, .review-chip, .thread-prompt')]
    .filter(element => { const rect = element.getBoundingClientRect(); return rect.right > innerWidth + 1 || rect.left < -1 || rect.bottom > innerHeight + 1 })
    .map(element => element.className))
}

/** Puts the reply's words in the middle of the transcript, so the button has room above them. */
async function centre(page: Page, messageId: string, words: string): Promise<void> {
  await logOf(page).evaluate((log, [messageId, words]) => {
    const body = document.querySelector(`.thread-message[data-message-id="${messageId}"] .rich-message`)!
    const paragraph = [...body.querySelectorAll('p')].find(item => item.textContent!.includes(words))!
    log.scrollTop += paragraph.getBoundingClientRect().top - log.getBoundingClientRect().top - log.clientHeight / 3
    log.dispatchEvent(new Event('scroll'))
  }, [messageId, words] as const)
}

test('words selected in a reply go onto the composer as quotes and out ahead of the next prompt', async () => {
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const launched = await launch(true)
  const errors: string[] = []
  launched.page.on('pageerror', error => errors.push(error.message))
  try {
    const page = await prepare(launched)
    await resize(launched, 1280, 800)
    const pane = paneOf(page)
    const prompt = pane.getByRole('textbox', { name: 'Prompt' })

    // A drag in the reply: Add to prompt stands above the words, inside the transcript.
    await centre(page, FIRST, 'The first is smaller')
    await select(page, FIRST, 'The first is smaller', 'one source of truth.')
    await expect(addButton(page)).toBeVisible()
    await expect(addButton(page)).toHaveAttribute('aria-keyshortcuts', process.platform === 'darwin' ? 'Meta+Shift+A' : 'Control+Shift+A')
    const above = await placement(page)
    expect(above.button.bottom, JSON.stringify(above)).toBeLessThanOrEqual(above.selection.top)
    expect(above.selection.top - above.button.bottom, JSON.stringify(above)).toBeLessThan(24)
    expectInside(above, 'above')

    // Escape puts it away and ends the selection.
    await page.keyboard.press('Escape')
    await expect(addButton(page)).toHaveCount(0)
    expect(await page.evaluate(() => document.getSelection()!.isCollapsed)).toBe(true)

    // A selection that runs into the next reply, or that is the user's own words, offers nothing.
    await drag(page, await wordsBox(page, FIRST, 'one source of truth.'), await wordsBox(page, SECOND, 'Dictation writes'))
    await page.waitForTimeout(150)
    await expect(addButton(page)).toHaveCount(0)
    await select(page, `${THREAD}-quote-2`, 'Does dictation go', 'same path?')
    await page.waitForTimeout(150)
    await expect(addButton(page)).toHaveCount(0)

    // Near the top of the transcript the button goes under the words rather than being cut off.
    await logOf(page).evaluate((log, messageId) => {
      const first = document.querySelector(`.thread-message[data-message-id="${messageId}"] .rich-message p`)!
      log.scrollTop += first.getBoundingClientRect().top - log.getBoundingClientRect().top - 4
      log.dispatchEvent(new Event('scroll'))
    }, FIRST)
    await select(page, FIRST, 'The draft lives', 'thread draft store')
    await expect(addButton(page)).toBeVisible()
    const below = await placement(page)
    expect(below.button.top, JSON.stringify(below)).toBeGreaterThanOrEqual(below.selection.bottom)
    expectInside(below, 'below')
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await page.screenshot({ path: join(evidence, `button-near-top-1280x800-${appearance}.png`), animations: 'disabled' })
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await page.keyboard.press('Escape')

    // The button over a selection at each size, dark and light.
    for (const [width, height] of SIZES) {
      await resize(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await centre(page, FIRST, 'There are two ways')
        await select(page, FIRST, 'Read the saved draft', 'already has it.')
        await expect(addButton(page)).toBeVisible()
        const where = await placement(page)
        expectInside(where, `${width}x${height} ${appearance}`)
        expect(await overflow(page), `${width}x${height} ${appearance}`).toEqual([])
        await page.screenshot({ path: join(evidence, `button-${width}x${height}-${appearance}.png`), animations: 'disabled' })
        await page.keyboard.press('Escape')
      }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resize(launched, 1280, 800)

    // The press: the words go onto the composer as a chip, the selection ends and the caret is in the composer.
    await centre(page, FIRST, 'There are two ways')
    await select(page, FIRST, 'Read the saved draft', 'already has it.')
    await addButton(page).click()
    await expect(addButton(page)).toHaveCount(0)
    await expect(prompt).toBeFocused()
    await expect(chipsOf(page).getByRole('listitem')).toHaveCount(1)
    await expect(chipsOf(page).locator('.review-chip__label')).toHaveText(['“Read the saved draft synchronously when…”'])

    // The chord adds a second.
    await centre(page, FIRST, 'The first is smaller')
    await select(page, FIRST, 'The first is smaller', 'one source of truth.')
    await expect(addButton(page)).toBeVisible()
    await page.keyboard.press(CHORD)
    await expect(chipsOf(page).getByRole('listitem')).toHaveCount(2)
    await expect(prompt).toBeFocused()
    // And a third, to remove.
    await centre(page, SECOND, 'Dictation writes')
    await select(page, SECOND, 'Dictation writes', 'same effect')
    await addButton(page).click()
    await expect(chipsOf(page).getByRole('listitem')).toHaveCount(3)

    for (const [width, height] of SIZES) {
      await resize(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await chipsOf(page).scrollIntoViewIfNeeded()
        expect(await overflow(page), `${width}x${height} ${appearance}`).toEqual([])
        await page.screenshot({ path: join(evidence, `chips-${width}x${height}-${appearance}.png`), animations: 'disabled' })
      }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', reducedMotion: 'on' }))
    await resize(launched, 1280, 800)
    await centre(page, FIRST, 'There are two ways')
    await select(page, FIRST, 'Read the saved draft', 'already has it.')
    await expect(addButton(page)).toBeVisible()
    expect(await pane.locator('.reply-quote-pop').evaluate(element => element.getAnimations().length)).toBe(0)
    await page.screenshot({ path: join(evidence, 'button-and-chips-1280x800-dark-reduced-motion.png') })
    await page.keyboard.press('Escape')
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))

    // Remove quote takes the third off, and focus moves to the chip before it.
    await chipsOf(page).getByRole('button', { name: 'Remove quote' }).nth(2).click()
    await expect(chipsOf(page).getByRole('listitem')).toHaveCount(2)
    await expect(chipsOf(page).getByRole('button', { name: 'Remove quote' }).nth(1)).toBeFocused()

    await fillPrompt(prompt, 'Do the first one.')
    await prompt.press('Enter')
    const sent = [
      'From your earlier reply:', '> Read the saved draft synchronously when the editor mounts, so the first render already has it.', '',
      'From your earlier reply:', '> The first is smaller and keeps one source of truth.', '',
      'Do the first one.',
    ].join('\n')
    await expect.poll(() => userMessageTexts(page, key(THREAD))).toContain(sent)
    await expect(chipsOf(page)).toHaveCount(0)
    await expectPromptText(prompt, '')
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await page.screenshot({ path: join(evidence, `sent-1280x800-${appearance}.png`), animations: 'disabled' })
    }
    expect(errors).toEqual([])
  } finally { await closeSotto(launched) }
})

test('with the Owl feature off a selection in a reply offers nothing', async () => {
  test.setTimeout(120_000)
  const launched = await launch(false)
  try {
    const page = await prepare(launched)
    await resize(launched, 1280, 800)
    await centre(page, FIRST, 'The first is smaller')
    await select(page, FIRST, 'The first is smaller', 'one source of truth.')
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => document.getSelection()!.toString())).toContain('The first is smaller')
    await expect(addButton(page)).toHaveCount(0)
    await page.keyboard.press(CHORD)
    await expect(chipsOf(page)).toHaveCount(0)
  } finally { await closeSotto(launched) }
})
