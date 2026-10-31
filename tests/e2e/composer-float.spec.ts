import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AgentRequest } from '../../src/shared/agents'
import { hostKeysPerTest } from './support/hostKeys'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

// #1391's composer floats over the transcript's foot. Its first rule nested one :has() in another, which is not valid CSS,
// so the browser dropped it and nothing floated while every layout assertion still held. These journeys measure the float
// itself in the built app: its scroll box stays put and its words run on under the composer, and its padding brings the
// last line clear of the composer and Jump to latest.

const evidence = evidenceDirectory('artifacts/composer-float')
const hostKeys = hostKeysPerTest()
const key = hostKeys.key
test.beforeEach(() => { hostKeys.reset() })

const permission: AgentRequest = {
  id: 'float-permission', kind: 'permission', text: 'Run the settings tests', options: [],
  context: { toolName: 'Bash', toolCallId: 'tool-float', command: 'npm run test -- tests/unit/settings', cwd: 'C:\\work\\sotto' },
  permissionChoices: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }, { id: 'reject', label: 'Deny', kind: 'deny' }],
}
const question: AgentRequest = {
  id: 'float-question', kind: 'question', text: 'Choose the next step.', options: [], questions: [{
    id: 'next', question: 'Choose the next step.', multiSelect: false, allowFreeText: true,
    options: [{ id: 'review', label: 'Review the links' }, { id: 'edit', label: 'Edit the footer' }],
  }],
}

async function prepare(launched: LaunchedSotto): Promise<void> {
  const { page } = launched
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'blue' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
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

async function emit(page: Page, threadId: string, request: AgentRequest): Promise<void> {
  await page.evaluate(async ([threadId, request]) => window.sottoE2E!.agentEvent!({ type: request.kind, threadId, text: request.text, request, status: 'running' }), [threadId, request] as const)
}

async function selectThread(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: title, exact: true }).click({ position: { x: 16, y: 12 } })
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

/** Enough history that the transcript runs well past its pane, so there is text for the composer to float over. */
async function history(page: Page, threadId: string): Promise<void> {
  await page.evaluate(async threadId => {
    await window.sottoE2E!.agentEvent!({ type: 'history', threadId, text: '', messages: Array.from({ length: 12 }, (_, index) => ({
      id: `${threadId}-float-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
      text: index % 2
        ? `Reply ${(index + 1) / 2}. The preview plays a two-second sample through the selected voice, and the key stays in the system keychain rather than settings.json. Nothing else in the window changed.`
        : `Question ${index / 2 + 1}: can the preview button sit beside each voice, and can the key move into the keychain?`,
      createdAt: new Date(Date.UTC(2026, 9, 23, 9, index * 3)).toISOString() })) })
  }, threadId)
}

const paneOf = (page: Page, threadId: string): Locator => page.locator(`section.thread-pane[data-thread-id="${key(threadId)}"]`)

interface Float { hit?: string | null; composeHeight: number; marginTop: number; overlap: number; logPadding: number; underStrip: boolean; lastClear: boolean; clipped: boolean; scrollbarClear: boolean }

/** How far the composer sits over the transcript, read after the transcript is scrolled to its end. */
async function float(pane: Locator): Promise<Float> {
  return pane.evaluate(async element => {
    const compose = element.querySelector<HTMLElement>(':scope > .thread-workspace__compose')!
    const log = element.querySelector<HTMLElement>('[aria-label="Thread transcript"]')!
    log.scrollTop = log.scrollHeight
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const composeBox = compose.getBoundingClientRect(), logBox = log.getBoundingClientRect()
    // The strip beside the card lets presses through to the transcript running under it. The right of the card, since
    // the message scrubber keeps the left margin.
    const card = compose.querySelector('.thread-prompt')!.getBoundingClientRect()
    const strip = document.elementFromPoint((card.right + composeBox.right) / 2, card.top + 10)
    const content = log.querySelector('.thread-transcript__content')!.getBoundingClientRect()
    const scrollbar = document.elementFromPoint(logBox.right - 1, logBox.bottom - 2)
    const last = [...log.querySelectorAll('.thread-transcript__content > *')].at(-1)?.getBoundingClientRect()
    return {
      composeHeight: compose.offsetHeight, marginTop: parseFloat(getComputedStyle(compose).marginTop),
      overlap: logBox.bottom - composeBox.top, logPadding: parseFloat(getComputedStyle(log).paddingBottom),
      underStrip: strip !== null && log.contains(strip), hit: strip ? `${strip.tagName}.${strip.className}` : null,
      lastClear: (last ?? content).bottom <= composeBox.top + 1,
      clipped: getComputedStyle(log.parentElement!).clipPath !== 'none',
      scrollbarClear: scrollbar !== null && log.contains(scrollbar),
    }
  })
}

function expectFloating(layout: Float): void {
  const context = JSON.stringify(layout)
  expect(layout.composeHeight, context).toBeGreaterThan(40)
  expect(layout.marginTop, context).toBeCloseTo(-layout.composeHeight, 0)
  expect(layout.overlap, context).toBeGreaterThanOrEqual(layout.composeHeight - 1)
  expect(layout.logPadding, context).toBeGreaterThanOrEqual(layout.composeHeight)
  expect(layout.underStrip, context).toBe(true)
  // Nothing cuts the words off at the composer's top: they scroll on under it (#1391).
  expect(layout.clipped, context).toBe(false)
  expect(layout.scrollbarClear, context).toBe(true)
  expect(layout.lastClear, context).toBe(true)
}

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  for (const [width, height] of [[1280, 860], [820, 560]] as const) {
    await resize(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await launched.page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
      await launched.page.evaluate(() => document.querySelectorAll<HTMLElement>('[aria-label="Thread transcript"]').forEach(log => { log.scrollTop = log.scrollHeight - log.clientHeight - 220 }))
      await launched.page.screenshot({ path: join(evidence, `${name}-${width}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await launched.page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
}

test('a thread composer floats over its transcript, alone, side by side and in a short pane, and stacks while a question waits', async () => {
  test.setTimeout(180_000)
  const launched = await launchSotto('design-threads')
  const { page } = launched
  try {
    await prepare(launched)
    await resize(launched, 1280, 860)
    await selectThread(page, 'Grok voice previews')
    for (const id of ['grok-previews', 'footer-links', 'weekly-note']) await history(page, id)
    await expect(page.locator('[data-message-id="grok-previews-float-11"]')).toBeVisible()
    const single = paneOf(page, 'grok-previews')
    expectFloating(await float(single))
    await resize(launched, 820, 560)
    expectFloating(await float(single))
    await capture(launched, 'single')

    // Side by side at a laptop's height, each pane is short and its composer still floats.
    await resize(launched, 1280, 620)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    for (const title of ['Footer links', 'Weekly note']) {
      await sidebar.getByRole('button', { name: title, exact: true }).hover({ position: { x: 16, y: 12 } })
      await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click()
    }
    await expect(page.locator('section.thread-pane[role="region"]:not([data-hidden])')).toHaveCount(3)
    for (const id of ['footer-links', 'weekly-note']) await expect(page.locator(`[data-message-id="${id}-float-11"]`)).toHaveCount(1)
    for (const id of ['grok-previews', 'footer-links', 'weekly-note']) expectFloating(await float(paneOf(page, id)))

    // A permission card lives in the transcript, so the composer keeps floating and the card's choices come clear of it.
    const footer = paneOf(page, 'footer-links')
    await emit(page, 'footer-links', permission)
    const approval = footer.locator('.thread-transcript .agent-request[data-kind="permission"]')
    await expect(approval).toBeVisible()
    expectFloating(await float(footer))
    const deny = approval.getByRole('button', { name: 'Deny', exact: true })
    await deny.focus()
    await expect.poll(() => deny.evaluate(element => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    })).toBe(true)
    await page.screenshot({ path: join(evidence, 'split-permission-1280x620-dark.png'), animations: 'disabled' })
    // Jump to latest rides above the floating composer; reading back through the card, it never sits over it.
    const covered = await footer.evaluate(async element => {
      const log = element.querySelector<HTMLElement>('[aria-label="Thread transcript"]')!
      const frame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const hits: number[] = [], obscured: number[] = []
      let shown = 0
      for (let top = log.scrollHeight - log.clientHeight; top >= 0; top -= 16) {
        log.scrollTop = top
        log.dispatchEvent(new Event('scroll'))
        await frame()
        const jump = element.querySelector('.thread-transcript__jump')?.getBoundingClientRect()
        if (!jump) continue
        shown++
        const edge = log.getBoundingClientRect().bottom - parseFloat(getComputedStyle(log).scrollPaddingBottom)
        if (edge > jump.top - 13) obscured.push(top)
        const card = log.querySelector('.agent-request')!.getBoundingClientRect()
        if (jump.bottom > card.top && jump.top < card.bottom && jump.right > card.left && jump.left < card.right) hits.push(top)
      }
      return { hits, obscured, shown }
    })
    expect(covered.shown, JSON.stringify(covered)).toBeGreaterThan(0)
    expect(covered.hits, JSON.stringify(covered)).toEqual([])
    expect(covered.obscured, JSON.stringify(covered)).toEqual([])

    // A waiting question goes above the message bar, and the composer stacks under the transcript again.
    await emit(page, 'weekly-note', question)
    const weekly = paneOf(page, 'weekly-note')
    await expect(weekly.locator('.thread-questions .agent-request')).toBeVisible()
    const stacked = await weekly.evaluate(element => {
      const compose = element.querySelector<HTMLElement>(':scope > .thread-workspace__compose')!
      const transcript = element.querySelector<HTMLElement>(':scope > .thread-transcript')
      const log = element.querySelector<HTMLElement>('[aria-label="Thread transcript"]')!
      const card = compose.querySelector('.thread-questions')!.getBoundingClientRect()
      return {
        marginTop: parseFloat(getComputedStyle(compose).marginTop), transcriptBottom: transcript?.getBoundingClientRect().bottom ?? null, composeTop: compose.getBoundingClientRect().top,
        overlap: log.getBoundingClientRect().bottom - compose.getBoundingClientRect().top,
        cover: parseFloat(getComputedStyle(log).getPropertyValue('--thread-compose-cover')),
        corners: [card.left + 1, card.right - 1].map(x => log.contains(document.elementFromPoint(x, card.top + 1))),
      }
    })
    expect(stacked.marginTop, JSON.stringify(stacked)).toBe(0)
    if (stacked.transcriptBottom !== null) expect(stacked.transcriptBottom, JSON.stringify(stacked)).toBeLessThanOrEqual(stacked.composeTop + 1)
    expect(stacked.overlap, JSON.stringify(stacked)).toBeCloseTo(26, 0)
    expect(stacked.cover, JSON.stringify(stacked)).toBe(0)
    expect(stacked.corners, JSON.stringify(stacked)).toEqual([true, true])
    expectFloating(await float(footer))
  } finally { await closeSotto(launched) }
})
