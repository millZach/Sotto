import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { expectPromptText, promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

// The next prompt (ADR-0131; Owl only, Drake's pick 6 "Picker" of docs/prototypes/next-prompt-prototype.html): when a Codex
// turn ends with an answer, Sotto asks the thread's own Codex on the side, over the fake app server's `codex exec`, what
// the user will type next. The ghost sits in the empty prompt, Up opens the Next list over the transcript, and a send takes
// it away. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/next-prompt.

const evidence = evidenceDirectory('artifacts/next-prompt')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const GHOST = 'Open the pull request for this fix'
const SUGGESTION = {
  headline: 'The dark theme now meets contrast on every surface.',
  ghost: GHOST,
  chips: [
    { intent: 'continue', label: 'Light theme too', text: 'Do the same for the light theme' },
    { intent: 'verify', label: 'Run the checks', text: 'Run the contrast checks again' },
    { intent: 'challenge', label: 'Why these colours', text: 'Why these colours and not the theme roles?' },
    { intent: 'wrap', label: 'Commit it', text: 'Commit this with a plain message' },
  ],
  answers: [{ label: 'Both themes', text: 'Do both themes' }, { label: 'Dark only', text: 'Only the dark theme for now' }],
}

async function launch(profile: string, root: string, enabled: boolean): Promise<LaunchedSotto> {
  const previous = { owl: process.env.SOTTO_OWL_FEATURES, root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_OWL_FEATURES = `next-prompt=${enabled ? 1 : 0},composer-shrink=0`
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  try { return await launchSotto('success', profile) } finally {
    for (const [name, value] of [['SOTTO_OWL_FEATURES', previous.owl], ['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  }
}

/** A Codex thread that has answered one prompt; titles are off so the side call the fixture answers is the next prompt's. */
async function answeredThread(page: Page, project: string): Promise<void> {
  await page.evaluate(async folder => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', threadTitles: false, reducedMotion: 'system' })
    const agents = window.sotto!.agents!
    await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
    await agents.command({ type: 'connect', provider: 'codex' })
    const created = await agents.command({ type: 'create-project', provider: 'codex', title: 'Contrast', path: folder, useExisting: true })
    const projectId = created.host.projects.find(p => p.title === 'Contrast')!.id
    const modelId = (await agents.get()).host.models.find(m => m.providerId === 'codex' && m.ready)!.id
    const thread = await agents.command({ type: 'create-thread', projectId, title: 'Dark theme contrast', titleSource: 'user', modelId, workingCopy: 'shared' })
    if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'Missing thread')
  }, project)
  await page.reload(); await openThreads(page)
  // The pane shows the thread before its turn, so its messages are in memory when the turn ends (ADR-0131).
  await page.getByRole('button', { name: 'Dark theme contrast', exact: true }).click()
  await page.evaluate(async () => {
    const agents = window.sotto!.agents!
    await agents.command({ type: 'manual-send', threadId: (await agents.get()).activeThreadId!, text: 'The palette is unreadable in dark mode.' })
  })
  await expect(page.getByLabel('Thread transcript')).toContainText('I raised the foreground contrast on both dark themes.')
}

async function fixture(prefix: string) {
  const profile = (await ownedE2EProfile({ prefix })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: 'I raised the foreground contrast on both dark themes. Should I do the light theme as well?' }))
  await writeFile(join(root, 'codex', 'oneshot.json'), JSON.stringify({ text: `Here it is:\n${JSON.stringify(SUGGESTION)}` }))
  return { profile, root }
}

const sideCalls = async (root: string): Promise<{ input: string }[]> =>
  (await readFile(join(root, 'codex', 'oneshot.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { input: string })

test('a finished Codex turn suggests the next prompt as a ghost and in the Next list', async () => {
  const { profile, root } = await fixture('sotto-e2e-next-prompt-')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launch(profile, root, true)
    const { page, app } = launched
    await answeredThread(page, join(root, 'project'))
    const prompt = promptField(page)
    const ghost = page.locator('.prompt-editor__ghost')
    await expect(ghost).toHaveText(`${GHOST}Tab`)
    // The ghost stands in for the placeholder; the two never draw over each other.
    expect(await prompt.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none')

    // The side call went to the thread's own Codex, ephemeral and tool-free, with the exchange as its material.
    const calls = await sideCalls(root)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toContain('Recent conversation, oldest first')
    expect(calls[0]!.input).toContain('The palette is unreadable in dark mode.')
    await expect(readFile(join(root, 'codex', 'violations.jsonl'), 'utf8')).rejects.toThrow()

    // Tab takes the ghost; emptied again, Up opens the list over the transcript without moving the composer.
    await prompt.click()
    await page.keyboard.press('Tab')
    await expectPromptText(prompt, GHOST)
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace')
    await expectPromptText(prompt, '')
    const composer = page.locator('form.thread-prompt')
    const before = await composer.boundingBox()
    await page.keyboard.press('ArrowUp')
    const list = page.getByRole('listbox', { name: 'Next prompts' })
    await expect(list).toBeVisible()
    await expect(page.locator('.next-list__headline')).toHaveText(SUGGESTION.headline)
    await expect(list.getByRole('option')).toHaveCount(7)
    // At 1280x800 every row shows without scrolling.
    expect(await page.locator('.next-list__rows').evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
    expect((await composer.boundingBox())!.height).toBe(before!.height)

    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(value => window.sotto!.updateSettings({ appearance: value }), appearance)
      for (const [width, height] of SIZES) {
        await app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.setContentSize(size[0]!, size[1]!)
        }, [width, height])
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await expect(list).toBeVisible()
        const bounds = await page.locator('.next-list').evaluate(element => {
          const rect = element.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth }
        })
        expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.width)
        expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.overflow).toBe(0)
        await page.screenshot({ path: join(evidence, `list-${width}x${height}-${appearance}.png`), animations: 'disabled' })
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.screenshot({ path: join(evidence, 'list-820x560-light-reduced-motion.png'), animations: 'disabled' })
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.setContentSize(1280, 800) })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1280)

    // Digits pick while it is open; Escape closes it.
    await page.keyboard.press('2')
    await expect(list).toBeHidden()
    await expectPromptText(prompt, SUGGESTION.chips[1]!.text)
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace')
    await page.keyboard.press('ArrowUp')
    await expect(list).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(list).toBeHidden()
    await expect(ghost).toHaveText(`${GHOST}Tab`)
    await page.screenshot({ path: join(evidence, 'ghost-1280x800-dark.png'), animations: 'disabled' })

    // The Next button opens the same list; Enter on the first answer sends it as the user's own message.
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(list).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByLabel('Thread transcript')).toContainText('Do both themes')
    await expect(ghost).toHaveCount(0)
  } finally {
    if (launched) await closeSotto(launched)
    await removeOwnedE2EProfile(profile)
  }
})

test('with the Owl feature off, a finished turn asks nothing and shows nothing', async () => {
  const { profile, root } = await fixture('sotto-e2e-next-prompt-off-')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launch(profile, root, false)
    const { page } = launched
    await answeredThread(page, join(root, 'project'))
    await expect(page.locator('.prompt-editor__ghost')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0)
    await promptField(page).click()
    await page.keyboard.press('ArrowUp')
    await expect(page.getByRole('listbox', { name: 'Next prompts' })).toHaveCount(0)
    expect(await sideCalls(root)).toEqual([])
  } finally {
    if (launched) await closeSotto(launched)
    await removeOwnedE2EProfile(profile)
  }
})
