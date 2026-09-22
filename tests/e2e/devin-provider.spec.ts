import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/** Resolve theme colors through the browser, including color-mix and translucent surfaces. */
async function textContrast(locator: Locator): Promise<number> {
  return locator.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d')!
    const rgba = (color: string): number[] => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value)
    }
    const blend = (front: number[], back: number[]): number[] => front.slice(0, 3).map((value, index) => value * front[3]! + back[index]! * (1 - front[3]!))
    const ancestors: Element[] = []; let current: Element | null = element
    while (current) { ancestors.unshift(current); current = current.parentElement }
    let background = [255, 255, 255]
    for (const ancestor of ancestors) background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background)
    const foreground = blend(rgba(getComputedStyle(element).color), background)
    const luminance = (color: number[]): number => color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
    const light = Math.max(luminance(foreground), luminance(background))
    const dark = Math.min(luminance(foreground), luminance(background))
    return (light + .05) / (dark + .05)
  })
}

test('uses Devin through the native adapter and preserves explicit thread decisions', async () => {
  test.setTimeout(180_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-devin-'))
  const root = join(profile, 'devin-fixture')
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  await mkdir('artifacts/devin-local-provider', { recursive: true })
  const previousRoot = process.env.SOTTO_E2E_DEVIN_ROOT
  const previousExecutable = process.env.SOTTO_E2E_DEVIN_EXECUTABLE
  process.env.SOTTO_E2E_DEVIN_ROOT = root
  process.env.SOTTO_E2E_DEVIN_EXECUTABLE = process.execPath
  const contrasts: { surface: string; width: number; appearance: string; ratio: number }[] = []
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
    await page.reload()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Providers', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Provider configuration', exact: true })
    await page.getByRole('button', { name: 'Devin', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Enable Devin' })).toHaveAttribute('aria-checked', 'false')
    await expect(panel).toContainText('devin auth login')
    await expect(panel).toContainText('usage analytics')
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
        await expect(panel.getByRole('button', { name: 'Connect Devin' })).toBeVisible()
        const horizontalOverflow = await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1)
        expect(horizontalOverflow).toBe(false)
        const ratio = await textContrast(panel.locator('.provider-models__empty').filter({ hasText: 'Uses your Devin account' }))
        expect(ratio).toBeGreaterThanOrEqual(4.5)
        contrasts.push({ surface: 'Devin disclosure', width, appearance, ratio })
        await page.screenshot({ animations: 'disabled', path: `artifacts/devin-local-provider/settings-${width}-${appearance}.png` })
      }
    }
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark', reducedMotion: 'system' }))
    await panel.getByRole('button', { name: 'Connect Devin' }).click()
    await expect(panel.getByRole('button', { name: 'Disconnect Devin' })).toBeVisible()
    await expect(panel.getByRole('combobox', { name: 'Devin default thread model' })).toHaveCount(0)
    await panel.getByRole('tab', { name: 'Configuration' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(panel.getByRole('tab', { name: 'Models' })).toBeFocused()
    await expect(panel.getByRole('tabpanel')).toContainText('Fixture Devin')
    await page.keyboard.press('ArrowLeft')
    await expect(panel.getByRole('tab', { name: 'Configuration' })).toBeFocused()
    const prepared = await page.evaluate(async path => {
      await window.sotto!.agents!.command({ type: 'connect', provider: 'codex' })
      return window.sotto!.agents!.command({ type: 'create-project', provider: 'devin', title: 'Devin project', path, useExisting: true })
    }, projectPath)
    expect(prepared.error).toBeNull()
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread in Devin project', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await dialog.getByText('Thread options', { exact: false }).click()
    await dialog.getByRole('textbox', { name: 'Thread name' }).fill('Devin UI check')
    await dialog.getByRole('combobox', { name: 'Thread model' }).click()
    await expect(page.getByRole('dialog', { name: 'Choose model' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Choose model' })).toHaveCount(0)
    await expect(dialog.getByRole('combobox', { name: 'Thread model' })).toBeFocused()
    await dialog.getByRole('combobox', { name: 'Thread model' }).click()
    const picker = page.getByRole('dialog', { name: 'Choose model' })
    await picker.getByRole('tab', { name: 'Devin', exact: true }).click()
    await picker.getByRole('option', { name: 'Fixture Devin', exact: true }).click()
    await expect(dialog.getByRole('combobox', { name: 'Thread model' })).toContainText('Fixture Devin')
    await dialog.getByRole('button', { name: 'Create thread' }).click()
    await expect(dialog).toHaveCount(0)
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Synthetic Devin UI prompt')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(prompt).toHaveValue('')
    const threadId = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.title === 'Devin UI check')!.id)
    const state = async () => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)!, threadId)
    await expect.poll(async () => (await state()).status).toBe('running')
    const aliases = JSON.parse(await readFile(join(profile, 'devin-threads.json'), 'utf8')) as Record<string, { title: string; devinSessionId: string }>
    const nativeId = Object.values(aliases).find(alias => alias.title === 'Devin UI check')!.devinSessionId
    const action = (type: string, text: string) => writeFile(join(root, `control-${nativeId}.json`), JSON.stringify({ id: randomUUID(), type, text }))
    await action('permission', 'Run synthetic check?')
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
        await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible()
        const ratio = await textContrast(page.getByRole('button', { name: 'Allow once', exact: true }))
        expect(ratio).toBeGreaterThanOrEqual(4.5)
        contrasts.push({ surface: 'Allow once', width, appearance, ratio })
        await page.screenshot({ animations: 'disabled', path: `artifacts/devin-local-provider/permission-${width}-${appearance}.png` })
      }
    }
    await page.getByRole('button', { name: 'Deny', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await state()).requests.length).toBe(0)
    await action('permission', 'Run approved synthetic check?')
    await page.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(async () => (await state()).requests.length).toBe(0)
    await action('question', 'Which synthetic color?')
    await page.getByRole('textbox', { name: 'answer', exact: true }).fill('Blue')
    await page.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect.poll(async () => (await state()).requests.length).toBe(0)
    await action('complete', 'Synthetic Devin reply complete')
    await expect(page.getByLabel('Thread transcript')).toContainText('Synthetic Devin reply complete')
    await expect.poll(async () => (await state()).status).toBe('idle')
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await page.screenshot({ animations: 'disabled', path: 'artifacts/devin-local-provider/thread-complete.png' })
    await prompt.fill('Synthetic cancellation prompt')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(prompt).toHaveValue('')
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
    await expect.poll(async () => (await state()).status).toBe('idle')
    // The permission chip changes the mode through the whole path the app uses: preload, IPC, coordinator and
    // adapter. Each of those once dropped or refused a change that carried only the mode.
    const permissions = page.getByRole('combobox', { name: 'Thread permissions', exact: true })
    await expect(permissions).toContainText('Ask first')
    await permissions.click()
    await page.getByRole('option', { name: /^Bypass Permissions/ }).click()
    await expect.poll(async () => (await state()).providerMode).toBe('bypass')
    await expect(permissions).toContainText('Bypass Permissions')
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'disconnect', provider: 'devin' }))
    await expect(page.getByLabel('Thread transcript')).toContainText('Synthetic Devin reply complete')
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).host.providers?.find(provider => provider.id === 'codex')?.connection)).toBe('connected')
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'connect', provider: 'devin' }))
    await expect.poll(async () => (await state()).status).toBe('idle')
    // A reconnected thread keeps the mode it was set to, rather than falling back to the asking one.
    expect((await state()).providerMode).toBe('bypass')
    const restored = JSON.parse(await readFile(join(profile, 'devin-threads.json'), 'utf8')) as Record<string, { devinSessionId: string }>
    expect(Object.values(restored).some(alias => alias.devinSessionId === nativeId)).toBe(true)
    expect(await page.evaluate(async () => (await window.sotto!.getSettings()).voiceCoordinatorEnabled)).toBe(false)
    expect(await readFile(join(root, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
    await writeFile('artifacts/devin-local-provider/contrast.json', JSON.stringify(contrasts, null, 2))
  } finally {
    if (launched) await closeSotto(launched)
    if (previousRoot === undefined) delete process.env.SOTTO_E2E_DEVIN_ROOT; else process.env.SOTTO_E2E_DEVIN_ROOT = previousRoot
    if (previousExecutable === undefined) delete process.env.SOTTO_E2E_DEVIN_EXECUTABLE; else process.env.SOTTO_E2E_DEVIN_EXECUTABLE = previousExecutable
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
