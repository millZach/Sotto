import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { AgentCommand, AgentCommandReceipt, AgentState } from '../../src/shared/agents'
import type { SottoBridge } from '../../src/shared/contracts'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openThreads, userMessageTexts } from './support/sottoLaunch'

type BrowserGlobals = { sotto: SottoBridge; sottoE2E: SottoE2EBridge }
type HostEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0] & {
  requestId?: string
  status?: 'idle' | 'running' | 'error'
}

async function command(page: Page, value: AgentCommand): Promise<AgentCommandReceipt> {
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

function thread(snapshot: AgentState | AgentCommandReceipt, id: string) {
  return snapshot.host.threads.find(item => item.id === hostEntityKey(snapshot.hostId, id))
}

async function event(page: Page, value: HostEvent): Promise<void> {
  await page.evaluate(async data => {
    const bridge = (globalThis as unknown as BrowserGlobals).sottoE2E
    if (!bridge.agentEvent) throw new Error('External host fixture unavailable')
    await bridge.agentEvent(data)
  }, value)
}

async function onboard(page: Page): Promise<void> {
  await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
  await page.reload()
  await openThreads(page)
  await command(page, { type: 'connect' })
  await page.getByRole('button', { name: 'Workshop', exact: true }).click()
}

const workshopQuestion: HostEvent = {
  type: 'question', threadId: 'workshop', requestId: 'layout-question',
  text: 'Which layout should the project use?', status: 'running',
}
const docsQuestion: HostEvent = {
  type: 'question', threadId: 'docs', requestId: 'audience-question',
  text: 'Who should the documentation address?', status: 'running',
}

test('keeps an answer on its own request through thread navigation and restart until explicit submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-e2e-'))
  let launched = await launchSotto('success', directory)
  try {
    await onboard(launched.page)
    await event(launched.page, workshopQuestion)
    await event(launched.page, docsQuestion)
    await launched.page.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Keep the existing layout and controls.')
    await expect.poll(async () => (await state(launched.page)).threadDrafts?.find(draft => draft.requestId === 'layout-question')?.text).toBe('Keep the existing layout and controls.')
    await launched.page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(launched.page.getByRole('textbox', { name: 'Your answer', exact: true })).toHaveValue('')
    expect(thread(await state(launched.page), 'workshop')?.requests).toHaveLength(1)
    await closeSotto(launched)

    launched = await launchSotto('success', directory)
    await openThreads(launched.page)
    await command(launched.page, { type: 'connect' })
    await event(launched.page, workshopQuestion)
    await event(launched.page, docsQuestion)
    await launched.page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expect(launched.page.getByRole('textbox', { name: 'Your answer', exact: true })).toHaveValue('Keep the existing layout and controls.')
    await launched.page.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect.poll(async () => thread(await state(launched.page), 'workshop')?.requests.length).toBe(0)
    expect(thread(await state(launched.page), 'docs')?.requests.map(request => request.id)).toEqual(['audience-question'])
    expect(await userMessageTexts(launched.page, 'workshop')).toHaveLength(0)
    await expect(launched.page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('')
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(directory), { recursive: true, force: true })
  }
})

test('keeps permission decisions pending until an explicit Deny', async () => {
  const launched = await launchSotto()
  try {
    await onboard(launched.page)
    await event(launched.page, { type: 'permission', threadId: 'workshop', requestId: 'publish-permission', text: 'Publish this project?', status: 'running' })
    await expect(launched.page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    expect(thread(await state(launched.page), 'workshop')?.requests).toHaveLength(1)
    await launched.page.getByRole('button', { name: 'Deny', exact: true }).click()
    await expect.poll(async () => thread(await state(launched.page), 'workshop')?.requests.length).toBe(0)
    expect(await userMessageTexts(launched.page, 'workshop')).toHaveLength(0)
  } finally { await closeSotto(launched) }
})
