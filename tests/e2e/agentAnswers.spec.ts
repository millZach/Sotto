import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AgentCommand, AgentState } from '../../src/shared/agents'
import type { SottoBridge } from '../../src/shared/contracts'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, enableVoiceCoordinator, launchSotto, launchSottoWithVoice, userMessageTexts } from './support/sottoLaunch'
import { completeVoiceJourneySetup, openVoiceJourneyAgents } from './support/voiceJourney'

type BrowserGlobals = { sotto: SottoBridge; sottoE2E: SottoE2EBridge }
type HostEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0] & {
  requestId?: string
  status?: 'idle' | 'running' | 'error'
}

async function command(page: Page, value: AgentCommand): Promise<AgentState> {
  return page.evaluate(async request => {
    const bridge = (globalThis as unknown as BrowserGlobals).sotto.agents
    if (!bridge) throw new Error('Agent bridge unavailable')
    return bridge.command(request)
  }, value)
}

async function state(page: Page): Promise<AgentState> {
  return page.evaluate(async () => {
    const bridge = (globalThis as unknown as BrowserGlobals).sotto.agents
    if (!bridge) throw new Error('Agent bridge unavailable')
    return bridge.get()
  })
}

async function event(page: Page, value: HostEvent): Promise<void> {
  await page.evaluate(async data => {
    const bridge = (globalThis as unknown as BrowserGlobals).sottoE2E
    if (!bridge.agentEvent) throw new Error('External host fixture unavailable')
    await bridge.agentEvent(data)
  }, value)
}

async function onboard(page: Page): Promise<void> {
  await completeVoiceJourneySetup(page)
  await openVoiceJourneyAgents(page)
  await page.getByRole('button', { name: 'Connect providers' }).click()
  await command(page, { type: 'assign', threadId: 'workshop' })
  await command(page, { type: 'assign', threadId: 'docs' })
  await page.getByRole('button', { name: 'Open Workshop', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Workshop', exact: true })).toBeVisible()
}

const workshopQuestion: HostEvent = {
  type: 'question', threadId: 'workshop', requestId: 'layout-question',
  text: 'Which layout should the project use?', status: 'running',
}
const docsQuestion: HostEvent = {
  type: 'question', threadId: 'docs', requestId: 'audience-question',
  text: 'Who should the documentation address?', status: 'running',
}

test('composes a spoken answer across pauses and advances only after explicit submission', async () => {
  const launched = await launchSottoWithVoice()
  const { page } = launched
  try {
    await onboard(page)
    await event(page, workshopQuestion)
    await command(page, { type: 'utterance', text: 'Use the same layout' })
    await expect(page.locator('.agent-composer textarea')).toHaveValue('Use the same layout')
    let snapshot = await state(page)
    expect(snapshot.host.threads.find(thread => thread.id === 'workshop')?.status).toBe('running')
    expect(snapshot.host.threads.find(thread => thread.id === 'workshop')?.requests.map(request => request.id)).toEqual(['layout-question'])

    // A second host needs attention while the first answer is still being dictated.
    await event(page, docsQuestion)
    await command(page, { type: 'refresh' })
    await command(page, { type: 'utterance', text: 'but keep the sidebar.' })
    await expect(page.locator('.agent-composer textarea')).toHaveValue('Use the same layout but keep the sidebar.')
    snapshot = await state(page)
    expect(snapshot.activeThreadId).toBe('workshop')
    expect(snapshot.host.threads.find(thread => thread.id === 'workshop')?.requests).toHaveLength(1)
    expect(snapshot.host.threads.find(thread => thread.id === 'docs')?.requests).toHaveLength(1)

    snapshot = await command(page, { type: 'utterance', text: 'send it' })
    expect(snapshot.error).toBeNull()
    expect(snapshot.host.threads.find(thread => thread.id === 'workshop')?.requests).toHaveLength(0)
    expect(await userMessageTexts(page, 'workshop')).toHaveLength(0)
    expect(snapshot.host.threads.find(thread => thread.id === 'docs')?.requests.map(request => request.id)).toEqual(['audience-question'])
    expect(snapshot.activeThreadId).toBe('docs')
    await expect(page.locator('.agent-composer textarea')).toHaveValue('')
    await expect(page.getByRole('heading', { name: 'Docs', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Docs', exact: true }).getByText(docsQuestion.text, { exact: true })).toBeVisible()
  } finally { await closeSotto(launched) }
})

test('restores the pending question binding with its draft after an application restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-e2e-'))
  await enableVoiceCoordinator(directory)
  let launched = await launchSotto('success', directory)
  try {
    await onboard(launched.page)
    await event(launched.page, workshopQuestion)
    await command(launched.page, { type: 'utterance', text: 'Use the existing controls' })
    await expect(launched.page.locator('.agent-composer textarea')).toHaveValue('Use the existing controls')
    await closeSotto(launched)

    launched = await launchSotto('success', directory)
    await openVoiceJourneyAgents(launched.page)
    await launched.page.getByRole('button', { name: 'Open Workshop', exact: true }).click()
    await expect(launched.page.getByRole('dialog', { name: 'Workshop', exact: true })).toBeVisible()
    // Reconcile the same authoritative host request; restarting Sotto does not create a new request.
    await event(launched.page, workshopQuestion)
    await event(launched.page, docsQuestion)
    await expect(launched.page.locator('.agent-composer textarea')).toHaveValue('Use the existing controls')
    await command(launched.page, { type: 'utterance', text: 'and preserve the keyboard shortcuts.' })
    await expect(launched.page.locator('.agent-composer textarea')).toHaveValue('Use the existing controls and preserve the keyboard shortcuts.')

    const snapshot = await command(launched.page, { type: 'utterance', text: 'send it' })
    expect(snapshot.error).toBeNull()
    expect(snapshot.host.threads.find(thread => thread.id === 'workshop')?.requests).toHaveLength(0)
    expect(await userMessageTexts(launched.page, 'workshop')).toHaveLength(0)
    expect(snapshot.host.threads.find(thread => thread.id === 'docs')?.requests.map(request => request.id)).toEqual(['audience-question'])
    expect(snapshot.activeThreadId).toBe('docs')
    await expect(launched.page.locator('.agent-composer textarea')).toHaveValue('')
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(directory), { recursive: true, force: true })
  }
})

test('keeps permission decisions explicit while allowing an exact spoken denial immediately', async () => {
  const launched = await launchSottoWithVoice()
  const { page } = launched
  try {
    await onboard(page)
    await event(page, { type: 'permission', threadId: 'workshop', requestId: 'publish-permission', text: 'Publish this project?', status: 'running' })
    let snapshot = await command(page, { type: 'utterance', text: 'I might allow this later.' })
    expect(snapshot.host.threads.find(thread => thread.id === 'workshop')?.requests.map(request => request.id)).toEqual(['publish-permission'])
    expect(snapshot.draft).toBe('')
    snapshot = await command(page, { type: 'utterance', text: 'deny' })
    expect(snapshot.error).toBeNull()
    expect(snapshot.host.threads.find(thread => thread.id === 'workshop')?.requests).toHaveLength(0)
    expect(snapshot.draft).toBe('')
  } finally { await closeSotto(launched) }
})

test('retains a typed question answer across queue navigation, widget edits, and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-e2e-'))
  await enableVoiceCoordinator(directory)
  let launched = await launchSotto('success', directory)
  try {
    await onboard(launched.page)
    await event(launched.page, workshopQuestion)
    await event(launched.page, docsQuestion)
    await launched.page.getByLabel('Your answer', { exact: true }).fill('Keep the existing layout')
    await launched.page.getByRole('dialog', { name: 'Workshop', exact: true }).getByRole('button', { name: 'Later', exact: true }).click()
    await expect(launched.page.getByRole('alert').first()).toContainText('Send or clear your draft')
    expect((await state(launched.page)).activeThreadId).toBe('workshop')

    const widget = launched.app.windows().find(window => window.url().endsWith('/widget.html'))!
    await widget.getByTestId('widget-sliver').hover()
    await widget.getByRole('button', { name: 'Expand threads', exact: true }).click()
    await expect(widget.getByLabel('Your answer', { exact: true })).toHaveValue('Keep the existing layout')
    await widget.getByLabel('Your answer', { exact: true }).fill('Keep the existing layout and controls.')
    await expect(launched.page.getByLabel('Your answer', { exact: true })).toHaveValue('Keep the existing layout and controls.')
    await widget.screenshot({ animations: 'disabled', path: 'artifacts/voice-journey/widget-answer-draft.png' })

    await launched.page.getByRole('button', { name: 'Close Workshop', exact: true }).click()
    await launched.page.getByRole('button', { name: 'Open Docs', exact: true }).click()
    await expect(launched.page.getByRole('dialog', { name: 'Docs', exact: true })).toBeVisible()
    await expect(launched.page.getByLabel('Your answer', { exact: true })).toHaveValue('Keep the existing layout and controls.')
    await expect(launched.page.getByText('This draft stays with Workshop.', { exact: true })).toBeVisible()
    await closeSotto(launched)

    launched = await launchSotto('success', directory)
    await openVoiceJourneyAgents(launched.page)
    await launched.page.getByRole('button', { name: 'Open Workshop', exact: true }).click()
    await expect(launched.page.getByRole('dialog', { name: 'Workshop', exact: true })).toBeVisible()
    await event(launched.page, workshopQuestion)
    await event(launched.page, docsQuestion)
    await expect(launched.page.locator('.agent-composer textarea')).toHaveValue('Keep the existing layout and controls.')
    expect((await state(launched.page)).draftRequestId).toBe('layout-question')
    await launched.page.getByRole('button', { name: 'Send it', exact: true }).click()
    await expect.poll(async () => (await state(launched.page)).host.threads.find(thread => thread.id === 'workshop')?.requests.length).toBe(0)
    expect((await state(launched.page)).host.threads.find(thread => thread.id === 'docs')?.requests.map(request => request.id)).toEqual(['audience-question'])
    await expect(launched.page.locator('.agent-composer textarea')).toHaveValue('')
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(directory), { recursive: true, force: true })
  }
})
