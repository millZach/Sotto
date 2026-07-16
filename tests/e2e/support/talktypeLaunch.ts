import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

import type { E2EScenario } from '../../../src/shared/e2e'

export interface LaunchedTalkType {
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
    TALKTYPE_E2E: '1',
    TALKTYPE_E2E_SCENARIO: scenario,
    TALKTYPE_E2E_USER_DATA: userData,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function assertOwnedProfile(path: string): void {
  const absolute = resolve(path)
  const temporaryRoot = resolve(tmpdir())
  if (
    dirname(absolute).toLocaleLowerCase() !== temporaryRoot.toLocaleLowerCase() ||
    !/^talktype-e2e-[A-Za-z0-9_-]+$/.test(basename(absolute))
  ) throw new Error('Refusing to remove an unsafe E2E profile path.')
}

async function removeOwnedProfile(path: string): Promise<void> {
  assertOwnedProfile(path)
  await rm(path, { recursive: true, force: true })
}

const defaultDependencies: LaunchDependencies = {
  createProfile: () => mkdtemp(join(tmpdir(), 'talktype-e2e-')),
  launch: (options) => electron.launch(options),
  firstWindow: (application) => application.firstWindow(),
  removeProfile: removeOwnedProfile,
}

export async function launchTalkType(
  scenario: E2EScenario = 'success',
  userData?: string,
  dependencies: LaunchDependencies = defaultDependencies,
): Promise<LaunchedTalkType> {
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

export async function closeTalkType(launched: LaunchedTalkType): Promise<void> {
  await launched.app.close().catch(() => undefined)
  if (launched.ownsUserData) await removeOwnedProfile(launched.userData)
}
