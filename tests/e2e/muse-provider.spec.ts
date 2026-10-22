import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { expectPromptText, fillPrompt, promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/muse-provider')
const sizes = [[1600, 1000], [1280, 800], [820, 560]] as const
type Frame = { method?: string; params?: Record<string, unknown> }

/** Resolve color-mix and translucent theme surfaces as Chromium renders them. */
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
    return (Math.max(luminance(foreground), luminance(background)) + .05) / (Math.min(luminance(foreground), luminance(background)) + .05)
  })
}

async function providerPanel(page: Page): Promise<Locator> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Providers', exact: true }).click()
  return page.getByRole('region', { name: 'Provider configuration', exact: true })
}

/** Keyboard activation waits for the previous command's lane to release before taking focus. */
async function activate(page: Page, button: Locator): Promise<void> {
  await expect(button).toBeEnabled()
  await button.focus()
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
}

test('uses Muse in Owl, settles requests and steered activity, and preserves it through stable', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-muse-' })).directory
  const root = join(profile, 'muse-fixture')
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  await mkdir(evidence, { recursive: true })
  const previousEnvironment = {
    SOTTO_E2E_MUSE_ROOT: process.env.SOTTO_E2E_MUSE_ROOT,
    SOTTO_E2E_MUSE_EXECUTABLE: process.env.SOTTO_E2E_MUSE_EXECUTABLE,
    SOTTO_OWL_FEATURES: process.env.SOTTO_OWL_FEATURES,
  }
  process.env.SOTTO_E2E_MUSE_ROOT = root
  process.env.SOTTO_E2E_MUSE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'muse=1'
  const contrasts: { surface: string; width: number; appearance: string; ratio: number }[] = []
  const pageErrors: string[] = []
  const frames = async (file = 'requests.jsonl'): Promise<Frame[]> => (await readFile(join(root, file), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Frame)
  const processCount = async (): Promise<number> => (await Promise.all([frames(), frames('oneshot.jsonl')])).flat().filter(frame => frame.method === 'fixture/process').length
  let launched: LaunchedSotto | undefined
  const launch = async (): Promise<LaunchedSotto> => {
    const result = await launchSotto('success', profile)
    result.page.on('pageerror', error => pageErrors.push(error.message))
    return result
  }
  try {
    launched = await launch()
    const { page } = launched
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }))
    await page.reload()
    const panel = await providerPanel(page)
    await page.getByRole('button', { name: 'Muse', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('switch', { name: 'Enable Muse' })).toHaveAttribute('aria-checked', 'false')
    await expect(panel).toContainText('Uses your Muse sign-in on this computer.')
    await expect(panel.locator('svg[data-provider="muse"]')).toBeVisible()
    await page.getByRole('button', { name: 'Copy Muse login command' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Copy Muse login command' })).toHaveText('Copied')
    for (const [width, height] of sizes) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
        await expect(panel.getByRole('button', { name: 'Connect Muse' })).toBeVisible()
        expect(await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false)
        const ratio = await textContrast(panel.locator('.provider-connection p'))
        expect(ratio).toBeGreaterThanOrEqual(4.5)
        contrasts.push({ surface: 'Muse sign-in', width, appearance, ratio })
        await page.screenshot({ animations: 'disabled', path: join(evidence, `settings-${width}-${appearance}.png`) })
      }
    }
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await panel.getByRole('button', { name: 'Connect Muse' }).focus()
    await page.keyboard.press('Enter')
    await expect(panel.getByRole('button', { name: 'Disconnect Muse' })).toBeVisible()
    await panel.getByRole('button', { name: 'Check again', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(panel.locator('.provider-client').filter({ hasText: 'Installed client' })).toContainText('1.1.1')
    await expect(panel.getByRole('button', { name: 'Check again', exact: true })).toBeInViewport()
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'settings-connected-1280-dark.png') })
    const deferUpdates = page.getByRole('button', { name: 'Not now', exact: true })
    if (await deferUpdates.count()) await deferUpdates.click()
    await panel.getByRole('tab', { name: 'Configuration' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(panel.getByRole('tab', { name: 'Models' })).toBeFocused()
    await expect(panel.getByRole('tabpanel')).toContainText('Fixture Muse')
    await page.keyboard.press('ArrowLeft')
    await expect(panel.getByRole('tab', { name: 'Configuration' })).toBeFocused()

    // Supply an owned fixture folder, then use the current instant-creation flow and composer picker.
    const prepared = await page.evaluate(async path => {
      await window.sotto!.agents!.command({ type: 'connect', provider: 'codex' })
      const state = await window.sotto!.agents!.get()
      const modelId = state.host.models.find(model => model.providerId === 'muse')!.id
      await window.sotto!.agents!.command({ type: 'configure', patch: { newThreadModelId: modelId } })
      return window.sotto!.agents!.command({ type: 'create-project', provider: 'muse', title: 'Muse project', path, useExisting: true })
    }, projectPath)
    expect(prepared.error).toBeNull()
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread in Muse project', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New thread', exact: true })).toBeVisible()
    const projects = page.getByRole('region', { name: 'Projects' })
    // An unsent thread is listed once its composer holds text, under that text.
    await page.getByRole('textbox', { name: 'Prompt' }).fill('Muse draft')
    await projects.getByRole('button', { name: 'Muse draft', exact: true }).hover()
    await projects.getByRole('button', { name: 'Rename Muse draft', exact: true }).click()
    await page.getByLabel('Rename Muse draft').fill('Muse UI check')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'Muse UI check', exact: true })).toBeVisible()
    const model = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await model.click()
    await expect(page.getByRole('dialog', { name: 'Choose model' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Choose model' })).toHaveCount(0)
    await expect(model).toBeFocused()
    await model.click()
    const picker = page.getByRole('dialog', { name: 'Choose model' })
    await picker.getByRole('tab', { name: 'Muse', exact: true }).click()
    await picker.getByRole('option', { name: 'Fixture Muse', exact: true }).click()
    await expect(model).toContainText('Fixture Muse')
    const prompt = promptField(page)
    await fillPrompt(prompt, 'Synthetic Muse UI prompt')
    await prompt.press('Enter')
    await expectPromptText(prompt, '')
    const threadId = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.title === 'Muse UI check')!.id)
    const state = async () => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)!, threadId)
    const detail = async () => page.evaluate(async id => (await window.sotto!.agents!.threadDetail!(id))!, threadId)
    await expect.poll(async () => (await state()).status).toBe('running')
    await expect.poll(async () => (await detail()).messages.some(message => message.text === 'Synthetic Muse UI prompt')).toBe(true)
    const originalTurn = (await detail()).messages.find(message => message.text === 'Synthetic Muse UI prompt')!.id
    await expect.poll(async () => (await state()).lastTurn?.id).toBe(originalTurn)
    const aliases = JSON.parse(await readFile(join(profile, 'muse-threads.json'), 'utf8')) as Record<string, { title: string; museSessionId: string }>
    const nativeId = Object.values(aliases).find(alias => alias.title === 'Muse UI check')!.museSessionId
    const action = (type: string, text = '', extra: Record<string, unknown> = {}) => writeFile(join(root, 'control.json'), JSON.stringify({ id: randomUUID(), type, text, sessionId: nativeId, ...extra }))
    await action('permission', 'Run synthetic check?')
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
    for (const [width, height] of sizes) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
        const allow = page.getByRole('button', { name: 'Allow once', exact: true })
        await expect(allow).toBeVisible()
        const layout = await page.evaluate(() => {
          const card = document.querySelector('.agent-request')!
          const composer = document.querySelector('.thread-prompt')!.getBoundingClientRect()
          return { pageOverflow: document.documentElement.scrollWidth - innerWidth, cardOverflow: card.scrollWidth - card.clientWidth, composerBottom: composer.bottom, height: innerHeight }
        })
        expect(layout.pageOverflow).toBeLessThanOrEqual(1)
        expect(layout.cardOverflow).toBeLessThanOrEqual(1)
        expect(layout.composerBottom).toBeLessThanOrEqual(layout.height + 1)
        const ratio = await textContrast(allow)
        expect(ratio).toBeGreaterThanOrEqual(4.5)
        contrasts.push({ surface: 'Allow once', width, appearance, ratio })
        await page.screenshot({ animations: 'disabled', path: join(evidence, `permission-${width}-${appearance}.png`) })
      }
    }
    await activate(page, page.getByRole('button', { name: 'Deny', exact: true }))
    await expect.poll(async () => (await state()).requests.length).toBe(0)
    expect((await frames()).filter(frame => frame.method === 'approval/decide').at(-1)?.params?.choiceId).toBe('no')
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toHaveCount(0)
    await action('permission', 'Run approved synthetic check?')
    await expect(page.locator('.agent-request')).toContainText('Run approved synthetic check?')
    await activate(page, page.getByRole('button', { name: 'Allow once', exact: true }))
    await expect.poll(async () => (await state()).requests.length).toBe(0)
    expect((await frames()).filter(frame => frame.method === 'approval/decide').at(-1)?.params?.choiceId).toBe('yes')

    await action('question', 'Which synthetic color?', { optional: true })
    await page.getByRole('textbox', { name: 'Fixture', exact: true }).fill('Blue')
    const optional = page.getByRole('textbox', { name: 'Optional', exact: true })
    await expect(optional).toHaveValue('')
    await expect(page.locator('.agent-request__optional')).toHaveText('Optional')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'optional-question-820-light.png') })
    await activate(page, page.getByRole('button', { name: 'Send answers', exact: true }))
    await expect.poll(async () => (await state()).requests.length).toBe(0)
    expect((await frames()).filter(frame => frame.method === 'userInput/answer').at(-1)?.params?.answers).toEqual([
      { questionId: 'q1', freeText: 'Blue' }, { questionId: 'q2', freeText: '' },
    ])
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await fillPrompt(prompt, 'Also check the tests')
    await activate(page, page.getByRole('button', { name: 'Steer now', exact: true }))
    await expectPromptText(prompt, '')
    await expect(page.getByLabel('Thread transcript')).toContainText('Also check the tests')
    await expect.poll(async () => (await detail()).messages.some(message => message.text === 'Also check the tests')).toBe(true)
    expect((await frames()).filter(frame => frame.method === 'turn/steer')).toHaveLength(1)
    expect((await state()).lastTurn?.id).toBe(originalTurn)
    await action('complete', 'Synthetic Muse steered reply complete')
    await expect(page.getByLabel('Thread transcript')).toContainText('Synthetic Muse steered reply complete')
    await expect.poll(async () => (await state()).status).toBe('idle')
    await expect.poll(async () => (await detail()).activities?.filter(activity => activity.kind === 'turn' && activity.status === 'running').length ?? 0).toBe(0)
    expect((await state()).lastTurn).toMatchObject({ id: originalTurn, status: 'completed' })
    await expect(page.getByRole('button', { name: 'Muse UI check', exact: true }).locator('.thread-nav__status')).toHaveAttribute('data-state', 'done')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'steered-thread-complete.png') })

    await fillPrompt(prompt, 'Synthetic gap recovery prompt')
    await prompt.press('Enter')
    await expect.poll(async () => (await state()).status).toBe('running')
    await action('gap', 'Synthetic reply missed by the stream', { repeat: true })
    await expect(page.getByLabel('Thread transcript')).toContainText('Synthetic reply missed by the stream')
    expect((await detail()).messages.filter(message => message.text === 'Synthetic reply missed by the stream')).toHaveLength(1)
    await action('complete', 'Synthetic stream still works')
    await expect(page.getByLabel('Thread transcript')).toContainText('Synthetic stream still works')
    await expect.poll(async () => (await state()).status).toBe('idle')
    await fillPrompt(prompt, 'Synthetic cancellation prompt')
    await prompt.press('Enter')
    await expect.poll(async () => (await state()).status).toBe('running')
    await activate(page, page.getByRole('button', { name: 'Stop agent', exact: true }))
    await expect.poll(async () => (await state()).status).toBe('idle')
    await fillPrompt(prompt, 'Synthetic process recovery prompt')
    await prompt.press('Enter')
    await expect.poll(async () => (await state()).status).toBe('running')
    await action('malformed')
    await expect.poll(async () => (await state()).status).toBe('error')
    await fillPrompt(prompt, 'Continue after process recovery')
    await prompt.press('Enter')
    await expect.poll(async () => (await state()).status).toBe('running')
    await action('complete', 'Synthetic recovered Muse reply')
    await expect(page.getByLabel('Thread transcript')).toContainText('Synthetic recovered Muse reply')
    await expect.poll(async () => (await state()).status).toBe('idle')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'recovered-thread.png') })

    await closeSotto(launched); launched = undefined
    const savedAliases = await readFile(join(profile, 'muse-threads.json'), 'utf8')
    const savedProjects = await readFile(join(profile, 'muse-projects.json'), 'utf8')
    const beforeStable = await processCount()
    process.env.SOTTO_OWL_FEATURES = 'muse=0'
    launched = await launch()
    const stable = launched.page
    await openThreads(stable)
    await expect(stable.getByRole('button', { name: 'Muse UI check', exact: true })).toHaveCount(0)
    const stableState = await stable.evaluate(async () => (await window.sotto!.agents!.get()).host)
    expect(stableState.threads.some(thread => thread.providerId === 'muse')).toBe(false)
    expect(stableState.models.some(model => model.providerId === 'muse')).toBe(false)
    expect(stableState.projects.some(project => project.providerId === 'muse')).toBe(false)
    await providerPanel(stable)
    await expect(stable.getByRole('button', { name: 'Muse', exact: true })).toHaveCount(0)
    await expect(stable.getByRole('switch', { name: 'Enable Muse' })).toHaveCount(0)
    await stable.evaluate(() => window.sotto!.updateSettings({ historyEnabled: false }))
    await stable.screenshot({ animations: 'disabled', path: join(evidence, 'stable-providers.png') })
    await closeSotto(launched); launched = undefined
    const stableStartedMuseProcesses = (await processCount()) - beforeStable
    expect(stableStartedMuseProcesses).toBe(0)
    expect(await readFile(join(profile, 'muse-threads.json'), 'utf8')).toBe(savedAliases)
    expect(await readFile(join(profile, 'muse-projects.json'), 'utf8')).toBe(savedProjects)

    process.env.SOTTO_OWL_FEATURES = 'muse=1'
    launched = await launch()
    const restored = launched.page
    const restoredPanel = await providerPanel(restored)
    await restored.getByRole('button', { name: 'Muse', exact: true }).click()
    const reconnect = restoredPanel.getByRole('button', { name: 'Connect Muse', exact: true })
    if (await reconnect.count()) await reconnect.click()
    await expect(restoredPanel.getByRole('button', { name: 'Disconnect Muse' })).toBeVisible()
    await openThreads(restored)
    await restored.getByRole('button', { name: 'Muse UI check', exact: true }).click()
    await expect(restored.getByLabel('Thread transcript')).toContainText('Synthetic recovered Muse reply')
    await expect(restored.getByLabel('Thread transcript')).toContainText('Also check the tests')
    expect(await restored.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.title === 'Muse UI check')?.id)).toBe(threadId)
    await restored.screenshot({ animations: 'disabled', path: join(evidence, 'owl-restored-thread.png') })
    expect(await readFile(join(root, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
    expect(pageErrors).toEqual([])
    await writeFile(join(evidence, 'contrast.json'), JSON.stringify(contrasts, null, 2))
    await writeFile(join(evidence, 'journey.json'), JSON.stringify({ threadId, nativeId, originalTurn, stableStartedMuseProcesses, pageErrors }, null, 2))
  } finally {
    if (launched) await closeSotto(launched)
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})

test('turns Muse’s shell sandbox off for this computer from the keyboard and applies it on Reconnect', async () => {
  test.setTimeout(180_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-muse-sandbox-' })).directory
  const root = join(profile, 'muse-fixture')
  await mkdir(root, { recursive: true })
  await mkdir(evidence, { recursive: true })
  const previousEnvironment = {
    SOTTO_E2E_MUSE_ROOT: process.env.SOTTO_E2E_MUSE_ROOT,
    SOTTO_E2E_MUSE_EXECUTABLE: process.env.SOTTO_E2E_MUSE_EXECUTABLE,
    SOTTO_OWL_FEATURES: process.env.SOTTO_OWL_FEATURES,
  }
  process.env.SOTTO_E2E_MUSE_ROOT = root
  process.env.SOTTO_E2E_MUSE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'muse=1'
  // The fake host records the arguments each `muse serve` it stands in for was started with.
  const hosts = async (): Promise<string[][]> => (await readFile(join(root, 'argv.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
  const contrasts: { surface: string; width: number; appearance: string; ratio: number }[] = []
  const pageErrors: string[] = []
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }))
    // No client update card over the row: this journey is about the switch, not updates.
    await page.evaluate(() => window.sotto!.agents!.command({ type: 'configure', patch: { checkClientUpdates: false } }))
    await page.reload()
    const panel = await providerPanel(page)
    await page.getByRole('button', { name: 'Muse', exact: true }).focus()
    await page.keyboard.press('Enter')
    await activate(page, panel.getByRole('button', { name: 'Connect Muse' }))
    await expect(panel.getByRole('button', { name: 'Disconnect Muse' })).toBeVisible()
    expect((await hosts()).every(args => !args.includes('--disable-sandbox'))).toBe(true)

    const sandbox = panel.getByRole('switch', { name: 'Shell sandbox' })
    await expect(sandbox).toHaveAttribute('aria-checked', 'true')
    await sandbox.focus()
    await page.keyboard.press('Space')
    await expect(sandbox).toHaveAttribute('aria-checked', 'false')
    const owed = panel.getByText('Muse is still running with its sandbox on.', { exact: false })
    await expect(owed).toBeVisible()
    // Saved, not live: the switch is in this computer's configuration, and nothing Muse is running changed.
    expect((await hosts()).every(args => !args.includes('--disable-sandbox'))).toBe(true)
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).configuration.museDisableSandbox)).toBe(true)
    const reconnect = panel.getByRole('button', { name: 'Reconnect Muse to apply the shell sandbox setting' })
    for (const [width, height] of sizes) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
        await expect(reconnect).toBeVisible()
        expect(await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false)
        const ratio = await textContrast(owed)
        expect(ratio).toBeGreaterThanOrEqual(4.5)
        contrasts.push({ surface: 'Shell sandbox reconnect line', width, appearance, ratio })
        await page.screenshot({ animations: 'disabled', path: join(evidence, `sandbox-owed-${width}-${appearance}.png`) })
      }
    }
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    // Tab order follows the row as it reads: Reconnect, then the switch.
    await reconnect.focus()
    await page.keyboard.press('Tab')
    await expect(sandbox).toBeFocused()
    await activate(page, reconnect)
    await expect(panel.getByRole('button', { name: 'Disconnect Muse' })).toBeVisible()
    await expect(owed).toHaveCount(0)
    await expect(reconnect).toHaveCount(0)
    // Reconnect left the row with focus on it, so focus is on the switch beside it rather than lost.
    await expect(sandbox).toBeFocused()
    await expect.poll(async () => (await hosts()).at(-1)).toContain('--disable-sandbox')
    // This computer's Muse reports the posture it is running with, on this computer's own entry when hosts are joined.
    expect(await page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      const local = state.connections?.find(host => host.kind === 'local')?.hostId
      const providers = state.host.clientHosts?.find(host => host.hostId === local)?.providers ?? state.host.providers
      return providers?.find(provider => provider.id === 'muse')?.sandboxDisabled
    })).toBe(true)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'sandbox-off-applied-1280-dark.png') })

    // Turning it back on owes a reconnect the other way.
    await sandbox.focus()
    await page.keyboard.press('Space')
    await expect(sandbox).toHaveAttribute('aria-checked', 'true')
    await expect(panel.getByText('Muse is still running with its sandbox off.', { exact: false })).toBeVisible()
    expect(pageErrors).toEqual([])
    await writeFile(join(evidence, 'sandbox-contrast.json'), JSON.stringify(contrasts, null, 2))
  } finally {
    if (launched) await closeSotto(launched)
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
