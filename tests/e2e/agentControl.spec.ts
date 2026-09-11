import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AgentCommand, AgentState } from '../../src/shared/agents'
import type { SottoBridge } from '../../src/shared/contracts'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto } from './support/sottoLaunch'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'

type BrowserGlobals = { sotto: SottoBridge; sottoE2E: SottoE2EBridge }
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
  await page.getByRole('link', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Connect T3 Code' }).click()
}

test('creates real folders using configured and explicit locations, rejects conflicts and unavailable models', async () => {
  const launched = await launchSotto()
  try {
    await onboard(launched.page)
    const directory = join(launched.userData, 'projects')
    await command(launched.page, { type: 'configure', patch: { projectsDirectory: directory, defaultModelId: 'claude:test' } })
    let result = await command(launched.page, { type: 'create-project', title: 'Created by voice' })
    expect(result.error).toBeNull()
    expect((await stat(join(directory, 'Created by voice'))).isDirectory()).toBe(true)
    const first = result.host.projects.find(p => p.title === 'Created by voice')!
    result = await command(launched.page, { type: 'create-project', title: 'Created by voice' })
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
    expect(result.assignments.some(a => a.threadId === result.activeThreadId)).toBe(true)
  } finally { await closeSotto(launched) }
})

test('limits automatic fixes, stops repeated failures, and never answers permissions or unassigned threads', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await onboard(page)
    await command(page, { type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'external-fixture', followupLimit: 2 } })
    await command(page, { type: 'assign', threadId: 'workshop', instruction: 'Fix the existing failing tests.' })
    await event(page, { type: 'failure', threadId: 'docs', text: 'fixable unassigned issue' })
    await event(page, { type: 'failure', threadId: 'workshop', text: 'fixable test one' })
    await expect.poll(async () => (await state(page)).assignments[0]?.followups).toBe(1)
    await expect.poll(async () => (await state(page)).host.threads[0]?.messages.filter(m => m.role === 'user').length).toBe(1)
    await event(page, { type: 'failure', threadId: 'workshop', text: 'fixable test two' })
    await expect.poll(async () => (await state(page)).assignments[0]?.followups).toBe(2)
    await expect.poll(async () => (await state(page)).host.threads[0]?.messages.filter(m => m.role === 'user').length).toBe(2)
    await event(page, { type: 'failure', threadId: 'workshop', text: 'fixable test three' })
    await expect.poll(async () => (await state(page)).assignments[0]?.paused).toBe(true)
    expect((await state(page)).host.threads[1]?.messages.filter(m => m.role === 'user')).toHaveLength(0)
    await command(page, { type: 'resume', threadId: 'workshop' })
    await expect.poll(async () => (await state(page)).assignments[0]?.followups).toBe(1)
    await expect.poll(async () => (await state(page)).host.threads[0]?.messages.filter(m => m.role === 'user').length).toBe(3)
    await event(page, { type: 'failure', threadId: 'workshop', text: 'fixable test three' })
    await expect.poll(async () => (await state(page)).queue.some(q => q.text.includes('repeating a failure'))).toBe(true)
    await event(page, { type: 'permission', threadId: 'workshop', text: 'Publish this project?' })
    let snapshot = await state(page)
    expect(snapshot.host.threads[0]?.requests).toHaveLength(1)
    expect(snapshot.queue.some(q => q.kind === 'permission')).toBe(true)
    const request = snapshot.host.threads[0]!.requests[0]!
    snapshot = await command(page, { type: 'answer', threadId: 'workshop', requestId: request.id, answer: 'yes' })
    expect(snapshot.error).toContain('Allow or Deny')
    snapshot = await command(page, { type: 'answer', threadId: 'workshop', requestId: request.id, answer: 'Denied', approved: false })
    expect(snapshot.host.threads[0]?.requests).toHaveLength(0)
  } finally { await closeSotto(launched) }
})

test('revokes an automatic reply while reasoning is in flight and retains manual ownership and drafts after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-e2e-'))
  let launched = await launchSotto('success', directory)
  try {
    await onboard(launched.page)
    await command(launched.page, { type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'external-fixture' } })
    await command(launched.page, { type: 'assign', threadId: 'workshop', instruction: 'Fix the test.' })
    await event(launched.page, { type: 'failure', threadId: 'workshop', text: 'fixable await external decision' })
    await event(launched.page, { type: 'manual', threadId: 'workshop', text: 'I am handling this now.' })
    await event(launched.page, { type: 'reasoner-release', threadId: 'workshop', text: '' })
    await expect.poll(async () => (await state(launched.page)).assignments[0]?.mode).toBe('manual')
    expect((await state(launched.page)).host.threads[0]?.messages.filter(m => m.role === 'user')).toHaveLength(1)
    await command(launched.page, { type: 'compose', text: 'A draft that must survive a restart.' })
    await closeSotto(launched)
    launched = await launchSotto('success', directory)
    await launched.page.getByRole('link', { name: 'Agents', exact: true }).click()
    await expect(launched.page.getByLabel('Prompt')).toHaveValue('A draft that must survive a restart.')
    const snapshot = await state(launched.page)
    expect(snapshot.assignments[0]?.mode).toBe('manual')
    expect(snapshot.draftThreadId).toBe('workshop')
    expect(JSON.parse(await readFile(join(directory, 'agents.json'), 'utf8')).draft).toBe(snapshot.draft)
  } finally { await closeSotto(launched); await rm(requireOwnedE2EProfile(directory), { recursive: true, force: true }) }
})

test('reconciles a lost acknowledgement without resubmitting, and keeps skipped approvals pending', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await onboard(page)
    await command(page, { type: 'assign', threadId: 'workshop' })
    await command(page, { type: 'assign', threadId: 'docs' })
    await command(page, { type: 'select-thread', threadId: 'workshop' })
    await command(page, { type: 'compose', text: 'Execute exactly once.' })
    await event(page, { type: 'uncertain', threadId: 'workshop', text: '' })
    let snapshot = await command(page, { type: 'send' })
    expect(snapshot.error).toContain('did not confirm')
    expect(snapshot.draft).toBe('Execute exactly once.')
    snapshot = await command(page, { type: 'refresh' })
    expect(snapshot.draft).toBe('')
    expect(snapshot.host.threads[0]?.messages).toHaveLength(1)
    await command(page, { type: 'send' })
    expect((await state(page)).host.threads[0]?.messages).toHaveLength(1)
    await event(page, { type: 'permission', threadId: 'workshop', text: 'Delete project?' })
    await event(page, { type: 'ready', threadId: 'docs', text: 'Docs completed.' })
    await command(page, { type: 'later' })
    snapshot = await state(page)
    expect(snapshot.activeThreadId).toBe('docs')
    expect(snapshot.host.threads[0]?.requests).toHaveLength(1)
    expect(snapshot.queue.some(q => q.threadId === 'workshop' && q.kind === 'permission' && q.deferred)).toBe(true)
    await command(page, { type: 'refresh' })
    expect((await state(page)).queue.filter(q => q.kind === 'permission')).toHaveLength(1)
  } finally { await closeSotto(launched) }
})

test('retains a rejected prompt and allows a deliberate retry after refreshing the host', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await onboard(page)
    await command(page, { type: 'assign', threadId: 'workshop' })
    await page.getByLabel('Prompt', { exact: true }).fill('Retry this only after I ask.')
    await event(page, { type: 'reject', threadId: 'workshop', text: 'T3 rejected the request before starting a turn.' })
    await page.getByRole('button', { name: 'Send it', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('T3 rejected the request')
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('Retry this only after I ask.')
    expect((await state(page)).host.threads.find(thread => thread.id === 'workshop')?.messages).toHaveLength(0)

    await page.getByRole('button', { name: 'Refresh T3 Code', exact: true }).click()
    await page.getByRole('button', { name: 'Send it', exact: true }).click()
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('')
    const snapshot = await state(page)
    expect(snapshot.error).toBeNull()
    expect(snapshot.host.threads.find(thread => thread.id === 'workshop')?.messages.map(message => message.text)).toEqual(['Retry this only after I ask.'])
  } finally { await closeSotto(launched) }
})

test('keeps the explicitly selected queued thread across host refresh and another ready event', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await onboard(page)
    await command(page, { type: 'assign', threadId: 'workshop' })
    await command(page, { type: 'assign', threadId: 'docs' })
    await event(page, { type: 'question', threadId: 'docs', text: 'Which audience should these docs address?' })
    await command(page, { type: 'utterance', text: 'Select Workshop' })
    await command(page, { type: 'refresh' })
    expect((await state(page)).activeThreadId).toBe('workshop')
    await expect(page.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible()

    await event(page, { type: 'ready', threadId: 'workshop', text: 'Workshop is ready to review.' })
    await command(page, { type: 'utterance', text: 'Select Docs' })
    await expect(page.getByRole('heading', { name: 'Docs', exact: true })).toBeVisible()
    await expect(page.getByText('Which audience should these docs address?', { exact: true })).toBeVisible()
    const briefing = (await state(page)).speech.id

    await command(page, { type: 'refresh' })
    await event(page, { type: 'ready', threadId: 'workshop', text: 'Workshop checks have also completed.' })
    const snapshot = await state(page)
    expect(snapshot.activeThreadId).toBe('docs')
    expect(snapshot.speech.id).toBe(briefing)
    expect(snapshot.host.threads.find(thread => thread.id === 'docs')?.requests).toHaveLength(1)
    await expect(page.getByRole('heading', { name: 'Docs', exact: true })).toBeVisible()
  } finally { await closeSotto(launched) }
})

test('uses a folder clarification with the original spoken project request', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await onboard(page)
    await command(page, { type: 'utterance', text: 'Create a project called Clarified Project.' })
    await expect(page.getByRole('status')).toContainText('Which folder should contain Clarified Project?')
    expect((await state(page)).host.projects).toHaveLength(1)

    const path = join(launched.userData, 'chosen-after-clarification')
    const snapshot = await command(page, { type: 'utterance', text: path })
    expect(snapshot.error).toBeNull()
    expect(snapshot.host.projects.filter(project => project.title === 'Clarified Project').map(project => project.path)).toEqual([path])
    expect((await stat(path)).isDirectory()).toBe(true)
    expect(snapshot.pendingRequest).toBe('')
    await expect(page.getByRole('button', { name: 'Clarified Project', exact: true })).toBeVisible()
  } finally { await closeSotto(launched) }
})

test('redacts processed assignment context when local history is disabled while preserving the unsent draft', async () => {
  const launched = await launchSotto()
  const { page } = launched
  const assignmentText = 'Private assignment marker 67192.'
  const failureText = 'fixable private failure marker 67314'
  const questionText = 'Private permission marker 67982?'
  const requestText = 'Private clarification marker 67772'
  const draft = 'Unsent draft explicitly retained for recovery.'
  try {
    await onboard(page)
    await command(page, { type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'external-fixture' } })
    await command(page, { type: 'assign', threadId: 'workshop', instruction: assignmentText })
    await event(page, { type: 'failure', threadId: 'workshop', text: failureText })
    await expect.poll(async () => (await state(page)).host.threads.find(thread => thread.id === 'workshop')?.messages.filter(message => message.role === 'user').length).toBe(1)
    await command(page, { type: 'pause', threadId: 'workshop' })
    await event(page, { type: 'permission', threadId: 'workshop', text: questionText })
    await command(page, { type: 'assign', threadId: 'docs' })
    await command(page, { type: 'select-thread', threadId: 'docs' })
    await command(page, { type: 'utterance', text: requestText })
    await page.getByLabel('Prompt', { exact: true }).fill(draft)
    await page.evaluate(async () => { await (globalThis as unknown as BrowserGlobals).sotto.updateSettings({ historyEnabled: false }) })

    await expect.poll(async () => {
      const saved = await readFile(join(launched.userData, 'agents.json'), 'utf8')
      return [assignmentText, failureText, questionText, requestText].some(text => saved.includes(text))
    }).toBe(false)
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(draft)
    const saved = JSON.parse(await readFile(join(launched.userData, 'agents.json'), 'utf8')) as { draft: string }
    expect(saved.draft).toBe(draft)
    expect((await state(page)).host.threads.find(thread => thread.id === 'workshop')?.requests).toHaveLength(1)
  } finally { await closeSotto(launched) }
})

test('expires dormant context after seven days without forgetting manual ownership or follow-up counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-e2e-'))
  let launched = await launchSotto('success', directory)
  const oldInstruction = 'Seven-day-old private assignment.'
  const recentInstruction = 'Recent assignment must remain recoverable.'
  try {
    await onboard(launched.page)
    await command(launched.page, { type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'external-fixture' } })
    await command(launched.page, { type: 'assign', threadId: 'workshop', instruction: oldInstruction })
    await event(launched.page, { type: 'failure', threadId: 'workshop', text: 'fixable dormant failure' })
    await expect.poll(async () => (await state(launched.page)).host.threads.find(thread => thread.id === 'workshop')?.messages.filter(message => message.role === 'user').length).toBe(1)
    await event(launched.page, { type: 'manual', threadId: 'workshop', text: 'I am taking control.' })
    await command(launched.page, { type: 'assign', threadId: 'docs', instruction: recentInstruction })
    await command(launched.page, { type: 'compose', text: 'A recoverable unsent draft.' })
    await command(launched.page, { type: 'disconnect' })
    await closeSotto(launched)

    const path = join(requireOwnedE2EProfile(directory), 'agents.json')
    const saved = JSON.parse(await readFile(path, 'utf8')) as { assignments: Array<{ threadId: string; contextUpdatedAt: number }> }
    saved.assignments.find(assignment => assignment.threadId === 'workshop')!.contextUpdatedAt = Date.now() - 8 * 86_400_000
    await writeFile(path, JSON.stringify(saved), 'utf8')

    launched = await launchSotto('success', directory)
    await launched.page.getByRole('link', { name: 'Agents', exact: true }).click()
    const snapshot = await state(launched.page)
    const dormant = snapshot.assignments.find(assignment => assignment.threadId === 'workshop')!
    expect(dormant.instruction).toBe('')
    expect(dormant.paused).toBe(true)
    expect(dormant.mode).toBe('manual')
    expect(dormant.followups).toBe(1)
    expect(snapshot.assignments.find(assignment => assignment.threadId === 'docs')?.instruction).toBe(recentInstruction)
    await expect(launched.page.getByLabel('Prompt', { exact: true })).toHaveValue('A recoverable unsent draft.')
    await expect.poll(async () => (await readFile(path, 'utf8')).includes(oldInstruction)).toBe(false)
  } finally { await closeSotto(launched); await rm(requireOwnedE2EProfile(directory), { recursive: true, force: true }) }
})
