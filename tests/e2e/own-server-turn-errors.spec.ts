import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { elementContrast } from './support/elementContrast'
import { expectPromptText, fillPrompt, promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * A thread on one of the user's own model servers when the server lets a turn down (ADR-0124, October 24 amendment;
 * placement A of the own-server-turn-errors prototype): the retry line, the still-waiting line, each failure with its
 * reason and buttons, Stop, Try again and Open Settings. The stand-in OpenCode lists the server Sotto declares to it and
 * plays OpenCode's retries and failures; no model server is contacted, so none runs here.
 */
const evidence = evidenceDirectory('artifacts/own-server-turn-errors')
const sizes = [[1600, 1000], [1280, 800], [820, 560]] as const
const appearances = ['dark', 'light'] as const

const zen = { id: 'zen-0', modelID: 'zen-0', providerID: 'opencode', name: 'Big Pickle', capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [], enabled: true, status: 'active', limit: { context: 200000, output: 32000 } }
const SPARKS_MODEL = { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 163_840, thinking: false, images: false }

const contrasts: { surface: string; state: string; size: string; appearance: string; ratio: number }[] = []

/** Nothing in the transcript spills sideways at this size, and the turn's line sits inside the window. */
async function fits(page: Page, part: Locator, state: string, size: string): Promise<void> {
  const box = await part.boundingBox()
  const width = await page.evaluate(() => innerWidth)
  expect(box, `${state} at ${size}`).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${state} at ${size}`).toBeLessThanOrEqual(width + 1)
  expect(await page.locator('.thread-transcript__content').evaluate(node => node.scrollWidth > node.clientWidth + 1), `${state} at ${size}`).toBe(false)
  expect(await part.evaluate(node => [node, ...node.querySelectorAll<HTMLElement>('*')].filter(item => item.scrollWidth > item.clientWidth + 1
    && getComputedStyle(item).overflowX !== 'visible').map(item => item.className)), `${state} at ${size}`).toEqual([])
}

/** The value once `read` has one. */
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  let value: T | undefined
  await expect.poll(async () => (value = await read()) !== undefined, { timeout: 60_000 }).toBe(true)
  return value!
}

async function measure(root: Locator, surfaces: Record<string, string>, state: string, size: string, appearance: string): Promise<void> {
  for (const [surface, selector] of Object.entries(surfaces)) {
    const ratio = await elementContrast(root.locator(selector).first())
    contrasts.push({ surface, state, size, appearance, ratio: Math.round(ratio * 100) / 100 })
    expect(ratio, `${surface} on ${state} at ${size} ${appearance}`).toBeGreaterThanOrEqual(4.5)
  }
}

test('says what your own model server is doing to a turn, and offers Stop, Try again and Open Settings', async () => {
  test.setTimeout(600_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-own-turns-' })).directory
  const root = join(profile, 'opencode-fixture')
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  await mkdir(evidence, { recursive: true })
  await writeFile(join(root, 'script.json'), JSON.stringify({ models: [zen], providers: [{ id: 'opencode', name: 'OpenCode', activation: 'enabled' }] }))
  const previousEnvironment = {
    SOTTO_E2E_OPENCODE_ROOT: process.env.SOTTO_E2E_OPENCODE_ROOT,
    SOTTO_E2E_OPENCODE_EXECUTABLE: process.env.SOTTO_E2E_OPENCODE_EXECUTABLE,
    SOTTO_OWL_FEATURES: process.env.SOTTO_OWL_FEATURES,
  }
  process.env.SOTTO_E2E_OPENCODE_ROOT = root
  process.env.SOTTO_E2E_OPENCODE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'opencode=1,own-model-servers=1'
  const pageErrors: string[] = []
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const app = launched
    const { page } = app
    page.on('pageerror', error => pageErrors.push(error.message))
    // The window's clock runs on, but can be moved: the still-waiting line comes 30 seconds into a silent turn.
    await page.clock.install()
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system' }))
    await page.reload()
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect', provider: 'opencode' }) })
    await resizeWindow(app, 1280, 800)

    // Sparks, as the user added it: OpenCode lists its model under it once told of it.
    const added = await page.evaluate(model => window.sotto!.ownServers!.add({ name: 'Sparks', address: 'http://spark-head:8888/v1', models: [model] }), SPARKS_MODEL)
    expect(added.status).toBe('ok')
    const modelId = await eventually(() => page.evaluate(async () => (await window.sotto!.agents!.get()).host.models
      .find(model => model.providerId === 'opencode' && model.name === 'DeepSeek V4.1 Flash')?.id))
    const created = await page.evaluate(async ({ path, model }) => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { newThreadModelId: model } })
      return (await window.sotto!.agents!.command({ type: 'create-project', provider: 'opencode', title: 'sotto', path, useExisting: true })).error
    }, { path: projectPath, model: modelId })
    expect(created).toBeNull()

    await openThreads(page)
    // The stand-in OpenCode is older than the newest; its offer to update would sit over the composer in every capture.
    const notNow = page.getByRole('button', { name: /^Not now/u })
    await page.getByRole('button', { name: 'New thread in sotto', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Thread model', exact: true })).toContainText('DeepSeek V4.1 Flash')
    const prompt = promptField(page)
    const transcript = page.getByRole('log', { name: 'Thread transcript' })
    const live = transcript.getByTestId('thread-activity-live')
    const stop = transcript.getByRole('button', { name: 'Stop agent', exact: true })
    const tryAgain = transcript.getByRole('button', { name: 'Try again, sending your last message to Sparks again', exact: true })
    const openSettings = transcript.getByRole('button', { name: 'Open Settings at Your own model servers', exact: true })

    const send = async (text: string): Promise<void> => {
      await fillPrompt(prompt, text)
      await prompt.press('Enter')
      await expectPromptText(prompt, '')
      await expect(transcript.getByText(text, { exact: true }).last()).toBeVisible()
      // The stand-in plays OpenCode's side only once the turn is running in main.
      if (threadId) await expect.poll(async () => (await thread()).status).toBe('running')
    }
    let threadId = ''
    let sessionId = ''
    const thread = async () => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(item => item.id === id)!, threadId)
    const action = async (type: string, extra: Record<string, unknown> = {}): Promise<void> =>
      writeFile(join(root, 'control.json'), JSON.stringify({ id: randomUUID(), type, sessionId, ...extra }))
    const sent = async (text: string): Promise<number> => (await page.evaluate(async id => (await window.sotto!.agents!.threadDetail!(id))!.messages
      .filter(message => message.role === 'user').map(message => message.text), threadId)).filter(said => said === text).length

    /** Every size in both appearances: the part fits, its words meet 4.5:1, and a capture of each. */
    const capture = async (state: string, part: Locator, surfaces: Record<string, string>): Promise<void> => {
      if (await notNow.isVisible()) await notNow.click()
      for (const [width, height] of sizes) {
        await resizeWindow(app, width, height)
        for (const appearance of appearances) {
          await page.evaluate(value => window.sotto!.updateSettings({ appearance: value }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await part.scrollIntoViewIfNeeded()
          await fits(page, part, state, `${width}x${height}`)
          await measure(part, surfaces, state, `${width}x${height}`, appearance)
          await page.screenshot({ animations: 'disabled', path: join(evidence, `${state}-${width}-${appearance}.png`) })
        }
      }
      await resizeWindow(app, 1280, 800)
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    }

    // 1. A silent server: the turn's line works as always, then at 30 seconds says it is still waiting, with Stop.
    await send('Write the guide section on adding a server, with the Sparks setup as the example.')
    threadId = await eventually(() => page.evaluate(async model => (await window.sotto!.agents!.get()).host.threads.find(item => item.modelId === model)?.id, modelId))
    // The provider's own session, which the stand-in OpenCode takes its actions for: this profile's only OpenCode thread.
    sessionId = await eventually(async () => Object.values(JSON.parse(await readFile(join(profile, 'opencode-threads.json'), 'utf8').catch(() => '{}')) as Record<string, { sessionId?: string }>)[0]?.sessionId)
    await expect.poll(async () => (await thread()).status).toBe('running')
    await expect(live).toBeVisible()
    await expect(live).not.toContainText('Still waiting')
    await page.clock.fastForward(31_000)
    await expect(live.getByRole('status')).toHaveText('Still waiting for Sparks to start answering.')
    await expect(live).toContainText('A long prompt can take a few minutes. The turn stops waiting at 5 minutes.')
    await capture('waiting', live, { words: '[role="status"]', clock: '.thread-activity__clock', stop: '.thread-activity-live__stop', note: '.thread-activity-live__note' })
    // The same, with reduced motion: the dot holds still.
    await page.evaluate(() => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    expect(await live.locator('.thread-activity__pulse').evaluate(node => getComputedStyle(node).animationName)).toBe('none')
    await page.screenshot({ path: join(evidence, 'waiting-1280-dark-reduced-motion.png') })
    await page.evaluate(() => window.sotto!.updateSettings({ reducedMotion: 'system' }))

    // Stop from the keyboard: the line's only control, then focus goes to the composer and the turn says it stopped.
    await prompt.focus()
    await page.keyboard.press('Shift+Tab')
    for (let step = 0; step < 40 && !await stop.evaluate(node => node === document.activeElement); step += 1) await page.keyboard.press('Shift+Tab')
    await expect(stop).toBeFocused()
    await expect(stop).toHaveText('Stop')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await thread()).status).not.toBe('running')
    await expect(live).toBeHidden()
    await expect(prompt).toBeFocused()
    // The window's clock back to the real time, so the next turns start where main says they do.
    await page.clock.setSystemTime(Date.now())

    // 2. OpenCode tries the server again: the line counts the tries, in the attention colour, with Stop.
    await send('Now the section on checking a server again.')
    await expect.poll(async () => (await thread()).status).toBe('running')
    await action('retry', { attempt: 2 })
    await expect(live.getByRole('status')).toHaveText('Sparks isn’t answering. Trying again (1 of 10).')
    await action('retry', { attempt: 4 })
    await expect(live.getByRole('status')).toHaveText('Sparks isn’t answering. Trying again (3 of 10).')
    await expect(stop).toBeEnabled()
    await capture('retrying', live, { words: '[role="status"]', stop: '.thread-activity-live__stop' })

    // 3. Each way the server lets a turn down: the Failed line, its reason, and the buttons on the newest only.
    const failure = transcript.locator('.thread-own-failure').last()
    const reason = { title: '.thread-own-failure__reason strong', body: '.thread-own-failure__reason', 'Try again': 'button:last-child' }
    // After ten tries, no answer.
    await action('fail', { error: 'provider.transport', message: 'ECONNREFUSED: Unable to connect. Is the computer able to access the url?' })
    await expect(failure).toHaveAttribute('data-failure', 'unreachable')
    await expect(failure).toContainText('Sparks didn’t answer. OpenCode tried it 10 times over about a minute and a half. Nothing in the thread was lost. Check that Sparks is on and this computer can reach spark-head:8888, then try again.')
    await expect(failure.getByRole('button')).toHaveCount(1)
    await capture('fail-unreachable', failure.locator('xpath=..'), reason)

    // Nothing for OpenCode's five minutes: Sotto stops the turn at OpenCode's first header timeout.
    await send('And the section on removing one.')
    await action('retry', { attempt: 2, message: 'Timed out waiting for response headers' })
    await expect(failure).toHaveAttribute('data-failure', 'timeout')
    await expect(failure).toContainText('Sparks didn’t start answering within 5 minutes. It took the message but sent nothing back.')
    // Only the newest failure keeps its buttons.
    await expect(transcript.locator('.thread-own-failure')).toHaveCount(2)
    await expect(transcript.locator('.thread-own-failure').first().getByRole('button')).toHaveCount(0)
    await capture('fail-timeout', failure.locator('xpath=..'), reason)

    // The key turned down: Open Settings comes first, then Try again, in the order Tab reaches them.
    await send('Add the key section too.')
    await action('fail', { error: 'provider.auth', status: 401, message: 'Invalid API key.' })
    await expect(failure).toHaveAttribute('data-failure', 'key-refused')
    await expect(failure).toContainText('Sparks turned down its key. Nothing in the thread was lost. In Settings › Providers › Your own model servers, remove Sparks and add it again with the right key, then try again.')
    await expect(failure).not.toContainText('Invalid API key.')
    await capture('fail-key-refused', failure.locator('xpath=..'), { ...reason, 'Open Settings': 'button:first-child' })
    await openSettings.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(openSettings).toBeFocused()
    await expect(openSettings).toHaveText('Open Settings')
    await page.keyboard.press('Tab')
    await expect(tryAgain).toBeFocused()
    await expect(tryAgain).toHaveText('Try again')
    await page.keyboard.press('Shift+Tab')
    await expect(openSettings).toBeFocused()
    await page.keyboard.press('Enter')
    const group = page.getByRole('region', { name: 'Your own model servers', exact: true })
    await expect(page.getByRole('tab', { name: 'Providers', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(group).toBeInViewport()
    expect(await group.evaluate(node => { const focused = document.activeElement; return focused !== null && (node.contains(focused) || focused.contains(node)) })).toBe(true)
    await expect(group).toContainText('Sparks')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'open-settings-1280-dark.png') })
    await openThreads(page)
    await expect(failure).toHaveAttribute('data-failure', 'key-refused')

    // The model gone from the server.
    await send('Then the model menu section.')
    await action('fail', { error: 'provider.invalid-request', status: 404, message: 'The model `deepseek-v4.1-flash` does not exist.' })
    await expect(failure).toHaveAttribute('data-failure', 'model-gone')
    await expect(failure).toContainText('Sparks no longer has DeepSeek V4.1 Flash. Nothing in the thread was lost. Pick another model in the model menu below, or load DeepSeek V4.1 Flash on Sparks again, then try again.')
    await capture('fail-model-gone', failure.locator('xpath=..'), reason)

    // The thread longer than the model takes.
    const last = 'Put the whole guide together in one page.'
    await send(last)
    await action('fail', { error: 'provider.invalid-request', status: 400, message: 'This model\'s maximum context length is 163840 tokens. However, you requested 170000 tokens.' })
    await expect(failure).toHaveAttribute('data-failure', 'too-long')
    await expect(failure).toContainText('This thread is too long for DeepSeek V4.1 Flash. Your last message and the thread before it are more than the model takes at once.')
    await capture('fail-too-long', failure.locator('xpath=..'), reason)

    // Try again from the keyboard sends the last message again as a new send, and focus goes to the composer.
    expect(await sent(last)).toBe(1)
    await tryAgain.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => sent(last)).toBe(2)
    await expect.poll(async () => (await thread()).status).toBe('running')
    await expect(prompt).toBeFocused()
    await expect(transcript.locator('.thread-own-failure').last().getByRole('button')).toHaveCount(0)
    await action('complete', { text: 'Here is the whole guide.' })
    await expect(transcript.getByText('Here is the whole guide.', { exact: true })).toBeVisible()
    await expect.poll(async () => (await thread()).status).not.toBe('running')

    expect(pageErrors).toEqual([])
    await writeFile(join(evidence, 'contrast.json'), `${JSON.stringify(contrasts, null, 2)}\n`)
  } finally {
    if (launched) await closeSotto(launched)
    for (const [name, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await removeOwnedE2EProfile(profile)
  }
})
