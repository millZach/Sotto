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

/** First-run setup's nine steps, in the order the footer walks them. */
const FIRST_RUN_STEPS = ['welcome', 'look', 'microphone', 'speech-model', 'shortcut', 'agents', 'project', 'computers', 'phone'] as const
export type FirstRunStepId = typeof FIRST_RUN_STEPS[number] | 'omarchy'

async function firstRunSteps(page: Page): Promise<readonly FirstRunStepId[]> {
  const linux = await page.evaluate(() => window.sotto?.platform === 'linux')
  return linux ? ['welcome', 'omarchy', ...FIRST_RUN_STEPS.slice(1)] : FIRST_RUN_STEPS
}

export interface FirstRunSetupOptions {
  /** 'test' runs the microphone test and waits for it to hear a voice before leaving that step; 'skip' (the default) leaves it untested. */
  readonly microphone?: 'test' | 'skip'
}

/**
 * The footer's forward action on a middle first-run step: Continue when the step's own task is done, Skip for now
 * otherwise. Welcome's "Get started" and the final phone step's "Finish setup" are their own calls, since neither
 * label varies with state.
 */
export function firstRunForwardButton(page: Page): Locator {
  return page.locator('.onboarding-actions').getByRole('button', { name: /^(Continue|Skip for now)$/ })
}

/** Clicks past one first-run step, in whichever way that step leaves setup: Welcome's Get started, Finish setup on the last step, or the footer's Continue/Skip for now in between. */
async function advanceFirstRunStep(page: Page, step: FirstRunStepId, options: FirstRunSetupOptions): Promise<void> {
  if (step === 'welcome') {
    await page.getByRole('button', { name: 'Get started' }).click()
    return
  }
  if (step === 'microphone' && options.microphone === 'test') {
    await page.getByRole('button', { name: /test microphone/i }).click()
    await expect(page.getByText('Sotto heard you. Your microphone works.')).toBeVisible()
  }
  if (step === 'phone') {
    await page.getByRole('button', { name: /finish setup/i }).click()
    return
  }
  await firstRunForwardButton(page).click()
}

/** Walks first-run setup up to, but not through, the named step: that step's own heading is showing and nothing past it has been touched. */
export async function reachFirstRunStep(page: Page, step: FirstRunStepId, options: FirstRunSetupOptions = {}): Promise<void> {
  const steps = await firstRunSteps(page), stop = steps.indexOf(step)
  for (const current of steps.slice(0, stop)) await advanceFirstRunStep(page, current, options)
}

/** Ends the Threads tour that first-run setup opens with, from whichever stop it is showing. */
export async function skipThreadsTour(page: Page): Promise<void> {
  const tour = page.locator('.threads-tour')
  await expect(tour).toBeVisible()
  const skipTour = tour.getByRole('button', { name: 'Skip tour' })
  if ((await skipTour.count()) > 0) await skipTour.click()
  else await tour.getByRole('button', { name: 'Done' }).click()
  await expect(tour).toHaveCount(0)
}

/**
 * Finishes first-run setup from wherever `reachFirstRunStep` left it (or from Welcome, the default), through Finish
 * setup and the Threads tour that follows it.
 */
export async function finishFirstRunSetupFrom(
  page: Page,
  from: FirstRunStepId = 'welcome',
  options: FirstRunSetupOptions = {},
): Promise<void> {
  const steps = await firstRunSteps(page)
  for (const step of steps.slice(steps.indexOf(from))) await advanceFirstRunStep(page, step, options)
  await expect(threadSidebar(page)).toBeVisible()
  await skipThreadsTour(page)
}

/** Walks the whole of first-run setup, Welcome through the Threads tour, in one call. */
export async function completeFirstRunSetup(page: Page, options: FirstRunSetupOptions = {}): Promise<void> {
  await finishFirstRunSetupFrom(page, 'welcome', options)
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
