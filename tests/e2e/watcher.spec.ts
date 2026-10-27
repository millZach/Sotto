import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { hostEntityKey, parseHostEntityKey } from '../../src/shared/clientIdentity'
import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../src/renderer/src/e2e/watcherStandIn'
import { MACHINE_FACTS_OLDER, MACHINE_NOT_CONNECTED, type WatcherOwnChange } from '../../src/shared/watcher'
import type { WatcherRoomState } from '../../src/shared/watcherRoom'
import type { AgentMessage } from '../../src/shared/agents'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openPage, openThreads, userMessageTexts, type LaunchedSotto } from './support/sottoLaunch'
import { holdOwlSky } from './support/sottoOwl'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Watcher's room on the built app (ADR-0073, tickets 6 and 7's beside pane), with no sidebar as Zach picked on
 * October 11, 2026: the first entry by sending, the needs-you line, the Overview over the room on All threads, a thread
 * opened beside Watcher, the header switch and the badges, on the Sotto Owl track, with stable showing none of it.
 * Main's Watcher side is stood in for by a seeded projection (src/renderer/src/e2e/watcherStandIn.ts), so these runs
 * check the room on a fixed picture, except the journeys that seed nothing and run against main's own Watcher over
 * the fake Codex app server: its start, and its permissions, Watch and Stop watching and own-change line through main's
 * own calls and projection. Run after `npm run build`. Captures go to disposable run evidence;
 * `SOTTO_E2E_EVIDENCE=publish` writes artifacts/watcher-room.
 */
const evidenceRoot = evidenceDirectory('artifacts/watcher-room')
/** Watcher's permissions, its own changes and watching (Zach's picks on October 13, 2026): captures for their note. */
const permissionEvidence = evidenceDirectory('artifacts/watcher-permission')
/** The handover after a provider change (ADR-0073, #1026): captures for its note. */
const handoverEvidence = evidenceDirectory('artifacts/watcher-handover')
/** Receipt cards, the takeover line and Stop all (#1120): captures for their note. */
const polishEvidence = evidenceDirectory('artifacts/watcher-room-polish')
/** Answering a watched thread's request in Watcher's conversation (October 19, 2026): captures for its note. */
const answerEvidence = evidenceDirectory('artifacts/watcher-answer')
/** Watcher's replies to news in place, their work in the reply's header (Zach's pick on October 19, 2026): captures for their note. */
const newsEvidence = evidenceDirectory('artifacts/watcher-news-turns')
/** Watcher's header in the macOS layout, clear of the traffic lights in a narrow pane (#1214): captures for its note. */
const macEvidence = evidenceDirectory('artifacts/macos-traffic-light-room')
/** New Watcher in Watcher's composer (Zach's pick A of prototype/new-watcher-button): captures for its note. */
const newWatcherEvidence = evidenceDirectory('artifacts/new-watcher-button')
/** The machines line, a machine's panel and Where new workers start (#1032, pick D): captures for their note. */
const machinesEvidence = evidenceDirectory('artifacts/watcher-machines')
/** The message scrubber in Watcher's conversation (ADR-0109), beside the thread captures in message-scrubber.spec.ts. */
const scrubberEvidence = evidenceDirectory('artifacts/message-scrubber')
const FOOT = 'When Watcher asks, you can allow it once, not for good. Its instructions still tell it to hand changes to a thread.'
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const THEMES = [['t3-code', 'sotto'], ['fern', 'fern']] as const
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
  readonly ownChanges?: readonly WatcherOwnChange[]; readonly messages?: readonly AgentMessage[]; readonly activities?: readonly AgentActivity[]
  /** More of the projection, from the host's ID and the request's: receipts and takeovers. */
  readonly more?: (hostId: string, requestId: string) => Partial<WatcherRoomState>
  readonly stopResults?: WatcherStandInSeed['stopResults']; readonly stopDelayMs?: number
  /** The thread New Watcher makes the new Watcher, emptied first; without it, New Watcher refuses. */
  readonly startNew?: string
  /** What the machines read answers (#1032), from the host's ID. */
  readonly machines?: (hostId: string) => NonNullable<WatcherStandInSeed['machines']> }): Promise<void> {
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
      // Watcher started both, so main keeps a standing watch on each.
      history: [], runtimeMode: 'approval-required', ownChanges: [...options.ownChanges ?? []],
      standingWatches: options.current ? WATCHED.map(threadId => ({ id: randomUUID(), target: target(threadId), createdAt: at(12), generation: 0 })) : [],
      requests: options.current ? [{ id: requestId, watcher: identity.target, rootUserMessageId: 'watcher-ask', state: 'active', createdAt: at(12), closedAt: null, participants }] : [],
      watchedThreads: options.current ? participants.map(part => ({ target: part.target, title: part.target.threadId, watched: true, paused: false, status: 'running' as const, connected: true,
        settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [part] })) : [],
      receipts: [], recoveryNotice: null, observedAt: at(0),
    },
    created: identity,
    ...options.permissionConfirms === false ? { permissionConfirms: false } : {},
    ...options.stopResults ? { stopResults: options.stopResults } : {},
    ...options.stopDelayMs ? { stopDelayMs: options.stopDelayMs } : {},
    ...options.machines ? { machines: options.machines(hostId!) } : {},
    ...options.startNew ? { startNew: { created: { ...identity, target: target(options.startNew), creationOperationId: randomUUID(), createdAt: at(0) },
      counts: { total: 2, carried: 2, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: true },
      text: 'This is a handover from another Sotto thread. The history below is context, not a new request.\n\nThe user:\nFind why the visual gate flakes and fix the footer links. Keep an eye on both.' } } : {},
  }
  if (options.more) {
    const more = options.more(hostId!, requestId)
    seed.state = { ...seed.state, ...more, ...more.requests ? {} : { requests: seed.state.requests },
      ...more.watchedThreads ? {} : { watchedThreads: seed.state.watchedThreads } }
  }
  await page.evaluate(async ({ key, seed, master, history, extra, activities, emptied }) => {
    localStorage.setItem(key, JSON.stringify(seed))
    if (emptied !== null) await window.sottoE2E!.agentEvent!({ type: 'history', threadId: emptied, text: '', messages: [], status: 'idle' })
    if (history) await window.sottoE2E!.agentEvent!({ type: 'history', threadId: master, text: '', messages: [
      { id: 'watcher-ask', role: 'user', text: 'Find why the visual gate flakes and fix the footer links. Keep an eye on both.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 29)).toISOString() },
      { id: 'watcher-reply', role: 'assistant', text: 'Started Visual gate flake on Claude Code and Footer links on Codex, and I am watching both. Visual gate flake is asking to run the unit suite. Only you can allow that, in its own pane.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 33)).toISOString() },
      ...extra,
    ], ...activities.length ? { activities } : {} })
  }, { key: WATCHER_STAND_IN_KEY, seed, master: CURRENT, history: options.history !== false, extra: [...options.messages ?? []], activities: [...options.activities ?? []],
    emptied: options.startNew ?? null })
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
  await expect(page.locator('.watcher-head__rooms')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
}

test('an unconfirmed prompt has a recovery in the actual Watcher room', async () => {
  await onReleaseTrack('owl', () => withSotto({ ...launchOptions('t3-code', 'dark'), scenario: 'phase3-workspace' }, async launched => {
    const { page } = launched
    await seedRoom(page, { current: true, history: false })
    await openRoom(page)
    const prompt = page.getByRole('textbox', { name: 'Watcher message', exact: true })
    await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'uncertain', threadId, text: '' }), CURRENT)
    await prompt.fill('The prompt whose delivery could not be confirmed.')
    await prompt.press('Enter')
    await expect(page.getByLabel('Pending message')).toContainText('Unconfirmed')
    // The provider cannot recover the original echo: repeated checks cannot settle its delivery.
    await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'history', threadId, text: '', messages: [], status: 'idle' }), CURRENT)
    await prompt.fill('hello')
    await page.reload()
    await openRoom(page)
    await expect(prompt).toHaveText('hello')
    await page.getByRole('button', { name: 'Check again', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Continue with a new message', exact: true })).toBeEnabled()
    const evidence = evidenceDirectory('artifacts/unconfirmed-send')
    await mkdir(evidence, { recursive: true })
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
      for (const [width, height] of SIZES) {
        await resizeContentWindow(launched, width, height, [800, 540])
        await settle(page)
        expect(await pageBoundProblems(page)).toEqual([])
        await page.screenshot({ path: join(evidence, `watcher-recovery-${appearance}-${width}x${height}.png`), animations: 'disabled' })
        const contrast = await roomContrast(page)
        expect(contrast.filter(item => item.ratio < 4.5)).toEqual([])
      }
    }
    const recovery = page.getByRole('button', { name: 'Continue with a new message', exact: true })
    await recovery.focus()
    await page.keyboard.press('Enter')
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveText('hello')
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeEnabled()
    await expect(page.getByLabel('Pending message')).toContainText('Set aside · Unconfirmed')
    await page.screenshot({ path: join(evidence, 'watcher-set-aside-light-820x560.png'), animations: 'disabled' })
    await page.reload()
    await openRoom(page)
    await expect(prompt).toHaveText('hello')
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeEnabled()
    await prompt.press('Enter')
    await expect(prompt).toHaveText('')
    await expect.poll(() => userMessageTexts(page, CURRENT)).toEqual(['hello'])
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).deliveries?.filter(item => item.setAside)
      .map(item => ({ status: item.status, updatesResumed: item.updatesResumed })))).toEqual([{ status: 'uncertain', updatesResumed: true }])
    await prompt.fill('A new follow-up after recovery')
    await expect(page.getByRole('button', { name: 'Queue prompt', exact: true })).toBeEnabled()
    await prompt.press('Enter')
    await expect(prompt).toHaveText('')
    await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, text: 'The new turn finished.' }), CURRENT)
    await expect.poll(() => userMessageTexts(page, CURRENT)).toEqual(['hello', 'A new follow-up after recovery'])
    await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'permission', threadId, requestId: 'recovered-permission', text: 'Allow the next step?', status: 'running' }), CURRENT)
    const deny = page.getByRole('button', { name: 'Deny', exact: true })
    await deny.click()
    await expect(deny).toHaveCount(0)
    await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'question', threadId, requestId: 'recovered-question', text: 'Which step comes next?' }), CURRENT)
    const answer = page.getByRole('textbox', { name: 'Your answer', exact: true })
    await answer.fill('Use the next step')
    await answer.press('Enter')
    await expect(answer).toHaveCount(0)
    expect(await userMessageTexts(page, CURRENT)).toEqual(['hello', 'A new follow-up after recovery'])
  }))
})

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

/** The header's way off the page stays inside the window, every composer reaches no lower than the window's floor,
    and the window controls never cover a pane header's controls. */
async function roomEdges(page: Page, width: number, height: number): Promise<void> {
  const way = await box(page.locator('.watcher-head__way'))
  expect(way.x + way.width, `the way off the page at ${width}x${height}`).toBeLessThanOrEqual(width)
  const controls = await box(page.locator('.threads-view__winctl'))
  for (const composer of await page.locator('.thread-workspace__compose .thread-prompt').all()) {
    const card = await box(composer)
    expect(card.y + card.height, `a composer at ${width}x${height}`).toBeLessThanOrEqual(height)
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
    /** How much a fill covers what is under it, 0 to 255, as the canvas paints it. */
    const cover = (value: string): number => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = 'rgba(0, 0, 0, 0)'; context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      return context.getImageData(0, 0, 1, 1).data[3]!
    }
    // A faint tint, such as the lit room tile's 12% of the text colour, is read through to the surface under it: painted
    // alone it is the text's own colour, and the ink would measure against itself.
    const background = (element: Element): string => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent' && cover(color) >= 128) return hex(color)
      }
      return hex(getComputedStyle(document.body).backgroundColor)
    }
    // The night in the room's corner sits between the canvas and the header: text over it is measured against both,
    // unless the text sits on an opaque fill of its own, which hides the night under it.
    const sky = document.querySelector('.watcher-room__sky')?.getBoundingClientRect()
    const surfaces = (element: Element): string[] => {
      const under = background(element)
      const bounds = element.getBoundingClientRect()
      const fill = getComputedStyle(element).backgroundColor
      const ownFill = fill !== 'transparent' && !fill.startsWith('rgba(') && !fill.includes('/')
      const onSky = !ownFill && sky !== undefined && element.closest('.watcher-pane') !== null && bounds.top < sky.bottom && bounds.left < sky.right
      return onSky ? [under, token(element.closest('.watcher-room')!, '--tt-owl-room-night')] : [under]
    }
    const selectors = ['.watcher-head h1', '.watcher-head__list', '.watcher-head__count', '.watcher-glance__lead', '.watcher-glance__name', '.watcher-glance__why',
      '.watcher-pane .thread-chip', '.thread-options__caption', '.thread-chip-menu__options small', '.thread-chip-menu__foot', '.watched-note', '.watch-toggle', '.watch-toast > span',
      '.watcher-head__rooms button', '.watcher-group__label', '.watcher-group__count', '.watcher-row__title', '.watcher-row__status',
      '.watcher-row__where', '.watcher-row__asks > span', '.watcher-answer', '.watcher-list__foot', '.watcher-list .thread-nav__time', '.watcher-first__intro h2', '.watcher-first__intro p',
      '.watcher-beside .thread-workspace__head h2', '.watcher-own__words > strong', '.watcher-own__said', '.watcher-own__none', '.watcher-own__toggle', '.watcher-own__files code',
      '.watcher-handover__lead > p', '.watcher-handover__ledger', '.watcher-handover__read', '.watcher-handover__text', '.thread-prompt__send[data-wide]',
      '.watcher-handover-message__lead', '.watcher-handover-message__ledger', '.watcher-handover__disclose',
      '.thread-message__work', '.receipt-card__lead', '.receipt-card__name', '.receipt-link', '.receipt-outcome', '.receipt-card__meta', '.sotto-line p', '.sotto-line time',
      '.watcher-ask__title', '.watcher-ask__meta', '.watcher-ask__kind', '.watcher-ask__open', '.watcher-ask__toggle', '.watcher-ask__said-body', '.watcher-ask-receipt__words',
      '.watcher-stop-all__button', '.watcher-stop h2', '.watcher-stop__name', '.watcher-stop__where', '.watcher-stop__state', '.watcher-stop__note', '.watcher-stop__said',
      '.watcher-stop .tt-button',
      '.thread-message__status', '.thread-message__delivery > span', '.thread-message__delivery-actions .tt-button',
      '.watcher-machines__name', '.watcher-machines__count', '.watcher-machines__words', '.watcher-machines__sep', '.watcher-machines__more', '.receipt-card__placement',
      '.watcher-machine-panel h2', '.watcher-machine-panel dt', '.watcher-machine-panel dd', '.watcher-machine-panel p', '.watcher-machine-panel__title',
      '.watcher-machine-panel__who', '.watcher-machine-panel__link']
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0).slice(0, 6)
      .flatMap((element, index) => surfaces(element).map(on => ({ name: `${selector} ${index}${element.getAttribute('data-tone') ? ` (${element.getAttribute('data-tone')})` : ''}`, ink: hex(getComputedStyle(element).color), on }))))
  })
  return pairs.map(({ name, ink, on }) => ({ name, ratio: Number(contrastRatio(parseThemeRgb(ink, BLACK), parseThemeRgb(on, BLACK)).toFixed(2)) }))
}

/** The window, settled and with the night held still, into one evidence folder. */
async function captureInto(folder: string, launched: LaunchedSotto, name: string): Promise<void> {
  await settle(launched.page)
  await holdOwlSky(launched.page)
  await captureWindow(launched.app, resolve(folder, name))
}
const capture = (launched: LaunchedSotto, name: string): Promise<void> => captureInto(evidenceRoot, launched, name)
/** The permissions, own changes and watching note's own folder. */
const captureNote = (launched: LaunchedSotto, name: string): Promise<void> => captureInto(permissionEvidence, launched, name)
/** The handover's own folder. */
const captureHandover = (launched: LaunchedSotto, name: string): Promise<void> => captureInto(handoverEvidence, launched, name)

/**
 * Sotto Owl over the fake Codex app server the integration tests use, with nothing seeded, so the room reads main's own
 * bridge (preload's `window.sotto.watcher`, main's WatcherService). `script` is what the fake Codex does on every turn
 * until a journey rewrites `<root>/codex/script.json`; `<root>/worker` is a folder for a worker project.
 */
async function withMainWatcher(prefix: string, script: Readonly<Record<string, unknown>>, run: (launched: LaunchedSotto, root: string) => Promise<void>,
  providers: readonly ('codex' | 'claude')[] = ['codex']): Promise<void> {
  const profile = (await ownedE2EProfile({ prefix })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'worker']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify(script))
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  try {
    await onReleaseTrack('owl', async () => {
      const launched = await launchSotto('success', profile)
      try {
        const { page } = launched
        await page.evaluate(async providers => {
          await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
          const agents = window.sotto!.agents!
          await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: [...providers], checkClientUpdates: false } })
          for (const provider of providers) await agents.command({ type: 'connect', provider })
        }, providers)
        await page.reload()
        await openThreads(page)
        // Main's bridge, not a stand-in: nothing is seeded, and main answers that no Watcher exists yet.
        expect(await page.evaluate(key => localStorage.getItem(key), WATCHER_STAND_IN_KEY)).toBeNull()
        expect(await page.evaluate(async () => (await window.sotto!.watcher!.get()))).toMatchObject({ status: 'ok', state: { current: null } })
        await run(launched, root)
      } finally { await closeSotto(launched) }
    })
  } finally {
    if (previous.root === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = previous.root
    if (previous.executable === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = previous.executable
    await removeOwnedE2EProfile(profile)
  }
}

/** Main's projection of Watcher, read through the preload as the room reads it. */
async function mainRoom(page: Page): Promise<WatcherRoomState> {
  const read = await page.evaluate(async () => window.sotto!.watcher!.get())
  if (read.status !== 'ok') throw new Error(read.message)
  return read.state
}

/** A thread on Codex in a project of its own, made through main and given nothing to do; its window ID and main's address. */
async function createWorker(page: Page, folder: string, title: string): Promise<{ readonly id: string; readonly target: { readonly hostId: string; readonly threadId: string } }> {
  const id = await page.evaluate(async ({ path, title }) => {
    const agents = window.sotto!.agents!
    const opened = await agents.command({ type: 'create-project', title: 'Watch without sending', path, useExisting: true, provider: 'codex' })
    if (opened.error || !opened.activeProjectId) throw new Error('Could not create the test worker project.')
    const room = await window.sotto!.watcher!.get()
    if (room.status !== 'ok' || !room.state.currentOptions) throw new Error('Watcher is unavailable.')
    const created = await agents.command({ type: 'create-thread', projectId: opened.activeProjectId, modelId: room.state.currentOptions.modelId,
      title, workingCopy: 'shared', runtimeMode: 'approval-required' })
    if (created.error || !created.activeThreadId) throw new Error('Could not create the test worker.')
    return created.activeThreadId
  }, { path: folder, title })
  const hostId = (await mainRoom(page)).current!.target.hostId
  return { id, target: { hostId, threadId: parseHostEntityKey(id)?.id ?? id } }
}

/** Every reading in the room on or above 4.5:1, recorded under `key`. */
async function contrastHolds(page: Page, key: string): Promise<void> {
  const contrast = await roomContrast(page)
  for (const { name, ratio } of contrast) expect(ratio, `${name}, ${key}`).toBeGreaterThanOrEqual(4.5)
  recorded.set(key, contrast)
}

test.describe("Watcher's room on the built app", () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })
  test.beforeAll(async () => {
    for (const folder of [evidenceRoot, permissionEvidence, handoverEvidence, polishEvidence, newsEvidence, answerEvidence, macEvidence, newWatcherEvidence, machinesEvidence, scrubberEvidence]) await mkdir(folder, { recursive: true })
  })
  test.afterAll(async () => {
    // Each folder gets its own readings, and a run that took none for a folder leaves that folder's file as it was.
    const note = /^(permissions|own-changes|threads-watch|room-watched|list-watch)-/u
    const handover = /^handover-/u
    const polish = /^polish-/u
    const news = /^news-/u
    const answer = /^answer-/u
    const mac = /^mac-/u
    const fresh = /^new-watcher-/u
    const machines = /^machines-/u
    const folders = [[evidenceRoot, [...recorded].filter(([key]) => !note.test(key) && !handover.test(key) && !polish.test(key) && !news.test(key) && !answer.test(key) && !mac.test(key) && !fresh.test(key) && !machines.test(key))],
      [permissionEvidence, [...recorded].filter(([key]) => note.test(key))], [handoverEvidence, [...recorded].filter(([key]) => handover.test(key))],
      [polishEvidence, [...recorded].filter(([key]) => polish.test(key))], [newsEvidence, [...recorded].filter(([key]) => news.test(key))],
      [answerEvidence, [...recorded].filter(([key]) => answer.test(key))], [macEvidence, [...recorded].filter(([key]) => mac.test(key))],
      [newWatcherEvidence, [...recorded].filter(([key]) => fresh.test(key))], [machinesEvidence, [...recorded].filter(([key]) => machines.test(key))]] as const
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
      // No actions before Watcher runs; the needs-you line and All threads already work.
      await expect(page.locator('.watcher-head .watcher-stop-all')).toHaveCount(0)
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
      // Watcher's own pane takes the first entry's place: its conversation, with the message, over its composer.
      const pane = watcherPane(page)
      await expect(page.getByRole('heading', { level: 2, name: 'Start Watcher' })).toHaveCount(0)
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
      await expect(beside(page).getByText(/Watched by Watcher\./)).toHaveCount(0)
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

  test('a fork made beside Watcher opens there in place of its source, with the cursor in its composer (#1136)', async () => {
    // The workspace scenario's threads name their providers, which Fork from here needs.
    await onReleaseTrack('owl', () => withSotto({ ...launchOptions('t3-code', 'dark'), scenario: 'phase3-workspace' }, async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      await allThreads(page).click()
      await threadsList(page).getByRole('button', { name: 'Open Grok voice previews beside Watcher' }).click()
      await expect(beside(page)).toHaveAttribute('aria-label', 'Grok voice previews')
      const reply = beside(page).locator('.thread-message[data-role="assistant"]').last()
      await reply.hover()
      await reply.getByRole('button', { name: /^Fork from here/u }).click()
      await beside(page).getByRole('region', { name: 'Fork from here' }).getByRole('button', { name: /^(Fork|Start the .+ thread)$/u }).click()
      await expect(beside(page)).toHaveAttribute('aria-label', 'Fork of Grok voice previews')
      const forkId = await beside(page).getAttribute('data-thread-id')
      expect(forkId).not.toMatch(/grok-previews$/u)
      await expect(beside(page).getByRole('textbox', { name: 'Prompt' })).toBeFocused()
      await expect(page.getByRole('region', { name: 'Grok voice previews', exact: true })).toHaveCount(0)
    }))
  })

  test('in the macOS layout, Watcher’s header keeps its controls apart and clear of the traffic lights in a narrow pane', async () => {
    // A Windows run has no traffic lights; the room's own macOS layout is what moves the header clear of them.
    const read = (page: Page) => page.locator('.watcher-pane .watcher-head').evaluate(head => {
      const rect = (node: Element) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom } }
      const named = (node: Element) => node.getAttribute('aria-label') ?? node.textContent?.trim() ?? node.className
      // Shown, and not only to assistive technology (the name, below 450 pixels off macOS).
      const shown = (node: Element) => node.getBoundingClientRect().width > 1 && getComputedStyle(node).display !== 'none' && getComputedStyle(node).clipPath === 'none'
      const parts = [head.querySelector('.watcher-head__tile'), head.querySelector('h1'), head.querySelector('.watcher-head__list'),
        ...head.querySelectorAll('.watcher-head__way :is([role="tab"], a, button)'), ...head.querySelectorAll('.thread-workspace__actions > * > button')].filter((node): node is Element => node !== null && shown(node))
      const style = getComputedStyle(head)
      return {
        pane: head.closest('.thread-pane')!.getBoundingClientRect().width,
        head: { ...rect(head), right: head.getBoundingClientRect().right - parseFloat(style.paddingRight), height: head.getBoundingClientRect().height },
        parts: parts.map(node => ({ name: named(node), ...rect(node) })),
        // A label or count cut off by its own control.
        clipped: [...head.querySelectorAll('.watcher-head__list, .thread-workspace__actions button, h1')].filter(shown)
          .filter(node => node.scrollWidth > node.clientWidth + 0.5).map(named),
      }
    })
    const apart = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) =>
      a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5
    // The divider's Home key gives Watcher its 400-pixel minimum; each Arrow Right after it adds 5 per cent of the room.
    const SPOTS = [[1280, 800, 0], [820, 560, 0], [1600, 1000, 1], [1600, 1000, 2], [1600, 1000, 3], [1600, 1000, 4]] as const
    const result: Record<string, unknown> = {}
    await onReleaseTrack('owl', async () => {
      for (const appearance of ['dark', 'light'] as const) await withSotto(launchOptions('t3-code', appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true })
        await resizeContentWindow(launched, 1280, 800)
        await openRoom(page)
        await page.getByRole('button', { name: 'Open Visual gate flake to answer its permission' }).click()
        await expect(beside(page)).toBeVisible()
        for (const platform of ['win32', 'darwin'] as const) {
          await page.locator('.watcher-room').evaluate((room, mac) => {
            room.classList.toggle('threads-view--mac', mac)
            // macOS draws its own traffic lights and has none of Sotto's window controls.
            room.querySelector<HTMLElement>('.threads-view__winctl')?.style.setProperty('display', mac ? 'none' : '')
          }, platform === 'darwin')
          // Off macOS this checks the two narrowest panes, which this change leaves as they were.
          for (const [width, height, steps] of platform === 'darwin' ? SPOTS : SPOTS.slice(0, 2)) {
            await resizeContentWindow(launched, width, height)
            await settle(page)
            const divider = page.getByRole('separator', { name: 'Resize panes' })
            await divider.focus()
            await page.keyboard.press('Home')
            for (let step = 0; step < steps; step += 1) await page.keyboard.press('ArrowRight')
            await settle(page)
            const reading = await read(page)
            const where = `${platform}, ${Math.round(reading.pane)}px pane at ${width}x${height}, ${appearance}`
            if (steps === 0) expect(reading.pane, where).toBeLessThan(410)
            for (const [index, part] of reading.parts.entries()) {
              for (const other of reading.parts.slice(index + 1)) expect.soft(apart(part, other), `${part.name} over ${other.name}, ${where}`).toBe(true)
              expect.soft(part.right, `${part.name} inside the header, ${where}`).toBeLessThanOrEqual(reading.head.right + 0.5)
              expect.soft(part.bottom, `${part.name} inside the header, ${where}`).toBeLessThanOrEqual(reading.head.bottom + 0.5)
            }
            expect.soft(reading.clipped, where).toEqual([])
            if (platform === 'darwin') {
              // Nothing of the header's in the traffic lights' row where they are drawn, 16 to about 76 pixels in.
              for (const part of reading.parts.filter(candidate => candidate.top < 38)) expect.soft(part.left, `${part.name} clear of the traffic lights, ${where}`).toBeGreaterThanOrEqual(84)
            } else expect.soft(reading.head.height, `one row, ${where}`).toBe(44)
            result[`mac-header-${platform}-${appearance}-${Math.round(reading.pane)}px-${width}x${height}`] = reading
            if (platform === 'darwin') {
              // The capture draws the traffic lights in where macOS 26 puts them (16 pixels in and down, about 60 across),
              // so the picture shows the room they keep.
              await page.evaluate(() => {
                const lights = document.body.appendChild(document.createElement('div'))
                lights.id = 'e2e-mac-lights'
                lights.setAttribute('aria-hidden', 'true')
                lights.style.cssText = 'position: fixed; top: 16px; left: 16px; z-index: 99999; display: flex; gap: 9px; pointer-events: none;'
                for (const colour of ['#ff5f57', '#febc2e', '#28c840']) lights.appendChild(document.createElement('span')).style.cssText = `width: 14px; height: 14px; border-radius: 50%; background: ${colour};`
              })
              await captureInto(macEvidence, launched, `mac-header-${appearance}-${Math.round(reading.pane)}px-${width}x${height}.png`)
              await page.evaluate(() => document.getElementById('e2e-mac-lights')?.remove())
            }
          }
        }
      })
    })
    recorded.set('mac-header', result)
  })

  test('the header switch answers the keyboard, and Tab follows the eye through the room', async () => {
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
      // In Watcher's room the switch sits right after All threads, where the tabs were (Zach, October 27, 2026), and
      // focus is on its lit owl.
      await expect(page.locator('.watcher-head').getByRole('tab', { name: 'Watcher' })).toBeFocused()
      const rooms = await box(page.locator('.watcher-head__rooms'))
      const list = await box(allThreads(page))
      expect(rooms.y + rooms.height).toBeLessThanOrEqual(44)
      expect(rooms.x).toBeGreaterThanOrEqual(list.x + list.width)
      expect(rooms.x).toBeLessThan(list.x + list.width + 16)
      await press('ArrowLeft', 'Dictate')
      await press('End', 'Threads')
      await press('Home', 'Dictate')
      await press('ArrowRight', 'Watcher')
      await press('ArrowRight', 'Threads')
      await press('ArrowLeft', 'Watcher')
      // Tab from All threads: the header (the room switch's one stop on the lit owl, the pages, the update control, then
      // Stop all while threads Watcher started run), the needs-you line, the conversation, then the composer.
      await allThreads(page).focus()
      const order: string[] = []
      for (let step = 0; step < 50 && !order.includes('Watcher message'); step++) {
        await page.keyboard.press('Tab')
        order.push(await focusedName(page))
      }
      recorded.set('tab-order', order)
      const indexOf = (name: string | RegExp): number => order.findIndex(entry => typeof name === 'string' ? entry === name : name.test(entry))
      expect(order.slice(0, 4)).toEqual(['Watcher', 'Usage', 'Settings', 'Help'])
      const stopAll = indexOf('Stop all threads Watcher started, 2 threads')
      // The update control, where the app updates itself, sits between Help and Stop all.
      expect(stopAll).toBeGreaterThanOrEqual(4)
      expect(stopAll).toBeLessThanOrEqual(5)
      expect(order.some(entry => /^More/.test(entry))).toBe(false)
      expect(indexOf(/^Open Visual gate flake to answer/)).toBeGreaterThan(stopAll)
      expect(indexOf('Watcher message')).toBeGreaterThan(indexOf(/^Open Streaming WAV stall/))
      for (const name of ['Settings', 'Help'] as const) {
        await openPage(page, name)
        await expect(switchTab(page, 'Dictate')).toHaveAttribute('tabindex', '0')
        await switchTab(page, 'Dictate').focus()
        await press('ArrowRight', 'Watcher')
        await press('End', 'Threads')
      }
    }))
  })

  test('badges, and no Threads in flight to set, with Watcher kept out of Threads', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await resizeContentWindow(launched, 1600, 1000)
      // On Threads: the owl after a watched thread's provider logo, Watch pressed in its pane with nothing under the composer, and Watcher is not listed.
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
      await expect(workerPane.getByText(/Watched by Watcher\./)).toHaveCount(0)
      await expect(workerPane.getByRole('button', { name: 'Watch Footer links', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await resizeContentWindow(launched, 1280, 800)
      expect(await pageBoundProblems(page)).toEqual([])
      await capture(launched, 'threads-watched-sotto-dark-1280x800.png')

      await openRoom(page)
      const pane = watcherPane(page)
      // The limit no longer counts watching, so the room has no meter for it.
      await expect(pane.getByRole('meter')).toHaveCount(0)
      await expect(pane.getByText('Only you can allow that, in its own pane.')).toBeVisible()
      await allThreads(page).click()
      // In the list the owl is drawn on each thread Watcher watches, and the row's description says it, so it is not read twice.
      await expect(threadsList(page).locator('.watcher-row .watched-badge')).toHaveCount(WATCHED.length)
      const watchedRow = threadsList(page).locator('.watcher-row').filter({ hasText: 'Visual gate flake' })
      await expect(watchedRow.locator('.watched-badge')).toBeVisible()
      await expect(watchedRow.getByRole('button', { name: 'Open Visual gate flake beside Watcher' })).toHaveAccessibleDescription(/Watched by Watcher/)
      await page.keyboard.press('Escape')

      // There is no Threads in flight limit to set (#1183), so the header has no More Watcher actions.
      await expect(page.getByRole('button', { name: 'More Watcher actions' })).toHaveCount(0)
      await expect(page.getByRole('combobox', { name: 'Threads in flight' })).toHaveCount(0)
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

  test('a long Watcher conversation has the message scrubber, its cards naming Watcher', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true })
      await openRoom(page)
      const pane = watcherPane(page)
      await page.evaluate(async master => {
        await window.sottoE2E!.agentEvent!({ type: 'history', threadId: master, text: '', messages: Array.from({ length: 40 }, (_, index) => ({
          id: `watcher-scrub-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
          text: index % 2 ? `Watching it. Package (Windows) is still running for message ${(index - 1) / 2 + 1}, and I will say when it finishes.` : `Is the release thread green yet? (${index / 2 + 1})`,
          createdAt: new Date(Date.UTC(2026, 6, 12, 18, index)).toISOString() })) })
      }, CURRENT)
      await expect(pane.getByText('Is the release thread green yet? (20)', { exact: true })).toBeVisible()
      const scrubber = pane.getByRole('navigation', { name: 'Messages you sent' })
      for (const [width, height] of SIZES) {
        await resizeContentWindow(launched, width, height)
        await settle(page)
        await expect(scrubber.getByRole('button')).toHaveCount(20)
        // The lane is the margin's, left of the conversation's column.
        const lane = (await scrubber.boundingBox())!
        const column = (await pane.locator('.thread-transcript__content').boundingBox())!
        expect(lane.x + lane.width).toBeLessThanOrEqual(column.x + 0.5)
        const tick = (await scrubber.getByRole('button').nth(4).boundingBox())!
        await page.mouse.move(tick.x + tick.width / 2, tick.y + tick.height / 2)
        const card = pane.locator('.message-scrubber__card')
        await expect(card).toContainText('Message 5 of 20')
        await expect(card).toContainText('Is the release thread green yet? (5)')
        await expect(card).toContainText('Watcher replied')
        await page.evaluate(() => Promise.all(document.querySelector('.message-scrubber__card')!.getAnimations().map(animation => animation.finished)))
        expect(await pageBoundProblems(page), `scrubber at ${width}x${height}`).toEqual([])
        await captureInto(scrubberEvidence, launched, `watcher-hover-dark-${width}x${height}.png`)
        await page.mouse.move(0, 0)
        await expect(card).toHaveCount(0)
      }
    }))
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
      { id: 'watcher-fixed', role: 'assistant', text: 'I fixed “npm instal” in README.md and docs/guide.md myself.', createdAt: new Date(Date.UTC(2026, 6, 12, 19, 41)).toISOString() },
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

  test('Watcher’s replies to news sit in place, their work in the reply’s header, nothing stacked under the last reply', async () => {
    // What main hands the window (watcherWakeUpsAsShown): Watcher's replies without the news wake-ups that began their
    // turns, whose work still names them. Times follow Zach's Watcher thread of October 19, 2026.
    const clock = (minute: number, second: number): string => new Date(Date.UTC(2026, 6, 12, 19, minute, 0) + second * 1000).toISOString()
    const said = (id: string, role: AgentMessage['role'], minute: number, second: number, text: string): AgentMessage => ({ id, role, text, createdAt: clock(minute, second) })
    let sequence = 100
    const work = (turnId: string, from: readonly [number, number], to: readonly [number, number], tools: readonly string[], status: AgentActivity['status'] = 'completed'): AgentActivity[] => [
      { id: `turn-${turnId}`, turnId, afterMessageId: turnId, sequence: sequence++, kind: 'turn', status, title: 'Turn', startedAt: clock(...from), completedAt: clock(...to) },
      ...tools.map((title): AgentActivity => ({ id: `${turnId}-${sequence}`, turnId, afterMessageId: turnId, sequence: sequence++, kind: title === 'Thinking' ? 'reasoning' : 'tool',
        status: 'completed', title, startedAt: clock(...from), completedAt: clock(...to) })),
    ]
    const messages: AgentMessage[] = [
      said('watcher-news-reply-1', 'assistant', 35, 7, 'Visual gate flake asked to run the unit suite. Only you can allow that, in its own pane.'),
      said('watcher-news-reply-2', 'assistant', 36, 30, 'Footer links finished its turn and pushed its branch. CI is running; I will look again when it ends.'),
      said('watcher-ask-2', 'user', 38, 0, 'Merge Footer links once CI is green.'),
      said('watcher-merge', 'assistant', 38, 27, 'Sent Footer links the merge. It merges once its required checks pass.'),
      said('watcher-news-reply-3', 'assistant', 39, 45, 'Footer links merged.'),
    ]
    const activities = [
      ...work('watcher-ask', [29, 1], [33, 0], ['Thinking', 'list_projects', 'start_thread', 'start_thread']),
      ...work('news-1', [35, 0], [35, 7.1], ['Thinking', 'read_thread', 'read_operation']),
      ...work('news-2', [36, 23], [36, 30.4], ['read_operation', 'Thinking']),
      ...work('news-silent', [37, 10], [37, 13], ['list_threads']),
      ...work('watcher-ask-2', [38, 1], [38, 28], ['Thinking', 'send_thread']),
      ...work('news-3', [39, 40], [39, 45.5], ['read_operation']),
    ]
    await onReleaseTrack('owl', async () => {
      for (const appearance of ['dark', 'light'] as const) await withSotto(launchOptions('t3-code', appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true, messages, activities })
        await resizeContentWindow(launched, 1280, 800)
        await openRoom(page)
        const pane = watcherPane(page)
        const transcript = pane.locator('.thread-transcript__content')
        await expect(pane.locator('[data-message-id="watcher-news-reply-3"]')).toBeVisible()
        // Every turn in time order: the work of each comes before its reply, and the newest reply is the last thing drawn.
        const words = await transcript.evaluate(element => element.textContent ?? '')
        const order = ['Find why the visual gate flakes', 'Started Visual gate flake', 'After news · 7.1s', 'asked to run the unit suite', 'After news · 7.4s', 'pushed its branch',
          'Merge Footer links once CI is green.', 'Sent Footer links the merge.', 'After news · 5.5s', 'Footer links merged.']
        expect(order.map(text => words.indexOf(text)).every((index, n, all) => index >= 0 && (n === 0 || index > all[n - 1]!)), words).toBe(true)
        expect(await transcript.locator('.thread-activity').count(), 'no stacked rows of news work').toBe(0)
        // The news turn that wrote nothing shows nothing; your turns keep their Worked for lines.
        await expect(transcript.locator('[data-turn-id="news-silent"]')).toHaveCount(0)
        await expect(transcript.getByRole('button', { name: /^Worked for/u })).toHaveCount(2)
        // The work opens from the keyboard under the reply's header, and Escape folds it back.
        const reply = pane.locator('[data-message-id="watcher-news-reply-1"]')
        const press = reply.getByRole('button', { name: 'After news · 7.1s' })
        await press.focus()
        await page.keyboard.press('Enter')
        await expect(press).toHaveAttribute('aria-expanded', 'true')
        await expect(reply.locator('.thread-message__work-body')).toContainText('Used 2 tools, thought once')
        for (const [width, height] of appearance === 'dark' ? SIZES : [[1280, 800]] as const) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          await reply.scrollIntoViewIfNeeded()
          expect(await pageBoundProblems(page), `news replies at ${width}x${height}`).toEqual([])
          await captureInto(newsEvidence, launched, `news-open-${appearance}-${width}x${height}.png`)
          await contrastHolds(page, `news-${appearance}-${width}x${height}`)
        }
        await press.focus()
        await page.keyboard.press('Escape')
        await expect(press).toHaveAttribute('aria-expanded', 'false')
        await expect(press).toBeFocused()
        await resizeContentWindow(launched, 1280, 800)
        await settle(page)
        await pane.locator('[data-message-id="watcher-news-reply-3"]').scrollIntoViewIfNeeded()
        await captureInto(newsEvidence, launched, `news-folded-${appearance}-1280x800.png`)
      })
    })
  })

  test('Watcher’s conversation keeps a reader’s place while Watcher works on news, and follows the end only from the end', async () => {
    // The wake-up that begins a news turn is left out of Watcher's conversation (watcherWakeUpsAsShown), so until its first
    // reply the turn has nothing drawn: only its work, under your last turn. That turn stays as it finished (#1452).
    const clock = (minute: number, second = 0): string => new Date(Date.UTC(2026, 6, 12, 18, minute, second)).toISOString()
    const said = (id: string, role: AgentMessage['role'], minute: number, text: string, second = 0): AgentMessage => ({ id, role, text, createdAt: clock(minute, second) })
    const long = (what: string): string => Array.from({ length: 14 }, (_, n) =>
      `${what}, paragraph ${n + 1}. ${'Watcher read the thread and says what changed, what waits on you and what comes next. '.repeat(3)}`).join('\n\n')
    let sequence = 1000
    const work = (turnId: string, from: number, to: number, tools: readonly string[], status: 'running' | 'completed' = 'completed'): AgentActivity[] => [
      { id: `turn-${turnId}`, turnId, afterMessageId: turnId, sequence: sequence++, kind: 'turn', status, title: 'Turn', startedAt: clock(from), ...status === 'completed' ? { completedAt: clock(to) } : {} },
      ...tools.map((title): AgentActivity => ({ id: `${turnId}-${title}`, turnId, afterMessageId: turnId, sequence: sequence++, kind: title === 'Thinking' ? 'reasoning' : 'tool',
        status, title, startedAt: clock(from), ...status === 'completed' ? { completedAt: clock(to) } : {} })),
    ]
    const messages: AgentMessage[] = []
    const activities: AgentActivity[] = []
    for (let turn = 0; turn < 4; turn++) {
      const at = turn * 6
      messages.push(said(`ask-${turn}`, 'user', at, `Question ${turn} for Watcher.`))
      // The replies written on the way fold under the turn's Worked for line.
      for (let step = 0; step < 4; step++) messages.push(said(`step-${turn}-${step}`, 'assistant', at + 1, `Looking at part ${step + 1} of question ${turn}. ${'Reading it first. '.repeat(8)}`, step * 10))
      messages.push(said(`final-${turn}`, 'assistant', at + 2, long(`Answer ${turn}`)))
      activities.push(...work(`ask-${turn}`, at, at + 2, ['Thinking', 'read_thread', 'list_threads', 'read_operation']))
      if (turn < 3) {
        messages.push(said(`news-reply-${turn}`, 'assistant', at + 4, `News ${turn}: Footer links pushed its branch.`, 5))
        activities.push(...work(`news-${turn}`, at + 4, at + 5, ['Thinking', 'read_operation']))
      }
    }
    await onReleaseTrack('owl', async () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true, history: false })
      const history = (next: { readonly messages: readonly AgentMessage[]; readonly activities: readonly AgentActivity[]; readonly status: 'idle' | 'running' }) =>
        page.evaluate(async ({ master, next }) => window.sottoE2E!.agentEvent!({ type: 'history', threadId: master, text: '', ...next }),
          { master: CURRENT, next: { ...next, messages: [...next.messages], activities: [...next.activities] } })
      await history({ messages, activities, status: 'idle' })
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      const pane = watcherPane(page)
      const log = pane.getByRole('log', { name: 'Thread transcript' })
      // What the reader is reading: the first paragraph or line reaching the top of the view, and where it starts.
      const reading = () => log.evaluate(element => {
        const top = element.getBoundingClientRect().top
        const first = [...element.querySelectorAll('.thread-transcript__content p, .thread-transcript__content button')].find(item => item.getBoundingClientRect().bottom > top + 1)
        return { words: (first?.textContent ?? '').slice(0, 48), offset: first ? Math.round(first.getBoundingClientRect().top - top) : null }
      })
      const fromEnd = () => log.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
      const newsTurn = (id: string) => pane.locator(`.thread-activity[data-turn-id="${id}"]`)
      const reply = (id: string) => pane.locator(`[data-message-id="${id}"]`)
      // The control that takes the reader to the newest message, named for what it brings.
      const toLatest = pane.getByRole('button', { name: /^(Jump to latest|New messages)$/u })
      // Inside your last turn's answer, and higher up in the conversation.
      for (const [answer, paragraph] of [['final-3', 'Answer 3, paragraph 4.'], ['final-1', 'Answer 1, paragraph 4.']] as const) {
        // Each reading has news of its own, since a turn that ended is never reopened.
        const news = `news-${answer}`, silent = `silent-${answer}`
        const newsReply = said(`reply-${answer}`, 'assistant', 40, 'Footer links merged.', 20)
        await history({ messages, activities, status: 'idle' })
        await expect(reply(answer).getByText(paragraph)).toBeVisible()
        await settle(page)
        await reply(answer).getByText(paragraph).evaluate(element => element.scrollIntoView({ block: 'start' }))
        await expect(toLatest).toBeVisible()
        await settle(page)
        const read = await reading()
        expect(read.words, `reading ${answer}`).toContain(paragraph)
        expect(await fromEnd(), `${answer} is away from the end`).toBeGreaterThan(400)
        const steps = [
          ['news starts', { messages, activities: [...activities, ...work(news, 40, 40, ['Thinking'], 'running')], status: 'running' },
            () => expect(newsTurn(news)).toHaveCount(1)],
          ['its reply arrives', { messages: [...messages, newsReply], activities: [...activities, ...work(news, 40, 40, ['Thinking'], 'running')], status: 'running' },
            () => expect(reply(newsReply.id)).toBeVisible()],
          ['it ends', { messages: [...messages, newsReply], activities: [...activities, ...work(news, 40, 41, ['Thinking'])], status: 'idle' },
            () => expect(reply(newsReply.id).getByRole('button', { name: /^After news/u })).toBeVisible()],
          ['silent news starts', { messages: [...messages, newsReply], activities: [...activities, ...work(news, 40, 41, ['Thinking']), ...work(silent, 42, 42, ['list_threads'], 'running')], status: 'running' },
            () => expect(newsTurn(silent)).toHaveCount(1)],
          ['it ends with no reply', { messages: [...messages, newsReply], activities: [...activities, ...work(news, 40, 41, ['Thinking']), ...work(silent, 42, 43, ['list_threads'])], status: 'idle' },
            () => expect(newsTurn(silent)).toHaveCount(0)],
        ] as const
        for (const [what, next, drawn] of steps) {
          await history(next)
          await drawn()
          await settle(page)
          expect(await reading(), `reading ${answer} when ${what}`).toEqual(read)
        }
      }
      // At the end, the conversation follows what arrives; the keyboard takes a reader there from higher up.
      await toLatest.focus()
      await page.keyboard.press('Enter')
      await expect(toLatest).toHaveCount(0)
      await history({ messages: [...messages, said('news-reply-later', 'assistant', 45, long('Later news'))], activities, status: 'idle' })
      await expect(reply('news-reply-later')).toBeVisible()
      await expect.poll(fromEnd).toBeLessThanOrEqual(1)
    }))
  })

  test('receipt cards, the takeover line and Stop all, from the keyboard at every size', async () => {
    // Watcher started Visual gate flake and Footer links and stopped Grok voice previews in its reply; the user then sent
    // in Weekly note, which Watcher was driving.
    const more = (hostId: string, requestId: string): Partial<WatcherRoomState> => {
      const target = (threadId: string) => ({ hostId, threadId })
      const operation = (threadId: string, action: 'start' | 'stop') => ({ id: randomUUID(), requestId, retryKey: randomUUID(), digest: '0'.repeat(64), action, target: target(threadId),
        generation: 0, deliveryState: 'accepted' as const, createdAt: at(8), updatedAt: at(8), receiptId: randomUUID(), cardId: randomUUID() })
      const receipts = [operation('visual-gate', 'start'), operation('footer-links', 'start'), operation('grok-previews', 'stop')]
      const participant = (threadId: string) => ({ requestId, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target(threadId), promptCount: 1 })
      const taken = { ...participant('weekly-note'), generation: 1, state: 'taken-over' as const, takeover: { reason: 'user-send' as const, at: new Date(Date.UTC(2026, 6, 12, 19, 36)).toISOString() } }
      const participants = [...WATCHED.map(participant), taken]
      return { receipts, receiptReplies: receipts.map(item => ({ operationId: item.id, messageId: 'watcher-reply' })),
        requests: [{ id: requestId, watcher: target(CURRENT), rootUserMessageId: 'watcher-ask', state: 'active', createdAt: at(12), closedAt: null, participants }],
        watchedThreads: participants.map(part => ({ target: part.target, title: part.target.threadId, watched: part.state === 'participating', paused: false,
          status: 'running' as const, connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [part] })) }
    }
    await onReleaseTrack('owl', async () => {
      for (const appearance of ['dark', 'light'] as const) await withSotto(launchOptions('t3-code', appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true, more, stopResults: { 'visual-gate': { status: 'requested', message: 'Stop requested.' } } })
        await resizeContentWindow(launched, 1280, 800)
        await openRoom(page)
        const pane = watcherPane(page)
        // One card per action under the reply that took it; a name is a link only on its card.
        const cards = pane.getByRole('list', { name: 'What Watcher did' }).getByRole('listitem')
        await expect(cards).toHaveCount(3)
        await expect(cards.nth(0)).toContainText('Started')
        await expect(cards.nth(0).getByRole('button', { name: 'Open Visual gate flake beside Watcher' })).toBeVisible()
        await expect(cards.nth(0)).toContainText('This computer')
        await expect(cards.nth(2)).toContainText('Stopped')
        await expect(pane.locator('[data-message-id="watcher-reply"] .thread-message__text').getByRole('button')).toHaveCount(0)
        const line = pane.locator('.sotto-line')
        await expect(line.locator('p')).toHaveText('You took over Weekly note. Watcher stopped sending to it.')
        // Stop all, for the two threads Watcher started that still run, never the one the user took over.
        const stopAll = page.getByRole('button', { name: 'Stop all threads Watcher started, 2 threads' })
        await expect(stopAll).toBeVisible()
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          await line.scrollIntoViewIfNeeded()
          expect(await pageBoundProblems(page), `receipts at ${width}x${height}`).toEqual([])
          await captureInto(polishEvidence, launched, `polish-receipts-${appearance}-${width}x${height}.png`)
          await contrastHolds(page, `polish-receipts-${appearance}-${width}x${height}`)
        }
        // From the keyboard: Stop all asks first, with Cancel taking focus, and Escape returns to it.
        await resizeContentWindow(launched, 1280, 800)
        await stopAll.focus()
        await page.keyboard.press('Enter')
        const ask = page.getByRole('dialog', { name: 'Stop the 2 threads Watcher started?' })
        await expect(ask).toContainText('Each stops its current turn and keeps the work it has done. Threads you started or took over keep running.')
        await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused()
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          expect(await pageBoundProblems(page), `Stop all at ${width}x${height}`).toEqual([])
          await captureInto(polishEvidence, launched, `polish-stop-ask-${appearance}-${width}x${height}.png`)
          await contrastHolds(page, `polish-stop-ask-${appearance}-${width}x${height}`)
        }
        await page.keyboard.press('Escape')
        await expect(ask).toHaveCount(0)
        await expect(stopAll).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(ask.getByRole('button', { name: 'Stop 2 threads' })).toBeFocused()
        await page.keyboard.press('Enter')
        const done = page.getByRole('dialog', { name: 'Stopped 1 of 2. One is waiting to confirm.' })
        await expect(done).toContainText('Stopped.')
        await expect(done).toContainText('Stop requested. Waiting for it to confirm.')
        await expect(done.getByRole('button', { name: 'Close' })).toBeFocused()
        await captureInto(polishEvidence, launched, `polish-stop-done-${appearance}-${SIZES[2][0]}x${SIZES[2][1]}.png`)
        await contrastHolds(page, `polish-stop-done-${appearance}`)
        await page.keyboard.press('Escape')
        // Visual gate flake is still running, so Stop all stays, now for it alone.
        await expect(page.getByRole('button', { name: 'Stop all threads Watcher started, 1 thread' })).toBeFocused()
      })
    })
  })

  test('the machines line names each machine, its panel opens and closes from the keyboard, and Settings chooses where new workers start (#1032)', async () => {
    const FORGE = '0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10', STUDIO = 'c5e2a1f8-9b3d-4e72-a6c1-3f8d2b5e9a07', LAB = '4e8a2c6f-1b7d-4a93-9e05-7c3f1d8b2a64'
    const GIB = 1024 ** 3
    const now = new Date().toISOString()
    const load = (cpu: number, available: number) => ({ observedAt: now, windowMs: 2_000, cpuBusyPercent: cpu, loadAverage: null, availableMemoryBytes: available * GIB,
      windowStartAvailableMemoryBytes: available * GIB, memoryPressurePercent: null })
    const facts = (name: string, family: 'windows' | 'linux' | 'macos', cpus: number, total: number) => ({ observedAt: now, os: { family, name, version: null }, architecture: 'x64',
      totalMemoryBytes: total * GIB, freeMemoryBytes: null, logicalCpuCount: cpus })
    const machines = (hostId: string): NonNullable<WatcherStandInSeed['machines']> => ({ status: 'ok', observedAt: now, newWorkersStart: { choice: 'machine', hostId: FORGE, name: 'forge' }, machines: [
      { hostId, name: 'This computer', thisComputer: true, connected: true, factsState: 'reported', facts: facts('Windows 11', 'windows', 16, 32), runningThreads: 2, load: load(34, 14),
        placedNotStarted: 0, memoryState: 'enough', cpuState: 'not-busy' },
      { hostId: FORGE, name: 'forge', thisComputer: false, connected: true, factsState: 'reported', facts: facts('Omarchy', 'linux', 24, 64), runningThreads: 3, load: load(93, 41),
        placedNotStarted: 1, memoryState: 'enough', cpuState: 'busy' },
      { hostId: STUDIO, name: 'studio', thisComputer: false, connected: true, factsState: 'unknown', facts: null, note: MACHINE_FACTS_OLDER, runningThreads: null, load: null,
        placedNotStarted: null, memoryState: 'unknown', cpuState: 'unknown' },
      { hostId: LAB, name: 'lab', thisComputer: false, connected: false, factsState: 'not-connected', facts: null, note: MACHINE_NOT_CONNECTED, runningThreads: null, load: null,
        placedNotStarted: null, memoryState: 'unknown', cpuState: 'unknown' }] })
    // Watcher started Visual gate flake here, not on forge where new workers start, and Footer links on forge.
    const more = (hostId: string, requestId: string): Partial<WatcherRoomState> => {
      const operation = (threadId: string) => ({ id: randomUUID(), requestId, retryKey: randomUUID(), digest: '0'.repeat(64), action: 'start' as const, target: { hostId, threadId },
        generation: 0, deliveryState: 'accepted' as const, createdAt: at(8), updatedAt: at(8), receiptId: randomUUID(), cardId: randomUUID() })
      const receipts = [operation('visual-gate'), operation('footer-links')]
      return { receipts, receiptReplies: receipts.map(item => ({ operationId: item.id, messageId: 'watcher-reply' })),
        receiptPlacements: [{ operationId: receipts[0]!.id, placement: { hostId, name: 'This computer', awayFromDefault: true, note: 'Forge, where new workers start, is not connected, so this one started on This computer.' } },
          { operationId: receipts[1]!.id, placement: { hostId: FORGE, name: 'forge', awayFromDefault: false } }] }
    }
    await onReleaseTrack('owl', async () => {
      for (const appearance of ['dark', 'light'] as const) await withSotto(launchOptions('t3-code', appearance, 'reduced'), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, { current: true, more, machines })
        await resizeContentWindow(launched, 1280, 800)
        await openRoom(page)
        // The night scene lays its owls out again a moment after the window resizes, so bounds are read once it has.
        const line = page.getByRole('group', { name: 'Machines and what works on each' })
        const wide = line.locator('.watcher-machines__wide')
        await expect(wide).toHaveText(/^This computer \d+ working·forge 0 working, 1 starting, busy·studio 0 working, load unknown·lab not connected$/u)
        await expect(page.locator('.receipt-card__placement')).toHaveText(['Forge, where new workers start, is not connected, so this one started on This computer.'])
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          await page.locator('.receipt-card').last().scrollIntoViewIfNeeded()
          await settle(page)
          await expect.poll(() => pageBoundProblems(page), { message: `the machines line at ${width}x${height}` }).toEqual([])
          await captureInto(machinesEvidence, launched, `machines-line-${appearance}-${width}x${height}.png`)
          await contrastHolds(page, `machines-line-${appearance}-${width}x${height}`)
        }
        // From the keyboard: the name opens its panel with focus in it, Tab stays inside, and Escape closes it back to the name.
        await resizeContentWindow(launched, 1280, 800)
        const forge = wide.getByRole('button', { name: 'forge, 0 working, 1 starting, busy. Show forge’s load and what runs there.' })
        await forge.focus()
        await page.keyboard.press('Enter')
        const panel = page.getByRole('dialog', { name: 'forge' })
        await expect(panel).toBeFocused()
        await expect(panel).toContainText('93% busy over the last 2 seconds. Busy')
        await expect(panel).toContainText('41 GB of 64 GB available')
        await expect(panel).toContainText('0 working, 1 starting. New workers start here.')
        await page.keyboard.press('Tab')
        await expect(panel.getByRole('button', { name: 'Close forge’s panel' })).toBeFocused()
        await page.keyboard.press('Tab')
        // What the panel says is its own stop, so what does not fit the room scrolls from the keyboard.
        await expect(panel.getByRole('region', { name: 'forge’s load and what runs there' })).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(panel.getByRole('button', { name: 'Change where new workers start' })).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(panel.getByRole('button', { name: 'Close forge’s panel' })).toBeFocused()
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          await expect.poll(() => pageBoundProblems(page), { message: `forge's panel at ${width}x${height}` }).toEqual([])
          // The panel ends inside the room under its name, so its foot is always in reach; the rest scrolls inside it.
          await expect(panel.getByRole('button', { name: 'Change where new workers start' })).toBeInViewport()
          expect(await panel.evaluate(element => element.getBoundingClientRect().bottom <= element.closest('.thread-pane')!.getBoundingClientRect().bottom + 1),
            `forge's panel ends inside the room at ${width}x${height}`).toBe(true)
          await captureInto(machinesEvidence, launched, `machines-panel-${appearance}-${width}x${height}.png`)
          await contrastHolds(page, `machines-panel-${appearance}-${width}x${height}`)
        }
        await page.keyboard.press('Escape')
        await expect(panel).toHaveCount(0)
        await expect(forge).toBeFocused()
        // The older host's panel says why its load is unknown.
        await resizeContentWindow(launched, 1280, 800)
        await wide.getByRole('button', { name: /^studio, / }).click()
        await expect(page.getByRole('dialog', { name: 'studio' })).toContainText('studio runs an older Sotto host that does not report its load. Watcher treats it as unknown, never idle.')
        await settle(page)
        await captureInto(machinesEvidence, launched, `machines-panel-older-${appearance}-1280x800.png`)
        await page.keyboard.press('Escape')
        // Beside a thread the room is narrow: the line keeps the machines with a problem and counts the rest.
        await resizeContentWindow(launched, 820, 560)
        await page.getByRole('button', { name: 'Open Footer links beside Watcher' }).click()
        await expect(beside(page)).toBeVisible()
        const narrow = line.locator('.watcher-machines__narrow')
        await expect(narrow).toBeVisible()
        await expect(narrow).toHaveText('forge 0 working, busy·studio 0 working, load unknown·lab not connected·1 more')
        await settle(page)
        await expect.poll(() => pageBoundProblems(page), { message: 'the short line at 820x560' }).toEqual([])
        await captureInto(machinesEvidence, launched, `machines-narrow-${appearance}-820x560.png`)
        await contrastHolds(page, `machines-narrow-${appearance}-820x560`)
        await narrow.getByRole('button', { name: '1 more machine. Show every machine' }).click()
        await expect(wide).toBeVisible()
        await expect(wide.getByRole('button', { name: /^This computer, / })).toBeFocused()

        // Settings, under Watcher: the group between Watched threads and Worker roles, and the note for a machine not connected.
        await resizeContentWindow(launched, 1280, 800)
        await wide.getByRole('button', { name: /^forge, / }).click()
        await page.getByRole('dialog', { name: 'forge' }).getByRole('button', { name: 'Change where new workers start' }).click()
        const group = page.getByRole('group', { name: 'Where new workers start' })
        await expect(group).toBeVisible()
        await expect(group.getByRole('radio')).toHaveCount(5)
        await group.getByRole('radio', { name: 'lab' }).click()
        await expect(group.getByRole('radio', { name: 'lab' })).toBeChecked()
        await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).newWorkerMachine)).toBe(LAB)
        await expect(group).toContainText('lab is not connected. Until it is, new workers start on this computer, and Watcher says so in its reply.')
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          await group.scrollIntoViewIfNeeded()
          await expect.poll(() => pageBoundProblems(page), { message: `Settings at ${width}x${height}` }).toEqual([])
          await captureInto(machinesEvidence, launched, `machines-settings-${appearance}-${width}x${height}.png`)
        }
        // Arrow keys move the choice, as radio buttons do.
        await group.getByRole('radio', { name: 'lab' }).focus()
        await page.keyboard.press('ArrowUp')
        await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).newWorkerMachine)).toBe(STUDIO)
        await page.evaluate(async () => window.sotto!.updateSettings({ newWorkerMachine: 'this-computer' }))

        // A long saved name gives way to an ellipsis inside the line at the minimum window, and its warning words stay
        // clear of its count.
        if (appearance === 'dark') {
          const long = 'The build server under the stairs in the second-floor office'
          await seedRoom(page, { current: true, more, machines: hostId => {
            const read = machines(hostId)
            if (read.status !== 'ok') return read
            return { ...read, machines: read.machines.map(item => {
              if (item.hostId !== STUDIO) return item
              const { note: _note, ...studio } = item
              void _note
              return { ...studio, name: long, factsState: 'reported' as const, facts: facts('Omarchy', 'linux', 8, 16), runningThreads: 0, load: load(96, 0.5),
                placedNotStarted: 0, memoryState: 'short' as const, cpuState: 'busy' as const }
            }) }
          } })
          await resizeContentWindow(launched, 820, 560)
          await openRoom(page)
          const entry = wide.locator(`[data-host="${STUDIO}"]`)
          await expect(entry.getByRole('button', { name: `${long}, 0 working, busy, short on memory. Show ${long}’s load and what runs there.` })).toBeVisible()
          await settle(page)
          const boxes = await entry.evaluate(element => {
            const line = element.closest('.watcher-machines')!.getBoundingClientRect(), name = element.querySelector('.watcher-machines__name > span')!
            const count = element.querySelector('.watcher-machines__count')!.getBoundingClientRect()
            // The words' first piece follows the count on its line, or starts a line under it.
            const words = element.querySelector('.watcher-machines__words')!.getClientRects()[0]!
            return { inside: [...element.getClientRects()].every(rect => rect.right <= line.right + 1), cut: name.scrollWidth > name.clientWidth,
              apart: count.right <= words.left + 1 || words.top >= count.bottom - 1 }
          })
          expect(boxes).toEqual({ inside: true, cut: true, apart: true })
          await expect.poll(() => pageBoundProblems(page), { message: 'a long machine name at 820x560' }).toEqual([])
          await captureInto(machinesEvidence, launched, 'machines-long-name-dark-820x560.png')
          await contrastHolds(page, 'machines-long-name-dark-820x560')
        }
      })
    })
  })

  test('a watched thread’s permission is answered on its card in Watcher’s conversation, which then says what was chosen', async () => {
    for (const [appearance, motion] of [['dark', 'normal'], ['light', 'reduced']] as const) await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', appearance, motion), async (launched) => {
      const { page } = launched
      await openThreads(page)
      // Visual gate flake waits on a permission; the wake-up that told Watcher so placed its card under Watcher's reply.
      const requestCardId = 'visual-gate-permission'
      await seedRoom(page, { current: true, more: hostId => ({ asks: [{ target: { hostId, threadId: 'visual-gate' }, requestCardId, kind: 'permission',
        messageId: 'watcher-reply', wakeUpMessageId: 'wake-visual-gate' }] }) })
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      const pane = watcherPane(page)
      const card = pane.getByRole('region', { name: 'Permission request from Visual gate flake' })
      await expect(card).toBeVisible()
      await expect(card).toContainText('This computer')
      // The needs-you line goes to the card and focuses it, rather than open the thread.
      await page.getByRole('button', { name: 'Go to the permission from Visual gate flake in this conversation' }).click()
      await expect(card).toBeFocused()
      await expect(beside(page)).toHaveCount(0)
      // The thread's last reply is folded until asked for; Escape folds it again onto its toggle.
      await page.keyboard.press('Tab')
      await expect(card.getByRole('button', { name: 'Open Visual gate flake beside Watcher' })).toBeFocused()
      await page.keyboard.press('Tab')
      const said = card.getByRole('button', { name: 'Show what it said' })
      await expect(said).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(card.getByRole('group', { name: 'What Visual gate flake said last' })).toBeVisible()
      for (const [width, height] of SIZES) {
        await resizeContentWindow(launched, width, height)
        await settle(page)
        await card.scrollIntoViewIfNeeded()
        expect(await pageBoundProblems(page), `the card at ${width}x${height}`).toEqual([])
        await captureInto(answerEvidence, launched, `answer-card-${appearance}-${width}x${height}.png`)
        await contrastHolds(page, `answer-card-${appearance}-${width}x${height}`)
      }
      await resizeContentWindow(launched, 1280, 800)
      await card.getByRole('button', { name: 'Hide what it said' }).focus()
      await page.keyboard.press('Escape')
      await expect(card.getByRole('group', { name: 'What Visual gate flake said last' })).toHaveCount(0)
      await expect(card.getByRole('button', { name: 'Show what it said' })).toBeFocused()
      // The user's own answer, from the card, to Visual gate flake's request.
      const choice = card.locator('.agent-request__actions button').first()
      const label = (await choice.textContent())!.trim()
      await choice.click()
      await expect(card).toHaveCount(0)
      const line = pane.locator('.watcher-ask-receipt')
      await expect(line.locator('.watcher-ask-receipt__words')).toHaveText(`You answered Visual gate flake: ${label}.`)
      await expect(line.getByRole('button', { name: 'Open Visual gate flake beside Watcher' })).toBeVisible()
      for (const [width, height] of SIZES) {
        await resizeContentWindow(launched, width, height)
        await settle(page)
        await line.scrollIntoViewIfNeeded()
        expect(await pageBoundProblems(page), `the answered line at ${width}x${height}`).toEqual([])
        await captureInto(answerEvidence, launched, `answer-line-${appearance}-${width}x${height}.png`)
        await contrastHolds(page, `answer-line-${appearance}-${width}x${height}`)
      }
      // With no card left, the needs-you name opens the thread as before.
      await expect(page.getByRole('button', { name: /^Go to the permission from Visual gate flake/ })).toHaveCount(0)
    }))
  })

  test('Stop all, confirmed from the keyboard, answers Escape while its stop is still going and keeps what came of it', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true, stopResults: {}, stopDelayMs: 4_000 })
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      const stopAll = page.getByRole('button', { name: 'Stop all threads Watcher started, 2 threads' })
      await stopAll.focus()
      await page.keyboard.press('Enter')
      const ask = page.getByRole('dialog', { name: 'Stop the 2 threads Watcher started?' })
      await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(ask.getByRole('button', { name: 'Stop 2 threads' })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(ask.getByRole('button', { name: 'Stopping…' })).toBeVisible()
      // The stop is still going and focus is still in the popover, so Escape reaches it.
      expect(await page.evaluate(() => document.querySelector('.watcher-stop')?.contains(document.activeElement) === true)).toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Stop all, show its progress' })).toBeFocused()
      // What came of it waits for the button.
      const show = page.getByRole('button', { name: 'Stop all, show what it did' })
      await expect(show).toBeVisible({ timeout: 15_000 })
      await show.press('Enter')
      await expect(page.getByRole('dialog', { name: 'Stopped 2 threads.' })).toBeVisible()
    }))
  })

  test('Watcher’s header keeps every control apart and whole at every pane width beside a thread, with and without Stop all', async () => {
    // The header off macOS: the tile, the name, All threads, the way off the page (the room switch, the pages and the
    // update control), then Stop all while it shows, on one row. On macOS the header starts past the traffic lights, which its own journey checks.
    test.skip(process.platform === 'darwin', 'The macOS header has its own journey')
    const read = (page: Page) => page.locator('.watcher-pane .watcher-head').evaluate(head => {
      const rect = (node: Element) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom } }
      const named = (node: Element) => node.getAttribute('aria-label') ?? node.textContent?.trim() ?? node.className
      // Shown, and not only to assistive technology (the name, in a narrow pane).
      const shown = (node: Element) => node.getBoundingClientRect().width > 1 && getComputedStyle(node).display !== 'none' && getComputedStyle(node).clipPath === 'none'
      const parts = [head.querySelector('.watcher-head__tile'), head.querySelector('h1'), head.querySelector('.watcher-head__list'),
        ...head.querySelectorAll('.watcher-head__way :is([role="tab"], a, button)'), ...head.querySelectorAll('.thread-workspace__actions > * > button')].filter((node): node is Element => node !== null && shown(node))
      const style = getComputedStyle(head)
      const box = head.getBoundingClientRect()
      const present = (selector: string) => { const node = head.querySelector(selector); return node !== null && shown(node) }
      const labels = ['.watcher-head__list-text', '.watcher-stop-all__text'].map(selector => head.querySelector(selector)).filter((node): node is Element => node !== null && shown(node))
      return {
        pane: head.closest('.thread-pane')!.getBoundingClientRect().width,
        head: { left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight), top: box.top, bottom: box.bottom, height: box.height },
        parts: parts.map(node => ({ name: named(node), ...rect(node) })),
        labels: labels.map(node => node.textContent ?? ''),
        present: { tile: present('.watcher-head__tile'), name: present('h1'), list: present('.watcher-head__list'), stopAll: present('.watcher-stop-all__button') },
        // A label or count cut off by its own control, or the name cut to an ellipsis.
        clipped: [...head.querySelectorAll('.watcher-head__list, .thread-workspace__actions button, h1')].filter(shown)
          .filter(node => node.scrollWidth > node.clientWidth + 0.5).map(named),
      }
    })
    const apart = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) =>
      a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5
    const round = (value: number) => Math.round(value * 10) / 10
    // watcher.css: while Stop all shows, Watcher's name gives way below this width.
    const NAME_FROM = 500
    // The narrowest pane that shows All threads' label beside Stop all, captured with three-digit counts.
    const CAPTURE_100 = 570
    const evidence = evidenceDirectory('artifacts/watcher-header-overlap')
    await mkdir(evidence, { recursive: true })
    const readings: Record<string, unknown> = {}
    await onReleaseTrack('owl', async () => {
      for (const appearance of ['dark', 'light'] as const) await withSotto(launchOptions('t3-code', appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        for (const stopAll of [true, false] as const) {
          // Without Stop all, the two threads Watcher started have finished their turns.
          await seedRoom(page, { current: true, ...stopAll ? {} : { more: (hostId, requestId) => ({ watchedThreads: WATCHED.map(threadId => {
            const target = { hostId, threadId }
            return { target, title: threadId, watched: true, paused: false, status: 'idle' as const, connected: true, settled: true, backgroundWorkCount: 0, waitsOn: [],
              participation: [{ requestId, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target, promptCount: 1 }] }
          }) }) } })
          await resizeContentWindow(launched, 1280, 800)
          await openRoom(page)
          await page.getByRole('button', { name: 'Open Visual gate flake to answer its permission' }).click()
          await expect(beside(page)).toBeVisible()
          await expect(page.locator('.watcher-head .watcher-stop-all')).toHaveCount(stopAll ? 1 : 0)
          for (const counts of ['seeded', 'three-digit'] as const) {
            // All threads' count is uncapped. The second pass draws it as 100, at the window sizes whose panes span the sweep.
            if (counts === 'three-digit') await page.locator('.watcher-head').evaluate(head => {
              for (const count of head.querySelectorAll('.watcher-head__count')) count.textContent = '100'
            })
            for (const [width, height] of counts === 'seeded' ? SIZES : [SIZES[1], SIZES[2]]) {
              await resizeContentWindow(launched, width, height)
              await settle(page)
              const divider = page.getByRole('separator', { name: 'Resize panes' })
              // Watcher's pane is the divider's offset in the room; each pane keeps 400 pixels, so the widest is the room less 409.
              const room = await divider.evaluate(node => node.parentElement!.getBoundingClientRect())
              const widest = Math.floor(room.width - 409)
              const targets = [...new Set([...Array.from({ length: 41 }, (_, index) => 400 + index * 10).filter(target => target < widest), Math.min(widest, 800)])]
              for (const target of targets) {
                // Dragged, as a pointer would, to the pixel; a drag whose last move a busy machine dropped is dragged again.
                await expect(async () => {
                  const handle = await box(divider)
                  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
                  await page.mouse.down()
                  await page.mouse.move(room.left + target + 4.5, handle.y + handle.height / 2, { steps: 2 })
                  await page.mouse.up()
                  await settle(page)
                  const pane = await page.locator('.watcher-pane').evaluate(node => node.getBoundingClientRect().width)
                  expect(Math.abs(pane - target), `the divider moved to ${target}px`).toBeLessThanOrEqual(1)
                }).toPass({ timeout: 15_000 })
                const reading = await read(page)
                const where = `${Math.round(reading.pane)}px pane at ${width}x${height}, ${appearance}, ${stopAll ? 'with' : 'without'} Stop all, ${counts} counts`
                expect(Math.abs(reading.pane - target), `the divider moved to ${target}px, ${where}`).toBeLessThanOrEqual(1)
                // Nothing is measured by leaving it out: every control is there at every width, and the name wherever the
                // styles keep it (from NAME_FROM pixels with Stop all, 450 without).
                const { name, ...always } = reading.present
                // More Watcher actions went with the Threads in flight limit (#1183), and the tabs with Watched and Watcher's
                // picture (October 27, 2026).
                expect.soft(always, where).toEqual({ tile: true, list: true, stopAll })
                if (reading.pane >= (stopAll ? NAME_FROM : 450) + 1) expect.soft(name, `the name shown, ${where}`).toBe(true)
                for (const [index, part] of reading.parts.entries()) {
                  for (const other of reading.parts.slice(index + 1)) expect.soft(apart(part, other), `${part.name} over ${other.name}, ${where}`).toBe(true)
                  expect.soft(part.left, `${part.name} inside the header, ${where}`).toBeGreaterThanOrEqual(reading.head.left - 0.5)
                  expect.soft(part.right, `${part.name} inside the header, ${where}`).toBeLessThanOrEqual(reading.head.right + 0.5)
                  expect.soft(part.top, `${part.name} inside the header, ${where}`).toBeGreaterThanOrEqual(reading.head.top - 0.5)
                  expect.soft(part.bottom, `${part.name} inside the header, ${where}`).toBeLessThanOrEqual(reading.head.bottom + 0.5)
                }
                expect.soft(reading.clipped, where).toEqual([])
                expect.soft(reading.head.height, `one row, ${where}`).toBe(44)
                readings[`${appearance}-${stopAll ? 'stop-all' : 'no-stop-all'}-${counts === 'seeded' ? '' : 'counts-100-'}${width}x${height}-${Math.round(reading.pane)}px`] = {
                  pane: round(reading.pane), head: [round(reading.head.left), round(reading.head.right)], labels: reading.labels, clipped: reading.clipped,
                  parts: reading.parts.map(part => [part.name, round(part.left), round(part.right)]),
                }
                // In the band that overlapped before this change (470 to 581 pixels with Stop all), where a 1100-pixel window’s even split lands.
                if (target === 540 && width === 1280 && counts === 'seeded') await captureInto(evidence, launched, `header-${stopAll ? 'stop-all' : 'no-stop-all'}-${appearance}-540px-1280x800.png`)
                if (target === CAPTURE_100 && width === 1280 && counts === 'three-digit' && stopAll) await captureInto(evidence, launched, `header-stop-all-counts-100-${appearance}-${CAPTURE_100}px-1280x800.png`)
              }
            }
          }
        }
      })
    })
    // One reading to a line: 516 of them pretty-printed would be thousands of lines of committed evidence.
    const lines = Object.entries(readings).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    await writeFile(resolve(evidence, 'readings.json'), `{\n${lines.join(',\n')}\n}\n`, 'utf8')
  })

  test('the receipt cards hold still with reduced motion', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark', 'reduced'), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, { current: true, more: (hostId, requestId) => {
        const receipt = { id: randomUUID(), requestId, retryKey: randomUUID(), digest: '0'.repeat(64), action: 'start' as const, target: { hostId, threadId: 'footer-links' },
          generation: 0, deliveryState: 'accepted' as const, createdAt: at(8), updatedAt: at(8), receiptId: randomUUID(), cardId: randomUUID() }
        return { receipts: [receipt], receiptReplies: [{ operationId: receipt.id, messageId: 'watcher-reply' }] }
      } })
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      const ring = watcherPane(page).locator('.receipt-outcome > .watcher-row__ring[data-tone="working"]')
      await expect(ring).toHaveCount(1)
      expect(await ring.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
      await captureInto(polishEvidence, launched, 'polish-receipts-dark-1280x800-reduced-motion.png')
    }))
  })

  test('Watch from a pane header, a row and All threads, from the keyboard', async () => {
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
        await expect(weekly.getByText(/Watched by Watcher\./)).toHaveCount(0)
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
        await watch.click()
        await expect(watch).toHaveAttribute('aria-pressed', 'false')
        await watch.click()
        await expect(watch).toHaveAttribute('aria-pressed', 'true')
        await resizeContentWindow(launched, 820, 560)
        await settle(page)
        expect(await pageBoundProblems(page)).toEqual([])
        await captureNote(launched, `threads-watch-${appearance}-820x560.png`)

        // In the room: All threads, from the keyboard, where the owl is each row's last stop. Weekly note is watched from
        // the pane header above; Space in the list stops watching it and watches it again.
        await resizeContentWindow(launched, 1280, 800)
        await openRoom(page)
        const pane = watcherPane(page)
        await allThreads(page).focus()
        await page.keyboard.press('Enter')
        const list = threadsList(page)
        await expect(list).toBeVisible()
        await expect(list.getByText(/The owl watches a thread until you press it again/)).toBeVisible()
        await list.getByRole('searchbox', { name: 'Filter threads' }).fill('weekly')
        await page.keyboard.press('Tab')
        expect(await focusedName(page)).toBe('Open Weekly note beside Watcher')
        await page.keyboard.press('Tab')
        expect(await focusedName(page)).toBe('Watch Weekly note')
        const listOwl = list.getByRole('button', { name: 'Watch Weekly note', exact: true })
        await expect(listOwl).toHaveAttribute('aria-pressed', 'true')
        await page.keyboard.press('Space')
        await expect(listOwl).toHaveAttribute('aria-pressed', 'false')
        await expect(listOwl).toBeFocused()
        await page.keyboard.press('Space')
        await expect(listOwl).toHaveAttribute('aria-pressed', 'true')
        await list.getByRole('searchbox', { name: 'Filter threads' }).fill('')
        await settle(page)
        expect(await pageBoundProblems(page)).toEqual([])
        await captureNote(launched, `list-watch-${appearance}-1280x800.png`)
        await contrastHolds(page, `list-watch-${appearance}-1280x800`)
        // Escape closes the list and gives focus back to All threads, over the conversation as it was.
        await page.keyboard.press('Escape')
        await expect(list).toHaveCount(0)
        await expect(allThreads(page)).toBeFocused()
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
   * Journeys with no stand-in: the room reads main's own bridge over the fake Codex app server (`withMainWatcher`), so
   * starting Watcher is main's real `open` and the first message is a real send to a real Watcher thread.
   */
  test('against main’s own Watcher, the first message starts Watcher on Codex and reaches it', async () => {
    test.setTimeout(3 * 60_000)
    await withMainWatcher('sotto-e2e-watcher-main-', { reply: 'Watcher here. I will look at the release notes.' }, async (launched, root) => {
      const { page } = launched
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      await expect(page.getByRole('heading', { level: 2, name: 'Start Watcher' })).toBeVisible()
      await expect(page.getByRole('group', { name: 'Watcher’s model' }).getByRole('combobox', { name: 'Thread model' })).toBeVisible()
      await page.getByRole('textbox', { name: 'Watcher message' }).click()
      await page.keyboard.type('Check the release notes and tell me what is missing.')
      await page.getByRole('button', { name: 'Start Watcher and send' }).click()
      // Main created Watcher on Codex: its own pane and composer, the message and the provider's reply.
      const pane = watcherPane(page)
      await expect(pane.getByRole('textbox', { name: 'Watcher message' })).toBeVisible()
      // Main takes the choice, so Watcher's permissions is the chip, on Ask for approval the first time.
      await expect(pane.getByRole('combobox', { name: 'Watcher’s permissions' })).toHaveText('Ask for approval')
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
      const room = await mainRoom(page)
      expect(room).toMatchObject({ current: { provider: 'codex' } })
      // The note names the request the message started, and its display proof records that the words went as typed.
      const request = room.requests.at(-1)!
      expect(note!.value).toContain(`Sotto Watcher request: ${request.id}. Local host: ${request.watcher.hostId}.`)
      expect(request.displayPrompt).toEqual({ originalLength: original.length, wireDigest: createHash('sha256').update(original).digest('hex') })
      // The bridge itself, as a paired phone's management reaches the same calls.
      expect(await page.evaluate(async () => window.sotto!.watcher!.setPermission!({ runtimeMode: 'full-access' })))
        .toMatchObject({ status: 'ok', state: { runtimeMode: 'full-access', currentOptions: { runtimeMode: 'full-access' } } })
      expect(await page.evaluate(async () => window.sotto!.watcher!.setPermission!({ runtimeMode: 'approval-required' })))
        .toMatchObject({ status: 'ok', state: { runtimeMode: 'approval-required', currentOptions: { runtimeMode: 'approval-required' } } })
      const worker = await createWorker(page, join(root, 'worker'), 'Standing watch worker')
      expect(await page.evaluate(async target => window.sotto!.watcher!.watchThread!({ target }), worker.target))
        .toMatchObject({ status: 'ok', state: { standingWatches: [expect.objectContaining({ target: worker.target })] } })
      const detail = await page.evaluate(async threadId => window.sotto!.agents!.threadDetail!(threadId), worker.id)
      expect(detail?.messages).toHaveLength(0)
      expect(await page.evaluate(async target => window.sotto!.watcher!.unwatchThread!({ target }), worker.target))
        .toMatchObject({ status: 'ok', state: { standingWatches: [] } })
      // Watcher is its room's: not listed on the Threads page, and nothing there was selected for it.
      await switchTab(page, 'Threads').click()
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' }).getByText('Watcher', { exact: true })).toHaveCount(0)
      // A fresh renderer recovers the prompt. Get and notifications may both participate.
      await switchTab(page, 'Watcher').click()
      await page.reload()
      await openRoom(page)
      await expect(watcherPane(page).locator('[data-role="user"] .rich-message')).toHaveText(original)
      await settle(page)
      expect(await pageBoundProblems(page)).toEqual([])
      await capture(launched, 'room-main-sotto-dark-1280x800.png')
    })
  })

  test('against main’s own Watcher, its permissions, Watch and Stop watching and its own changes go through main', async () => {
    test.setTimeout(4 * 60_000)
    await withMainWatcher('sotto-e2e-watcher-manage-', { reply: 'Watcher here.' }, async (launched, root) => {
      const { page } = launched
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      await page.getByRole('textbox', { name: 'Watcher message' }).click()
      await page.keyboard.type('Keep an eye on my threads.')
      await page.getByRole('button', { name: 'Start Watcher and send' }).click()
      const pane = watcherPane(page)
      await expect(pane.locator('[data-role="assistant"]')).toContainText('Watcher here.')

      // Watcher's permissions: a press is main's setPermission, Codex confirms it, and the chip settles on it.
      const chip = pane.getByRole('combobox', { name: 'Watcher’s permissions' })
      await expect(chip).toHaveText('Ask for approval')
      await chip.click()
      const list = page.getByRole('listbox', { name: 'Watcher’s permissions' })
      await expect(list.getByRole('option')).toHaveText([/^Ask for approval/, /^Allow edits/, /^Auto/, /^Full access/])
      await list.getByRole('option', { name: /^Full access/ }).click()
      await expect(chip).toHaveText('Full access')
      await expect.poll(async () => { const state = await mainRoom(page); return [state.runtimeMode, state.currentOptions?.runtimeMode] }).toEqual(['full-access', 'full-access'])
      await expect(chip).not.toHaveAttribute('data-pending', 'true')
      // Narrowing goes the same way, from the keyboard.
      await chip.focus()
      await page.keyboard.press('Enter')
      await expect(list.getByRole('option', { name: /^Full access/ })).toBeFocused()
      for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Enter')
      await expect(chip).toHaveText('Ask for approval')
      await expect.poll(async () => { const state = await mainRoom(page); return [state.runtimeMode, state.currentOptions?.runtimeMode] }).toEqual(['approval-required', 'approval-required'])

      // Watch in a thread's pane header is main's watchThread: the room counts it, and nothing is sent to it.
      const worker = await createWorker(page, join(root, 'worker'), 'Weekly worker')
      await switchTab(page, 'Threads').click()
      const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
      await sidebar.getByRole('button', { name: 'Weekly worker', exact: true }).click()
      const workerPane = page.getByRole('region', { name: 'Weekly worker' })
      const watch = workerPane.getByRole('button', { name: 'Watch Weekly worker', exact: true })
      await expect(watch).toHaveAttribute('aria-pressed', 'false')
      await watch.click()
      await expect(watch).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.watch-toast')).toHaveText(/Watcher is watching Weekly worker\./)
      await expect(workerPane.getByText(/Watched by Watcher\./)).toHaveCount(0)
      await expect(sidebar.getByRole('button', { name: 'Watch Weekly worker', exact: true })).toHaveAttribute('aria-pressed', 'true')
      expect((await mainRoom(page)).standingWatches).toEqual([expect.objectContaining({ target: worker.target })])
      expect((await mainRoom(page)).watchedThreads.find(row => row.target.threadId === worker.target.threadId)).toMatchObject({ watched: true, paused: false })
      expect((await page.evaluate(async threadId => window.sotto!.agents!.threadDetail!(threadId), worker.id))?.messages).toHaveLength(0)
      // In the room, All threads draws the owl on its row, pressed; pressing it is main's unwatchThread.
      await switchTab(page, 'Watcher').click()
      await allThreads(page).click()
      const everyThread = threadsList(page)
      const listOwl = everyThread.getByRole('button', { name: 'Watch Weekly worker', exact: true })
      await expect(listOwl).toHaveAttribute('aria-pressed', 'true')
      await settle(page)
      expect(await pageBoundProblems(page)).toEqual([])
      await captureNote(launched, 'room-main-watched-dark-1280x800.png')
      await listOwl.click()
      await expect(listOwl).toHaveAttribute('aria-pressed', 'false')
      await expect.poll(async () => (await mainRoom(page)).standingWatches).toEqual([])
      await page.keyboard.press('Escape')
      await expect(everyThread).toHaveCount(0)

      // A reply in which Watcher changed a file itself: main's own projection draws the line, with the reason line's words.
      const reason = 'A one-word typo is smaller than briefing a thread.'
      await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: `I fixed the typo in README.md myself.\nWatcher change reason: ${reason}`, fileChanges: ['README.md'] }))
      await pane.getByRole('textbox', { name: 'Watcher message' }).click()
      await page.keyboard.type('Fix the README typo.')
      await page.keyboard.press('Enter')
      const line = pane.locator('.watcher-own')
      await expect(line).toHaveText(`Watcher changed 1 file itself. Its reason: “${reason}”Show the file`)
      expect((await mainRoom(page)).ownChanges).toEqual([expect.objectContaining({ fileCount: 1, reason, source: 'provider-file-change', files: [expect.stringMatching(/README\.md$/)] })])
      // The reply itself reads without the reason line: the own-change line under it already says it.
      await expect(pane.getByText('I fixed the typo in README.md myself.', { exact: true })).toBeVisible()
      await expect(pane.getByText(/Watcher change reason:/)).toHaveCount(0)
      // Captured folded: the file's full path names the disposable profile's folder.
      await line.scrollIntoViewIfNeeded()
      await settle(page)
      expect(await pageBoundProblems(page)).toEqual([])
      await captureNote(launched, 'room-main-own-change-dark-1280x800.png')
      await line.getByRole('button', { name: 'Show the file' }).click()
      await expect(line.getByRole('list', { name: 'Files Watcher changed' }).getByRole('listitem')).toHaveText([/README\.md$/])
    })
  })

  /**
   * The handover after a provider change (ADR-0073, #1026), against main's own Watcher over the fake Codex and Claude
   * providers: another provider's model in Watcher's picker makes a new Watcher, the strip over its composer offers the
   * last one's handover, and Continue sends it ahead of the first message, as one message, which the room shows as
   * Sotto's handover beside the user's words. Captured at 1280x800 and 820x560, dark and light.
   */
  test('against main’s own Watcher, a provider change offers the handover, and Continue sends it with the first message', async () => {
    test.setTimeout(4 * 60_000)
    await withMainWatcher('sotto-e2e-watcher-handover-', { reply: 'Watcher here. Release notes is missing the install line.' }, async (launched, root) => {
      const { page } = launched
      await writeFile(join(root, 'claude', 'script.json'), JSON.stringify({ reply: 'Claude Watcher here. I have the handover.' }))
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      // This journey starts on Codex explicitly; role defaults may choose Claude when both fixtures are ready.
      await page.getByRole('group', { name: 'Watcher’s model' }).getByRole('combobox', { name: 'Thread model' }).click()
      const firstPicker = page.getByRole('dialog', { name: 'Choose model' })
      await firstPicker.getByRole('tab', { name: /Codex/ }).click()
      await firstPicker.getByRole('option').first().click()
      await page.getByRole('textbox', { name: 'Watcher message' }).click()
      await page.keyboard.type('Check the release notes and tell me what is missing.')
      await page.getByRole('button', { name: 'Start Watcher and send' }).click()
      const pane = watcherPane(page)
      await expect.poll(async () => (await mainRoom(page)).current?.provider).toBe('codex')
      await expect(pane.locator('[data-role="assistant"]')).toContainText('Watcher here. Release notes is missing the install line.')
      await expect.poll(async () => (await mainRoom(page)).currentOptions?.status).toBe('idle')
      const codex = (await mainRoom(page)).current!
      expect(codex.provider).toBe('codex')
      expect((await mainRoom(page)).handover ?? null).toBeNull()

      // Another provider's model in Watcher's own picker is a new Watcher there.
      await pane.getByRole('combobox', { name: 'Thread model' }).click()
      const picker = page.getByRole('dialog', { name: 'Choose model' })
      await expect(picker.getByText(/Another provider’s model starts a new Watcher\./)).toBeVisible()
      await picker.getByRole('tab', { name: /Claude/ }).click()
      await picker.getByRole('option').first().click()
      const strip = pane.getByRole('region', { name: 'Handover of the last Watcher' })
      await expect(strip).toContainText('Sending starts the new Watcher with a handover of the last one, from Codex.')
      // The fake Codex records its turn, which the handover counts and never carries.
      await expect(strip).toContainText('It carries all 2 messages and leaves out 1 record of its work.')
      const room = await mainRoom(page)
      expect(room).toMatchObject({ current: { provider: 'claude' }, history: [expect.objectContaining({ target: codex.target })],
        handover: { source: codex.target, provider: 'codex', counts: { total: 2, carried: 2, historyKept: true } } })
      await expect(pane.getByRole('button', { name: 'Continue with the handover' })).toBeVisible()
      // Nothing has gone to Claude yet: the offer is only an offer.
      const prompts = async (): Promise<string[]> => (await readFile(join(root, 'claude', 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { method: string; params: { frame: { prompt?: string } } }).filter(entry => entry.method === 'hook-context').map(entry => entry.params.frame.prompt ?? '')
      expect(await prompts()).toEqual([])

      // Read it, from the keyboard; Escape folds it again.
      await strip.getByRole('button', { name: 'Read it' }).focus()
      await page.keyboard.press('Enter')
      const words = strip.getByRole('region', { name: 'The handover, word for word' })
      await expect(words).toContainText('The history below is context, not a new request.')
      await expect(words).toContainText('Check the release notes and tell me what is missing.')
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async value => { await window.sotto!.updateSettings({ appearance: value }) }, appearance)
        for (const [width, height] of [[1280, 800], [820, 560]] as const) {
          await resizeContentWindow(launched, width, height, [800, 540])
          await settle(page)
          expect(await pageBoundProblems(page), `the offer at ${width}x${height}, ${appearance}`).toEqual([])
          await roomEdges(page, width, height)
          await expect(strip).toBeInViewport()
          await expect(pane.getByRole('button', { name: 'Continue with the handover' })).toBeInViewport()
          await contrastHolds(page, `handover-offer-${appearance}-${width}x${height}`)
          await captureHandover(launched, `offer-read-${appearance}-${width}x${height}.png`)
        }
      }
      // Escape from the words folds them and returns to Read it.
      await words.focus()
      await page.keyboard.press('Escape')
      await expect(words).toHaveCount(0)
      await expect(strip.getByRole('button', { name: 'Read it' })).toBeFocused()
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resizeContentWindow(launched, 1280, 800)
      await settle(page)
      await captureHandover(launched, 'offer-dark-1280x800.png')

      // Continue: the handover and the first message go to Claude as one message, in one turn.
      await pane.getByRole('textbox', { name: 'Watcher message' }).click()
      await page.keyboard.type('Carry on and add the install line.')
      await pane.getByRole('button', { name: 'Continue with the handover' }).click()
      const card = pane.getByRole('article', { name: 'Handover from the last Watcher' })
      await expect(card).toContainText('From the last Watcher, on Codex. Context, not a new request.')
      await expect(card).toContainText('Carried all 2 messages. Left out 1 record of its work.')
      await expect(pane.locator('[data-role="user"][data-message-id] .rich-message')).toHaveText('Carry on and add the install line.')
      await expect(pane.locator('[data-role="assistant"]')).toContainText('Claude Watcher here. I have the handover.')
      await expect(strip).toHaveCount(0)
      await expect(pane.getByRole('button', { name: 'Continue with the handover' })).toHaveCount(0)
      const sent = await prompts()
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatch(/^This is a handover from another Sotto thread\. The history below is context, not a new request\./u)
      expect(sent[0]).toContain('Check the release notes and tell me what is missing.')
      expect(sent[0]).toContain('Watcher here. Release notes is missing the install line.')
      expect(sent[0]!.endsWith('\n\nCarry on and add the install line.')).toBe(true)
      expect((await mainRoom(page)).handover ?? null).toBeNull()

      // The first message, its handover's words open, at both sizes, dark and light.
      await card.getByRole('button', { name: 'Read the handover, word for word' }).click()
      await expect(card.getByRole('region', { name: 'The handover, word for word' })).toContainText('Check the release notes and tell me what is missing.')
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async value => { await window.sotto!.updateSettings({ appearance: value }) }, appearance)
        for (const [width, height] of [[1280, 800], [820, 560]] as const) {
          await resizeContentWindow(launched, width, height, [800, 540])
          await card.scrollIntoViewIfNeeded()
          await settle(page)
          expect(await pageBoundProblems(page), `the first message at ${width}x${height}, ${appearance}`).toEqual([])
          await roomEdges(page, width, height)
          await contrastHolds(page, `handover-message-${appearance}-${width}x${height}`)
          await captureHandover(launched, `first-message-${appearance}-${width}x${height}.png`)
        }
      }
    }, ['codex', 'claude'])
  })

  test('New Watcher: first in the composer, unavailable while Watcher works, and a press brings the new Watcher with the handover', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('t3-code', 'dark'), async (launched) => {
      const { page } = launched
      const captureNew = (name: string): Promise<void> => captureInto(newWatcherEvidence, launched, name)
      const kept = (appearance: 'dark' | 'light', width: number): boolean => width !== 1600 && (appearance === 'dark' || width === 1280)
      await openThreads(page)
      // Streaming WAV stall is on Watcher's model, so it stands for the new Watcher, emptied.
      await seedRoom(page, { current: true, startNew: 'wav-stall' })
      await openRoom(page)
      await resizeContentWindow(launched, 1280, 800)
      const pane = watcherPane(page)
      const button = pane.getByRole('button', { name: 'New Watcher', exact: true })
      await expect(button).toBeVisible()
      await expect(button).toHaveAttribute('title', 'Start a new Watcher with a handover of this one')
      await expect(button).not.toHaveAttribute('aria-disabled', 'true')
      // Watcher always runs on this computer, so its composer does not say so.
      await expect(pane.locator('.thread-host-chip')).toHaveCount(0)
      // The keyboard reaches it after the message and the paperclip, which is off for a model that takes no images, and
      // before the model.
      const paperclip = pane.getByRole('button', { name: 'Attach screenshots' })
      expect(await paperclip.evaluate((clip, chip) => Boolean(clip.compareDocumentPosition(chip!) & Node.DOCUMENT_POSITION_FOLLOWING), await button.elementHandle())).toBe(true)
      await pane.getByRole('textbox', { name: 'Watcher message' }).focus()
      await page.keyboard.press('Tab')
      if (await paperclip.isEnabled()) await page.keyboard.press('Tab')
      await expect(button).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(pane.getByRole('combobox', { name: 'Thread model' })).toBeFocused()
      // The captures show the chip at rest, with the composer focused as the room opens.
      await pane.getByRole('textbox', { name: 'Watcher message' }).focus()
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async value => { await window.sotto!.updateSettings({ appearance: value }) }, appearance)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          await settle(page)
          expect(await pageBoundProblems(page), `the idle chip at ${width}x${height}, ${appearance}`).toEqual([])
          await roomEdges(page, width, height)
          await expect(button).toBeInViewport({ ratio: 1 })
          await contrastHolds(page, `new-watcher-idle-${appearance}-${width}x${height}`)
          if (kept(appearance, width)) await captureNew(`idle-${appearance}-${width}x${height}.png`)
        }
      }
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resizeContentWindow(launched, 1280, 800)

      // While Watcher works, it stays in the Tab order, says why, and a press does nothing.
      await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'stream', threadId, messageId: 'watcher-working', text: 'Checking the release.', status: 'running' }), CURRENT)
      await expect(button).toHaveAttribute('aria-disabled', 'true')
      await expect(button).toHaveAttribute('title', 'Wait for Watcher to finish before starting a new one.')
      await expect(button).toHaveAccessibleDescription('Wait for Watcher to finish before starting a new one.')
      await button.focus()
      await page.keyboard.press('Enter')
      await expect(pane.getByRole('region', { name: 'Handover of the last Watcher' })).toHaveCount(0)
      await settle(page)
      await captureNew('busy-dark-1280x800.png')
      await page.evaluate(async threadId => window.sottoE2E!.agentEvent!({ type: 'ready', threadId, text: 'Both are still running.' }), CURRENT)
      await expect(button).not.toHaveAttribute('aria-disabled', 'true')

      // Enter starts the new Watcher at once: the handover over its composer, Continue, its empty room's note, and focus
      // in its composer.
      await button.focus()
      await page.keyboard.press('Enter')
      const strip = pane.getByRole('region', { name: 'Handover of the last Watcher' })
      await expect(strip).toContainText('Sending starts the new Watcher with a handover of the last one.')
      await expect(strip).not.toContainText('from Codex')
      await expect(strip).toContainText('It carries all 2 messages.')
      await expect(pane.getByRole('button', { name: 'Continue with the handover' })).toBeVisible()
      await expect(pane.getByRole('textbox', { name: 'Watcher message' })).toBeFocused()
      const note = pane.locator('.watcher-new-note')
      await expect(note).toContainText(/^New Watcher on .+\.The last conversation is in Watcher history on the Threads page\. Watcher still watches your 2 threads, and the threads it started keep working\.$/u)
      await expect(pane.getByText('What is next for this thread?')).toHaveCount(0)
      // The new Watcher has said nothing yet, so there is nothing to hand over again.
      await expect(button).toHaveAccessibleDescription('This Watcher is new, so there is nothing to hand over yet.')
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async value => { await window.sotto!.updateSettings({ appearance: value }) }, appearance)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          await settle(page)
          expect(await pageBoundProblems(page), `after the press at ${width}x${height}, ${appearance}`).toEqual([])
          await roomEdges(page, width, height)
          await expect(strip).toBeInViewport()
          await expect(pane.getByRole('button', { name: 'Continue with the handover' })).toBeInViewport()
          await contrastHolds(page, `new-watcher-after-${appearance}-${width}x${height}`)
          if (kept(appearance, width)) await captureNew(`after-${appearance}-${width}x${height}.png`)
        }
      }
      // Escape in the composer puts the offer away, and the send button sends again.
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await pane.getByRole('textbox', { name: 'Watcher message' }).focus()
      await page.keyboard.press('Escape')
      await expect(strip).toHaveCount(0)
      await expect(pane.getByRole('button', { name: 'Send prompt' })).toBeVisible()
    }))
  })

  test('against main’s own Watcher, New Watcher starts one on the same model with the last one’s handover', async () => {
    test.setTimeout(4 * 60_000)
    await withMainWatcher('sotto-e2e-new-watcher-', { reply: 'Watcher here. Release notes is missing the install line.' }, async (launched) => {
      const { page } = launched
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      await page.getByRole('textbox', { name: 'Watcher message' }).click()
      await page.keyboard.type('Check the release notes and tell me what is missing.')
      await page.getByRole('button', { name: 'Start Watcher and send' }).click()
      const pane = watcherPane(page)
      await expect(pane.locator('[data-role="assistant"]')).toContainText('Watcher here. Release notes is missing the install line.')
      await expect.poll(async () => (await mainRoom(page)).currentOptions?.status).toBe('idle')
      const before = await mainRoom(page)
      const button = pane.getByRole('button', { name: 'New Watcher', exact: true })
      await expect(button).not.toHaveAttribute('aria-disabled', 'true')
      await button.click()
      const strip = pane.getByRole('region', { name: 'Handover of the last Watcher' })
      await expect(strip).toContainText('Sending starts the new Watcher with a handover of the last one.')
      await expect(strip).not.toContainText(/, from /u)
      const after = await mainRoom(page)
      expect(after.current?.target).not.toEqual(before.current!.target)
      expect(after).toMatchObject({ current: { provider: before.current!.provider },
        currentOptions: { modelId: before.currentOptions!.modelId, runtimeMode: before.currentOptions!.runtimeMode },
        history: [expect.objectContaining({ target: before.current!.target })], handover: { source: before.current!.target, provider: before.current!.provider } })
      await expect(pane.getByRole('textbox', { name: 'Watcher message' })).toBeFocused()
      await expect(pane.locator('.watcher-new-note')).toContainText('The last conversation is in Watcher history on the Threads page.')
      await expect(button).toHaveAccessibleDescription('This Watcher is new, so there is nothing to hand over yet.')
    })
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
      await expect(page.locator('.watcher-head__rooms')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'New Watcher' })).toHaveCount(0)
      // Stable lists the thread the projection names as Watcher, since stable has no Watcher to give it to.
      const threads = page.getByRole('complementary', { name: 'Thread sidebar' })
      await threads.getByRole('button', { name: /^Settled/ }).click()
      await expect(threads.getByRole('button', { name: 'Release notes 1.4', exact: true })).toHaveCount(1)
    }))
  })
})
