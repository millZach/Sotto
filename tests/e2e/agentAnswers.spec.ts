import { expectPromptText, fillPrompt, promptField } from './support/prompt'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { agentCommand as command, agentState as state } from './support/agentAccess'
import { expect, test, type Page } from '@playwright/test'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { AgentCommandReceipt, AgentState } from '../../src/shared/agents'
import type { SottoBridge } from '../../src/shared/contracts'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto, openThreads, userMessageTexts } from './support/sottoLaunch'

type BrowserGlobals = { sotto: SottoBridge; sottoE2E: SottoE2EBridge }
type HostEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0] & {
  requestId?: string
  status?: 'idle' | 'running' | 'error'
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
  const directory = (await ownedE2EProfile({ prefix: 'sotto-e2e-' })).directory
  let launched = await launchSotto('success', directory)
  try {
    await onboard(launched.page)
    await event(launched.page, workshopQuestion)
    await event(launched.page, docsQuestion)
    await fillPrompt(promptField(launched.page, 'Your answer'), 'Keep the existing layout and controls.')
    await expect.poll(async () => (await state(launched.page)).threadDrafts?.find(draft => draft.requestId === 'layout-question')?.text).toBe('Keep the existing layout and controls.')
    await launched.page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expectPromptText(promptField(launched.page, 'Your answer'), '')
    expect(thread(await state(launched.page), 'workshop')?.requests).toHaveLength(1)
    await closeSotto(launched)

    launched = await launchSotto('success', directory)
    await openThreads(launched.page)
    await command(launched.page, { type: 'connect' })
    await event(launched.page, workshopQuestion)
    await event(launched.page, docsQuestion)
    await launched.page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await expectPromptText(promptField(launched.page, 'Your answer'), 'Keep the existing layout and controls.')
    await launched.page.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect.poll(async () => thread(await state(launched.page), 'workshop')?.requests.length).toBe(0)
    expect(thread(await state(launched.page), 'docs')?.requests.map(request => request.id)).toEqual(['audience-question'])
    expect(await userMessageTexts(launched.page, 'workshop')).toHaveLength(0)
    await expectPromptText(promptField(launched.page), '')
  } finally {
    await closeSotto(launched)
    await removeOwnedE2EProfile(directory)
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
