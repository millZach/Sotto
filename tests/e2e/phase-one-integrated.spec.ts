import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

const screenshot = {
  name: 'phase-one-reference.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=', 'base64'),
}

async function prepare(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await page.getByRole('link', { name: 'Threads', exact: true }).click()
}

async function selectThread(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: title, exact: true }).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
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
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await selectThread(page, 'Docs')
    await expect(prompt).toHaveValue('Docs draft is independently owned.')
    await selectThread(page, 'Workshop')
    await expect(prompt).toHaveValue('Workshop draft with a reference image.')
    await expect(page.getByLabel('Attached screenshots').getByAltText(screenshot.name)).toBeVisible()

    await closeSotto(launched)
    launched = await launchSotto('success', profile)
    page = launched.page
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    await selectThread(page, 'Workshop')
    prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await expect(prompt).toHaveValue('Workshop draft with a reference image.')
    await expect(page.getByLabel('Attached screenshots').getByAltText(screenshot.name)).toBeVisible()
    await prompt.press('Enter')
    await expect(prompt).toHaveValue('')
    const transcript = page.getByLabel('Thread transcript', { exact: true })
    await expect(transcript).toContainText('Workshop draft with a reference image.')
    await expect(transcript.getByAltText(screenshot.name)).toBeVisible()
    const state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state.assignments).toEqual([])
    expect(state.host.threads.find(thread => thread.id === 'workshop')!.messages.filter(message => message.role === 'user')).toHaveLength(1)
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
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(760, 800)
    })
    await page.screenshot({ path: 'artifacts/crossing/phase-one-rich-minimum.png', animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await page.evaluate(async () => {
      for (let index = 0; index < 100; index += 1) {
        await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: `History message ${index}.\n\nDetail retained for the current project.` })
      }
    })
    await expect(transcript).toContainText('History message 99.')
    await transcript.evaluate(node => { node.scrollTop = 120; node.dispatchEvent(new Event('scroll')) })
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
    await page.getByRole('button', { name: /jump to latest|new messages/i }).click()
    await expect(transcript).toContainText('A new update while reading earlier messages.')
    await expect.poll(() => transcript.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(3)
  } finally { await closeSotto(launched) }
})

test('project settlement preserves individual choices, drafts and running work in both appearances', async () => {
  const launched = await launchSotto()
  const { page, app } = launched
  try {
    await prepare(page)
    await selectThread(page, 'Docs')
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Keep this document draft while the project is settled.')
    await page.getByRole('button', { name: 'Settle', exact: true }).click()
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(760, 800))
    await page.screenshot({ path: 'artifacts/crossing/phase-one-projects-minimum.png', animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).focus()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toBeFocused()
  } finally { await closeSotto(launched) }
})
