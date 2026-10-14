import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { hostEntityKey } from '../../src/shared/clientIdentity'
import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../src/renderer/src/e2e/watcherStandIn'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { holdOwlSky } from './support/sottoOwl'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Watcher's room on the built app (ADR-0073, tickets 6 and 7's beside pane), with no sidebar as Zach picked on
 * October 11, 2026: the first entry by sending, the needs-you line, the Overview over the room on All threads, a thread
 * opened beside Watcher, the floating switch and the badges, on the Sotto Owl track, with stable showing none of it.
 * Main's Watcher side is stood in for by a seeded projection (src/renderer/src/e2e/watcherStandIn.ts), so these runs
 * check the room on a fixed picture, except one journey that seeds nothing and runs against main's own Watcher over
 * the fake Codex app server. Run after `npm run build`. Captures go to disposable run evidence;
 * `SOTTO_E2E_EVIDENCE=publish` writes artifacts/watcher-room.
 */
const evidenceRoot = evidenceDirectory('artifacts/watcher-room')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const THEMES = [['t3-code', 'sotto'], ['tropic', 'tropic']] as const
const BLACK = { r: 0, g: 0, b: 0 }
const CURRENT = 'release-notes'
const WATCHED = ['visual-gate', 'footer-links'] as const
const recorded = new Map<string, unknown>()

const at = (minutes: number): string => new Date(E2E_THREADS_NOW - minutes * 60_000).toISOString()

function launchOptions(theme: string, appearance: 'dark' | 'light', motion: 'normal' | 'reduced' = 'normal') {
  return {
    onboardingComplete: true, appearance, motion, scenario: 'design-threads', agents: 'design-threads',
    ...(appearance === 'dark' ? { darkTheme: theme } : { lightTheme: theme }),
  } as const
}

/**
 * Seeds Watcher's projection and reloads: `release-notes` stands for the current Watcher (its history replaced by a
 * Watcher conversation), Watcher started and watches Visual gate flake and Footer links, and two threads are in flight.
 * With `current: false`, the room opens on its first entry and `open` names that same thread as the one created.
 */
async function seedRoom(page: Page, options: { readonly current: boolean; readonly history?: boolean }): Promise<void> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  expect(hostId, 'the window names its host').toBeTruthy()
  const target = (threadId: string) => ({ hostId: hostId!, threadId })
  const requestId = randomUUID()
  const identity = { target: target(CURRENT), projectId: 'workshop', provider: 'codex' as const, creationOperationId: randomUUID(), createdAt: at(12) }
  const participants = WATCHED.map(threadId => ({ requestId, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target(threadId), promptCount: 1 }))
  const seed: WatcherStandInSeed = {
    state: {
      current: options.current ? identity : null,
      currentOptions: options.current ? { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true } : null,
      history: [],
      requests: options.current ? [{ id: requestId, watcher: identity.target, rootUserMessageId: 'watcher-ask', state: 'active', createdAt: at(12), closedAt: null, participants }] : [],
      watchedThreads: options.current ? participants.map(part => ({ target: part.target, title: part.target.threadId, status: 'running' as const, connected: true,
        settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [part] })) : [],
      inFlight: options.current ? 2 : 0, inFlightLimit: 4, receipts: [], recoveryNotice: null, observedAt: at(0),
    },
    created: identity,
  }
  await page.evaluate(async ({ key, seed, master, history }) => {
    localStorage.setItem(key, JSON.stringify(seed))
    if (history) await window.sottoE2E!.agentEvent!({ type: 'history', threadId: master, text: '', messages: [
      { id: 'watcher-ask', role: 'user', text: 'Find why the visual gate flakes and fix the footer links. Keep an eye on both.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 29)).toISOString() },
      { id: 'watcher-reply', role: 'assistant', text: 'Started Visual gate flake on Claude Code and Footer links on Codex, and I am watching both. Visual gate flake is asking to run the unit suite. Only you can allow that, in its own pane.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 33)).toISOString() },
    ] })
  }, { key: WATCHER_STAND_IN_KEY, seed, master: CURRENT, history: options.history !== false })
  await page.reload()
  await openThreads(page)
}

const switchTab = (page: Page, name: 'Dictate' | 'Watcher' | 'Threads') => page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name, exact: true })
const watcherPane = (page: Page) => page.getByRole('region', { name: 'Watcher', exact: true })
const beside = (page: Page) => page.locator('#watcher-beside-pane')
const allThreads = (page: Page) => page.getByRole('button', { name: /^All threads, \d+\. Show the list$/ })
const threadsList = (page: Page) => page.getByRole('dialog', { name: 'All threads' })

async function openRoom(page: Page): Promise<void> {
  await switchTab(page, 'Watcher').click()
  await expect(page.locator('.watcher-dock')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

/** The name of what has focus: its accessible label, title or text. */
const focusedName = (page: Page): Promise<string> => page.evaluate(() => {
  const element = document.activeElement as HTMLElement
  return element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim().slice(0, 40) ?? element.tagName
})

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox()
  expect(found, 'the element is on screen').not.toBeNull()
  return found!
}
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** The floating switch never covers a composer, and the window controls never cover a pane header's controls. */
async function roomEdges(page: Page, width: number, height: number): Promise<void> {
  const pill = await box(page.locator('.watcher-dock__pill'))
  expect(pill.y + pill.height, `the floating switch at ${width}x${height}`).toBeLessThanOrEqual(height)
  const controls = await box(page.locator('.threads-view__winctl'))
  for (const composer of await page.locator('.thread-workspace__compose .thread-prompt').all()) {
    expect(overlaps(await box(composer), pill), `a composer under the floating switch at ${width}x${height}`).toBe(false)
  }
  for (const control of await page.locator('.thread-workspace__head :is(button, [role="meter"])').all()) {
    if (!await control.isVisible()) continue
    const name = await control.getAttribute('aria-label') ?? 'control'
    expect(overlaps(await box(control), controls), `${name} under the window controls at ${width}x${height}`).toBe(false)
  }
}

/** Every piece of text the room draws in colour, measured against the surface it actually sits on. */
async function roomContrast(page: Page): Promise<Array<{ name: string; ratio: number }>> {
  const pairs = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const hex = (value: string): string => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = 'rgba(0, 0, 0, 0)'; context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      return `#${[...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    }
    const token = (holder: Element, name: string): string => {
      const probe = document.createElement('i')
      probe.style.cssText = `position:absolute;width:1px;height:1px;background:var(${name})`
      holder.append(probe)
      const value = getComputedStyle(probe).backgroundColor
      probe.remove()
      return hex(value)
    }
    const background = (element: Element): string => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return hex(color)
      }
      return hex(getComputedStyle(document.body).backgroundColor)
    }
    // The night in the room's corner sits between the canvas and the header: text over it is measured against both.
    const sky = document.querySelector('.watcher-room__sky')?.getBoundingClientRect()
    const surfaces = (element: Element): string[] => {
      const under = background(element)
      const bounds = element.getBoundingClientRect()
      const onSky = sky !== undefined && element.closest('.watcher-pane') !== null && bounds.top < sky.bottom && bounds.left < sky.right
      return onSky ? [under, token(element.closest('.watcher-room')!, '--tt-owl-room-night')] : [under]
    }
    const selectors = ['.watcher-head h1', '.watcher-head__list', '.watcher-head__count', '.watcher-meter', '.watcher-glance__lead', '.watcher-glance__name', '.watcher-glance__why',
      '.thread-options__pinned', '.watched-note', '.watcher-dock__switch button', '.watcher-group__label', '.watcher-group__count', '.watcher-row__title', '.watcher-row__status',
      '.watcher-row__where', '.watcher-row__asks > span', '.watcher-answer', '.watcher-list__foot', '.watcher-list .thread-nav__time', '.watcher-first__intro h2', '.watcher-first__intro p',
      '.watcher-beside .thread-workspace__head h2']
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0).slice(0, 6)
      .flatMap((element, index) => surfaces(element).map(on => ({ name: `${selector} ${index}${element.getAttribute('data-tone') ? ` (${element.getAttribute('data-tone')})` : ''}`, ink: hex(getComputedStyle(element).color), on }))))
  })
  return pairs.map(({ name, ink, on }) => ({ name, ratio: Number(contrastRatio(parseThemeRgb(ink, BLACK), parseThemeRgb(on, BLACK)).toFixed(2)) }))
}

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await settle(launched.page)
  await holdOwlSky(launched.page)
  await captureWindow(launched.app, resolve(evidenceRoot, name))
}

test.describe("Watcher's room on the built app", () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })
  test.beforeAll(async () => { await mkdir(evidenceRoot, { recursive: true }) })
  test.afterAll(async () => { await writeFile(resolve(evidenceRoot, 'readings.json'), `${JSON.stringify(Object.fromEntries(recorded), null, 2)}\n`, 'utf8') })

  test('the first message starts Watcher on a chosen model and goes to it', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: false })
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      await expect(page.getByRole('heading', { level: 2, name: 'Start Watcher' })).toBeVisible()
      // No meter or actions before Watcher runs; the needs-you line and All threads already work.
      await expect(page.getByRole('meter', { name: 'Watched threads' })).toHaveCount(0)
      await expect(page.locator('.watcher-glance')).toContainText('2 need you')
      const choice = page.getByRole('group', { name: 'Watcher’s model' })
      await expect(choice.getByRole('combobox', { name: 'Thread model' })).toHaveText(/Sonnet 4\.5/)
      await expect(choice.getByText('Ask before changes')).toBeVisible()
      // Devin is not offered for Watcher.
      await choice.getByRole('combobox', { name: 'Thread model' }).click()
      await expect(page.getByRole('dialog', { name: 'Choose model' }).getByRole('option', { name: /Devin/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      const send = page.getByRole('button', { name: 'Start Watcher and send' })
      await expect(send).toBeDisabled()
      await expect(page.getByText('Your first message starts Watcher on Sonnet 4.5, with your own Claude Code account.')).toBeVisible()
      for (const [width, height] of SIZES) {
        await resizeContentWindow(launched, width, height)
        await settle(page)
        expect(await pageBoundProblems(page), `first entry at ${width}x${height}`).toEqual([])
        await roomEdges(page, width, height)
        await capture(launched, `first-entry-sotto-dark-${width}x${height}.png`)
      }
      await resizeContentWindow(launched, 1280, 800)
      const message = page.getByRole('textbox', { name: 'Watcher message' })
      await message.click()
      await page.keyboard.type('Keep an eye on the footer links until they ship.')
      await expect(send).toBeEnabled()
      await page.keyboard.press('Enter')
      const pane = watcherPane(page)
      await expect(pane.getByRole('meter', { name: 'Watched threads' })).toBeVisible()
      await expect(pane.getByText('Keep an eye on the footer links until they ship.')).toBeVisible()
      await expect(pane.getByRole('textbox', { name: 'Watcher message' })).toBeVisible()
      await expect(pane.getByText('Ask before changes')).toBeVisible()
      await expect(pane.getByRole('combobox', { name: 'Thread permissions' })).toHaveCount(0)
      // Creating Watcher selected nothing on the Threads page.
      expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId)).toBeNull()
    }))
  })

  test('the Overview opens over the room, keeps Tab inside, and Escape returns focus to All threads', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      // No sidebar in Watcher's room.
      await expect(page.locator('.thread-nav')).toHaveCount(0)
      await expect(allThreads(page)).toHaveAccessibleName('All threads, 8. Show the list')
      await allThreads(page).focus()
      await page.keyboard.press('Enter')
      const list = threadsList(page)
      await expect(list).toBeVisible()
      await expect(list.getByRole('searchbox', { name: 'Filter threads' })).toBeFocused()
      expect(await list.locator('.watcher-group__label').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
        .toEqual(['Needs you, 2 threads', 'Working, 2 threads', 'Idle, 4 threads'])
      await expect(list.getByRole('button', { name: /Release notes 1\.4/ })).toHaveCount(0)
      await expect(list.getByRole('button', { name: 'Open Footer links beside Watcher' })).toBeVisible()
      await expect(list.getByRole('button', { name: 'Open Visual gate flake to answer its permission' })).toBeVisible()
      await expect(list.getByRole('button', { name: 'Open Streaming WAV stall at its failed turn' })).toBeVisible()
      expect(await pageBoundProblems(page)).toEqual([])
      await capture(launched, 'list-sotto-dark-1280x800.png')
      // Tab stays inside the list.
      const inside: boolean[] = []
      for (let step = 0; step < 14; step++) {
        await page.keyboard.press('Tab')
        inside.push(await list.evaluate(node => node.contains(document.activeElement)))
      }
      expect(inside.every(Boolean)).toBe(true)
      // Typing narrows the list.
      await list.getByRole('searchbox', { name: 'Filter threads' }).fill('foot')
      await expect(list.getByRole('button', { name: /beside Watcher$/ })).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(list).toHaveCount(0)
      await expect(allThreads(page)).toBeFocused()
      // A press outside closes it too.
      await allThreads(page).click()
      await expect(threadsList(page)).toBeVisible()
      await page.mouse.click(900, 400)
      await expect(threadsList(page)).toHaveCount(0)
      // From the keyboard alone: filter, Tab to the row, Enter opens it beside Watcher at its title.
      await allThreads(page).focus()
      await page.keyboard.press('Enter')
      await page.keyboard.type('weekly')
      await page.keyboard.press('Tab')
      expect(await focusedName(page)).toBe('Open Weekly note beside Watcher')
      await page.keyboard.press('Enter')
      await expect(threadsList(page)).toHaveCount(0)
      await expect(beside(page).getByRole('heading', { level: 2, name: 'Weekly note' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(beside(page)).toHaveCount(0)
      await expect(allThreads(page)).toBeFocused()
      await resizeContentWindow(launched, 820, 560)
      await allThreads(page).click()
      await settle(page)
      expect(await pageBoundProblems(page)).toEqual([])
      const panel = await box(threadsList(page))
      expect(panel.x + panel.width).toBeLessThanOrEqual(820)
      expect(panel.y + panel.height).toBeLessThanOrEqual(560)
      await capture(launched, 'list-sotto-dark-820x560.png')
      await page.keyboard.press('Escape')
    }))
  })

  test('a thread opens beside Watcher at its request, keeps its draft, and Escape closes it back to its opener', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      const pane = watcherPane(page)
      await expect(page.locator('.watcher-glance')).toContainText('2 need you')
      await expect(page.locator('.watcher-glance')).toContainText('permission')
      await expect(page.locator('.watcher-glance')).toContainText('last turn failed')
      // Watcher's draft stays while a thread opens beside it.
      await pane.getByRole('textbox', { name: 'Watcher message' }).click()
      await page.keyboard.type('Draft for Watcher')
      const glanceName = page.getByRole('button', { name: 'Open Visual gate flake to answer its permission' })
      await glanceName.click()
      await expect(beside(page)).toBeVisible()
      await expect(beside(page)).toHaveAttribute('aria-label', 'Visual gate flake')
      await expect(beside(page).locator('.agent-request[data-kind="permission"]')).toBeFocused()
      await expect(beside(page).getByRole('img', { name: 'Watched by Watcher' })).toBeVisible()
      await expect(beside(page).getByText('Watched by Watcher. If you send here, Watcher stops sending to it.')).toBeVisible()
      await expect(pane.getByRole('textbox', { name: 'Watcher message' })).toHaveText('Draft for Watcher')
      for (const [width, height] of SIZES) {
        await resizeContentWindow(launched, width, height)
        await settle(page)
        expect(await pageBoundProblems(page), `beside at ${width}x${height}`).toEqual([])
        await roomEdges(page, width, height)
        // Side by side even at the minimum: each pane keeps its 400 pixels.
        expect((await box(page.locator('.watcher-pane'))).width).toBeGreaterThanOrEqual(400)
        expect((await box(beside(page))).width).toBeGreaterThanOrEqual(400)
        await capture(launched, `beside-sotto-dark-${width}x${height}.png`)
      }
      await resizeContentWindow(launched, 1280, 800)
      await settle(page)
      // The divider answers the keyboard, once it has measured the wider room: until then the minimum size's
      // range still holds and clamps the step.
      const divider = page.getByRole('separator', { name: 'Resize panes' })
      const before = Number(await divider.getAttribute('aria-valuenow'))
      await expect.poll(async () => Number(await divider.getAttribute('aria-valuemax'))).toBeGreaterThanOrEqual(before + 5)
      await divider.focus()
      await page.keyboard.press('ArrowRight')
      await expect(divider).toHaveAttribute('aria-valuenow', String(before + 5))
      await page.keyboard.press('Enter')
      await expect(divider).toHaveAttribute('aria-valuenow', '50')
      // Escape inside the pane closes it, and focus goes back to the name that opened it.
      await beside(page).locator('.agent-request[data-kind="permission"]').focus()
      await page.keyboard.press('Escape')
      await expect(beside(page)).toHaveCount(0)
      await expect(glanceName).toBeFocused()
      // A thread waiting after a failed turn opens at that turn: with no turn record to point at, the end of its
      // transcript, where the failed turn ended, with the transcript focused.
      const failedName = page.getByRole('button', { name: 'Open Streaming WAV stall at its failed turn' })
      await failedName.click()
      await expect(beside(page)).toHaveAttribute('aria-label', 'Streaming WAV stall')
      const failedLog = beside(page).getByRole('log', { name: 'Thread transcript' })
      await expect(failedLog).toBeFocused()
      expect(await failedLog.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1)
      await page.keyboard.press('Escape')
      await expect(beside(page)).toHaveCount(0)
      await expect(failedName).toBeFocused()

      // From the list: the thread opens at its title; its draft is its own and survives closing.
      await allThreads(page).click()
      await threadsList(page).getByRole('button', { name: 'Open Footer links beside Watcher' }).click()
      await expect(threadsList(page)).toHaveCount(0)
      await expect(beside(page)).toHaveAttribute('aria-label', 'Footer links')
      await expect(beside(page).getByRole('heading', { level: 2, name: 'Footer links' })).toBeFocused()
      await beside(page).getByRole('textbox', { name: 'Prompt' }).click()
      await page.keyboard.type('Draft for the footer')
      await beside(page).getByRole('button', { name: 'Close Footer links pane' }).click()
      await expect(beside(page)).toHaveCount(0)
      await expect(allThreads(page)).toBeFocused()
      await allThreads(page).click()
      await threadsList(page).getByRole('button', { name: 'Open Footer links beside Watcher' }).click()
      await expect(beside(page).getByRole('textbox', { name: 'Prompt' })).toHaveText('Draft for the footer')
      await expect(pane.getByRole('textbox', { name: 'Watcher message' })).toHaveText('Draft for Watcher')
      // Opening another replaces it; nothing on the Threads page was selected.
      await allThreads(page).click()
      await threadsList(page).getByRole('button', { name: 'Open Weekly note beside Watcher' }).click()
      await expect(beside(page)).toHaveAttribute('aria-label', 'Weekly note')
      expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId)).toBeNull()
      // The room is as it was left after a trip to another room, Watcher's reading position included, given a
      // conversation long enough to scroll.
      await page.evaluate(async master => {
        await window.sottoE2E!.agentEvent!({ type: 'history', threadId: master, text: '', messages: Array.from({ length: 40 }, (_, index) => ({
          id: `watcher-long-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, text: `Watcher history ${index}`,
          createdAt: new Date(Date.UTC(2026, 6, 12, 18, index)).toISOString() })) })
      }, CURRENT)
      await expect(pane.getByText('Watcher history 39', { exact: true })).toBeVisible()
      const watcherLog = pane.getByRole('log', { name: 'Thread transcript' })
      // The first message reaching the top of the view, and how far below the top it starts in whole pixels (a part of a
      // pixel above it rounds to -0, which is the same place as 0).
      const atTop = () => watcherLog.evaluate(element => {
        const top = element.getBoundingClientRect().top
        const first = [...element.querySelectorAll('[data-message-id]')].find(item => item.getBoundingClientRect().bottom > top)
        return { id: first?.getAttribute('data-message-id') ?? null, offset: first ? Math.round(first.getBoundingClientRect().top - top) || 0 : null }
      })
      await pane.locator('[data-message-id="watcher-long-30"]').evaluate(element => element.scrollIntoView({ block: 'start' }))
      await expect(pane.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
      await expect.poll(atTop).toMatchObject({ id: 'watcher-long-30' })
      const read = await atTop()
      await switchTab(page, 'Threads').click()
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
      await switchTab(page, 'Watcher').click()
      await expect(beside(page)).toHaveAttribute('aria-label', 'Weekly note')
      // The transcript is drawn afresh, with fewer of Watcher's messages in the window than before: the same message is
      // at the top, where it was.
      await expect.poll(atTop).toEqual(read)
      await expect(pane.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
      // Open in Threads takes the thread to the Threads room, selected.
      await beside(page).getByRole('button', { name: 'Open Weekly note in Threads' }).click()
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId)).toMatch(/weekly-note$/)
      // Shift with a press does the same from the room.
      await switchTab(page, 'Watcher').click()
      await allThreads(page).click()
      await threadsList(page).getByRole('button', { name: 'Open Footer links beside Watcher' }).click({ modifiers: ['Shift'] })
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId)).toMatch(/footer-links$/)
      await expect(page.getByRole('region', { name: 'Footer links' })).toBeVisible()
    }))
  })

  test('the floating switch answers the keyboard, and Tab follows the eye through the room', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await resizeContentWindow(launched, 1280, 800)
      const tabs = page.getByRole('tablist', { name: 'Page' }).getByRole('tab')
      await expect(tabs).toHaveCount(3)
      expect(await tabs.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? node.textContent))).toEqual(['Dictate', 'Watcher', 'Threads'])
      await expect(switchTab(page, 'Watcher')).toHaveAttribute('title', 'Watcher')
      const press = async (key: string, room: 'Dictate' | 'Watcher' | 'Threads'): Promise<void> => {
        await page.keyboard.press(key)
        await expect(switchTab(page, room)).toHaveAttribute('aria-selected', 'true')
        await expect(switchTab(page, room)).toBeFocused()
      }
      await switchTab(page, 'Threads').focus()
      await press('ArrowLeft', 'Watcher')
      // In Watcher's room the switch floats at the bottom centre, and focus is on its lit owl.
      await expect(page.locator('.watcher-dock').getByRole('tab', { name: 'Watcher' })).toBeFocused()
      const pill = await box(page.locator('.watcher-dock__pill'))
      expect(Math.abs(pill.x + pill.width / 2 - 640)).toBeLessThanOrEqual(2)
      await press('ArrowLeft', 'Dictate')
      await press('End', 'Threads')
      await press('Home', 'Dictate')
      await press('ArrowRight', 'Watcher')
      await press('ArrowRight', 'Threads')
      await press('ArrowLeft', 'Watcher')
      // Tab from All threads: the header, the needs-you line, the conversation, the composer, then the floating switch's row.
      await allThreads(page).focus()
      const order: string[] = []
      for (let step = 0; step < 50 && !order.includes('Check for updates'); step++) {
        await page.keyboard.press('Tab')
        order.push(await focusedName(page))
      }
      recorded.set('tab-order', order)
      const indexOf = (name: string | RegExp): number => order.findIndex(entry => typeof name === 'string' ? entry === name : name.test(entry))
      expect(indexOf('More Watcher actions')).toBe(0)
      expect(indexOf(/^Open Visual gate flake to answer/)).toBeGreaterThan(indexOf('More Watcher actions'))
      expect(indexOf('Watcher message')).toBeGreaterThan(indexOf(/^Open Streaming WAV stall/))
      expect(indexOf('History')).toBeGreaterThan(indexOf('Watcher message'))
      expect(order.slice(indexOf('History'), indexOf('History') + 6)).toEqual(['History', 'Usage', 'Settings', 'Help', 'Watcher', 'Check for updates'])
      for (const name of ['Settings', 'Help', 'History'] as const) {
        await openPage(page, name)
        await expect(switchTab(page, 'Dictate')).toHaveAttribute('tabindex', '0')
        await switchTab(page, 'Dictate').focus()
        await press('ArrowRight', 'Watcher')
        await press('End', 'Threads')
      }
    }))
  })

  test('badges and Threads in flight, with Watcher kept out of Threads', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await resizeContentWindow(launched, 1600, 1000)
      // On Threads: the owl after a watched thread's provider logo, its pane says what a send does, and Watcher is not listed.
      const threads = page.getByRole('complementary', { name: 'Thread sidebar' })
      await threads.getByRole('button', { name: /^Settled/ }).click()
      await expect(threads.getByRole('button', { name: 'Benchmark rerun', exact: true })).toBeVisible()
      await expect(threads.getByRole('button', { name: 'Release notes 1.4', exact: true })).toHaveCount(0)
      await threads.getByRole('button', { name: /^Settled/ }).click()
      const footer = threads.getByRole('button', { name: 'Footer links', exact: true })
      await expect(footer.getByRole('img', { name: 'Watched by Watcher' })).toHaveAttribute('title', 'Watched by Watcher')
      await expect(threads.getByRole('button', { name: 'Weekly note', exact: true }).getByRole('img', { name: 'Watched by Watcher' })).toHaveCount(0)
      await footer.click()
      const workerPane = page.getByRole('region', { name: 'Footer links' })
      await expect(workerPane.getByRole('img', { name: 'Watched by Watcher' })).toBeVisible()
      await expect(workerPane.getByText('Watched by Watcher. If you send here, Watcher stops sending to it.')).toBeVisible()
      await resizeContentWindow(launched, 1280, 800)
      expect(await pageBoundProblems(page)).toEqual([])
      await capture(launched, 'threads-watched-sotto-dark-1280x800.png')

      await openRoom(page)
      const pane = watcherPane(page)
      await expect(pane.getByRole('meter', { name: 'Watched threads' })).toHaveAttribute('aria-valuetext', '2 of 4 watched')
      await expect(pane.getByText('Only you can allow that, in its own pane.')).toBeVisible()
      await allThreads(page).click()
      // In the list the owl is drawn, and the row's description says it, so it is not read twice.
      const watchedRow = threadsList(page).locator('.watcher-row').filter({ hasText: 'Visual gate flake' })
      await expect(watchedRow.locator('.watched-badge')).toBeVisible()
      await expect(watchedRow.getByRole('button', { name: 'Open Visual gate flake beside Watcher' })).toHaveAccessibleDescription(/Watched by Watcher/)
      await page.keyboard.press('Escape')

      // Threads in flight saves the real setting.
      const more = pane.getByRole('button', { name: 'More Watcher actions' })
      await more.click()
      const limit = page.getByRole('dialog', { name: 'Watcher settings' }).getByRole('combobox', { name: 'Threads in flight' })
      await expect(limit).toBeFocused()
      await limit.selectOption('3')
      await expect(pane.getByRole('meter', { name: 'Watched threads' })).toHaveAttribute('aria-valuetext', '2 of 3 watched')
      await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).watcherInFlightLimit)).toBe(3)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Watcher settings' })).toHaveCount(0)
      await expect(more).toBeFocused()
      recorded.set('limit', { saved: await page.evaluate(async () => (await window.sotto!.getSettings()).watcherInFlightLimit) })
    }))
  })

  for (const [theme, label] of THEMES) for (const appearance of ['dark', 'light'] as const) {
    test(`the room at three sizes, ${label}, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(theme, appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true })
        await openRoom(page)
        const readings: Record<string, unknown> = {}
        const measure = async (key: string, width: number, height: number): Promise<void> => {
          expect(await pageBoundProblems(page), key).toEqual([])
          await roomEdges(page, width, height)
          const contrast = await roomContrast(page)
          for (const { name, ratio } of contrast) expect(ratio, `${name}, ${key}`).toBeGreaterThanOrEqual(4.5)
          readings[key] = contrast
        }
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          await measure(`${width}x${height}`, width, height)
          await capture(launched, `room-${label}-${appearance}-${width}x${height}.png`)
        }
        // With the list open and with a thread beside, at the size Zach's mock-up was mostly reviewed at.
        await resizeContentWindow(launched, 1280, 800)
        await allThreads(page).click()
        await settle(page)
        await measure('1280x800 list', 1280, 800)
        await capture(launched, `list-${label}-${appearance}-1280x800.png`)
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: 'Open Visual gate flake to answer its permission' }).click()
        await expect(beside(page)).toBeVisible()
        for (const [width, height] of [[1280, 800], [820, 560]] as const) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          await measure(`${width}x${height} beside`, width, height)
          await capture(launched, `beside-${label}-${appearance}-${width}x${height}.png`)
        }
        await page.keyboard.press('Escape')
        recorded.set(`room-${label}-${appearance}`, readings)
      }))
    })
  }

  test('the room with reduced motion, from the system and from Sotto’s own setting', async () => {
    await onReleaseTrack('owl', async () => {
      for (const motion of ['normal', 'reduced'] as const) await withSotto(launchOptions('t3-code', 'dark', motion), async (launched) => {
        const { page } = launched
        if (motion === 'normal') await page.emulateMedia({ reducedMotion: 'reduce' })
        await openThreads(page)
        await seedRoom(page, { current: true })
        if (motion === 'normal') await page.emulateMedia({ reducedMotion: 'reduce' })
        await openRoom(page)
        await resizeContentWindow(launched, 1280, 800)
        await allThreads(page).click()
        await settle(page)
        const working = page.locator('.watcher-row__ring[data-tone="working"]').first()
        await expect(working).toBeVisible()
        // Reduced motion cuts every transition to a millisecond (global.css) rather than removing it, and one caught in
        // that millisecond, such as a scrollbar colour settling, is not motion. What must not run is the ring's own spin.
        expect(await working.evaluate(node => node.getAnimations().filter(animation => animation instanceof CSSAnimation).length), `ring, ${motion}`).toBe(0)
        // The stars stop twinkling too.
        expect(await page.locator('.watcher-room__sky .thread-nav__star[data-twinkle]').evaluateAll(stars => stars.reduce((count, star) => count + star.getAnimations().filter(animation => animation instanceof CSSAnimation).length, 0)), `stars, ${motion}`).toBe(0)
        await capture(launched, `room-sotto-dark-1280x800-reduced-motion-${motion === 'normal' ? 'system' : 'setting'}.png`)
      })
    })
  })

  test('a long title, a disconnected host and no other threads stay inside the room', async () => {
    await onReleaseTrack('owl', async () => {
      await withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true })
        const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
        const long = 'Find why the visual gate flakes on the widget listening capture at the smallest window, in every theme and both modes'
        await page.evaluate(async ({ threadId, title }) => { await window.sotto!.agents!.command({ type: 'rename-thread', threadId, title }) },
          { threadId: hostEntityKey(hostId, 'visual-gate'), title: long })
        await openRoom(page)
        await resizeContentWindow(launched, 820, 560)
        await settle(page)
        // In the needs-you line and the list, a long title gives way with an ellipsis and keeps its whole text as a tooltip.
        const name = page.locator('.watcher-glance__name').filter({ hasText: long })
        await expect(name).toHaveAttribute('title', long)
        expect(await name.locator('span').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
        await allThreads(page).click()
        const title = threadsList(page).locator('.watcher-row__title').filter({ hasText: long })
        expect(await title.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
        expect(await pageBoundProblems(page)).toEqual([])
        await capture(launched, 'room-long-title-sotto-dark-820x560.png')
        await page.keyboard.press('Escape')
        await page.evaluate(async () => { await window.sottoE2E!.agentEvent!({ type: 'disconnect', threadId: '', text: '' }) })
        await allThreads(page).click()
        await expect(threadsList(page).locator('.watcher-row__status').filter({ hasText: 'Disconnected' }).first()).toBeVisible()
        expect(await pageBoundProblems(page)).toEqual([])
        await capture(launched, 'room-disconnected-sotto-dark-820x560.png')
      })
      await withSotto({ ...launchOptions('t3-code', 'dark'), scenario: 'design-threads-empty', agents: 'design-threads-empty' }, async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: false, history: false })
        await resizeContentWindow(launched, 1280, 800)
        await openRoom(page)
        await expect(page.locator('.watcher-glance')).toHaveCount(0)
        await expect(allThreads(page)).toHaveAccessibleName('All threads, 0. Show the list')
        await allThreads(page).click()
        await expect(threadsList(page).getByText('No other threads yet.', { exact: false })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('heading', { level: 2, name: 'Start Watcher' })).toBeVisible()
        expect(await pageBoundProblems(page)).toEqual([])
        await capture(launched, 'room-empty-sotto-dark-1280x800.png')
      })
    })
  })

  /**
   * The one journey here with no stand-in: the room reads main's own bridge (preload's `window.sotto.watcher`, main's
   * WatcherService) over the fake Codex app server the integration tests use, so starting Watcher is main's real `open`
   * and the first message is a real send to a real Watcher thread.
   */
  test('against main’s own Watcher, the first message starts Watcher on Codex and reaches it', async () => {
    test.setTimeout(3 * 60_000)
    const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-watcher-main-' })).directory
    const root = join(profile, 'native-fixture')
    for (const folder of ['claude', 'codex']) await mkdir(join(root, folder), { recursive: true })
    await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: 'Watcher here. I will look at the release notes.' }))
    const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
    process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
    process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
    try {
      await onReleaseTrack('owl', async () => {
        const launched = await launchSotto('success', profile)
        try {
          const { page } = launched
          await page.evaluate(async () => {
            await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
            const agents = window.sotto!.agents!
            await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
            await agents.command({ type: 'connect', provider: 'codex' })
          })
          await page.reload()
          await openThreads(page)
          // Main's bridge, not a stand-in: nothing is seeded, and main answers that no Watcher exists yet.
          expect(await page.evaluate(key => localStorage.getItem(key), WATCHER_STAND_IN_KEY)).toBeNull()
          expect(await page.evaluate(async () => (await window.sotto!.watcher!.get()))).toMatchObject({ status: 'ok', state: { current: null } })
          await resizeContentWindow(launched, 1280, 800)
          await openRoom(page)
          await expect(page.getByRole('heading', { level: 2, name: 'Start Watcher' })).toBeVisible()
          await expect(page.getByRole('group', { name: 'Watcher’s model' }).getByRole('combobox', { name: 'Thread model' })).toBeVisible()
          await page.getByRole('textbox', { name: 'Watcher message' }).click()
          await page.keyboard.type('Check the release notes and tell me what is missing.')
          await page.getByRole('button', { name: 'Start Watcher and send' }).click()
          // Main created Watcher on Codex: its own pane, the meter, the message and the provider's reply.
          const pane = watcherPane(page)
          await expect(page.getByRole('meter', { name: 'Watched threads' })).toHaveAttribute('aria-valuetext', '0 of 4 watched')
          const original = 'Check the release notes and tell me what is missing.'
          await expect(pane.locator('[data-role="user"] .rich-message')).toHaveText(original)
          await expect(pane.locator('[data-role="assistant"]')).toContainText('Watcher here. I will look at the release notes.')
          await expect(pane.locator('[data-role="user"]')).toHaveCount(1)
          // The bubble shows only what was typed. The request rides in the turn's own context, beside the words, and
          // names no projects.
          await expect(pane.locator('[data-role="user"]')).not.toContainText('Sotto Watcher request')
          const turns = (await readFile(join(root, 'codex', 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as
            { method?: string; params?: { input?: { type: string; text?: string }[]; additionalContext?: Record<string, { value: string; kind: string }> } })
            .filter(frame => frame.method === 'turn/start')
          expect(turns).toHaveLength(1)
          expect(turns[0]!.params!.input).toEqual([expect.objectContaining({ type: 'text', text: original })])
          const note = turns[0]!.params!.additionalContext?.sotto_watcher_request
          expect(note).toMatchObject({ kind: 'application', value: expect.stringMatching(/^Sotto Watcher request: [0-9a-f-]{36}\. Local host: [0-9a-f-]{36}\./u) })
          expect(note!.value).not.toMatch(/project/iu)
          const record = await page.evaluate(async () => (await window.sotto!.watcher!.get()))
          expect(record).toMatchObject({ status: 'ok', state: { current: { provider: 'codex' } } })
          if (record.status !== 'ok') throw new Error('Main did not return the Watcher room')
          // The note names the request the message started, and its display proof records that the words went as typed.
          const request = record.state.requests.at(-1)!
          expect(note!.value).toContain(`Sotto Watcher request: ${request.id}. Local host: ${request.watcher.hostId}.`)
          expect(request.displayPrompt).toEqual({ originalLength: original.length, wireDigest: createHash('sha256').update(original).digest('hex') })
          // Watcher is its room's: not listed on the Threads page, and nothing there was selected for it.
          await switchTab(page, 'Threads').click()
          await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
          await expect(page.getByRole('complementary', { name: 'Thread sidebar' }).getByText('Watcher', { exact: true })).toHaveCount(0)
          // Threads in flight saves through main's own setLimit.
          await switchTab(page, 'Watcher').click()
          await page.getByRole('button', { name: 'More Watcher actions' }).click()
          await page.getByRole('combobox', { name: 'Threads in flight' }).selectOption('3')
          await expect(page.getByRole('meter', { name: 'Watched threads' })).toHaveAttribute('aria-valuetext', '0 of 3 watched')
          await expect.poll(async () => (await page.evaluate(() => window.sotto!.getSettings())).watcherInFlightLimit).toBe(3)
          await page.keyboard.press('Escape')
          await settle(page)
          expect(await pageBoundProblems(page)).toEqual([])
          await capture(launched, 'room-main-sotto-dark-1280x800.png')
        } finally { await closeSotto(launched) }
      })
    } finally {
      if (previous.root === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT
      else process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = previous.root
      if (previous.executable === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE
      else process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = previous.executable
      await removeOwnedE2EProfile(profile)
    }
  })

  test('stable shows nothing of Watcher, even with a projection seeded', async () => {
    await onReleaseTrack('stable', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await expect(page.getByRole('tablist', { name: 'Page' }).getByRole('tab')).toHaveCount(2)
      await expect(switchTab(page, 'Watcher')).toHaveCount(0)
      await expect(page.getByRole('img', { name: 'Watched by Watcher' })).toHaveCount(0)
      await expect(page.getByText(/If you send here, Watcher stops sending to it/)).toHaveCount(0)
      await expect(page.locator('.watcher-dock')).toHaveCount(0)
      // Stable lists the thread the projection names as Watcher, since stable has no Watcher to give it to.
      const threads = page.getByRole('complementary', { name: 'Thread sidebar' })
      await threads.getByRole('button', { name: /^Settled/ }).click()
      await expect(threads.getByRole('button', { name: 'Release notes 1.4', exact: true })).toHaveCount(1)
    }))
  })
})
