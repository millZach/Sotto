import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

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
  }).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

async function removeOwnedProfile(path: string): Promise<void> {
  await rm(requireOwnedE2EProfile(path), { recursive: true, force: true })
}

const defaultDependencies: LaunchDependencies = {
  createProfile: () => mkdtemp(join(tmpdir(), 'sotto-e2e-')),
  launch: (options) => electron.launch(options),
  firstWindow: (application) => application.firstWindow(),
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

export async function closeSotto(launched: LaunchedSotto): Promise<void> {
  await launched.app.close().catch(() => undefined)
  if (launched.ownsUserData) await removeOwnedProfile(launched.userData)
}
