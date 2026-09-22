/* PROTOTYPE, throwaway: paints the Threads page and Appearance in every candidate palette. Build with VITE_THEME_PROTOTYPE=1, run with SOTTO_THEME_PROTOTYPE=1. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { PROTOTYPE_NEW_PALETTES } from '../../src/renderer/src/features/settings/themes/prototype-theme-picker/prototypePalettes'
import { designThreadsFixture } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { canonicalizeTheme } from '../../src/shared/themes/library'
import { closeSotto, launchSotto, openPage, openThreads, resizeWindow } from './support/sottoLaunch'

const out = resolve(process.cwd(), 'artifacts/prototype-theme-picker/palettes')
const ids = ['t3-code', ...PROTOTYPE_NEW_PALETTES.map(theme => theme.id)]

test.skip(process.env.SOTTO_THEME_PROTOTYPE !== '1', 'prototype captures are opt-in')

async function paintWith(page: Page, id: string): Promise<void> {
  await page.evaluate(async theme => {
    await (window as unknown as { sotto: { updateSettings: (patch: object) => Promise<unknown> } }).sotto.updateSettings({ lightTheme: theme, darkTheme: theme })
  }, id)
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', id)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(250)
}

for (const appearance of ['dark', 'light'] as const) {
  test(`candidate palettes, ${appearance}`, async () => {
    test.setTimeout(300_000)
    await mkdir(out, { recursive: true })
    const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-proto-palettes-'))
    const fixture = designThreadsFixture()
    await writeFile(join(profile, 'settings.json'), JSON.stringify({
      ...DEFAULT_SETTINGS, onboardingComplete: true, appearance, customThemes: PROTOTYPE_NEW_PALETTES.map(canonicalizeTheme),
    }), 'utf8')
    await writeFile(join(profile, 'agents.json'), JSON.stringify({
      configuration: { provider: 'codex', enabled: true, projectsDirectory: '', defaultModelId: 'claude:sonnet', followupLimit: 5, speak: false, speechProvider: 'system', speechVoice: 'F1', grokSpeechVoice: 'ara', wakeModelDirectory: '', wakeRuntimeDirectory: '', reasoning: 'none', reasoningModel: '', reasoningEffort: '', membershipEndpoint: '' },
      assignments: fixture.assignments.map(assignment => ({ ...assignment, contextUpdatedAt: Date.now() })),
      queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', contextSavedAt: Date.now(), outbox: [],
    }), 'utf8')
    const launched = await launchSotto('design-threads', profile)
    try {
      const { page } = launched
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await resizeWindow(launched, 1600, 1000)
      await openThreads(page)
      const thread = page.getByRole('button', { name: 'Visual gate flake', exact: true })
      await thread.click()
      await expect(thread).toHaveAttribute('aria-current', 'page')
      for (const id of ids) {
        await paintWith(page, id)
        await page.screenshot({ path: join(out, `${id}-threads-${appearance}.png`), animations: 'disabled' })
      }
      await openPage(page, 'Settings')
      await page.locator('#tab-settings-appearance').click()
      await page.waitForSelector('#settings-appearance')
      for (const id of ids) {
        await paintWith(page, id)
        await page.screenshot({ path: join(out, `${id}-appearance-${appearance}.png`), animations: 'disabled' })
      }
    } finally {
      await closeSotto(launched)
    }
  })
}
