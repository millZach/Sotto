import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'

import { requireOwnedE2EProfile } from '../../../scripts/e2e-profile-policy.mjs'
import type { E2EScenario } from '../../../src/shared/e2e'

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
      args: ['out/main/index.js'],
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

export async function closeSotto(launched: LaunchedSotto): Promise<void> {
  await launched.app.close().catch(() => undefined)
  if (launched.ownsUserData) await removeOwnedProfile(launched.userData)
}

/** The Threads page landmark, whichever sidebar mode the window last remembered. */
function threadSidebar(page: Page): Locator {
  return page.getByRole('complementary', { name: /Thread sidebar|Terminal sidebar/ })
}

/**
 * Opens the Threads page from wherever the window happens to be. Sotto now
 * opens on Threads, so the common case is that the sidebar is already there and
 * nothing is clicked. Otherwise the page is reached through the footer link on
 * the pages that still have a footer, and through the Dictate/Threads switch on
 * the pages that do not.
 */
export async function openThreads(page: Page): Promise<void> {
  const sidebar = threadSidebar(page)
  if (await sidebar.isVisible()) return
  const link = page.getByRole('link', { name: 'Threads', exact: true })
  if ((await link.count()) > 0) await link.click()
  else await page.getByRole('tab', { name: 'Threads', exact: true }).click()
  await expect(sidebar).toBeVisible()
}

/** The pages a spec can reach by name; Dictate is a switch tab rather than a link. */
export type SottoPageName = 'Chats' | 'History' | 'Memory' | 'Settings' | 'Help' | 'Dictate'

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
 * Turns the voice coordinator, and memory with it, on in a profile before its
 * window opens. The beta hides the Agents room, the wake phrase and every "let
 * Sotto manage" control behind `voiceCoordinatorEnabled`, and the Memory page
 * with the questionnaire that greets the Agents room behind `memoryEnabled`, so
 * a spec that still exercises them has to seed the settings. Whatever else the spec already wrote is kept; a profile with
 * no settings file yet gets one holding only the flag, which the main process
 * fills out from the defaults when it reads it.
 */
export async function enableVoiceCoordinator(userData: string): Promise<void> {
  const file = join(userData, 'settings.json')
  let persisted: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) persisted = parsed as Record<string, unknown>
  } catch {
    // No settings file yet, or one this profile is about to replace anyway.
  }
  await mkdir(userData, { recursive: true })
  await writeFile(file, `${JSON.stringify({ ...persisted, voiceCoordinatorEnabled: true, memoryEnabled: true }, null, 2)}\n`, 'utf8')
}

/**
 * Launches with the voice coordinator already on, in a throwaway profile this
 * module still owns, so the spec's own cleanup removes it as usual.
 */
export async function launchSottoWithVoice(scenario: E2EScenario = 'success'): Promise<LaunchedSotto> {
  return launchSotto(scenario, undefined, {
    ...defaultDependencies,
    createProfile: async () => {
      const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-voice-'))
      await enableVoiceCoordinator(profile)
      return profile
    },
  })
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
 * button now; Rename, Manage, Reconnect, Settle and their kin sit behind it.
 * Scoped to a pane locator when several panes are open, or to the page when
 * one pane is.
 */
export async function paneMenuAction(scope: Page | Locator, name: string): Promise<void> {
  await scope.getByRole('button', { name: 'More actions', exact: true }).first().click()
  await scope.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name, exact: true }).click()
}
