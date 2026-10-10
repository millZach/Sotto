import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { writeFile } from 'node:fs/promises'
import { agentState } from './support/agentAccess'
import { join } from 'node:path'
import { evidenceDirectory } from '../fixtures/evidence'
import { expect, test } from '@playwright/test'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { hostKeys } from './support/hostKeys'
import { closeSotto, launchSotto,  openThreads, resizeWindow } from './support/sottoLaunch'

const savedDraftEvidence = evidenceDirectory('artifacts/new-thread-saved-draft')

const evidence = evidenceDirectory('artifacts/new-thread-setup')

const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5FoAAAAASUVORK5CYII=', 'base64')

test('creates a project thread without replacing a leftover draft from an earlier thread', async () => {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-thread-creation-' })).directory
  const leftover = 'Keep the earlier thread draft'
  // Upgrade state can retain a prompt whose thread is no longer listed (CONTEXT.md: Leftover draft).
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: defaultAgentConfiguration(), activeThreadId: null, activeProjectId: 'project',
    draft: leftover, draftThreadId: 'removed-thread', draftRequestId: null, composing: false, outbox: [],
  }), 'utf8')
  const launched = await launchSotto('success', profile).catch(async error => {
    await removeOwnedE2EProfile(profile)
    throw error
  })
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    await expect(page.getByRole('heading', { name: 'A draft from an earlier thread is saved.', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Saved draft', exact: true })).toHaveValue(leftover)
    await expect(page.getByRole('button', { name: 'New thread with this draft', exact: true })).toBeEnabled()
    expect(await page.evaluate(async () => window.sotto!.getSettings())).not.toHaveProperty('voiceCoordinatorEnabled')
    // The pen opens the thread at once, on defaults, with no dialog to fill in (issue #347).
    await page.getByRole('button', { name: 'New thread in Sotto test', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'New thread', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'New thread', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toBeEnabled()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('')
    // Wait for confirmation of the thread this pane opened; the singleton draft keeps its earlier owner.
    const pane = page.getByRole('region', { name: 'New thread', exact: true })
    const threadId = await pane.getAttribute('data-thread-id')
    expect(threadId).not.toBeNull()
    await expect.poll(async () => page.evaluate(async threadId => {
      const state = await window.sotto!.agents!.get()
      return !state.globalLaneBusy && state.host.threads.some(thread => thread.id === threadId
        && thread.title === 'New thread' && thread.projectId === state.activeProjectId)
    }, threadId)).toBe(true)
    const state = await agentState(page)
    expect(state.error).toBeNull()
    expect(state.host.threads).toContainEqual(expect.objectContaining({ id: threadId, title: 'New thread', projectId: state.activeProjectId }))
    const key = await hostKeys(page)
    const draftThreadId = key('removed-thread')
    expect(state.draftThreadId).toBe(draftThreadId)
    expect(state.host.threads.some(thread => thread.id === draftThreadId)).toBe(false)
    expect(state).toMatchObject({ draft: leftover, draftThreadId, draftRequestId: null })
    expect(state).not.toHaveProperty('assignments')
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Only send this new prompt')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Only send this new prompt')
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('')
    expect(await agentState(page)).toMatchObject({ draft: leftover, draftThreadId })
    await page.screenshot({ animations: 'disabled', path: join(savedDraftEvidence, 'created-and-sent.png') })
  } finally {
    await closeSotto(launched)
    await removeOwnedE2EProfile(profile)
  }
})

test('creates a thread in a centered popup, configures it, and sends file and pasted screenshots', async () => {
  const previousFolder = process.env.SOTTO_E2E_PROJECT_DIRECTORY
  process.env.SOTTO_E2E_PROJECT_DIRECTORY = process.cwd()
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Threads', exact: true })).toBeAttached()
    const centered = await dialog.evaluate(node => {
      const rect = node.getBoundingClientRect()
      return Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 2 && Math.abs(rect.y + rect.height / 2 - innerHeight / 2) < 2
    })
    expect(centered).toBe(true)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'new-thread-picker.png') })
    // Choosing the folder opens the thread at once, on defaults from Settings → Agents; there is no options
    // form left to fill in here (issue #347). The rest of this test configures it from its own composer instead.
    await dialog.getByRole('button', { name: /Local folder/ }).click()
    // This computer's folders open in Sotto's browser; its File Explorer button is the system dialog the fixture answers.
    await page.getByRole('dialog', { name: /Choose a folder for the new thread/ }).getByRole('button', { name: 'Browse with File Explorer' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'New thread', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Threads', exact: true })).toBeAttached()

    await page.getByRole('combobox', { name: 'Thread model' }).click()
    await expect(page.getByRole('dialog', { name: 'Choose model' })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'composer-provider-models.png') })
    // At the 820x560 minimum the chips and the open menu stay inside the window.
    await resizeWindow(launched, 820, 560)
    await expect(page.getByRole('dialog', { name: 'Choose model' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'composer-chips-820.png') })
    await resizeWindow(launched, 1280, 800)
    await page.getByRole('option', { name: 'Claude Test', exact: true }).click()
    await page.getByRole('combobox', { name: 'Thread reasoning' }).click()
    // The card has no level buttons: Home is the lowest level the model reports.
    await page.getByRole('slider', { name: 'Thread reasoning effort', exact: true }).press('Home')
    await expect(page.getByRole('combobox', { name: 'Thread reasoning' })).toHaveText('Low')
    await page.keyboard.press('Escape')
    await page.getByRole('combobox', { name: 'Thread permissions' }).click()
    await page.getByRole('option', { name: 'Allow edits', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Thread permissions' })).toHaveText('Allow edits')
    await page.getByLabel('Screenshot files').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: screenshot })
    await expect(page.getByRole('img', { name: 'screen.png' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Review this screenshot.')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'thread-screenshot-draft.png') })
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('screen.png')
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('')
    await expect(page.getByLabel('Attached screenshots').getByRole('img', { name: 'screen.png' })).toHaveCount(0)
    await expect(page.getByLabel('Thread transcript').getByRole('img', { name: 'screen.png' })).toBeVisible()
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop agent', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Attach screenshots' })).toBeEnabled()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toBeEnabled()
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).evaluate((node, base64) => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, screenshot.toString('base64'))
    await expect(page.getByRole('img', { name: 'pasted.png' })).toBeVisible()
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('pasted.png')
    // Pending transcript content appears before the native delivery receipt clears the draft.
    await expect(page.getByLabel('Attached screenshots').getByRole('img', { name: 'pasted.png' })).toHaveCount(0)
    await expect(page.getByLabel('Thread transcript').getByRole('img', { name: 'pasted.png' })).toBeVisible()
    const state = await agentState(page)
    // The shell summarises histories; the detail bridge carries the messages themselves.
    const created = (await page.evaluate(async id => window.sotto!.agents!.threadDetail!(id), state.activeThreadId!))!
    expect(created.messages.filter(message => message.role === 'user')).toHaveLength(2)
    expect(created.messages.at(-1)).toMatchObject({ text: '', attachments: [{ name: 'pasted.png' }] })

    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send prompt', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Attach screenshots' })).toBeEnabled()
    await page.getByLabel('Screenshot files').setInputFiles({ name: 'retained.png', mimeType: 'image/png', buffer: screenshot })
    await expect(page.getByRole('img', { name: 'retained.png' })).toBeVisible()
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'reject', threadId: (await window.sotto!.agents!.get()).activeThreadId!, text: 'Temporary provider failure' }))
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Temporary provider failure')
    await expect(page.getByRole('img', { name: 'retained.png' })).toBeVisible()
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('retained.png')
    await expect(page.getByLabel('Attached screenshots').getByRole('img', { name: 'retained.png' })).toHaveCount(0)
    await expect(page.getByLabel('Thread transcript').getByRole('img', { name: 'retained.png' })).toBeVisible()
  } finally {
    if (previousFolder === undefined) delete process.env.SOTTO_E2E_PROJECT_DIRECTORY
    else process.env.SOTTO_E2E_PROJECT_DIRECTORY = previousFolder
    await closeSotto(launched)
  }
})
