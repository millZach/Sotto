import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { hostKeysPerTest } from './support/hostKeys'
import { longHistory } from './support/longHistory'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'
import { READING_BACK_PX } from '../../src/renderer/src/agents/slimComposer'
import { COMPOSER_STYLES, type ComposerStyle } from '../../src/shared/composerStyle'

// The slim composer (ADR-0125; Owl only, the user's pick B of docs/prototypes/composer-shrink-prototype.html): reading
// back through a thread steps the floating composer down to one line with its disc, and the end, a click, a key typed
// into the transcript or a draft bring it back full. The transcript keeps the full composer's room the whole time.
// Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/composer-shrink.

const evidence = evidenceDirectory('artifacts/composer-shrink')
const hostKeys = hostKeysPerTest()
const key = hostKeys.key
test.beforeEach(() => { hostKeys.reset() })

async function launch(enabled: boolean): Promise<LaunchedSotto> {
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = `composer-shrink=${enabled ? 1 : 0}`
  try { return await launchSotto('design-threads') } finally { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous }
}

async function prepare(launched: LaunchedSotto, reducedMotion: 'system' | 'on' = 'system', composerStyle: ComposerStyle = 'rows'): Promise<void> {
  const { page } = launched
  await page.evaluate(async ({ reducedMotion, composerStyle }) => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'blue', reducedMotion, composerStyle })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  }, { reducedMotion, composerStyle })
  await page.reload()
  await hostKeys.read(page)
  await openThreads(page)
}

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

async function selectThread(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: title, exact: true }).click({ position: { x: 16, y: 12 } })
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

/** A thread long enough to read back through. */
async function history(page: Page, threadId: string): Promise<void> {
  await longHistory(page, threadId, `${threadId}-slim`)
}

const paneOf = (page: Page, threadId: string): Locator => page.locator(`section.thread-pane[data-thread-id="${key(threadId)}"]`)

/** Scrolls the transcript to `fromEnd` pixels above its end, as a reader's wheel would, and lets the pane hear of it. */
async function readBack(pane: Locator, fromEnd: number): Promise<void> {
  await pane.locator('[aria-label="Thread transcript"]').evaluate((log, fromEnd) => {
    log.scrollTop = log.scrollHeight - log.clientHeight - fromEnd
    log.dispatchEvent(new Event('scroll'))
  }, fromEnd)
}

interface Shape {
  slim: boolean; card: number; compose: number; log: number; editorLines: number; discBeside: boolean; optionsShown: boolean; metaShown: boolean
  toolbarShown: boolean; jumpGap: number | null; edge: string
}

async function shape(pane: Locator): Promise<Shape> {
  return pane.evaluate(element => {
    const compose = element.querySelector<HTMLElement>(':scope > .thread-workspace__compose')!
    const card = compose.querySelector<HTMLElement>(':scope > .thread-prompt')!
    const editor = card.querySelector<HTMLElement>('.prompt-editor')!
    const disc = card.querySelector<HTMLElement>('.thread-prompt__actions > button:not(.thread-prompt__steer)')!
    const shown = (node: Element | null): boolean => node !== null && node.getBoundingClientRect().height > 0 && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden'
    const editorBox = editor.getBoundingClientRect(), discBox = disc.getBoundingClientRect(), cardBox = card.getBoundingClientRect()
    const jump = element.querySelector('.thread-transcript__jump')
    return {
      slim: compose.hasAttribute('data-slim'), card: Math.round(cardBox.height), compose: compose.offsetHeight,
      log: element.querySelector<HTMLElement>('[aria-label="Thread transcript"]')!.clientHeight,
      editorLines: Math.round(editorBox.height / parseFloat(getComputedStyle(editor).lineHeight)),
      discBeside: Math.abs((discBox.top + discBox.bottom) / 2 - (editorBox.top + editorBox.bottom) / 2) < 6 && discBox.left >= editorBox.left,
      optionsShown: shown(card.querySelector('.thread-prompt__meta')), metaShown: shown(compose.querySelector(':scope > .thread-pane__meta')),
      toolbarShown: shown(compose.querySelector(':scope > .branch-toolbar')),
      jumpGap: jump === null ? null : Math.round(cardBox.top - jump.getBoundingClientRect().bottom), edge: getComputedStyle(card).borderTopColor,
    }
  })
}

/** Dark and light at a laptop's size and at the window's minimum, read back `fromEnd` pixels from the end. */
/** Waits for the card to finish moving between slim and full. */
async function settled(pane: Locator): Promise<void> {
  await expect.poll(() => pane.evaluate(element => element.querySelector('.thread-prompt')!.getAnimations()
    .every(motion => motion instanceof CSSAnimation || motion instanceof CSSTransition || motion.playState !== 'running'))).toBe(true)
}

/** The words in the pane's live regions, which slimming must leave as they were: nothing is announced. */
async function liveWords(pane: Locator): Promise<string[]> {
  return pane.locator('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]').allTextContents()
}

async function capture(launched: LaunchedSotto, name: string, pane: Locator, fromEnd: number): Promise<void> {
  const compose = pane.locator(':scope > .thread-workspace__compose')
  for (const [width, height] of [[1280, 860], [820, 560]] as const) {
    await resize(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await launched.page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
      await readBack(pane, fromEnd)
      if (fromEnd > READING_BACK_PX) await expect(compose).toHaveAttribute('data-slim', 'true')
      else await expect(compose).not.toHaveAttribute('data-slim')
      await settled(pane)
      if (fromEnd > READING_BACK_PX) {
        const slim = await shape(pane)
        expect(slim.editorLines, `${width}x${height} ${appearance} ${JSON.stringify(slim)}`).toBe(1)
        expect(slim.card, `${width}x${height} ${appearance} ${JSON.stringify(slim)}`).toBeLessThanOrEqual(44)
        expect(slim.discBeside, `${width}x${height} ${appearance} ${JSON.stringify(slim)}`).toBe(true)
      }
      expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `nothing spills sideways at ${width}x${height}`).toBe(true)
      await launched.page.screenshot({ path: join(evidence, `${name}-${width}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await launched.page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
}

// Both of the composer's styles (ADR-0168): Zach's two rows, the default, and Drake's pill.
for (const style of COMPOSER_STYLES) test(`reading back slims ${style === 'rows' ? 'Zach’s' : 'Drake’s'} composer to one line, and the end, a click, typing and a draft bring it back full`, async () => {
  test.setTimeout(180_000)
  const launched = await launch(true)
  const { page } = launched
  try {
    await prepare(launched, 'system', style)
    await resize(launched, 1280, 860)
    await selectThread(page, 'Grok voice previews')
    await history(page, 'grok-previews')
    await expect(page.locator('[data-message-id="grok-previews-slim-15"]')).toBeVisible()
    const pane = paneOf(page, 'grok-previews')
    const compose = pane.locator(':scope > .thread-workspace__compose')
    const textbox = pane.getByRole('textbox', { name: 'Prompt' })
    const log = pane.locator('[aria-label="Thread transcript"]')

    // At the end, full.
    await readBack(pane, 0)
    await expect(compose).not.toHaveAttribute('data-slim')
    const full = await shape(pane)
    expect(full.optionsShown, JSON.stringify(full)).toBe(true)

    const announced = await liveWords(pane)
    // A pixel or two short of the end is still the end.
    await readBack(pane, 2)
    await expect(compose).not.toHaveAttribute('data-slim')

    // Reading back: one line with its disc beside it; the options row, the toolbar and the row under the card step away.
    // The composer keeps the full card's room, so the transcript neither moves nor changes size.
    await compose.evaluate(element => {
      const flips = { count: 0 }
      ;(window as unknown as { slimFlips: typeof flips }).slimFlips = flips
      new MutationObserver(records => { flips.count += records.length }).observe(element, { attributes: true, attributeFilter: ['data-slim'] })
    })
    await readBack(pane, 420)
    await expect(compose).toHaveAttribute('data-slim', 'true')
    await settled(pane)
    await page.waitForTimeout(400)
    // It changes once, and stays: the transcript keeps its size, so slimming never moves the reader back across the line.
    expect(await page.evaluate(() => (window as unknown as { slimFlips: { count: number } }).slimFlips.count)).toBe(1)
    const slim = await shape(pane)
    const context = JSON.stringify({ full, slim })
    expect(slim.editorLines, context).toBe(1)
    // Zach's two rows step down to one; Drake's pill is one line already, and only its options step away.
    if (style === 'rows') expect(slim.card, context).toBeLessThan(full.card - 30)
    else expect(slim.card, context).toBeLessThanOrEqual(full.card)
    expect(slim.discBeside, context).toBe(true)
    expect(slim.optionsShown || slim.metaShown || slim.toolbarShown, context).toBe(false)
    expect(slim.compose, context).toBe(full.compose)
    expect(slim.log, context).toBe(full.log)
    // Jump to latest sits just above the slim card, not above the room it keeps.
    expect(slim.jumpGap, context).toBeGreaterThanOrEqual(4)
    expect(slim.jumpGap, context).toBeLessThanOrEqual(30)
    // Names stay; nothing is announced.
    await expect(textbox).toBeVisible()
    await expect(pane.getByRole('button', { name: 'Send prompt' }).or(pane.getByRole('button', { name: /^Stop/ })).first()).toBeVisible()
    expect(await liveWords(pane), 'what the composer announces').toEqual(announced)

    // Back near the end: full again.
    await readBack(pane, 2)
    await expect(compose).not.toHaveAttribute('data-slim')

    // The caret resting in the empty prompt, as it is after a send or on opening a thread, does not hold the composer
    // full: reading back slims it all the same, and the caret stays.
    await textbox.focus()
    await readBack(pane, 420)
    await expect(compose).toHaveAttribute('data-slim', 'true')
    await expect(textbox).toBeFocused()
    await readBack(pane, 2)
    await expect(compose).not.toHaveAttribute('data-slim')
    await log.focus()

    // Every scroll away from the end slims the empty composer, by a real wheel notch, time after time, with the caret in
    // the prompt or not, and after a press on the card brought it back full (Zach's report on October 31, 2026).
    const box = (await log.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
    for (let round = 0; round < 5; round++) {
      await readBack(pane, 0)
      await expect(compose, `full at the end, round ${round}`).not.toHaveAttribute('data-slim')
      if (round % 2 === 0) await textbox.focus()
      await page.mouse.wheel(0, -120)
      await expect(compose, `slim after one notch, round ${round}`).toHaveAttribute('data-slim', 'true')
      await settled(pane)
    }
    for (let round = 0; round < 3; round++) {
      await compose.locator(':scope > .thread-prompt').click({ position: { x: 6, y: 6 } })
      await expect(compose).not.toHaveAttribute('data-slim')
      await expect(textbox).toBeFocused()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
      await page.mouse.wheel(0, -120)
      await expect(compose, `slim again after a press on the card, round ${round}`).toHaveAttribute('data-slim', 'true')
      await settled(pane)
    }
    await log.focus()

    // A click on the slim card puts the caret in it, and it comes back full.
    await readBack(pane, 420)
    await expect(compose).toHaveAttribute('data-slim', 'true')
    const card = compose.locator(':scope > .thread-prompt')
    await card.click({ position: { x: 6, y: 6 } })
    await expect(compose).not.toHaveAttribute('data-slim')
    await expect(textbox).toBeFocused()
    // No focus edge (ADR-0110, amended October 23, 2026): the card's border stays clear while the caret is in it.
    expect((await shape(pane)).edge).toBe('rgba(0, 0, 0, 0)')

    // Leaving the composer while still reading back slims it again.
    await log.focus()
    await expect(compose).toHaveAttribute('data-slim', 'true')

    // Tab from Jump to latest, the last stop in the transcript, reaches the composer, which comes back full.
    await pane.getByRole('button', { name: 'Jump to latest' }).focus()
    await expect(compose).toHaveAttribute('data-slim', 'true')
    await page.keyboard.press('Tab')
    expect(await compose.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await expect(compose).not.toHaveAttribute('data-slim')
    // The composer's controls keep their focus rings from the keyboard.
    for (let step = 0; step < 8 && !(await pane.evaluate(() => document.activeElement?.matches('button') ?? false)); step++) await page.keyboard.press('Tab')
    expect(await pane.evaluate(() => { const style = getComputedStyle(document.activeElement!); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== 'none' })).toBe(true)
    await log.focus()
    await expect(compose).toHaveAttribute('data-slim', 'true')

    // A key typed in the transcript is the start of a message: the composer takes it, comes back full and keeps it.
    await page.keyboard.press('h')
    await expect(textbox).toBeFocused()
    await expect(compose).not.toHaveAttribute('data-slim')
    await page.keyboard.type('ow loud is the preview?')
    await expect(textbox).toHaveText('how loud is the preview?')
    // A draft keeps it full while reading back.
    await log.focus()
    await readBack(pane, 420)
    await page.waitForTimeout(100)
    await expect(compose).not.toHaveAttribute('data-slim')
    // Empty again, it slims.
    await textbox.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
    await log.focus()
    await expect(compose).toHaveAttribute('data-slim', 'true')

    // The disc is pressed where it stands; the press does not bring the composer back full under the pointer.
    await pane.locator('.thread-prompt__actions > button').last().dispatchEvent('mousedown')
    await expect(compose).toHaveAttribute('data-slim', 'true')

    // The height change is a short animation of the card.
    await readBack(pane, 0)
    await expect(compose).not.toHaveAttribute('data-slim')
    const moving = await pane.evaluate(element => {
      const log = element.querySelector<HTMLElement>('[aria-label="Thread transcript"]')!
      log.scrollTop = 0
      log.dispatchEvent(new Event('scroll'))
      return new Promise<number>(done => requestAnimationFrame(() => done(element.querySelector('.thread-prompt')!.getAnimations().filter(motion => !(motion instanceof CSSAnimation) && !(motion instanceof CSSTransition)).length)))
    })
    expect(moving).toBe(1)

    const name = style === 'rows' ? 'thread' : 'thread-pill'
    await capture(launched, `${name}-full`, pane, 0)
    await capture(launched, `${name}-slim`, pane, 420)
  } finally { await closeSotto(launched) }
})

test('with motion reduced the composer slims at once, and while a question waits it never slims', async () => {
  test.setTimeout(120_000)
  const launched = await launch(true)
  const { page } = launched
  try {
    await prepare(launched, 'on')
    await resize(launched, 1280, 860)
    await selectThread(page, 'Grok voice previews')
    await history(page, 'grok-previews')
    const pane = paneOf(page, 'grok-previews')
    const compose = pane.locator(':scope > .thread-workspace__compose')
    await expect(page.locator('[data-message-id="grok-previews-slim-15"]')).toBeVisible()
    const animations = await pane.evaluate(element => {
      const log = element.querySelector<HTMLElement>('[aria-label="Thread transcript"]')!
      log.scrollTop = 0
      log.dispatchEvent(new Event('scroll'))
      return new Promise<number>(done => requestAnimationFrame(() => done(element.querySelector('.thread-prompt')!.getAnimations().filter(motion => !(motion instanceof CSSAnimation) && !(motion instanceof CSSTransition)).length)))
    })
    await expect(compose).toHaveAttribute('data-slim', 'true')
    expect(animations).toBe(0)

    await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'question', threadId, text: 'Choose the next step.', status: 'running', request: {
      id: 'slim-question', kind: 'question', text: 'Choose the next step.', options: [], questions: [{ id: 'next', question: 'Choose the next step.', multiSelect: false, allowFreeText: true,
        options: [{ id: 'review', label: 'Review the links' }, { id: 'edit', label: 'Edit the footer' }] }] } }), 'grok-previews')
    await expect(pane.locator('.thread-questions .agent-request')).toBeVisible()
    await expect(compose).not.toHaveAttribute('data-slim')
  } finally { await closeSotto(launched) }
})

test('with the Owl feature off the composer keeps its full size and a key in the transcript stays there', async () => {
  test.setTimeout(120_000)
  const launched = await launch(false)
  const { page } = launched
  try {
    await prepare(launched)
    await resize(launched, 1280, 860)
    await selectThread(page, 'Grok voice previews')
    await history(page, 'grok-previews')
    const pane = paneOf(page, 'grok-previews')
    const compose = pane.locator(':scope > .thread-workspace__compose')
    await expect(page.locator('[data-message-id="grok-previews-slim-15"]')).toBeVisible()
    await readBack(pane, 420)
    await page.waitForTimeout(300)
    await expect(compose).not.toHaveAttribute('data-slim')
    const log = pane.locator('[aria-label="Thread transcript"]')
    await log.focus()
    await page.keyboard.press('h')
    await expect(log).toBeFocused()
  } finally { await closeSotto(launched) }
})
