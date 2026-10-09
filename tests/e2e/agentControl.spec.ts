import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { AgentCommand, AgentCommandReceipt, AgentState } from '../../src/shared/agents'
import type { SottoBridge } from '../../src/shared/contracts'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto,  openThreads, userMessageTexts } from './support/sottoLaunch'

type BrowserGlobals = { sotto: SottoBridge; sottoE2E: SottoE2EBridge }
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
async function event(page: Page, value: Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]): Promise<void> {
  await page.evaluate(async data => { await (globalThis as unknown as BrowserGlobals).sottoE2E.agentEvent?.(data) }, value)
}
async function onboard(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /test microphone/i }).click()
  await expect(page.getByText(/microphone ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /finish setup/i }).click()
  await openThreads(page)
  await page.getByRole('button', { name: 'Connect providers' }).click()
  await openThreads(page)
}

test('creates real folders using configured and explicit locations, rejects conflicts and unavailable models', async () => {
  const launched = await launchSotto()
  try {
    await onboard(launched.page)
    const directory = join(launched.userData, 'projects')
    await command(launched.page, { type: 'configure', patch: { projectsDirectory: directory, defaultModelId: 'claude:test' } })
    let result = await command(launched.page, { type: 'create-project', title: 'Created project' })
    expect(result.error).toBeNull()
    expect((await stat(join(directory, 'Created project'))).isDirectory()).toBe(true)
    const first = result.host.projects.find(p => p.title === 'Created project')!
    result = await command(launched.page, { type: 'create-project', title: 'Created project' })
    expect(result.error).toContain('already exists')
    expect(result.host.projects.filter(p => p.path === first.path)).toHaveLength(1)
    result = await command(launched.page, { type: 'create-project', title: 'Explicit', path: join(launched.userData, 'explicit-project') })
    expect(result.error).toBeNull()
    result = await command(launched.page, { type: 'create-thread', title: 'Requested model', projectId: first.id, modelId: 'unavailable:grok' })
    expect(result.error).toContain('unavailable')
    expect(result.host.threads.some(t => t.title === 'Requested model')).toBe(false)
    result = await command(launched.page, { type: 'create-thread', title: 'Requested model', projectId: first.id, modelId: 'claude:test' })
    expect(result.error).toBeNull()
    expect(result.host.threads.find(t => t.title === 'Requested model')?.modelId).toBe('claude:test')
    expect(result.assignments).toHaveLength(0)
  } finally { await closeSotto(launched) }
})

test('reconciles a lost acknowledgement without resubmitting, and keeps skipped approvals pending', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await onboard(page)
    await command(page, { type: 'select-thread', threadId: 'workshop' })
    await command(page, { type: 'compose', text: 'Execute exactly once.' })
    await event(page, { type: 'uncertain', threadId: 'workshop', text: '' })
    let snapshot: AgentState | AgentCommandReceipt = await command(page, { type: 'send' })
    expect(snapshot.error).toContain('did not confirm')
    expect(snapshot.draft).toBe('Execute exactly once.')
    snapshot = await command(page, { type: 'refresh' })
    expect(snapshot.draft).toBe('')
    expect(await userMessageTexts(page, 'workshop')).toHaveLength(1)
    await command(page, { type: 'send' })
    expect(await userMessageTexts(page, 'workshop')).toHaveLength(1)
    await event(page, { type: 'permission', threadId: 'workshop', text: 'Delete project?' })
    await event(page, { type: 'ready', threadId: 'docs', text: 'Docs completed.' })
    await command(page, { type: 'select-thread', threadId: 'docs' })
    snapshot = await state(page)
    expect(snapshot.activeThreadId).toBe(hostEntityKey(snapshot.hostId, 'docs'))
    expect(snapshot.host.threads[0]?.requests).toHaveLength(1)
    await command(page, { type: 'refresh' })
  } finally { await closeSotto(launched) }
})

test('retains a rejected prompt and allows a deliberate retry after refreshing the host', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await onboard(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await page.getByLabel('Prompt', { exact: true }).fill('Retry this only after I ask.')
    await event(page, { type: 'reject', threadId: 'workshop', text: 'The provider rejected the request before starting a turn.' })
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('The provider rejected the request')
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('Retry this only after I ask.')
    expect(await userMessageTexts(page, 'workshop')).toHaveLength(0)

    await command(page, { type: 'refresh' })
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('')
    const snapshot = await state(page)
    expect(snapshot.error).toBeNull()
    expect(await userMessageTexts(page, 'workshop')).toEqual(['Retry this only after I ask.'])
  } finally { await closeSotto(launched) }
})

test('keeps the explicitly selected thread across host refresh and another ready event', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await onboard(page)
    await event(page, { type: 'question', threadId: 'docs', text: 'Which audience should these docs address?' })
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await command(page, { type: 'refresh' })
    const selected = await state(page)
    expect(selected.activeThreadId).toBe(hostEntityKey(selected.hostId, 'workshop'))
    await expect(page.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible()

    await event(page, { type: 'ready', threadId: 'workshop', text: 'Workshop is ready to review.' })
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Docs', exact: true })).toBeVisible()
    await expect(page.getByText('Which audience should these docs address?', { exact: true })).toBeVisible()

    await command(page, { type: 'refresh' })
    await event(page, { type: 'ready', threadId: 'workshop', text: 'Workshop checks have also completed.' })
    const snapshot = await state(page)
    expect(snapshot.activeThreadId).toBe(hostEntityKey(snapshot.hostId, 'docs'))
    expect(snapshot.host.threads.find(thread => thread.id === hostEntityKey(snapshot.hostId, 'docs'))?.requests).toHaveLength(1)
    await expect(page.getByRole('heading', { name: 'Docs', exact: true })).toBeVisible()
  } finally { await closeSotto(launched) }
})
