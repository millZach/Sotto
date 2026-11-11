import { ownedE2EProfile, removeOwnedE2EProfile } from './e2eProfile'
import type { ChildProcess } from 'node:child_process'

import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'

import { requireOwnedE2EProfile } from '../../../scripts/e2e-profile-policy.mjs'
import { E2E_UNCAUGHT_EXIT_CODE, E2E_UNCAUGHT_PREFIX, type E2EScenario } from '../../../src/shared/e2e'

/**
 * An entity ID without its host qualification. `clientScoped` mode prefixes every thread and project ID with
 * `host:<hostId>:` once the desktop router takes over from the raw provider snapshot, a transition that can
 * still be settling immediately after `connect`; a check keyed on the fixture's own bare IDs (`workshop`,
 * `docs`) reads the same either way instead of racing that transition.
 */
export function bareEntityId(id: string | null): string | null {
  return id?.replace(/^host:[0-9a-f-]+:/iu, '') ?? id
}

export interface LaunchedSotto {
  readonly app: ElectronApplication
  readonly page: Page
  readonly userData: string
  readonly ownsUserData: boolean
}

type ElectronLaunchOptions = Parameters<typeof electron.launch>[0]

export interface LaunchDependencies {
  readonly createProfile: () => Promise<string>
  readonly launch: (options: ElectronLaunchOptions) => Promise<ElectronApplication>
  readonly firstWindow: (application: ElectronApplication) => Promise<Page>
  readonly removeProfile: (path: string) => Promise<void>
}

export function e2eEnvironment(scenario: E2EScenario, userData: string): Record<string, string> {
  return Object.fromEntries(Object.entries({
    ...process.env,
    SOTTO_E2E: '1',
    SOTTO_E2E_SCENARIO: scenario,
    SOTTO_E2E_USER_DATA: userData,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
}

export async function firstSottoWindow(application: ElectronApplication): Promise<Page> {
  const first = await application.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  if (first.url().endsWith('/index.html')) return first
  const existing = application.windows().find(page => page.url().endsWith('/index.html'))
  if (existing) return existing
  return application.waitForEvent('window', { predicate: async page => {
    await page.waitForLoadState('domcontentloaded')
    return page.url().endsWith('/index.html')
  } })
}

/** The widget is created after onboarding; wait for its page and navigation to arrive. */
export async function sottoWidget(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.windows().some(page => page.url().endsWith('/widget.html'))).toBe(true)
  const widget = application.windows().find(page => page.url().endsWith('/widget.html'))!
  await widget.waitForLoadState('domcontentloaded')
  return widget
}

const defaultDependencies: LaunchDependencies = {
  createProfile: async () => (await ownedE2EProfile()).directory,
  launch: (options) => electron.launch(options),
  firstWindow: firstSottoWindow,
  removeProfile: removeOwnedE2EProfile,
}

export async function launchSotto(
  scenario: E2EScenario = 'success',
  userData?: string,
  dependencies: LaunchDependencies = defaultDependencies,
): Promise<LaunchedSotto> {
  const ownsUserData = userData === undefined
  const profile = userData ?? requireOwnedE2EProfile(await dependencies.createProfile())
  let application: ElectronApplication | undefined
  try {
    application = await dependencies.launch({
      args: [process.env.SOTTO_E2E_MAIN_ENTRY ?? 'out/main/index.js'],
      env: e2eEnvironment(scenario, profile),
    })
    keepUncaughtReport(application)
    const page = await dependencies.firstWindow(application)
    await page.waitForLoadState('domcontentloaded')
    return { app: application, page, userData: profile, ownsUserData }
  } catch (error: unknown) {
    await application?.close().catch(() => undefined)
    if (ownsUserData) await dependencies.removeProfile(profile).catch(() => undefined)
    throw error
  }
}

export { resizeWindow } from './sottoWindow'
export { captureWindow } from './sottoCapture'

/**
 * Each launched main's process, kept at launch because Playwright no longer hands it out once the app is closed, and
 * what it wrote after an uncaught exception (#1577): its stable line and the frames under it.
 */
const launchedProcesses = new WeakMap<ElectronApplication, { child: ChildProcess; report: string }>()

function keepUncaughtReport(application: ElectronApplication): void {
  // A stand-in application in the launch helper's own tests has no process.
  const child = typeof application.process === 'function' ? application.process() : null
  if (!child?.stderr) return
  const kept = { child, report: '' }
  launchedProcesses.set(application, kept)
  let seen = ''
  child.stderr.on('data', (chunk: Buffer | string) => {
    if (kept.report) { kept.report = (kept.report + String(chunk)).slice(0, 4_000); return }
    seen = (seen + String(chunk)).slice(-4_000)
    const at = seen.indexOf(E2E_UNCAUGHT_PREFIX)
    if (at >= 0) kept.report = seen.slice(at)
  })
}

/** The process's exit code once it has exited; null when it is still running after `withinMs`. */
async function exitCode(application: ElectronApplication, withinMs: number): Promise<number | null> {
  const child = launchedProcesses.get(application)?.child
  if (!child) return null
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), withinMs)
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
}

/**
 * Closes Sotto and removes the profile it owns. An uncaught exception in main, during the test or while it closed,
 * ends main with `E2E_UNCAUGHT_EXIT_CODE` rather than a box on the desktop (#1577), and fails the test here with the
 * place it was thrown.
 */
export async function closeSotto(launched: LaunchedSotto): Promise<void> {
  await launched.app.close().catch(() => undefined)
  if (launched.ownsUserData) await removeOwnedE2EProfile(launched.userData)
  if (await exitCode(launched.app, 5_000) === E2E_UNCAUGHT_EXIT_CODE) {
    throw new Error(`Sotto's main process had an uncaught exception.\n${launchedProcesses.get(launched.app)?.report.trim() || '(It wrote no report.)'}`)
  }
}

/** The Threads page landmark: its sidebar. */
function threadSidebar(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Thread sidebar' })
}

/** First-run setup's stops, in the order its walk visits them (ADR-0200); `omarchy` only on Linux. */
const SETUP_STOPS = ['welcome', 'agents', 'project', 'thread', 'omarchy', 'microphone', 'speech-model', 'shortcut', 'tailscale', 'computers', 'iphone', 'end'] as const
export type SetupStopId = typeof SETUP_STOPS[number]

export interface FirstRunSetupOptions {
  /** 'test' runs Settings' microphone test at the walk's microphone stop and waits for it to hear a voice; 'skip' (the default) leaves it untested. */
  readonly microphone?: 'test' | 'skip'
}

/** First-run setup's note, beside the control its stop lights. */
export function setupNote(page: Page): Locator {
  return page.locator('.setup-walk__note')
}

/** The stop the walk is on. */
export async function setupStop(page: Page): Promise<SetupStopId> {
  await expect(setupNote(page)).toBeVisible()
  return await page.locator('.setup-walk').getAttribute('data-stop') as SetupStopId
}

/**
 * The note's way forward: Start on the first note, then Continue once the stop's task is done and Skip for now until
 * then (Continue to dictation once the first thread is open), and Done on the last note.
 */
export function setupForwardButton(page: Page): Locator {
  return setupNote(page).locator('.setup-walk__actions button').last()
}

/**
 * Walks first-run setup forward to the named stop: its note is showing and nothing past it has been touched. With no
 * agent connected the walk passes over `project` and `thread`, so a spec that stops there connects one first.
 */
export async function reachSetupStop(page: Page, stop: SetupStopId): Promise<void> {
  for (let presses = 0; presses < SETUP_STOPS.length; presses += 1) {
    const now = await setupStop(page)
    if (now === stop) return
    if (SETUP_STOPS.indexOf(now) > SETUP_STOPS.indexOf(stop)) throw new Error(`First-run setup is on ${now}, past ${stop}.`)
    await setupForwardButton(page).click()
    await expect(page.locator('.setup-walk')).not.toHaveAttribute('data-stop', now)
  }
  throw new Error(`First-run setup never reached ${stop}.`)
}

/** Ends first-run setup from whichever stop it is on, with Skip setup, Finish here or the last note's Done, and waits for the Threads page. */
export async function skipSetup(page: Page): Promise<void> {
  const note = setupNote(page)
  await expect(note).toBeVisible()
  const quit = note.locator('.setup-walk__quit')
  if ((await quit.count()) > 0) await quit.click()
  else await setupForwardButton(page).click()
  await expect(page.locator('.setup-walk')).toHaveCount(0)
  await expect(threadSidebar(page)).toBeVisible()
}

/**
 * Finishes first-run setup from wherever it is: the microphone test first when asked for, then Skip setup. The window
 * is left on the Threads page with setup saved as done.
 */
export async function completeFirstRunSetup(page: Page, options: FirstRunSetupOptions = {}): Promise<void> {
  if (options.microphone === 'test') {
    await reachSetupStop(page, 'microphone')
    await page.locator('.settings-microphone-test').getByRole('button', { name: 'Test microphone', exact: true }).click()
    await expect(page.locator('.settings-microphone-test[data-heard]')).toBeVisible()
    await expect(setupNote(page)).toContainText('Sotto heard you. Your microphone works.')
  }
  await skipSetup(page)
}

/**
 * Opens the Threads page from wherever the window happens to be. Sotto now
 * opens on Threads, so the common case is that the workspace is already there and
 * nothing is clicked. The sidebar alone also appears beside Dictate and Help.
 * Otherwise the page is reached through the footer link on
 * the pages that still have a footer, and through the Dictate/Threads switch on
 * the pages that do not.
 */
export async function openThreads(page: Page): Promise<void> {
  const sidebar = threadSidebar(page)
  if (await page.locator('.threads-view').isVisible()) {
    await expect(sidebar).toBeVisible()
    return
  }
  const link = page.getByRole('link', { name: 'Threads', exact: true })
  if ((await link.count()) > 0) await link.click()
  // Settings has a page named Threads too; the room switch is every other tablist.
  else await page.locator('[role="tablist"]:not([aria-label="Settings sections"])').getByRole('tab', { name: 'Threads', exact: true }).click()
  await expect(sidebar).toBeVisible()
}

/** The pages a spec can reach by name; Dictate is a switch tab rather than a link. */
export type SottoPageName = 'Memory' | 'Settings' | 'Help' | 'Dictate'

/**
 * Opens one of the named pages. The sidebar foot on Threads and the footer on
 * every other page carry the same accessible names, so one link query serves
 * both; Dictate is the other half of the page switch and answers to a tab.
 */
export async function openPage(page: Page, name: SottoPageName): Promise<void> {
  if (name === 'Dictate') {
    await page.getByRole('tab', { name: 'Dictate', exact: true }).click()
    return
  }
  await page.getByRole('link', { name, exact: true }).click()
}

/** Opens the newest transcript in the Dictate room's Journal from the keyboard, the way a row opens in place. */
export async function openJournalRow(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^Transcript from/ }).first()
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/**
 * The texts of a thread's user messages, read through the thread-detail bridge: the shell that
 * `agents.get()` answers with summarises every history instead of carrying it.
 */
export async function userMessageTexts(page: Page, threadId: string): Promise<string[]> {
  return page.evaluate(async id => {
    const detail = await window.sotto!.agents!.threadDetail!(id)
    return (detail?.messages ?? []).filter(message => message.role === 'user').map(message => message.text)
  }, threadId)
}

/**
 * Runs one of a pane's More-menu actions. The pane header keeps a single menu
 * button now; Rename, Reconnect, Settle and their kin sit behind it.
 * Scoped to a pane locator when several panes are open, or to the page when
 * one pane is.
 */
export async function paneMenuAction(scope: Page | Locator, name: string): Promise<void> {
  await scope.getByRole('button', { name: 'More actions', exact: true }).first().click()
  await scope.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name, exact: true }).click()
}

/** The focused pane's Tools symbol (ADR-0182): every pane has one, and this is where the panel hands focus back. */
export const FOCUSED_TOOLS = '.thread-pane[data-focused] .tools-toggle'

/** Shows or hides Tools from a pane's header: the given pane's symbol, or on a page the focused pane's. */
export async function toggleTools(scope: Page | Locator): Promise<void> {
  await scope.locator('goto' in scope ? FOCUSED_TOOLS : '.tools-toggle').click()
}

/** Shows or hides a pane's Terminal drawer from its header (ADR-0182): the given pane's, or the first pane's on a page. */
export async function toggleTerminalDrawer(scope: Page | Locator): Promise<void> {
  await scope.getByRole('button', { name: 'Terminal drawer', exact: true }).first().click()
}
