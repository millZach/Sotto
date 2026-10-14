import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { hostEntityKey } from '../../src/shared/clientIdentity'
import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../src/renderer/src/e2e/watcherStandIn'
import type { WatcherOwnChange } from '../../src/shared/watcher'
import type { AgentMessage } from '../../src/shared/agents'
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
/** Watcher's permissions, its own changes and watching (Zach's picks on October 13, 2026): captures for their note. */
const permissionEvidence = evidenceDirectory('artifacts/watcher-permission')
const FOOT = 'When Watcher asks, you can allow it once, not for good. Its instructions still tell it to hand changes to a thread.'
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
 * With `current: false`, the room opens on its first entry and `open` names that same thread as the one created. The
 * projection carries the contract's fields as main supplies them: the remembered permission and the current Watcher's,
 * each row marked watched, and Watcher's own changes. `permissionConfirms: false` holds a permission change unconfirmed.
 */
async function seedRoom(page: Page, options: { readonly current: boolean; readonly history?: boolean; readonly permissionConfirms?: boolean
  readonly ownChanges?: readonly WatcherOwnChange[]; readonly messages?: readonly AgentMessage[] }): Promise<void> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  expect(hostId, 'the window names its host').toBeTruthy()
  const target = (threadId: string) => ({ hostId: hostId!, threadId })
  const requestId = randomUUID()
  const identity = { target: target(CURRENT), projectId: 'workshop', provider: 'codex' as const, creationOperationId: randomUUID(), createdAt: at(12) }
  const participants = WATCHED.map(threadId => ({ requestId, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target(threadId), promptCount: 1 }))
  const seed: WatcherStandInSeed = {
    state: {
      current: options.current ? identity : null,
      currentOptions: options.current ? { modelId: 'codex:gpt', reasoningEffort: null, runtimeMode: 'approval-required', status: 'idle', connected: true } : null,
      history: [], runtimeMode: 'approval-required', standingWatches: [], ownChanges: [...options.ownChanges ?? []],
      requests: options.current ? [{ id: requestId, watcher: identity.target, rootUserMessageId: 'watcher-ask', state: 'active', createdAt: at(12), closedAt: null, participants }] : [],
      watchedThreads: options.current ? participants.map(part => ({ target: part.target, title: part.target.threadId, watched: true, paused: false, status: 'running' as const, connected: true,
        settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [part] })) : [],
      inFlight: options.current ? 2 : 0, inFlightLimit: 4, receipts: [], recoveryNotice: null, observedAt: at(0),
    },
    created: identity,
    ...options.permissionConfirms === false ? { permissionConfirms: false } : {},
  }
  await page.evaluate(async ({ key, seed, master, history, extra }) => {
    localStorage.setItem(key, JSON.stringify(seed))
    if (history) await window.sottoE2E!.agentEvent!({ type: 'history', threadId: master, text: '', messages: [
      { id: 'watcher-ask', role: 'user', text: 'Find why the visual gate flakes and fix the footer links. Keep an eye on both.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 29)).toISOString() },
      { id: 'watcher-reply', role: 'assistant', text: 'Started Visual gate flake on Claude Code and Footer links on Codex, and I am watching both. Visual gate flake is asking to run the unit suite. Only you can allow that, in its own pane.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 33)).toISOString() },
      ...extra,
    ] })
  }, { key: WATCHER_STAND_IN_KEY, seed, master: CURRENT, history: options.history !== false, extra: [...options.messages ?? []] })
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
    const selectors = ['.watcher-head h1', '.watcher-head__list', '.watcher-head__count', '.watcher-tabs__tab', '.watcher-tabs__count', '.watcher-glance__lead', '.watcher-glance__name', '.watcher-glance__why',
      '.watcher-pane .thread-chip', '.thread-options__caption', '.thread-chip-menu__options small', '.thread-chip-menu__foot', '.watched-note', '.watched-note__stop', '.watch-toggle', '.watch-toast > span',
      '.watcher-dock__switch button', '.watcher-group__label', '.watcher-group__count', '.watcher-row__title', '.watcher-row__status',
      '.watcher-row__where', '.watcher-row__asks > span', '.watcher-answer', '.watcher-list__foot', '.watcher-list .thread-nav__time', '.watcher-first__intro h2', '.watcher-first__intro p',
      '.watcher-beside .thread-workspace__head h2', '.watcher-own__words > strong', '.watcher-own__said', '.watcher-own__none', '.watcher-own__toggle', '.watcher-own__files code',
      '.watcher-watched__lead > p', '.watcher-watched__label', '.watched-card__title', '.watched-card__meta', '.watched-card__doing', '.watched-card__stop']
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

/** The same, for the permissions, own changes and watching note's own folder. */
async function captureNote(launched: LaunchedSotto, name: string): Promise<void> {
  await settle(launched.page)
  await holdOwlSky(launched.page)
  await captureWindow(launched.app, resolve(permissionEvidence, name))
}

/** Every reading in the room on or above 4.5:1, recorded under `key`. */
async function contrastHolds(page: Page, key: string): Promise<void> {
  const contrast = await roomContrast(page)
  for (const { name, ratio } of contrast) expect(ratio, `${name}, ${key}`).toBeGreaterThanOrEqual(4.5)
  recorded.set(key, contrast)
}

test.describe("Watcher's room on the built app", () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })
  test.beforeAll(async () => { await mkdir(evidenceRoot, { recursive: true }); await mkdir(permissionEvidence, { recursive: true }) })
  test.afterAll(async () => {
    // Each folder gets its own readings, and a run that took none for a folder leaves that folder's file as it was.
    const note = /^(permissions|own-changes|threads-watch|room-watched|list-watch)-/u
    const folders = [[evidenceRoot, [...recorded].filter(([key]) => !note.test(key))], [permissionEvidence, [...recorded].filter(([key]) => note.test(key))]] as const
    for (const [folder, entries] of folders) {
      if (entries.length > 0) await writeFile(resolve(folder, 'readings.json'), `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, 'utf8')
    }
  })

  test('the first message starts Watcher on a chosen model and goes to it', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: false })
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      await expect(page.getByRole('heading', { level: 2, name: 'Start Watcher' })).toBeVisible()
      // No tabs or actions before Watcher runs; the needs-you line and All threads already work.
      await expect(page.getByRole('tablist', { name: 'Watcher’s view' })).toHaveCount(0)
      await expect(page.locator('.watcher-glance')).toContainText('2 need you')
      const choice = page.getByRole('group', { name: 'Watcher’s model' })
      await expect(choice.getByRole('combobox', { name: 'Thread model' })).toHaveText(/Sonnet 4\.5/)
      await expect(choice.getByRole('combobox', { name: 'Watcher’s permissions' })).toHaveText('Ask for approval')
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
      await expect(pane.getByRole('tab', { name: /^Watched, / })).toBeVisible()
      await expect(pane.getByText('Keep an eye on the footer links until they ship.')).toBeVisible()
      await expect(pane.getByRole('textbox', { name: 'Watcher message' })).toBeVisible()
      await expect(pane.getByRole('combobox', { name: 'Watcher’s permissions' })).toHaveText('Ask for approval')
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
      await expect(beside(page).getByText('Watched by Watcher. It keeps this thread going and brings you its questions and permissions.')).toBeVisible()
      await expect(beside(page).getByRole('button', { name: 'Watch Visual gate flake', exact: true })).toHaveAttribute('aria-pressed', 'true')
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
      // Tab from All threads: the header (its tabs, one stop on the one shown, then More Watcher actions), the needs-you
      // line, the conversation, the composer, then the floating switch's row.
      await allThreads(page).focus()
      const order: string[] = []
      for (let step = 0; step < 50 && !order.includes('Check for updates'); step++) {
        await page.keyboard.press('Tab')
        order.push(await focusedName(page))
      }
      recorded.set('tab-order', order)
      const indexOf = (name: string | RegExp): number => order.findIndex(entry => typeof name === 'string' ? entry === name : name.test(entry))
      expect(order.slice(0, 2)).toEqual(['Conversation', 'More Watcher actions'])
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
      await expect(workerPane.getByText('Watched by Watcher. It keeps this thread going and brings you its questions and permissions.')).toBeVisible()
      await expect(workerPane.getByRole('button', { name: 'Stop watching Footer links', exact: true })).toBeVisible()
      await resizeContentWindow(launched, 1280, 800)
      expect(await pageBoundProblems(page)).toEqual([])
      await capture(launched, 'threads-watched-sotto-dark-1280x800.png')

      await openRoom(page)
      const pane = watcherPane(page)
      // How many it watches is on Watched; the limit no longer counts watching.
      await expect(pane.getByRole('tab', { name: 'Watched, 2 threads' })).toBeVisible()
      await expect(pane.getByRole('meter')).toHaveCount(0)
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
      await expect(limit).toHaveValue('3')
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

  test('Watcher’s permissions: a chip after model and reasoning, chosen from the keyboard and marked until the provider confirms', async () => {
    await onReleaseTrack('owl', async () => {
      for (const appearance of ['dark', 'light'] as const) await withSotto(launchOptions('t3-code', appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true, permissionConfirms: false })
        await resizeContentWindow(launched, 1280, 800)
        await openRoom(page)
        const pane = watcherPane(page)
        const chip = pane.getByRole('combobox', { name: 'Watcher’s permissions' })
        await expect(chip).toHaveText('Ask for approval')
        // From the keyboard: Enter opens the list on the mode in force, each mode with its line and the line that holds in all.
        await chip.focus()
        await page.keyboard.press('Enter')
        const list = page.getByRole('listbox', { name: 'Watcher’s permissions' })
        await expect(list.getByRole('option', { name: /^Ask for approval/ })).toBeFocused()
        await expect(list.getByRole('option')).toHaveText([/^Ask for approval/, /^Allow edits/, /^AutoCodex decides what to ask you about\.$/, /^Full access/])
        await expect(page.getByText(FOOT)).toBeVisible()
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          expect(await pageBoundProblems(page), `permissions open at ${width}x${height}`).toEqual([])
          const panel = await box(page.locator('.thread-chip-menu__list--foot'))
          expect(panel.x + panel.width, `the list inside the window at ${width}x${height}`).toBeLessThanOrEqual(width)
          expect(panel.y, `the list under the header at ${width}x${height}`).toBeGreaterThanOrEqual(44)
          await captureNote(launched, `permissions-open-${appearance}-${width}x${height}.png`)
          await contrastHolds(page, `permissions-open-${appearance}-${width}x${height}`)
        }
        await resizeContentWindow(launched, 1280, 800)
        await settle(page)
        // Escape closes it back to the chip, choosing nothing.
        await page.keyboard.press('Escape')
        await expect(list).toHaveCount(0)
        await expect(chip).toBeFocused()
        await expect(chip).toHaveText('Ask for approval')
        // Arrow and Enter choose; the chip keeps focus, shows the choice at once, and is marked until Codex confirms.
        await page.keyboard.press('Enter')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
        await expect(chip).toBeFocused()
        await expect(chip).toHaveText('Allow edits')
        await expect(chip).toHaveAttribute('data-pending', 'true')
        await expect(pane.getByText('Codex still asks for approval until it confirms.')).toBeVisible()
        expect(await pageBoundProblems(page)).toEqual([])
        await captureNote(launched, `permissions-pending-${appearance}-1280x800.png`)
        await contrastHolds(page, `permissions-pending-${appearance}-1280x800`)
        await resizeContentWindow(launched, 820, 560)
        await settle(page)
        expect(await pageBoundProblems(page)).toEqual([])
        await captureNote(launched, `permissions-pending-${appearance}-820x560.png`)
      })
    })
  })

  test('a reply in which Watcher changed files itself carries one quiet line, its files on request', async () => {
    const changes: WatcherOwnChange[] = [
      { replyMessageId: 'watcher-fixed', turnId: 'turn-2', files: ['README.md', 'docs/guide.md'], fileCount: 2, reason: 'A one-word typo in two files is smaller than briefing a thread.', source: 'provider-file-change' },
      { replyMessageId: 'watcher-quiet', turnId: 'turn-3', files: ['CHANGELOG.md'], fileCount: 1, reason: null, source: 'provider-file-change' },
    ]
    const messages: AgentMessage[] = [
      { id: 'watcher-ask-2', role: 'user', text: 'The README’s install line says “npm instal”. Fix that too.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 40)).toISOString() },
      { id: 'watcher-fixed', role: 'assistant', text: 'I fixed “npm instal” in README.md and docs/guide.md myself.\n\nWatcher change reason: A one-word typo in two files is smaller than briefing a thread.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 41)).toISOString() },
      { id: 'watcher-ask-3', role: 'user', text: 'And the changelog date?', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 44)).toISOString() },
      { id: 'watcher-quiet', role: 'assistant', text: 'The changelog date is right now.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 45)).toISOString() },
    ]
    await onReleaseTrack('owl', async () => {
      for (const appearance of ['dark', 'light'] as const) await withSotto(launchOptions('t3-code', appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true, ownChanges: changes, messages })
        await resizeContentWindow(launched, 1280, 800)
        await openRoom(page)
        const pane = watcherPane(page)
        const said = pane.locator('[data-message-id="watcher-fixed"] .watcher-own')
        await expect(said).toHaveText(/^Watcher changed 2 files itself\. Its reason: “A one-word typo in two files is smaller than briefing a thread\.”Show the 2 files$/)
        const quiet = pane.locator('[data-message-id="watcher-quiet"] .watcher-own')
        await expect(quiet).toHaveText(/^Watcher changed 1 file itself\. It gave no reason\.Show the file$/)
        await expect(pane.locator('[data-message-id="watcher-reply"] .watcher-own')).toHaveCount(0)
        // The files show on request, from the keyboard, and Escape folds them back.
        // Its name says what a press does, so it changes with the press: the same button either way.
        const show = said.locator('.watcher-own__toggle')
        await expect(show).toHaveAccessibleName('Show the 2 files')
        await show.focus()
        await page.keyboard.press('Enter')
        await expect(show).toHaveAttribute('aria-expanded', 'true')
        await expect(show).toHaveAccessibleName('Hide the 2 files')
        await expect(said.getByRole('list', { name: 'Files Watcher changed' }).getByRole('listitem')).toHaveText(['README.md', 'docs/guide.md'])
        await said.scrollIntoViewIfNeeded()
        for (const [width, height] of appearance === 'dark' ? SIZES : [[1280, 800]] as const) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          await said.scrollIntoViewIfNeeded()
          expect(await pageBoundProblems(page), `own changes at ${width}x${height}`).toEqual([])
          await captureNote(launched, `own-changes-${appearance}-${width}x${height}.png`)
          await contrastHolds(page, `own-changes-${appearance}-${width}x${height}`)
        }
        await show.focus()
        await page.keyboard.press('Escape')
        await expect(said.getByRole('list', { name: 'Files Watcher changed' })).toHaveCount(0)
        await expect(show).toBeFocused()
        await expect(show).toHaveAccessibleName('Show the 2 files')
      })
    })
  })

  test('Watch from a pane header and a row, and the Watched view, from the keyboard', async () => {
    await onReleaseTrack('owl', async () => {
      for (const appearance of ['dark', 'light'] as const) await withSotto(launchOptions('t3-code', appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true })
        await resizeContentWindow(launched, 1280, 800)
        // On Threads: Weekly note is not watched; Watch in its pane header acts at once and says so, with Undo.
        const threads = page.getByRole('complementary', { name: 'Thread sidebar' })
        await threads.getByRole('button', { name: 'Weekly note', exact: true }).click()
        const weekly = page.getByRole('region', { name: 'Weekly note' })
        const watch = weekly.getByRole('button', { name: 'Watch Weekly note', exact: true })
        await expect(watch).toHaveAttribute('aria-pressed', 'false')
        await expect(weekly.getByText(/Watched by Watcher/)).toHaveCount(0)
        await watch.focus()
        await page.keyboard.press('Enter')
        await expect(watch).toHaveAttribute('aria-pressed', 'true')
        await expect(watch).toBeFocused()
        await expect(weekly.locator('.thread-workspace__head').getByRole('img', { name: 'Watched by Watcher' })).toBeVisible()
        await expect(weekly.getByText('Watched by Watcher. It keeps this thread going and brings you its questions and permissions.')).toBeVisible()
        const toast = page.locator('.watch-toast')
        await expect(toast).toHaveText(/Watcher is watching Weekly note\./)
        // The toast never takes focus, and does not cover a composer.
        await expect(watch).toBeFocused()
        expect(overlaps(await box(toast), await box(weekly.locator('.thread-prompt')))).toBe(false)
        expect(await pageBoundProblems(page)).toEqual([])
        await captureNote(launched, `threads-watch-${appearance}-1280x800.png`)
        await contrastHolds(page, `threads-watch-${appearance}-1280x800`)
        // The sidebar row's owl says the same, pressed.
        await expect(threads.getByRole('button', { name: 'Watch Weekly note', exact: true })).toHaveAttribute('aria-pressed', 'true')
        // Undo stops it again; Stop watching under the composer does the same once watched again.
        await toast.getByRole('button', { name: 'Undo: stop watching Weekly note' }).click()
        await expect(watch).toHaveAttribute('aria-pressed', 'false')
        await expect(toast).toHaveText(/Watcher stopped watching Weekly note\./)
        // The row's actions show on hover, as Rename and Settle do; the owl is among them. Captured with the pointer there.
        const rowOwl = threads.getByRole('button', { name: 'Watch Weekly note', exact: true })
        await threads.getByRole('button', { name: 'Weekly note', exact: true }).hover()
        await expect(rowOwl).toHaveAttribute('aria-pressed', 'false')
        await holdOwlSky(page)
        await captureWindow(launched.app, resolve(permissionEvidence, `threads-row-owl-${appearance}-1280x800.png`))
        // From the keyboard: Tab from the row goes through its actions, Rename and Regenerate title, to the owl.
        await threads.getByRole('button', { name: 'Weekly note', exact: true }).focus()
        for (const name of ['Rename Weekly note', 'Regenerate title for Weekly note', 'Watch Weekly note']) {
          await page.keyboard.press('Tab')
          expect(await focusedName(page)).toBe(name)
        }
        await page.keyboard.press('Enter')
        await expect(watch).toHaveAttribute('aria-pressed', 'true')
        await weekly.getByRole('button', { name: 'Stop watching Weekly note', exact: true }).click()
        await expect(watch).toHaveAttribute('aria-pressed', 'false')
        await watch.click()
        await expect(watch).toHaveAttribute('aria-pressed', 'true')
        await resizeContentWindow(launched, 820, 560)
        await settle(page)
        expect(await pageBoundProblems(page)).toEqual([])
        await captureNote(launched, `threads-watch-${appearance}-820x560.png`)

        // In the room: Watched, from the keyboard, beside Conversation.
        await resizeContentWindow(launched, 1280, 800)
        await openRoom(page)
        const pane = watcherPane(page)
        const conversation = pane.getByRole('tab', { name: 'Conversation' })
        await expect(conversation).toHaveAttribute('aria-selected', 'true')
        await conversation.focus()
        await page.keyboard.press('ArrowRight')
        const watched = pane.getByRole('tab', { name: 'Watched, 3 threads' })
        await expect(watched).toBeFocused()
        await expect(watched).toHaveAttribute('aria-selected', 'true')
        // The panel is named by its tab, whose name follows the count.
        const panel = pane.getByRole('tabpanel')
        await expect(panel).toHaveAccessibleName('Watched, 3 threads')
        await expect(panel.getByRole('region')).toHaveText([/^Needs you1/, /^Working2/])
        await expect(panel.getByRole('button', { name: /^Stop watching / })).toHaveCount(3)
        await expect(panel.getByRole('button', { name: 'Open Visual gate flake to answer its permission' })).toBeVisible()
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          expect(await pageBoundProblems(page), `Watched at ${width}x${height}`).toEqual([])
          await roomEdges(page, width, height)
          await captureNote(launched, `room-watched-${appearance}-${width}x${height}.png`)
          await contrastHolds(page, `room-watched-${appearance}-${width}x${height}`)
        }
        // A thread opened beside Watcher keeps both headers whole at the minimum.
        await panel.getByRole('button', { name: 'Open Footer links beside Watcher' }).click()
        await expect(beside(page)).toHaveAttribute('aria-label', 'Footer links')
        await settle(page)
        expect(await pageBoundProblems(page), 'Watched with a thread beside at 820x560').toEqual([])
        await roomEdges(page, 820, 560)
        await captureNote(launched, `room-watched-beside-${appearance}-820x560.png`)
        await page.keyboard.press('Escape')
        await expect(beside(page)).toHaveCount(0)
        await resizeContentWindow(launched, 1280, 800)
        await settle(page)
        // Stop watching on a card stops it, and the count follows.
        await panel.getByRole('button', { name: 'Stop watching Weekly note', exact: true }).click()
        await expect(pane.getByRole('tab', { name: 'Watched, 2 threads' })).toBeVisible()
        await expect(panel.getByText('Weekly note', { exact: true })).toHaveCount(0)
        // Watch a thread opens All threads, where the owl is each row's last stop.
        await panel.getByRole('button', { name: 'Watch a thread' }).click()
        const list = threadsList(page)
        await expect(list).toBeVisible()
        await expect(list.getByText(/The owl watches a thread until you press it again/)).toBeVisible()
        await list.getByRole('searchbox', { name: 'Filter threads' }).fill('weekly')
        await page.keyboard.press('Tab')
        expect(await focusedName(page)).toBe('Open Weekly note beside Watcher')
        await page.keyboard.press('Tab')
        expect(await focusedName(page)).toBe('Watch Weekly note')
        await expect(list.getByRole('button', { name: 'Watch Weekly note', exact: true })).toHaveAttribute('aria-pressed', 'false')
        await page.keyboard.press('Space')
        await expect(list.getByRole('button', { name: 'Watch Weekly note', exact: true })).toHaveAttribute('aria-pressed', 'true')
        await list.getByRole('searchbox', { name: 'Filter threads' }).fill('')
        await settle(page)
        expect(await pageBoundProblems(page)).toEqual([])
        await captureNote(launched, `list-watch-${appearance}-1280x800.png`)
        await contrastHolds(page, `list-watch-${appearance}-1280x800`)
        await page.keyboard.press('Escape')
        await expect(pane.getByRole('tab', { name: 'Watched, 3 threads' })).toBeVisible()
        // Back to the conversation, which comes back as it was.
        await pane.getByRole('tab', { name: 'Watched, 3 threads' }).focus()
        await page.keyboard.press('Home')
        await expect(pane.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true')
        await expect(pane.getByText('Only you can allow that, in its own pane.')).toBeVisible()
      })
    })
  })

  test('the permission list and the watch toast hold still with reduced motion', async () => {
    await onReleaseTrack('owl', async () => {
      await withSotto(launchOptions('t3-code', 'light', 'reduced'), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true })
        await resizeContentWindow(launched, 1280, 800)
        const threads = page.getByRole('complementary', { name: 'Thread sidebar' })
        await threads.getByRole('button', { name: 'Weekly note', exact: true }).click()
        await page.getByRole('region', { name: 'Weekly note' }).getByRole('button', { name: 'Watch Weekly note', exact: true }).click()
        const toast = page.locator('.watch-toast')
        await expect(toast).toBeVisible()
        expect(await toast.evaluate(node => node.getAnimations().filter(animation => animation instanceof CSSAnimation).length), 'toast').toBe(0)
        await openRoom(page)
        await watcherPane(page).getByRole('combobox', { name: 'Watcher’s permissions' }).click()
        const list = page.locator('.thread-chip-menu__list--foot')
        await expect(list).toBeVisible()
        expect(await list.evaluate(node => node.getAnimations().filter(animation => animation instanceof CSSAnimation).length), 'list').toBe(0)
        await captureNote(launched, 'permissions-open-light-1280x800-reduced-motion.png')
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
          // Main created Watcher on Codex: its own pane, its tabs, the message and the provider's reply.
          const pane = watcherPane(page)
          await expect(pane.getByRole('tab', { name: 'Watched, 0 threads' })).toBeVisible()
          // Ask for approval, as a chip where main takes the choice and as a fact where it does not yet.
          await expect(pane.locator('.thread-prompt__footer')).toContainText('Ask for approval')
          await expect(pane.locator('[data-role="user"]')).toContainText('Check the release notes and tell me what is missing.')
          await expect(pane.locator('[data-role="assistant"]')).toContainText('Watcher here. I will look at the release notes.')
          await expect(pane.locator('[data-role="user"]')).toHaveCount(1)
          const record = await page.evaluate(async () => (await window.sotto!.watcher!.get()))
          expect(record).toMatchObject({ status: 'ok', state: { current: { provider: 'codex' } } })
          // Watcher is its room's: not listed on the Threads page, and nothing there was selected for it.
          await switchTab(page, 'Threads').click()
          await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
          await expect(page.getByRole('complementary', { name: 'Thread sidebar' }).getByText('Watcher', { exact: true })).toHaveCount(0)
          // Threads in flight saves through main's own setLimit.
          await switchTab(page, 'Watcher').click()
          await page.getByRole('button', { name: 'More Watcher actions' }).click()
          await page.getByRole('combobox', { name: 'Threads in flight' }).selectOption('3')
          await expect(page.getByRole('combobox', { name: 'Threads in flight' })).toHaveValue('3')
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
      await expect(page.getByText(/Watched by Watcher/)).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Watch |^Stop watching/ })).toHaveCount(0)
      await expect(page.getByRole('combobox', { name: 'Watcher’s permissions' })).toHaveCount(0)
      await expect(page.locator('.watcher-dock')).toHaveCount(0)
      // Stable lists the thread the projection names as Watcher, since stable has no Watcher to give it to.
      const threads = page.getByRole('complementary', { name: 'Thread sidebar' })
      await threads.getByRole('button', { name: /^Settled/ }).click()
      await expect(threads.getByRole('button', { name: 'Release notes 1.4', exact: true })).toHaveCount(1)
    }))
  })
})
