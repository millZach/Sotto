import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { hostEntityKey, parseHostEntityKey } from '../../src/shared/clientIdentity'
import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../src/renderer/src/e2e/watcherStandIn'
import type { WatcherOwnChange } from '../../src/shared/watcher'
import type { WatcherRoomState } from '../../src/shared/watcherRoom'
import type { AgentMessage } from '../../src/shared/agents'
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
 * opened beside Watcher, the floating switch and the badges, on the Sotto Owl track, with stable showing none of it.
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
  readonly ownChanges?: readonly WatcherOwnChange[]; readonly messages?: readonly AgentMessage[]
  /** More of the projection, from the host's ID and the request's: receipts and takeovers. */
  readonly more?: (hostId: string, requestId: string) => Partial<WatcherRoomState>
  readonly stopResults?: WatcherStandInSeed['stopResults']; readonly stopDelayMs?: number }): Promise<void> {
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
      inFlight: options.current ? 2 : 0, inFlightLimit: 4, receipts: [], recoveryNotice: null, observedAt: at(0),
    },
    created: identity,
    ...options.permissionConfirms === false ? { permissionConfirms: false } : {},
    ...options.stopResults ? { stopResults: options.stopResults } : {},
    ...options.stopDelayMs ? { stopDelayMs: options.stopDelayMs } : {},
  }
  if (options.more) {
    const more = options.more(hostId!, requestId)
    seed.state = { ...seed.state, ...more, ...more.requests ? {} : { requests: seed.state.requests },
      ...more.watchedThreads ? {} : { watchedThreads: seed.state.watchedThreads } }
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
      '.watcher-watched__lead > p', '.watcher-watched__label', '.watched-card__title', '.watched-card__meta', '.watched-card__doing', '.watched-card__stop',
      '.watcher-handover__lead > p', '.watcher-handover__ledger', '.watcher-handover__read', '.watcher-handover__text', '.thread-prompt__send[data-wide]',
      '.watcher-handover-message__lead', '.watcher-handover-message__ledger', '.watcher-handover__disclose',
      '.receipt-card__lead', '.receipt-card__name', '.receipt-link', '.receipt-outcome', '.receipt-card__meta', '.sotto-line p', '.sotto-line time',
      '.watcher-stop-all__button', '.watcher-stop h2', '.watcher-stop__name', '.watcher-stop__where', '.watcher-stop__state', '.watcher-stop__note', '.watcher-stop__said',
      '.watcher-stop .tt-button',
      '.thread-message__status', '.thread-message__delivery > span', '.thread-message__delivery-actions .tt-button']
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
    for (const folder of [evidenceRoot, permissionEvidence, handoverEvidence, polishEvidence]) await mkdir(folder, { recursive: true })
  })
  test.afterAll(async () => {
    // Each folder gets its own readings, and a run that took none for a folder leaves that folder's file as it was.
    const note = /^(permissions|own-changes|threads-watch|room-watched|list-watch)-/u
    const handover = /^handover-/u
    const polish = /^polish-/u
    const folders = [[evidenceRoot, [...recorded].filter(([key]) => !note.test(key) && !handover.test(key) && !polish.test(key))], [permissionEvidence, [...recorded].filter(([key]) => note.test(key))],
      [handoverEvidence, [...recorded].filter(([key]) => handover.test(key))], [polishEvidence, [...recorded].filter(([key]) => polish.test(key))]] as const
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
      // Tab from All threads: the header (its tabs, one stop on the one shown, then Stop all while threads Watcher started run,
      // then More Watcher actions), the needs-you
      // line, the conversation, the composer, then the floating switch's row.
      await allThreads(page).focus()
      const order: string[] = []
      for (let step = 0; step < 50 && !order.includes('Check for updates'); step++) {
        await page.keyboard.press('Tab')
        order.push(await focusedName(page))
      }
      recorded.set('tab-order', order)
      const indexOf = (name: string | RegExp): number => order.findIndex(entry => typeof name === 'string' ? entry === name : name.test(entry))
      expect(order.slice(0, 3)).toEqual(['Conversation', 'Stop all threads Watcher started, 2 threads', 'More Watcher actions'])
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
      // Main created Watcher on Codex: its own pane, its tabs, the message and the provider's reply.
      const pane = watcherPane(page)
      await expect(pane.getByRole('tab', { name: 'Watched, 0 threads' })).toBeVisible()
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
        .toMatchObject({ status: 'ok', state: { inFlight: 0, standingWatches: [expect.objectContaining({ target: worker.target })] } })
      const detail = await page.evaluate(async threadId => window.sotto!.agents!.threadDetail!(threadId), worker.id)
      expect(detail?.messages).toHaveLength(0)
      expect(await page.evaluate(async target => window.sotto!.watcher!.unwatchThread!({ target }), worker.target))
        .toMatchObject({ status: 'ok', state: { standingWatches: [] } })
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
      // Ordinary Settings updates supply no room reply. The populated room's limit overrides the Settings fallback,
      // so this select needs the final quiet notification rather than a test get() flushing the desktop publisher.
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ watcherInFlightLimit: 1 })
        await window.sotto!.updateSettings({ watcherInFlightLimit: 2 })
      })
      await expect(page.getByRole('combobox', { name: 'Threads in flight' })).toHaveValue('2')
      await page.keyboard.press('Escape')
      // A fresh renderer recovers the current limit and prompt. Get and notifications may both participate.
      await page.reload()
      await openRoom(page)
      await page.getByRole('button', { name: 'More Watcher actions' }).click()
      await expect(page.getByRole('combobox', { name: 'Threads in flight' })).toHaveValue('2')
      await page.keyboard.press('Escape')
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
      await expect(workerPane.getByText('Watched by Watcher. It keeps this thread going and brings you its questions and permissions.')).toBeVisible()
      await expect(sidebar.getByRole('button', { name: 'Watch Weekly worker', exact: true })).toHaveAttribute('aria-pressed', 'true')
      expect((await mainRoom(page)).standingWatches).toEqual([expect.objectContaining({ target: worker.target })])
      expect((await mainRoom(page)).watchedThreads.find(row => row.target.threadId === worker.target.threadId)).toMatchObject({ watched: true, paused: false })
      expect((await page.evaluate(async threadId => window.sotto!.agents!.threadDetail!(threadId), worker.id))?.messages).toHaveLength(0)
      await switchTab(page, 'Watcher').click()
      const watchedTab = pane.getByRole('tab', { name: 'Watched, 1 thread' })
      await expect(watchedTab).toBeVisible()
      await watchedTab.click()
      const panel = pane.getByRole('tabpanel')
      await expect(panel.getByRole('button', { name: 'Open Weekly worker beside Watcher' })).toBeVisible()
      await expect(panel.getByText(/^Watching since .+\. Nothing sent yet\.$/)).toBeVisible()
      await settle(page)
      expect(await pageBoundProblems(page)).toEqual([])
      await captureNote(launched, 'room-main-watched-dark-1280x800.png')
      // Stop watching on its card is main's unwatchThread, and the count follows.
      await panel.getByRole('button', { name: 'Stop watching Weekly worker', exact: true }).click()
      await expect(pane.getByRole('tab', { name: 'Watched, 0 threads' })).toBeVisible()
      await expect.poll(async () => (await mainRoom(page)).standingWatches).toEqual([])
      await pane.getByRole('tab', { name: 'Conversation' }).click()

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
