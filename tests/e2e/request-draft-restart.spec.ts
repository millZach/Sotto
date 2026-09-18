import { mkdtemp, mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { AgentRequest } from '../../src/shared/agents'
import type { RequestDraft } from '../../src/shared/requestDrafts'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

const form: AgentRequest = { id: 'durable-form', kind: 'question', text: 'Native restart fixture', options: [], questions: [
  { id: 'place', question: 'Where should we go?', multiSelect: false, allowFreeText: true, options: [{ id: 'coast', label: 'Coast' }, { id: 'hills', label: 'Hills' }] },
  { id: 'checks', question: 'Which checks?', multiSelect: true, allowFreeText: false, options: [{ id: 'unit', label: 'Unit checks' }, { id: 'types', label: 'Type checks' }] },
  { id: 'notes', question: 'Travel notes', multiSelect: false, allowFreeText: true, options: [] },
] }
const second: AgentRequest = { ...form, id: 'separate-form', questions: [{ id: 'place', question: 'A separate request', multiSelect: false, allowFreeText: false,
  options: [{ id: 'coast', label: 'Separate coast' }, { id: 'hills', label: 'Separate hills' }] }] }
type Owner = 'thread' | 'personal'
declare global { var draftAnswerCalls: number; var holdDraftAnswer: boolean }
const drafts = async (profile: string): Promise<RequestDraft[]> => JSON.parse(await readFile(join(profile, 'request-drafts.json'), 'utf8')).drafts
const card = (page: Page) => page.locator('.agent-request').filter({ has: page.getByRole('group', { name: 'Where should we go?' }) })
async function record(launched: LaunchedSotto, owner: Owner, hold = false): Promise<void> {
  await launched.app.evaluate(({ ipcMain }, { channel, hold }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, payload: { type?: string }) => unknown> })._invokeHandlers
    const original = handlers.get(channel)!
    globalThis.draftAnswerCalls = 0; globalThis.holdDraftAnswer = hold
    handlers.set(channel, async (event, payload) => {
      if (payload.type === 'answer') {
        globalThis.draftAnswerCalls++
        if (globalThis.holdDraftAnswer) await new Promise(() => {})
      }
      return original(event, payload)
    })
  }, { channel: owner === 'thread' ? 'sotto:agents:command' : 'personal-chat:command', hold })
}
async function emit(page: Page, owner: Owner, id: string): Promise<void> {
  for (const request of [form, second]) await page.evaluate(async ({ owner, id, request }) => {
    await window.sottoE2E!.agentEvent!({ ...(owner === 'personal' ? { scope: 'personal' as const } : {}), type: 'question', threadId: id, text: request.text, request })
  }, { owner, id, request })
}
async function open(page: Page, owner: Owner): Promise<void> {
  if (owner === 'personal') await openPage(page, 'Chats')
  else await openThreads(page)
  if (owner === 'thread') await page.getByRole('button', { name: 'Workshop', exact: true }).click()
}

for (const owner of ['thread', 'personal'] as const) test(`${owner} structured text and selections survive a full app restart with history disabled and independent composer/request drafts`, async () => {
  test.setTimeout(60_000)
  const profile = await mkdtemp(join(tmpdir(), `sotto-e2e-request-draft-${owner}-`))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: false }))
  let launched = await launchSotto('success', profile)
  try {
    let page = launched.page
    const id = await page.evaluate(async owner => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: 'low' } })
      if (owner === 'thread') {
        await window.sotto!.agents!.command({ type: 'connect' })
        await window.sotto!.agents!.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: crypto.randomUUID(), text: 'Independent threaded composer' })
        return 'workshop'
      }
      const api = window.sotto!.personalChats!
      await api.connect()
      const id = (await api.create()).selectedChatId!
      await api.saveDraft({ chatId: id, revision: 1, text: 'Create fixture conversation', skills: [] })
      await api.send({ chatId: id, revision: 1 })
      return id
    }, owner)
    if (owner === 'personal') {
      await expect.poll(() => page.evaluate(async id => (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)?.submissions[0]?.status, id)).toBe('accepted')
      await page.evaluate(async id => window.sotto!.personalChats!.saveDraft({ chatId: id, revision: 3, text: 'Independent personal composer', skills: [] }), id)
    }
    await record(launched, owner)
    await emit(page, owner, id); await open(page, owner)
    const first = card(page)
    await first.getByRole('radio', { name: 'Other', exact: true }).click()
    await first.getByRole('textbox', { name: 'Other answer to: Where should we go?' }).fill('A quiet shore')
    await first.getByRole('checkbox', { name: 'Unit checks' }).click()
    await first.getByRole('checkbox', { name: 'Type checks' }).click()
    await first.getByRole('textbox', { name: 'Travel notes' }).fill('Unsent notes survive restart')
    await page.getByRole('radio', { name: 'Separate hills' }).click()
    await expect.poll(async () => (await drafts(profile)).filter(draft => draft.target.ownerId === id).length).toBe(2)
    await expect(first).toHaveAttribute('data-save', 'saved')
    const before = await drafts(profile)
    expect(await launched.app.evaluate(() => globalThis.draftAnswerCalls)).toBe(0)
    await closeSotto(launched)

    launched = await launchSotto('success', profile); page = launched.page
    await record(launched, owner)
    await open(page, owner)
    // Startup intentionally supplies no native request. The service must keep the original file intact.
    expect(await drafts(profile)).toEqual(before)
    if (owner === 'personal') await page.evaluate(() => window.sotto!.personalChats!.connect())
    else {
      await page.evaluate(() => window.sotto!.agents!.command({ type: 'connect' }))
      expect(await drafts(profile)).toEqual(before)
      // Thread fixture effects are in memory; simulate the provider returning the exact requests on reconnect.
      await emit(page, owner, id)
    }
    await expect(card(page).getByRole('textbox', { name: 'Travel notes' })).toHaveValue('Unsent notes survive restart')
    await expect(card(page).getByRole('radio', { name: 'Other', exact: true })).toBeChecked()
    await expect(card(page).getByRole('textbox', { name: 'Other answer to: Where should we go?' })).toHaveValue('A quiet shore')
    await expect(card(page).getByRole('checkbox', { name: 'Unit checks' })).toBeChecked()
    await expect(card(page).getByRole('checkbox', { name: 'Type checks' })).toBeChecked()
    await expect(page.getByRole('radio', { name: 'Separate hills' })).toBeChecked()
    expect(await launched.app.evaluate(() => globalThis.draftAnswerCalls)).toBe(0)
    const composer = await page.evaluate(async ({ owner, id }) => owner === 'personal'
      ? (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)!.draft.text
      : (await window.sotto!.agents!.get()).threadDrafts!.find(draft => draft.threadId === id)!.text, { owner, id })
    expect(composer).toBe(`Independent ${owner === 'thread' ? 'threaded' : 'personal'} composer`)
    await mkdir('artifacts/request-drafts', { recursive: true })
    await card(page).getByRole('textbox', { name: 'Travel notes' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `artifacts/request-drafts/${owner}-restarted.png` })
    // Only this explicit click delivers. Accepted content is removed without touching the other request or composer.
    await card(page).getByRole('button', { name: 'Send answers' }).click()
    await expect(card(page)).toHaveCount(0)
    await expect.poll(async () => (await drafts(profile)).map(draft => draft.target.requestId)).toEqual(['separate-form'])
    expect(await launched.app.evaluate(() => globalThis.draftAnswerCalls)).toBe(1)
  } finally { await closeSotto(launched) }
})

for (const owner of ['thread', 'personal'] as const) test(`${owner} full-process restart restores an interrupted answer as held and never replays it`, async () => {
  test.setTimeout(60_000)
  const profile = await mkdtemp(join(tmpdir(), `sotto-e2e-held-draft-${owner}-`))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: false }))
  let launched = await launchSotto('success', profile)
  try {
    let page = launched.page
    const id = await page.evaluate(async owner => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: 'low' } })
      if (owner === 'thread') { await window.sotto!.agents!.command({ type: 'connect' }); return 'workshop' }
      const api = window.sotto!.personalChats!; await api.connect()
      const id = (await api.create()).selectedChatId!
      await api.saveDraft({ chatId: id, revision: 1, text: 'Fixture only', skills: [] }); await api.send({ chatId: id, revision: 1 }); return id
    }, owner)
    if (owner === 'personal') await expect.poll(() => page.evaluate(async id => (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)?.submissions[0]?.status, id)).toBe('accepted')
    await emit(page, owner, id); await open(page, owner)
    await card(page).getByRole('radio', { name: 'Coast', exact: true }).click()
    await card(page).getByRole('checkbox', { name: 'Unit checks' }).click()
    await card(page).getByRole('textbox', { name: 'Travel notes' }).fill('Held through restart')
    await record(launched, owner, true)
    await card(page).getByRole('button', { name: 'Send answers' }).click()
    await expect.poll(() => launched.app.evaluate(() => globalThis.draftAnswerCalls)).toBe(1)
    expect((await drafts(profile))[0]?.held).toBe(true)
    await closeSotto(launched)
    launched = await launchSotto('success', profile); page = launched.page; await record(launched, owner)
    if (owner === 'personal') await page.evaluate(() => window.sotto!.personalChats!.connect())
    else { await page.evaluate(() => window.sotto!.agents!.command({ type: 'connect' })); await emit(page, owner, id) }
    await open(page, owner)
    await expect(card(page)).toHaveAttribute('data-phase', 'unconfirmed')
    await expect(card(page).getByRole('button', { name: 'Send answers' })).toBeDisabled()
    await expect(card(page).getByRole('textbox', { name: 'Travel notes' })).toHaveValue('Held through restart')
    expect(await launched.app.evaluate(() => globalThis.draftAnswerCalls)).toBe(0)
    await mkdir('artifacts/request-drafts', { recursive: true })
    await card(page).getByRole('button', { name: 'Check again' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `artifacts/request-drafts/${owner}-held-restarted.png` })
    await card(page).getByRole('button', { name: 'Check again' }).click()
    await expect(card(page)).toHaveAttribute('data-phase', 'idle')
    expect(await launched.app.evaluate(() => globalThis.draftAnswerCalls)).toBe(0)
  } finally { await closeSotto(launched) }
})

test('a real atomic save failure retains the visible answer, blocks sending and recovers through Save again', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-draft-save-failure-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: false }))
  const launched = await launchSotto('success', profile)
  try {
    const { page } = launched
    await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await emit(page, 'thread', 'workshop'); await open(page, 'thread'); await record(launched, 'thread')
    // An empty directory at the exact owned fixture file path forces the real atomic rename to fail.
    await mkdir(join(profile, 'request-drafts.json'))
    await card(page).getByRole('radio', { name: 'Coast', exact: true }).click()
    await card(page).getByRole('checkbox', { name: 'Unit checks' }).click()
    await card(page).getByRole('textbox', { name: 'Travel notes' }).fill('Recover this answer after the disk failure')
    await expect(card(page)).toHaveAttribute('data-save', 'unsaved')
    await expect(card(page).getByRole('alert')).toContainText('Could not save this answer draft')
    await expect(card(page).getByRole('button', { name: 'Send answers' })).toBeDisabled()
    await expect(card(page).getByRole('textbox', { name: 'Travel notes' })).toHaveValue('Recover this answer after the disk failure')
    await mkdir('artifacts/request-drafts', { recursive: true })
    await card(page).getByRole('button', { name: 'Save again' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'artifacts/request-drafts/save-failure.png' })
    await rmdir(join(profile, 'request-drafts.json'))
    await card(page).getByRole('button', { name: 'Save again' }).click()
    await expect(card(page)).toHaveAttribute('data-save', 'saved')
    await expect(card(page).getByRole('button', { name: 'Send answers' })).toBeEnabled()
    expect((await drafts(profile))[0]?.selections.notes?.text).toBe('Recover this answer after the disk failure')
    expect(await launched.app.evaluate(() => globalThis.draftAnswerCalls)).toBe(0)
  } finally { await closeSotto(launched) }
})

test('invalid request draft storage remains unchanged and is honestly shown as unsaved in the complete app', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-draft-corrupt-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: false }))
  const invalid = '{ invalid storage containing an unsent private answer'
  await writeFile(join(profile, 'request-drafts.json'), invalid)
  const launched = await launchSotto('success', profile)
  try {
    const { page } = launched
    await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await emit(page, 'thread', 'workshop'); await open(page, 'thread'); await record(launched, 'thread')
    await expect(card(page).getByRole('alert')).toContainText('original request-drafts.json is unchanged')
    await card(page).getByRole('textbox', { name: 'Travel notes' }).fill('Preserve newer local text too')
    await expect(card(page)).toHaveAttribute('data-save', 'unsaved')
    await expect(card(page).getByRole('button', { name: 'Send answers' })).toBeDisabled()
    expect(await readFile(join(profile, 'request-drafts.json'), 'utf8')).toBe(invalid)
    expect((await readdir(profile)).filter(name => name.startsWith('request-drafts.json'))).toEqual(['request-drafts.json'])
    expect(await launched.app.evaluate(() => globalThis.draftAnswerCalls)).toBe(0)
    await mkdir('artifacts/request-drafts', { recursive: true })
    await card(page).getByRole('alert').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'artifacts/request-drafts/invalid-storage.png' })
  } finally { await closeSotto(launched) }
})
