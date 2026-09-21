import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DETERMINISTIC_TRANSCRIPT } from '../fixtures/fakeTranscription'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage } from './support/sottoLaunch'

test('client-only desktop keeps local history, renders Hosts, and retains dictation settings', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-hosts-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const saved = '{"existing":"untouched workspace"}'
  await writeFile(join(profile, 'workspace.json'), saved)
  const launched = await launchSotto('success', profile)
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const state = await page.evaluate(() => window.sotto!.agents!.get())
    expect(state.host.threads).toEqual([])
    expect(state.connections).toEqual([])
    expect(await readFile(join(profile, 'workspace.json'), 'utf8')).toBe(saved)
    expect((await readdir(profile)).filter(file => file.startsWith('threads.sqlite'))).toEqual([])
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Run the local host' })).toHaveAttribute('aria-checked', 'false')
    await page.getByRole('button', { name: 'Add host' }).click()
    await page.getByRole('textbox', { name: 'Host name', exact: true }).fill('Forge')
    await page.getByRole('button', { name: 'Save host', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Forge', exact: true })).toBeVisible()
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await launched.app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width!, size.height!)
      }, { width, height })
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        expect(await page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth,
          form: document.querySelector('.settings-scroll')!.scrollWidth > document.querySelector('.settings-scroll')!.clientWidth + 1 }))).toEqual({ page: false, form: false })
        await page.screenshot({ path: test.info().outputPath(`hosts-${width}-${appearance}.png`), animations: 'disabled' })
      }
    }
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'SSH target' })).toHaveValue('zach@forge')
    await page.getByRole('button', { name: 'Save host', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('button', { name: 'Save host', exact: true })).toBeInViewport()
    expect(await page.getByRole('dialog').evaluate(element => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight })).toBe(true)
    await page.screenshot({ path: test.info().outputPath('host-edit-minimum.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('tab', { name: 'Dictation', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Global shortcut' })).toBeVisible()
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page.getByRole('switch', { name: 'Run the local host' }).click()
    await expect(page.getByRole('button', { name: 'Restart Sotto' })).toBeVisible()
    expect((await page.evaluate(() => window.sotto!.getSettings())).localHostEnabled).toBe(true)
    expect(await readFile(join(profile, 'workspace.json'), 'utf8')).toBe(saved)
    await openPage(page, 'Dictate')
    await page.getByRole('button', { name: /start dictation/i }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E.snapshot())).toMatchObject({ clipboardText: DETERMINISTIC_TRANSCRIPT })
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
