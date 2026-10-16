import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { defaultAgentConfiguration } from '../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'
import { textContrast } from './support/textContrast'

/**
 * The starting screen (ADR-0086) in the built app: it covers launch while this computer's providers and a saved host
 * connect, names what has not answered after ten seconds with a button that opens Sotto without it, and is for launch
 * only. `SOTTO_E2E_STARTING_SCREEN=1` asks for it; every other journey opens straight onto the app.
 */
const evidence = evidenceDirectory('artifacts/starting-screen')
const FORGE = '33333333-3333-4333-8333-333333333333'

/** Sets the variables for one launch and puts back what was there before. */
async function withEnvironment<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  try { return await run() } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

async function appearance(page: Page, mode: 'dark' | 'light'): Promise<void> {
  await page.evaluate(value => window.sotto!.updateSettings({ appearance: value }), mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
}

/** Nothing scrolls sideways and the column sits wholly inside the window. */
async function fits(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const block = document.querySelector('.starting-screen__block')!.getBoundingClientRect()
    return document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight
      && block.left >= 0 && block.right <= innerWidth && block.top >= 0 && block.bottom <= innerHeight
  })
}

test('covers launch until the providers connect, then opens on Threads, and a reload goes straight to the app', async () => {
  test.setTimeout(120_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-starting-' })).directory
  const root = join(profile, 'devin-fixture')
  await mkdir(join(root, 'project'), { recursive: true })
  await mkdir(evidence, { recursive: true })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), provider: 'devin', enabledProviders: ['codex', 'devin'], enabled: true },
    activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false, outbox: [],
  }))
  // Devin answers its first start eight seconds late, so the screen has something to wait for.
  await writeFile(join(root, 'script.json'), JSON.stringify({ delayInitialize: 8_000 }))
  let launched: LaunchedSotto | undefined
  try {
    launched = await withEnvironment({ SOTTO_E2E_STARTING_SCREEN: '1', SOTTO_E2E_DEVIN_ROOT: root, SOTTO_E2E_DEVIN_EXECUTABLE: process.execPath },
      () => launchSotto('success', profile))
    const { page } = launched
    const status = page.locator('.starting-screen').getByRole('status')
    await expect(status).toHaveText('Connecting Devin', { timeout: 15_000 })
    const items = page.getByRole('list', { name: 'Providers and hosts' })
    await expect(items.getByRole('listitem')).toHaveText(['Codex, ready', 'Devin, connecting'])
    await expect(page.locator('.starting-screen [data-state="ready"]')).toHaveCount(1)
    // Nothing in the room takes focus while it waits, and the Threads page is not underneath it.
    await expect(page.locator('.starting-screen button')).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: /Thread sidebar|Terminal sidebar/ })).toHaveCount(0)
    await resizeWindow(launched, 1280, 800)
    await page.screenshot({ path: join(evidence, 'providers-1280x800-dark.png'), animations: 'disabled' })

    // Devin answers: the app replaces the screen.
    await expect(page.getByRole('complementary', { name: /Thread sidebar|Terminal sidebar/ })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.starting-screen')).toHaveCount(0)

    // Launch only: the same window reloaded opens straight onto the app, never painting the screen on the way.
    await page.addInitScript(() => {
      new MutationObserver(() => { if (document.querySelector('.starting-screen')) (window as { sawStartingScreen?: boolean }).sawStartingScreen = true })
        .observe(document, { childList: true, subtree: true })
    })
    await page.reload()
    await expect(page.getByRole('complementary', { name: /Thread sidebar|Terminal sidebar/ })).toBeVisible()
    expect(await page.evaluate(() => (window as { sawStartingScreen?: boolean }).sawStartingScreen ?? false)).toBe(false)
  } finally {
    if (launched) await closeSotto(launched)
    await removeOwnedE2EProfile(profile).catch(() => undefined)
  }
})

test('names a host that has not answered in ten seconds, and opens Sotto without it from the keyboard', async () => {
  test.setTimeout(150_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-starting-late-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~'), { recursive: true })
  await mkdir(evidence, { recursive: true })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  // forge is switched on, so Sotto connects it at launch; the scripted ssh signs in and then never answers.
  await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: FORGE, name: 'forge', target: 'forge', identityFile: '',
    installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', enabled: true }]))
  let launched: LaunchedSotto | undefined
  try {
    launched = await withEnvironment({
      SOTTO_E2E_STARTING_SCREEN: '1', SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
      FAKE_SSH_MODE: 'timeout', FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'), HOME: join(root, '~'), USERPROFILE: join(root, '~'),
    }, () => launchSotto('success', profile))
    const { page } = launched
    const screen = page.locator('.starting-screen')
    const status = screen.getByRole('status')
    const late = page.getByRole('button', { name: 'Open Sotto without forge' })

    // Connecting: captured at both sizes and in both modes before the ten seconds are up.
    await expect(status).toHaveText('Connecting forge', { timeout: 15_000 })
    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        await appearance(page, mode)
        await expect(status).toHaveText('Connecting forge')
        await page.screenshot({ path: join(evidence, `connecting-${width}x${height}-${mode}.png`), animations: 'disabled' })
      }
    }
    await expect(late).toHaveCount(0)

    // Ten seconds: the line names forge, says Sotto keeps trying, and its button takes focus.
    await expect(status).toHaveText('Waiting for forge', { timeout: 15_000 })
    await expect(screen.getByText('forge has not answered in 10 seconds. Sotto keeps trying in the background.')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Providers and hosts' }).getByRole('listitem')).toHaveText(['forge, not answering'])
    await expect(late).toBeFocused()
    // The strip still drags the window and keeps its controls; the button is the room's only control.
    expect(await page.locator('.app-strip').evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('drag')
    await expect(screen.getByRole('button')).toHaveCount(1)

    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        await appearance(page, mode)
        expect(await fits(page), `${width}x${height} ${mode}`).toBe(true)
        for (const pair of await textContrast(screen, '.starting-screen__line, .starting-screen__item, .starting-screen__late p, .starting-screen__late button')) {
          expect(pair.ratio, `${pair.text} at ${width}x${height} ${mode}`).toBeGreaterThanOrEqual(4.5)
        }
        if (width !== 1600) await page.screenshot({ path: join(evidence, `late-${width}x${height}-${mode}.png`), animations: 'disabled' })
      }
    }
    await appearance(page, 'dark')

    // Enter on the focused button opens the app; forge keeps connecting in the background.
    await late.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('complementary', { name: /Thread sidebar|Terminal sidebar/ })).toBeVisible()
    await expect(screen).toHaveCount(0)
    const forge = (await page.evaluate(() => window.sotto!.hosts!.get())).hosts.find(host => host.id === FORGE)
    expect(forge?.phase).toBe('connecting')
  } finally {
    if (launched) await closeSotto(launched)
    await removeOwnedE2EProfile(profile).catch(() => undefined)
  }
})
