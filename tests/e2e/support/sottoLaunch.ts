import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'

import { requireOwnedE2EProfile } from '../../../scripts/e2e-profile-policy.mjs'
import type { E2EScenario } from '../../../src/shared/e2e'

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

async function removeOwnedProfile(path: string): Promise<void> {
  await rm(requireOwnedE2EProfile(path), { recursive: true, force: true })
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
  createProfile: () => mkdtemp(join(tmpdir(), 'sotto-e2e-')),
  launch: (options) => electron.launch(options),
  firstWindow: firstSottoWindow,
  removeProfile: removeOwnedProfile,
}

export async function launchSotto(
  scenario: E2EScenario = 'success',
  userData?: string,
  dependencies: LaunchDependencies = defaultDependencies,
): Promise<LaunchedSotto> {
  const ownsUserData = userData === undefined
  const profile = userData ?? await dependencies.createProfile()
  let application: ElectronApplication | undefined
  try {
    application = await dependencies.launch({
      args: [process.env.SOTTO_E2E_MAIN_ENTRY ?? 'out/main/index.js'],
      env: e2eEnvironment(scenario, profile),
    })
    const page = await dependencies.firstWindow(application)
    await page.waitForLoadState('domcontentloaded')
    return { app: application, page, userData: profile, ownsUserData }
  } catch (error: unknown) {
    await application?.close().catch(() => undefined)
    if (ownsUserData) await dependencies.removeProfile(profile).catch(() => undefined)
    throw error
  }
}

/** Resize the main window and wait for the page to see the new width; fractional display scaling rounds it by a pixel or two. */
export async function resizeWindow(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    window.setSize(size.width, size.height)
  }, { width, height })
  await expect.poll(async () => Math.abs(await launched.page.evaluate(() => innerWidth) - width)).toBeLessThanOrEqual(2)
}

/**
 * The main window as it is drawn on screen, through Electron's own capture of its composited frame. Playwright's
 * screenshot of the page composes a `<webview>` guest (an interactive visual's page, ADR-0060) at the wrong scale on a
 * scaled display, 1.5 times too large and cut off at 150%, though the screen shows it right; a capture that shows one
 * is taken here instead.
 */
export async function captureWindow(application: ElectronApplication, path: string): Promise<void> {
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))
    if (!window) throw new Error('No main window to capture.')
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(path, Buffer.from(png, 'base64'))
}

export async function closeSotto(launched: LaunchedSotto): Promise<void> {
  await launched.app.close().catch(() => undefined)
  if (launched.ownsUserData) await removeOwnedProfile(launched.userData)
}

/** The Threads page landmark, whichever sidebar mode the window last remembered. */
function threadSidebar(page: Page): Locator {
  return page.getByRole('complementary', { name: /Thread sidebar|Terminal sidebar/ })
}

/** First-run setup's nine steps, in the order the footer walks them. */
const FIRST_RUN_STEPS = ['welcome', 'look', 'microphone', 'key', 'shortcut', 'agents', 'project', 'computers', 'phone'] as const
export type FirstRunStepId = typeof FIRST_RUN_STEPS[number]

export interface FirstRunSetupOptions {
  /** 'test' runs the microphone test and waits for it to report ready before leaving that step; 'skip' (the default) leaves it untested. */
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
    await expect(page.getByText(/microphone ready/i)).toBeVisible()
  }
  if (step === 'phone') {
    await page.getByRole('button', { name: /finish setup/i }).click()
    return
  }
  await firstRunForwardButton(page).click()
}

/** Walks first-run setup up to, but not through, the named step: that step's own heading is showing and nothing past it has been touched. */
export async function reachFirstRunStep(page: Page, step: FirstRunStepId, options: FirstRunSetupOptions = {}): Promise<void> {
  const stop = FIRST_RUN_STEPS.indexOf(step)
  for (const current of FIRST_RUN_STEPS.slice(0, stop)) await advanceFirstRunStep(page, current, options)
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
  for (const step of FIRST_RUN_STEPS.slice(FIRST_RUN_STEPS.indexOf(from))) await advanceFirstRunStep(page, step, options)
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
 * nothing is clicked. The sidebar alone also appears beside Dictate, History and Help.
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
  else await page.getByRole('tab', { name: 'Threads', exact: true }).click()
  await expect(sidebar).toBeVisible()
}

/** The pages a spec can reach by name; Dictate is a switch tab rather than a link. */
export type SottoPageName = 'History' | 'Memory' | 'Settings' | 'Help' | 'Dictate'

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
