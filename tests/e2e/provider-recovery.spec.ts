import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto } from './support/sottoLaunch'

const draft = 'Review this synthetic recovered drawing before deciding what to send.'
const attachment = { id: 'synthetic-image', name: 'recovered-drawing.png', mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5FoAAAAASUVORK5CYII=' }

async function seed(): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-recovery-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), provider: 't3', enabled: true, speak: false, endpoint: 'http://synthetic-previous-provider.invalid', defaultModelId: 'old-model' },
    assignments: [{ threadId: 'previous-thread', mode: 'managed', instruction: 'Synthetic previous assignment', followups: 1,
      paused: false, seenMessageIds: [], ownMessageIds: [], handledRequestIds: [], lastFailure: '', contextUpdatedAt: Date.now() }],
    queue: [{ id: 'previous-question', threadId: 'previous-thread', kind: 'question', requestId: 'previous-request',
      text: 'Synthetic previous question', createdAt: new Date().toISOString(), deferred: false }],
    activeThreadId: 'previous-thread', activeProjectId: 'previous-project', draft, draftAttachments: [attachment],
    draftThreadId: 'previous-thread', draftRequestId: 'previous-request', composing: true, pendingRequest: 'Synthetic pending action',
    contextSavedAt: Date.now(), outbox: [{ id: 'previous-command', type: 'answer', threadId: 'previous-thread', requestId: 'previous-request' }],
  }))
  return profile
}

async function capture(page: Page, name: string): Promise<void> {
  await mkdir('artifacts/provider-recovery', { recursive: true })
  await page.screenshot({ path: `artifacts/provider-recovery/${name}-desktop.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 760, height: 850 })
  await page.screenshot({ path: `artifacts/provider-recovery/${name}-760.png`, animations: 'disabled' })
  const notice = page.getByRole('region', { name: 'Recovered work' })
  const bounds = await (await notice.count() ? notice : page.getByRole('region', { name: 'Thread workspace' })).boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(761)
  await page.setViewportSize({ width: 1080, height: 720 })
}

for (const localDraft of [false, true]) test(`recovered provider draft stays unbound through connect/create, then binds only for explicit review${localDraft ? ' after clearing the current local draft' : ''}`, async () => {
  const profile = await seed()
  const launched = await launchSotto('success', profile)
  const { page } = launched
  const rendererErrors: string[] = []
  page.on('pageerror', error => rendererErrors.push(error.message))
  try {
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    const notice = page.getByRole('region', { name: 'Recovered work' })
    await expect(notice.getByRole('textbox', { name: 'Recovered draft' })).toHaveValue(draft)
    await expect(notice).toContainText(attachment.name)
    let state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state).toMatchObject({ configuration: { provider: 'codex', enabled: false }, draft, draftAttachments: [attachment],
      draftThreadId: null, draftRequestId: null, assignments: [], queue: [], composing: false })
    await capture(page, 'unbound')
    await page.getByRole('button', { name: 'Connect Codex', exact: true }).click()
    await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await dialog.getByRole('button', { name: /Sotto test/ }).click()
    await dialog.getByRole('textbox', { name: 'Thread name' }).fill('Recovered work review')
    await dialog.getByRole('button', { name: 'Create thread', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Recovered work review', exact: true })).toBeVisible()
    state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state).toMatchObject({ draft, draftAttachments: [attachment], draftThreadId: null, assignments: [], composing: false })
    const threadId = state.activeThreadId!
    expect(state.host.threads.find(thread => thread.id === threadId)?.messages).toHaveLength(0)
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('')
    await expect(notice.getByRole('button', { name: 'Use saved draft here' })).toBeEnabled()
    if (localDraft) {
      const composer = page.getByRole('textbox', { name: 'Prompt', exact: true })
      await composer.fill('Keep this current unsent native prompt too.')
      await page.getByLabel('Screenshot files').setInputFiles({ name: 'current-native-image.png', mimeType: 'image/png', buffer: Buffer.from(attachment.dataUrl.split(',')[1]!, 'base64') })
      await expect(page.getByRole('img', { name: 'current-native-image.png' })).toBeVisible()
      await expect(notice.getByRole('button', { name: 'Use saved draft here' })).toBeDisabled()
      await expect(composer).toHaveValue('Keep this current unsent native prompt too.')
      await expect(notice.getByRole('textbox', { name: 'Recovered draft' })).toHaveValue(draft)
      expect(await page.evaluate(async () => window.sotto!.agents!.get())).toMatchObject({ draft, draftAttachments: [attachment], draftThreadId: null })
      await capture(page, 'local-draft-kept')
      await composer.fill('')
      await expect(notice.getByRole('button', { name: 'Use saved draft here' })).toBeDisabled()
      await page.getByRole('button', { name: 'Remove current-native-image.png' }).click()
      await expect(notice.getByRole('button', { name: 'Use saved draft here' })).toBeEnabled()
    } else await capture(page, 'before-bind')
    await notice.getByRole('button', { name: 'Use saved draft here' }).click()
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(draft)
    await expect(page.getByRole('img', { name: attachment.name })).toBeVisible()
    await expect(notice.getByRole('button', { name: 'Use saved draft here' })).toHaveCount(0)
    state = await page.evaluate(async () => window.sotto!.agents!.get())
    expect(state).toMatchObject({ draft, draftAttachments: [attachment], draftThreadId: threadId, draftRequestId: null, assignments: [], composing: true })
    expect(state.host.threads.find(thread => thread.id === threadId)?.messages).toHaveLength(0)
    expect(state.host.threads.find(thread => thread.id === threadId)?.requests).toHaveLength(0)
    await capture(page, localDraft ? 'bound-after-local-clear' : 'bound-for-review')
    const recovery = JSON.parse(await readFile(join(profile, 'provider-retirement-v1.json'), 'utf8'))
    expect(recovery.state).toMatchObject({ draft, draftAttachments: [attachment], draftThreadId: 'previous-thread', outbox: [{ id: 'previous-command' }] })
    expect(rendererErrors).toEqual([])
  } finally { await closeSotto(launched); await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true }) }
})

test('clear saved draft removes recovered text and images and stays cleared after restart', async () => {
  const profile = await seed()
  let launched = await launchSotto('success', profile)
  try {
    await launched.page.getByRole('link', { name: 'Threads', exact: true }).click()
    await launched.page.getByRole('button', { name: 'Clear saved draft', exact: true }).click()
    await expect(launched.page.getByRole('textbox', { name: 'Recovered draft' })).toHaveCount(0)
    await expect(launched.page.getByText(attachment.name, { exact: true })).toHaveCount(0)
    const state = await launched.page.evaluate(async () => window.sotto!.agents!.get())
    expect(state).toMatchObject({ draft: '', draftAttachments: [], draftThreadId: null, draftRequestId: null, assignments: [], composing: false })
    await capture(launched.page, 'cleared')
    await closeSotto(launched)
    launched = await launchSotto('success', profile)
    await launched.page.getByRole('link', { name: 'Threads', exact: true }).click()
    await expect(launched.page.getByRole('textbox', { name: 'Recovered draft' })).toHaveCount(0)
    expect(await launched.page.evaluate(async () => window.sotto!.agents!.get())).toMatchObject({ draft: '', draftAttachments: [], draftThreadId: null })
  } finally { await closeSotto(launched); await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true }) }
})
