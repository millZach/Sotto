import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto, userMessageTexts } from './support/sottoLaunch'

const screenshot = {
  name: 'phase-one-reference.png', mimeType: 'image/png',
  buffer: readFileSync(join(process.cwd(), 'build/icon.png')),
}

async function prepare(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await openThreads(page)
}

async function selectThread(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: title, exact: true }).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

/** Rename, Regenerate title and Settle live behind the pane header's More menu now, so it has to be opened first. */
async function headerAction(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions', exact: true }).first().click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function captureModes(launched: LaunchedSotto, name: string, width = 820): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(760, 700)
    window.setContentSize(width, 800)
  }, width)
  await expect.poll(() => launched.page.evaluate(() => window.innerWidth)).toBe(width)
  for (const appearance of ['dark', 'light'] as const) {
    await launched.page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'blue' }), appearance)
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
    await launched.page.screenshot({ path: `artifacts/crossing/phase-one-${name}-${appearance}.png`, animations: 'disabled' })
  }
}

test('independent text and image drafts survive navigation, renderer reload and a full Electron restart', async () => {
  test.setTimeout(60_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase-one-'))
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    let page = launched.page
    await prepare(page)
    await selectThread(page, 'Workshop')
    let prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Workshop draft with a reference image.')
    await page.getByLabel('Screenshot files', { exact: true }).setInputFiles(screenshot)
    await expect(page.getByLabel('Attached screenshots').getByAltText(screenshot.name)).toBeVisible()
    await selectThread(page, 'Docs')
    await prompt.fill('Docs draft is independently owned.')
    await page.reload()
    await openThreads(page)
    await selectThread(page, 'Docs')
    await expect(prompt).toHaveValue('Docs draft is independently owned.')
    await selectThread(page, 'Workshop')
    await expect(prompt).toHaveValue('Workshop draft with a reference image.')
    await expect(page.getByLabel('Attached screenshots').getByAltText(screenshot.name)).toBeVisible()

    await closeSotto(launched)
    launched = await launchSotto('success', profile)
    page = launched.page
    await openThreads(page)
    await selectThread(page, 'Workshop')
    prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await expect(prompt).toHaveValue('Workshop draft with a reference image.')
    await expect(page.getByLabel('Attached screenshots').getByAltText(screenshot.name)).toBeVisible()
    await prompt.press('Enter')
    await expect(prompt).toHaveValue('')
    const transcript = page.getByLabel('Thread transcript', { exact: true })
    await expect(transcript).toContainText('Workshop draft with a reference image.')
    await expect(transcript.getByAltText(screenshot.name)).toBeVisible()
    await captureModes(launched, 'sent-image', 760)
    expect(await transcript.getByAltText(screenshot.name).evaluate(image => {
      const img = image.getBoundingClientRect(); const frame = image.parentElement!.getBoundingClientRect()
      return img.top >= frame.top && img.bottom <= frame.bottom + 1 && img.left >= frame.left && img.right <= frame.right + 1
    })).toBe(true)
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state.assignments).toEqual([])
    expect(await userMessageTexts(page, 'workshop')).toHaveLength(1)
    expect(state.threadDrafts!.find(draft => draft.threadId === 'docs')!.text).toBe('Docs draft is independently owned.')
    await selectThread(page, 'Docs')
    await expect(prompt).toHaveValue('Docs draft is independently owned.')
  } finally {
    if (launched) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})

test('rich answers remain safe and readable without pulling the reader away from older history', async () => {
  test.setTimeout(60_000)
  const launched = await launchSotto()
  const { page, app } = launched
  try {
    await prepare(page)
    await selectThread(page, 'Workshop')
    const answer = [
      'A **readable answer** with a [source](https://example.com/reference).',
      '', '> Keep the operating context.', '', '- First step', '- Second step', '',
      '| Signal | State |', '| --- | --- |', '| Pump | Ready |', '',
      '```typescript', 'const state = { ready: true };', 'console.log(state);', '```', '',
      '<script>window.phaseOneInjected = true</script>',
      '[Unsafe](javascript:alert(1))', '![Remote tracker](https://example.com/tracker.png)',
    ].join('\n')
    await page.evaluate(async text => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text }), answer)
    const transcript = page.getByLabel('Thread transcript', { exact: true })
    await expect(transcript.locator('strong')).toHaveText('readable answer')
    await expect(transcript.locator('blockquote')).toContainText('Keep the operating context.')
    await expect(transcript.getByRole('table')).toContainText('Pump')
    await expect(transcript.getByRole('link', { name: 'source', exact: true })).toHaveAttribute('href', 'https://example.com/reference')
    expect(await transcript.locator('script, iframe, object, embed, a[href^="javascript:"], img[src^="http"]').count()).toBe(0)
    await transcript.getByRole('button', { name: /copy .*code/i }).click()
    await expect(transcript.getByText('Copied', { exact: true })).toBeVisible()
    expect((await page.evaluate(async () => window.sottoE2E!.snapshot())).clipboardText).toBe('const state = { ready: true };\nconsole.log(state);')

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(1280, 900)
    })
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.screenshot({ path: 'artifacts/crossing/phase-one-rich-light.png', animations: 'disabled' })
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.screenshot({ path: 'artifacts/crossing/phase-one-rich-dark.png', animations: 'disabled' })
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      window.setMinimumSize(760, 700)
      window.setContentSize(760, 800)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(760)
    await page.screenshot({ path: 'artifacts/crossing/phase-one-rich-minimum.png', animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await page.evaluate(async () => {
      for (let index = 0; index < 100; index += 1) {
        await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: `History message ${index}.\n\nDetail retained for the current project.` })
      }
    })
    await expect(transcript).toContainText('History message 99.')
    await transcript.evaluate(node => { node.scrollTop = 120; node.dispatchEvent(new Event('scroll')) })
    // Messages scrolled into view render on the next frames (content-visibility: auto); measure the anchor once they have.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const readingTop = await transcript.evaluate(node => node.scrollTop)
    const readingAnchor = await transcript.locator('article').evaluateAll(nodes => {
      const scroller = document.querySelector('[aria-label="Thread transcript"]')!.getBoundingClientRect()
      const node = nodes.find(item => item.getBoundingClientRect().top >= scroller.top)!
      return { text: node.textContent, top: node.getBoundingClientRect().top - scroller.top }
    })
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: 'A new update while reading earlier messages.' }))
    await expect(page.getByRole('button', { name: /jump to latest|new messages/i })).toBeVisible()
    expect(readingTop).toBe(120)
    const keptAnchor = await transcript.locator('article').evaluateAll((nodes, text) => {
      const scroller = document.querySelector('[aria-label="Thread transcript"]')!.getBoundingClientRect()
      const node = nodes.find(item => item.textContent === text)
      return node ? node.getBoundingClientRect().top - scroller.top : null
    }, readingAnchor.text)
    expect(keptAnchor).not.toBeNull()
    expect(Math.abs(keptAnchor! - readingAnchor.top)).toBeLessThan(3)
    const jump = page.getByRole('button', { name: /jump to latest|new messages/i })
    await jump.focus()
    await expect(jump).toBeFocused()
    expect(await jump.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2)
    await captureModes(launched, 'reading-jump', 760)
    await page.getByRole('button', { name: /jump to latest|new messages/i }).click()
    await expect(transcript).toContainText('A new update while reading earlier messages.')
    await expect.poll(() => transcript.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(3)
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ appearance: 'light', reducedMotion: 'on' })
      await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', status: 'running', text: '## In progress\n\nPartial **bold\n\n```typescript\nconst pending = ' })
    })
    await expect(transcript).toContainText('const pending =')
    await page.screenshot({ path: 'artifacts/crossing/phase-one-streaming-light-reduced-motion.png', animations: 'disabled' })
  } finally { await closeSotto(launched) }
})

test('project settlement preserves individual choices, drafts and running work in both appearances', async () => {
  const launched = await launchSotto()
  const { page, app } = launched
  try {
    await prepare(page)
    await selectThread(page, 'Docs')
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Keep this document draft while the project is settled.')
    await headerAction(page, 'Settle')
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: /^Settled / }).click()
    await expect(sidebar.getByRole('button', { name: 'Restore Docs', exact: true })).toBeVisible()
    await selectThread(page, 'Workshop')
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Continue the workshop task.')
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).press('Enter')
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('')
    await expect(page.getByRole('button', { name: 'Stop agent', exact: true })).toBeVisible()
    await sidebar.getByRole('button', { name: 'Settle project Sotto test', exact: true }).click()
    await expect(sidebar.getByRole('button', { name: 'Restore project Sotto test', exact: true })).toBeVisible()
    await captureModes(launched, 'settled-project', 820)
    let state = await page.evaluate(async () => window.sotto!.agents!.get())
    const individuallySettled = state.host.threads.find(thread => thread.id === 'docs')!.workspaceSettledAt
    expect(individuallySettled).toBeTruthy()
    expect(state.host.projects.find(project => project.id === 'project')!.workspaceSettledAt).toBeTruthy()
    expect(state.host.threads.find(thread => thread.id === 'workshop')!.status).toBe('running')
    await sidebar.getByRole('button', { name: 'Restore project Sotto test', exact: true }).click()
    await expect(sidebar.getByRole('button', { name: 'Settle project Sotto test', exact: true })).toBeVisible()
    state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state.host.projects.find(project => project.id === 'project')!.workspaceSettledAt).toBeFalsy()
    expect(state.host.threads.find(thread => thread.id === 'docs')!.workspaceSettledAt).toBe(individuallySettled)
    expect(state.host.threads.find(thread => thread.id === 'workshop')!).toMatchObject({ status: 'running', projectId: 'project' })
    expect(state.assignments).toEqual([])
    await selectThread(page, 'Docs')
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Keep this document draft while the project is settled.')
    await selectThread(page, 'Workshop')
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', status: 'running', text: 'Checking the project while Docs stays settled.\n\nThe draft and original project scope are retained.' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(1280, 850))
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'blue' }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await page.screenshot({ path: `artifacts/crossing/phase-one-projects-${appearance}.png`, animations: 'disabled' })
    }
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      window.setMinimumSize(760, 700)
      window.setContentSize(760, 800)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(760)
    await page.screenshot({ path: 'artifacts/crossing/phase-one-projects-minimum.png', animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).focus()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toBeFocused()
  } finally { await closeSotto(launched) }
})

test('light provider controls remain readable and uncertain delivery can be checked after navigation and reload', async () => {
  const launched = await launchSotto()
  const { page, app } = launched
  try {
    await prepare(page)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByRole('button', { name: 'New thread in Sotto test', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await expect(dialog).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      window.setMinimumSize(760, 700)
      window.setContentSize(760, 800)
    })
    await page.screenshot({ path: 'artifacts/crossing/phase-one-new-thread-light.png', animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await dialog.getByRole('button', { name: 'Close new thread dialog', exact: true }).click()
    await selectThread(page, 'Docs')
    // The model, reasoning and permission controls sit behind the pane's Thread options pill now.
    await page.getByRole('button', { name: 'Thread options', exact: true }).click()
    const model = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await model.click()
    await expect(page.getByRole('listbox')).toBeVisible()
    await page.screenshot({ path: 'artifacts/crossing/phase-one-model-picker-light.png', animations: 'disabled' })
    // Escape closes the picker alone and hands focus back to the model control; a second Escape closes the options.
    await page.keyboard.press('Escape')
    await expect(model).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(model).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Thread options', exact: true })).toBeFocused()
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'uncertain', threadId: 'docs', text: '' }))
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('A prompt with an uncertain acknowledgement.')
    await prompt.press('Enter')
    await expect(page.getByLabel('Pending message')).toContainText('Unconfirmed')
    await captureModes(launched, 'uncertain-submission', 820)
    await prompt.fill('A newer draft while confirmation is pending.')
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await openThreads(page)
    await expect(prompt).toHaveValue('A newer draft while confirmation is pending.')
    await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()
    await page.reload()
    await openThreads(page)
    await selectThread(page, 'Docs')
    await expect(prompt).toHaveValue('A newer draft while confirmation is pending.')
    await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()
    // Sending or queuing: nothing new leaves while the earlier prompt is unconfirmed.
    await expect(page.getByRole('button', { name: /^(Send|Queue) prompt$/ })).toBeDisabled()
    await page.getByRole('button', { name: 'Check again', exact: true }).focus()
    await captureModes(launched, 'uncertain-recovery-focus', 760)
    await page.getByRole('button', { name: 'Check again', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Check again', exact: true })).toHaveCount(0)
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(await userMessageTexts(page, 'docs')).toEqual(['A prompt with an uncertain acknowledgement.'])
    expect(state.threadDrafts!.find(draft => draft.threadId === 'docs')!.text).toBe('A newer draft while confirmation is pending.')
    expect(state.assignments).toEqual([])
  } finally { await closeSotto(launched) }
})

test('keyboard navigation exposes folder actions, rich scrollers and truthful failed-send recovery', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await prepare(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('searchbox', { name: 'Search threads' }).focus()
    const action = sidebar.getByRole('button', { name: 'Settle project Sotto test', exact: true })
    for (let steps = 0; steps < 15 && !await action.evaluate(node => node === document.activeElement); steps += 1) await page.keyboard.press('Tab')
    await expect(action).toBeFocused()
    expect(await action.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2)
    expect(await action.evaluate(node => getComputedStyle(node.parentElement!).opacity)).toBe('1')
    await captureModes(launched, 'keyboard-folder-action', 760)
    await selectThread(page, 'Docs')
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'docs', text: '| Item | State |\n| --- | --- |\n| Pump | Ready |\n\n```typescript\nconst enabled = true;\n```' }))
    const transcript = page.getByRole('log', { name: 'Thread transcript' })
    await transcript.focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('region', { name: 'Table', exact: true })).toBeFocused()
    await captureModes(launched, 'keyboard-table', 760)
    await page.keyboard.press('Tab')
    const copy = page.getByRole('button', { name: /copy .*code/i })
    await expect(copy).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Copied', { exact: true })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('typescript code block', { exact: true })).toBeFocused()
    await captureModes(launched, 'keyboard-code', 760)
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'reject', threadId: 'docs', text: 'The test provider declined this prompt.' }))
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('A prompt the provider will reject.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).focus()
    await captureModes(launched, 'keyboard-send', 760)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Retry', exact: true }).focus()
    await captureModes(launched, 'failed-retry-focus', 760)
    await prompt.fill('A newer draft after a rejected prompt.')
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    await expect(prompt).toHaveValue('A newer draft after a rejected prompt.')
    await captureModes(launched, 'failed-newer-draft', 760)
    expect(await userMessageTexts(page, 'docs')).toEqual([])
  } finally { await closeSotto(launched) }
})
