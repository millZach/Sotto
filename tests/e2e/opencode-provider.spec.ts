import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { expectPromptText, fillPrompt, promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/opencode-provider')
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

test('uses OpenCode in Owl over its own server, restores each turn under its prompt, and preserves it through stable', async () => {
  test.setTimeout(300_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-opencode-' })).directory
  const root = join(profile, 'opencode-fixture')
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  await mkdir(evidence, { recursive: true })
  const previousEnvironment = {
    SOTTO_E2E_OPENCODE_ROOT: process.env.SOTTO_E2E_OPENCODE_ROOT,
    SOTTO_E2E_OPENCODE_EXECUTABLE: process.env.SOTTO_E2E_OPENCODE_EXECUTABLE,
    SOTTO_OWL_FEATURES: process.env.SOTTO_OWL_FEATURES,
  }
  process.env.SOTTO_E2E_OPENCODE_ROOT = root
  process.env.SOTTO_E2E_OPENCODE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'opencode=1'
  const contrasts: { surface: string; width: number; appearance: string; ratio: number }[] = []
  const pageErrors: string[] = []
  const frames = async (): Promise<Frame[]> => (await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Frame)
  const processCount = async (): Promise<number> => (await frames()).filter(frame => frame.method === 'fixture/process').length
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

    // Settings > Providers > OpenCode: connected on Sotto's own folder, its version, and no model source signed in yet.
    const panel = await providerPanel(page)
    await page.getByRole('button', { name: 'OpenCode', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(panel).toContainText('in a folder of Sotto’s own, apart from your own OpenCode')
    await expect(panel.locator('svg[data-provider="opencode"]')).toBeVisible()
    await activate(page, panel.getByRole('button', { name: 'Connect OpenCode' }))
    await expect(panel.getByRole('button', { name: 'Disconnect OpenCode' })).toBeVisible()
    await expect(panel).toContainText('No model source signed in yet; OpenCode Zen’s free models only.')
    await expect(panel).toContainText('2.0.31')
    const deferUpdates = page.getByRole('button', { name: 'Not now', exact: true })
    if (await deferUpdates.count()) await deferUpdates.click()
    for (const [width, height] of sizes) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
        await expect(panel.getByRole('button', { name: 'Disconnect OpenCode' })).toBeVisible()
        expect(await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false)
        const account = panel.locator('.provider-connection p', { hasText: 'No model source signed in yet' })
        const ratio = await textContrast(account)
        expect(ratio).toBeGreaterThanOrEqual(4.5)
        contrasts.push({ surface: 'OpenCode account line', width, appearance, ratio })
        await page.screenshot({ animations: 'disabled', path: join(evidence, `settings-${width}-${appearance}.png`) })
      }
    }
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await panel.getByRole('tab', { name: 'Configuration' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(panel.getByRole('tab', { name: 'Models' })).toBeFocused()
    await expect(panel.getByRole('tabpanel')).toContainText('Fixture Model')

    // A new OpenCode thread on an OpenCode Zen model.
    const prepared = await page.evaluate(async path => {
      await window.sotto!.agents!.command({ type: 'connect', provider: 'codex' })
      const state = await window.sotto!.agents!.get()
      const model = state.host.models.find(candidate => candidate.providerId === 'opencode' && candidate.name === 'Fixture Model')!
      await window.sotto!.agents!.command({ type: 'configure', patch: { newThreadModelId: model.id } })
      const created = await window.sotto!.agents!.command({ type: 'create-project', provider: 'opencode', title: 'OpenCode project', path, useExisting: true })
      return { error: created.error, source: model.source }
    }, projectPath)
    expect(prepared).toEqual({ error: null, source: 'OpenCode Zen' })
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread in OpenCode project', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New thread', exact: true })).toBeVisible()
    const projects = page.getByRole('region', { name: 'Projects' })
    await projects.getByRole('button', { name: 'New thread', exact: true }).hover()
    await projects.getByRole('button', { name: 'Rename New thread', exact: true }).click()
    await page.getByLabel('Rename New thread').fill('OpenCode UI check')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'OpenCode UI check', exact: true })).toBeVisible()
    const model = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await model.click()
    const picker = page.getByRole('dialog', { name: 'Choose model' })
    await picker.getByRole('tab', { name: 'OpenCode', exact: true }).click()
    await picker.getByRole('option', { name: 'Fixture Model', exact: true }).click()
    await expect(model).toContainText('Fixture Model')
    const prompt = promptField(page)
    const transcript = page.getByLabel('Thread transcript')
    await fillPrompt(prompt, 'Synthetic OpenCode prompt')
    await prompt.press('Enter')
    await expectPromptText(prompt, '')
    const threadId = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.title === 'OpenCode UI check')!.id)
    const state = async () => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)!, threadId)
    const detail = async () => page.evaluate(async id => (await window.sotto!.agents!.threadDetail!(id))!, threadId)
    await expect.poll(async () => (await state()).status).toBe('running')
    await expect.poll(async () => (await detail()).messages.some(message => message.text === 'Synthetic OpenCode prompt')).toBe(true)
    const firstTurn = (await detail()).messages.find(message => message.text === 'Synthetic OpenCode prompt')!.id
    const aliases = JSON.parse(await readFile(join(profile, 'opencode-threads.json'), 'utf8')) as Record<string, { title: string; sessionId: string }>
    const nativeId = Object.values(aliases).find(alias => alias.title === 'OpenCode UI check')!.sessionId
    const action = (type: string, extra: Record<string, unknown> = {}) => writeFile(join(root, 'control.json'), JSON.stringify({ id: randomUUID(), type, sessionId: nativeId, ...extra }))

    // A tool, and the file its step changed.
    await action('tool', { name: 'shell', input: { command: 'npm run format' }, output: 'Formatted 1 file', files: ['notes.txt'] })
    await expect(transcript).toContainText('npm run format')
    await expect.poll(async () => (await detail()).activities?.filter(activity => activity.kind === 'file-change').flatMap(activity => activity.changes?.map(change => change.path) ?? [])).toEqual([join(projectPath, 'notes.txt')])

    // A permission card answered with Allow once, then one answered with Reject.
    await action('permission', { text: 'npm run build' })
    await expect(page.locator('.agent-request')).toContainText('Run a command: npm run build')
    for (const [width, height] of sizes) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
        const allow = page.getByRole('button', { name: 'Allow once', exact: true })
        await expect(allow).toBeVisible()
        await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeVisible()
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
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    const decisions = async () => (await frames()).filter(frame => frame.method === 'session.permission.reply').map(frame => frame.params?.decision)
    await activate(page, page.getByRole('button', { name: 'Allow once', exact: true }))
    await expect.poll(async () => (await state()).requests.length).toBe(0)
    await expect.poll(decisions).toEqual(['once'])
    await action('permission', { text: 'rm -rf build' })
    await expect(page.locator('.agent-request')).toContainText('Run a command: rm -rf build')
    await activate(page, page.getByRole('button', { name: 'Reject', exact: true }))
    await expect.poll(async () => (await state()).requests.length).toBe(0)
    await expect.poll(decisions).toEqual(['once', 'reject'])

    // A question card from a form.
    await action('form', { fields: [{ key: 'colour', title: 'Colour', description: 'Which colour should the badge be?', type: 'string', options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] }] })
    await expect(page.locator('.agent-request')).toContainText('Which colour should the badge be?')
    await page.getByRole('radio', { name: 'Blue' }).check()
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'question-1280-dark.png') })
    await activate(page, page.getByRole('button', { name: 'Send answer', exact: true }))
    await expect.poll(async () => (await state()).requests.length).toBe(0)
    await expect.poll(async () => (await frames()).filter(frame => frame.method === 'session.form.reply').map(frame => frame.params?.answer)).toEqual([{ colour: 'blue' }])

    // The streamed reply ends the turn.
    await action('complete', { text: 'Synthetic OpenCode reply complete' })
    await expect(transcript).toContainText('Synthetic OpenCode reply complete')
    await expect.poll(async () => (await state()).status).toBe('idle')
    expect((await state()).lastTurn).toMatchObject({ id: firstTurn, status: 'completed' })

    // A second turn with a tool of its own, which edits a file it reports itself.
    await fillPrompt(prompt, 'Second synthetic OpenCode prompt')
    await prompt.press('Enter')
    await expect.poll(async () => (await state()).status).toBe('running')
    await expect.poll(async () => (await detail()).messages.some(message => message.text === 'Second synthetic OpenCode prompt')).toBe(true)
    const secondTurn = (await detail()).messages.find(message => message.text === 'Second synthetic OpenCode prompt')!.id
    await action('tool', { name: 'write', input: { path: join(projectPath, 'probe.txt'), content: 'hi' }, output: 'Wrote file', files: ['probe.txt'] })
    await expect.poll(async () => (await detail()).activities?.filter(activity => activity.kind === 'file-change').length).toBe(2)
    await action('complete', { text: 'Second synthetic OpenCode reply' })
    await expect(transcript).toContainText('Second synthetic OpenCode reply')
    await expect.poll(async () => (await state()).status).toBe('idle')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'thread-activity-1280-dark.png') })

    // Stop on a running turn.
    await fillPrompt(prompt, 'Synthetic OpenCode prompt to stop')
    await prompt.press('Enter')
    await expect.poll(async () => (await state()).status).toBe('running')
    await activate(page, page.getByRole('button', { name: 'Stop agent', exact: true }))
    await expect.poll(async () => (await state()).status).toBe('idle')
    expect((await state()).lastTurn?.status).toBe('interrupted')
    expect((await frames()).filter(frame => frame.method === 'session.interrupt')).toHaveLength(1)
    const placed = async () => (await detail()).activities?.filter(activity => activity.kind === 'command' || activity.kind === 'file-change')
      .map(activity => [activity.kind, activity.command ?? activity.changes?.map(change => change.path).join(', '), activity.turnId])
    const live = await placed()
    expect(live).toEqual([
      ['command', 'npm run format', firstTurn], ['file-change', join(projectPath, 'notes.txt'), firstTurn],
      // The two commands that asked first: OpenCode starts and calls a tool before it asks, as 2.0.31 does.
      ['command', 'npm run build', firstTurn], ['command', 'rm -rf build', firstTurn],
      ['file-change', join(projectPath, 'probe.txt'), secondTurn],
    ])
    const asked = (await detail()).activities?.filter(activity => activity.kind === 'command' && activity.command !== 'npm run format').map(activity => activity.status)
    expect(asked).toEqual(['completed', 'failed'])

    // Restart on the same profile: the history comes back from OpenCode, each turn's activity under its own prompt.
    await closeSotto(launched); launched = undefined
    launched = await launch()
    const reopened = launched.page
    const reopenedPanel = await providerPanel(reopened)
    await reopened.getByRole('button', { name: 'OpenCode', exact: true }).click()
    const connectAgain = reopenedPanel.getByRole('button', { name: 'Connect OpenCode', exact: true })
    const connected = reopenedPanel.getByRole('button', { name: 'Disconnect OpenCode' })
    // The panel draws one of the two once it has read the provider; asking before then saw neither.
    await expect(connectAgain.or(connected)).toBeVisible()
    if (await connectAgain.isVisible()) await connectAgain.click()
    await expect(connected).toBeVisible()
    await openThreads(reopened)
    await reopened.getByRole('button', { name: 'OpenCode UI check', exact: true }).click()
    await expect(reopened.getByLabel('Thread transcript')).toContainText('Second synthetic OpenCode reply')
    await expect(reopened.getByLabel('Thread transcript')).toContainText('Synthetic OpenCode reply complete')
    const reopenedDetail = async () => reopened.evaluate(async id => (await window.sotto!.agents!.threadDetail!(id))!, threadId)
    await expect.poll(async () => (await reopenedDetail()).activities?.filter(activity => activity.kind === 'command' || activity.kind === 'file-change')
      .map(activity => [activity.kind, activity.command ?? activity.changes?.map(change => change.path).join(', '), activity.turnId])).toEqual(live)
    await resizeWindow(launched, 1280, 800)
    await reopened.screenshot({ animations: 'disabled', path: join(evidence, 'restored-thread-1280-dark.png') })
    await reopened.getByLabel('Thread transcript').getByText('Synthetic OpenCode prompt', { exact: true }).scrollIntoViewIfNeeded()
    await reopened.screenshot({ animations: 'disabled', path: join(evidence, 'restored-first-turn-1280-dark.png') })

    // Stable: nothing of OpenCode is offered, its thread is hidden, and nothing of it is lost.
    await closeSotto(launched); launched = undefined
    const savedAliases = await readFile(join(profile, 'opencode-threads.json'), 'utf8')
    const savedProjects = await readFile(join(profile, 'opencode-projects.json'), 'utf8')
    const beforeStable = await processCount()
    process.env.SOTTO_OWL_FEATURES = 'opencode=0'
    launched = await launch()
    const stable = launched.page
    await openThreads(stable)
    await expect(stable.getByRole('button', { name: 'OpenCode UI check', exact: true })).toHaveCount(0)
    const stableState = await stable.evaluate(async () => (await window.sotto!.agents!.get()).host)
    expect(stableState.threads.some(thread => thread.providerId === 'opencode')).toBe(false)
    expect(stableState.models.some(model => model.providerId === 'opencode')).toBe(false)
    expect(stableState.projects.some(project => project.providerId === 'opencode')).toBe(false)
    await providerPanel(stable)
    await expect(stable.getByRole('button', { name: 'OpenCode', exact: true })).toHaveCount(0)
    await stable.screenshot({ animations: 'disabled', path: join(evidence, 'stable-providers.png') })
    await closeSotto(launched); launched = undefined
    const stableStartedOpenCodeProcesses = (await processCount()) - beforeStable
    expect(stableStartedOpenCodeProcesses).toBe(0)
    expect(await readFile(join(profile, 'opencode-threads.json'), 'utf8')).toBe(savedAliases)
    expect(await readFile(join(profile, 'opencode-projects.json'), 'utf8')).toBe(savedProjects)

    // Owl again: the thread and its history are all there.
    process.env.SOTTO_OWL_FEATURES = 'opencode=1'
    launched = await launch()
    const restored = launched.page
    const restoredPanel = await providerPanel(restored)
    await restored.getByRole('button', { name: 'OpenCode', exact: true }).click()
    const reconnect = restoredPanel.getByRole('button', { name: 'Connect OpenCode', exact: true })
    if (await reconnect.count()) await reconnect.click()
    await expect(restoredPanel.getByRole('button', { name: 'Disconnect OpenCode' })).toBeVisible()
    await openThreads(restored)
    await restored.getByRole('button', { name: 'OpenCode UI check', exact: true }).click()
    await expect(restored.getByLabel('Thread transcript')).toContainText('Second synthetic OpenCode reply')
    expect(await restored.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.title === 'OpenCode UI check')?.id)).toBe(threadId)
    await restored.screenshot({ animations: 'disabled', path: join(evidence, 'owl-restored-thread.png') })
    expect(await readFile(join(root, 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
    expect(pageErrors).toEqual([])
    await writeFile(join(evidence, 'contrast.json'), JSON.stringify(contrasts, null, 2))
    await writeFile(join(evidence, 'journey.json'), JSON.stringify({ threadId, nativeId, firstTurn, secondTurn, activities: live, decisions: await decisions(), stableStartedOpenCodeProcesses, pageErrors }, null, 2))
  } finally {
    if (launched) await closeSotto(launched)
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
