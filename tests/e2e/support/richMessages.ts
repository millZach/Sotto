import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'

export interface LaunchedRichMessages { app: ElectronApplication; page: Page }

let built = false
/** The serial e2e worker reuses this build; every case still launches its own application. */
export function buildRichMessageFixture(): void {
  if (built) return
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'tests/fixtures/richMessages/vite.config.mjs'], { stdio: 'inherit' })
  built = true
}

export async function launchRichMessageFixture(options: { width?: number; height: number; scale?: string },
  ready?: (page: Page) => Promise<void>): Promise<LaunchedRichMessages> {
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    SOTTO_RICH_FIXTURE: '1',
    SOTTO_RICH_FIXTURE_WIDTH: String(options.width ?? 1080),
    SOTTO_RICH_FIXTURE_HEIGHT: String(options.height),
    SOTTO_RICH_FIXTURE_SCALE: options.scale,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await electron.launch({ args: [resolve('tests/fixtures/richMessages/electronMain.cjs')], env })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('load')
    await page.evaluate(() => document.fonts.ready)
    await expect(page.getByRole('img', { name: 'help-page-404.png' })).toBeVisible()
    await ready?.(page)
    return { app, page }
  } catch (error) {
    await app.close().catch(() => undefined)
    throw error
  }
}
