import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Continuing a thread on another provider on the built app (ADR-0088, #1027; Zach's pick B, in place), over the fake
 * Claude Code and Codex clients the integration tests use: a Claude Code thread stops at its plan's usage limit, its
 * error offers Codex, the composer becomes "Continue on Codex" under a strip, and the first message starts a Codex thread
 * whose first message is the handover ahead of the user's words. Each thread links to the other; the source stays
 * readable and sendable. Stable shows none of it. Run after `npm run build`. Captures go to disposable run evidence;
 * `SOTTO_E2E_EVIDENCE=publish` writes artifacts/continue-on-provider.
 */
const evidence = evidenceDirectory('artifacts/continue-on-provider')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const APPEARANCES = ['dark', 'light'] as const
const BLACK = { r: 0, g: 0, b: 0 }
const LIMIT = 'Claude Code has reached your plan’s usage limit, so this turn stopped. Nothing in the thread was lost. Send again after it resets at 6pm.'
const recorded = new Map<string, unknown>()

/** Sotto Owl (or stable) over the fake Claude Code and Codex clients, both connected; `<root>/workshop` is a project folder. */
async function withFakeProviders(prefix: string, track: 'owl' | 'stable', run: (launched: LaunchedSotto, root: string) => Promise<void>): Promise<void> {
  const profile = (await ownedE2EProfile({ prefix })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'workshop']) await mkdir(join(root, folder), { recursive: true })
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  try {
    await onReleaseTrack(track, async () => {
      const launched = await launchSotto('success', profile)
      try {
        const { page } = launched
        await page.evaluate(async () => {
          await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
          const agents = window.sotto!.agents!
          await agents.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude', 'codex'], checkClientUpdates: false } })
          for (const provider of ['claude', 'codex'] as const) await agents.command({ type: 'connect', provider })
        })
        await page.reload()
        await openThreads(page)
        await run(launched, root)
      } finally { await closeSotto(launched) }
    })
  } finally {
    if (previous.root === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = previous.root
    if (previous.executable === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = previous.executable
    await removeOwnedE2EProfile(profile)
  }
}

/**
 * A Claude Code thread in the workshop project, which answered its first message and stopped the second at the usage
 * limit. Returns its window ID.
 */
async function stoppedThread(page: Page, root: string): Promise<string> {
  await writeFile(join(root, 'claude', 'script.json'), JSON.stringify({ reply: 'Fixed: the length marker is now patched after every chunk, and the three new tests pass.' }))
  const threadId = await page.evaluate(async ({ path }) => {
    const agents = window.sotto!.agents!
    const opened = await agents.command({ type: 'create-project', title: 'workshop', path, useExisting: true, provider: 'claude' })
    if (opened.error || !opened.activeProjectId) throw new Error('Could not open the workshop project.')
    const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)
    if (!model) throw new Error('Claude Code offers no ready model.')
    const created = await agents.command({ type: 'create-thread', projectId: opened.activeProjectId, modelId: model.id, title: 'WAV preview stall', titleSource: 'user',
      workingCopy: 'shared', runtimeMode: 'approval-required' })
    if (created.error || !created.activeThreadId) throw new Error('Could not create the thread.')
    return created.activeThreadId
  }, { path: join(root, 'workshop') })
  const send = (text: string) => page.evaluate(async ({ threadId, text }) => {
    const result = await window.sotto!.agents!.command({ type: 'manual-send', threadId, draftId: crypto.randomUUID(), text })
    if (result?.error) throw new Error(result.error)
  }, { threadId, text })
  await send('The WAV preview stalls after two seconds. Find out why, fix it and run the tests.')
  const pane = threadPane(page, 'WAV preview stall')
  await expect(pane.locator('[data-role="assistant"]')).toContainText('Fixed: the length marker is now patched after every chunk')
  await writeFile(join(root, 'claude', 'script.json'), JSON.stringify({ limit: '6pm' }))
  await send('Also add a test for a stream that ends mid-chunk.')
  await expect(pane.getByText(LIMIT)).toBeVisible()
  return threadId
}

const threadPane = (page: Page, title: string): Locator => page.locator('.thread-workspace').filter({ has: page.getByRole('heading', { level: 2, name: title }) }).first()

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

/** Every continuation surface's text against the surface it is painted on, on or above 4.5:1, recorded under `key`. */
async function contrastHolds(page: Page, key: string): Promise<void> {
  const pairs = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const hex = (value: string): string => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = 'rgba(0, 0, 0, 0)'; context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      return `#${[...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    }
    const background = (element: Element): string => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return hex(color)
      }
      return hex(getComputedStyle(document.body).backgroundColor)
    }
    const selectors = ['.continue-now__lead', '.continue-chip', '.continue-chip small', '.continue-strip__lead > p', '.continue-strip__fact', '.continue-strip .thread-chip',
      '.continue-strip__ledger', '.continue-strip__read', '.continue-strip__text', '.continue-strip__error', '.thread-prompt__send[data-wide]', '.continue-note > p', '.continue-note strong',
      '.continue-note__open', '.continue-composer-note', '.watcher-handover-message__lead', '.watcher-handover-message__ledger', '.watcher-handover__disclose', '.watcher-handover__text']
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0).slice(0, 6)
      .map((element, index) => ({ name: `${selector} ${index}`, ink: hex(getComputedStyle(element).color), on: background(element) })))
  })
  const readings = pairs.map(({ name, ink, on }) => ({ name, ratio: Number(contrastRatio(parseThemeRgb(ink, BLACK), parseThemeRgb(on, BLACK)).toFixed(2)) }))
  expect(readings.length, `contrast readings for ${key}`).toBeGreaterThan(0)
  for (const { name, ratio } of readings) expect(ratio, `${name}, ${key}`).toBeGreaterThanOrEqual(4.5)
  recorded.set(key, readings)
}

/** Each size and appearance: nothing outside the window, every reading on or above 4.5:1, and a capture. */
async function everyWindow(launched: LaunchedSotto, name: string, inView: () => Locator[], whole: () => Locator[] = () => []): Promise<void> {
  const { page } = launched
  for (const appearance of APPEARANCES) {
    await page.evaluate(async value => { await window.sotto!.updateSettings({ appearance: value }) }, appearance)
    for (const [width, height] of SIZES) {
      await resizeContentWindow(launched, width, height, [800, 540])
      await settle(page)
      expect(await pageBoundProblems(page), `${name} at ${width}x${height}, ${appearance}`).toEqual([])
      for (const locator of inView()) await expect(locator, `${name} at ${width}x${height}, ${appearance}`).toBeInViewport()
      for (const locator of whole()) await expect(locator, `${name} whole at ${width}x${height}, ${appearance}`).toBeInViewport({ ratio: 1 })
      await contrastHolds(page, `${name}-${appearance}-${width}x${height}`)
      await captureWindow(launched.app, resolve(evidence, `${name}-${appearance}-${width}x${height}.png`))
    }
  }
  await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
  await resizeContentWindow(launched, 1280, 800)
}

/** The prompts the fake Codex was sent, each as one text. */
async function codexPrompts(root: string): Promise<string[]> {
  const lines = (await readFile(join(root, 'codex', 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  return lines.map(line => JSON.parse(line) as { method?: string; params?: { input?: { type: string; text?: string }[] } })
    .filter(message => message.method === 'turn/start').map(message => (message.params?.input ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n'))
}

test.describe('continuing a thread on another provider', () => {
  test.describe.configure({ mode: 'serial', timeout: 6 * 60_000 })
  test.beforeAll(async () => { await mkdir(evidence, { recursive: true }) })
  test.afterAll(async () => {
    if (recorded.size > 0) await writeFile(resolve(evidence, 'readings.json'), `${JSON.stringify(Object.fromEntries(recorded), null, 2)}\n`, 'utf8')
  })

  test('from a Claude Code thread stopped at its usage limit to Codex, with the handover in the first message', async () => {
    await withFakeProviders('sotto-e2e-continue-', 'owl', async (launched, root) => {
      const { page } = launched
      await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: 'Codex here. I have the handover and will add the mid-chunk test.' }))
      await resizeContentWindow(launched, 1280, 800)
      const sourceId = await stoppedThread(page, root)
      const source = threadPane(page, 'WAV preview stall')

      // The error offers Codex, by keyboard as well as by pointer.
      const chips = source.getByRole('group', { name: 'Continue now on another provider' })
      await expect(chips).toContainText('Or continue now on')
      const codex = chips.getByRole('button', { name: /^Continue on Codex, / })
      await expect(codex).toHaveAttribute('aria-pressed', 'false')
      await source.getByRole('log', { name: 'Thread transcript' }).focus()
      for (let step = 0; step < 40 && !(await codex.evaluate(element => element === document.activeElement)); step++) await page.keyboard.press('Tab')
      await expect(codex).toBeFocused()
      await everyWindow(launched, 'stopped', () => [codex], () => [codex, source.locator('.thread-prompt')])

      await page.keyboard.press('Enter')
      const strip = source.getByRole('region', { name: 'Continue on Codex', exact: true })
      await expect(strip).toContainText('Sending starts a new Codex thread with a handover of this one.')
      await expect(strip).toContainText('This computer')
      await expect(strip).toContainText('Handover first: it carries all 3 messages')
      const send = source.getByRole('button', { name: 'Continue on Codex', exact: true })
      await expect(send).toBeDisabled()
      const prompt = source.getByRole('textbox', { name: 'Prompt' })
      await expect(prompt).toBeFocused()
      // Nothing has gone to Codex yet: the strip is only a choice.
      expect(await codexPrompts(root)).toEqual([])

      // Read it, then Escape folds it and returns to Read it.
      await strip.getByRole('button', { name: 'Read it' }).click()
      const words = strip.getByRole('region', { name: 'The handover, word for word' })
      await expect(words).toContainText('The history below is context, not a new request.')
      await expect(words).toContainText('The WAV preview stalls after two seconds.')
      await everyWindow(launched, 'strip', () => [strip], () => [send, prompt, source.locator('.thread-prompt'), strip.getByRole('button', { name: 'Hide it' })])
      await words.focus()
      await page.keyboard.press('Escape')
      await expect(words).toHaveCount(0)
      await expect(strip.getByRole('button', { name: 'Read it' })).toBeFocused()
      // Escape again puts the continuation away; a chip begins it again.
      await page.keyboard.press('Escape')
      await expect(strip).toHaveCount(0)
      await expect(prompt).toBeFocused()
      await codex.click()
      await expect(strip).toBeVisible()

      // Continue: Codex gets the handover and the first message as one message, in one turn.
      await prompt.click()
      await page.keyboard.type('Carry on with the mid-chunk test.')
      await send.click()
      const continued = threadPane(page, 'WAV preview stall')
      await expect(continued.getByRole('article', { name: 'Handover from WAV preview stall' })).toBeVisible()
      await expect(continued.locator('[data-role="assistant"]')).toContainText('Codex here. I have the handover')
      const sent = await codexPrompts(root)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatch(/^This is a handover from another Sotto thread\. The history below is context, not a new request\./u)
      expect(sent[0]).toContain('The WAV preview stalls after two seconds.')
      expect(sent[0]).toContain('Also add a test for a stream that ends mid-chunk.')
      expect(sent[0]!.endsWith('\n\nCarry on with the mid-chunk test.')).toBe(true)
      // The new thread: its own Sotto ID, on Codex, keeping the title, its handover beside the user's words, a link back.
      const state = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads)
      const made = state.find(thread => thread.continuedFrom?.threadId === sourceId)!
      expect(made).toMatchObject({ providerId: 'codex', title: 'WAV preview stall', continuedFrom: { provider: 'claude' } })
      expect(made.id).not.toBe(sourceId)
      expect(state.find(thread => thread.id === sourceId)?.continuedIn).toEqual([expect.objectContaining({ threadId: made.id, provider: 'codex' })])
      const card = continued.getByRole('article', { name: 'Handover from WAV preview stall' })
      await expect(card).toContainText('From WAV preview stall on Claude Code. Context, not a new request.')
      await expect(continued.locator('[data-role="user"][data-message-id] .rich-message').first()).toHaveText('Carry on with the mid-chunk test.')
      await expect(continued.getByRole('note').filter({ hasText: 'Continued from' })).toContainText('Continued from WAV preview stall on Claude Code. It stays readable there.')
      await card.getByRole('button', { name: 'Read the handover, word for word' }).click()
      await expect(card.getByRole('region', { name: 'The handover, word for word' })).toContainText('The WAV preview stalls after two seconds.')
      await everyWindow(launched, 'continued', () => [card], () => [continued.locator('.thread-prompt')])

      // The source afterwards: readable, linked to the new thread, and still sendable once Claude's limit resets.
      await continued.getByRole('button', { name: 'Open WAV preview stall, the thread this one continues' }).click()
      const back = threadPane(page, 'WAV preview stall')
      await expect(back.getByText(LIMIT)).toBeVisible()
      await expect(back.getByRole('group', { name: 'Continue now on another provider' })).toHaveCount(0)
      const link = back.getByRole('note').filter({ hasText: 'Continued in' })
      await expect(link).toContainText(/Continued in WAV preview stall on Codex, .+, with a handover of this thread\./u)
      await expect(back.getByText('Continued in a Codex thread. You can still send here once Claude’s limit resets at 6pm.')).toBeVisible()
      await expect(back.getByRole('textbox', { name: 'Prompt' })).toBeEditable()
      await everyWindow(launched, 'source-after', () => [link], () => [back.locator('.thread-prompt'), back.getByText('Continued in a Codex thread. You can still send here once Claude’s limit resets at 6pm.')])
    })
  })

  test('stable shows none of it: no chips, no bridge, and the model chip keeps the thread on its provider', async () => {
    await withFakeProviders('sotto-e2e-continue-stable-', 'stable', async (launched, root) => {
      const { page } = launched
      await stoppedThread(page, root)
      const source = threadPane(page, 'WAV preview stall')
      await expect(source.getByRole('group', { name: 'Continue now on another provider' })).toHaveCount(0)
      expect(await page.evaluate(() => window.sotto?.continueThread === undefined)).toBe(true)
      await source.getByRole('combobox', { name: 'Thread model' }).click()
      const picker = page.getByRole('dialog', { name: 'Choose model' })
      await expect(picker).toBeVisible()
      await expect(picker.getByRole('tab', { name: 'Codex' })).toHaveCount(0)
      await expect(picker).not.toContainText('Continue in a new thread on')
      await page.keyboard.press('Escape')
      await expect(picker).toHaveCount(0)
    })
  })
})
