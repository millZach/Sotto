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
declare global { var draftAnswerCalls: number; var draftAnswerPayloads: unknown[]; var holdDraftAnswer: boolean }
const drafts = async (profile: string): Promise<RequestDraft[]> => JSON.parse(await readFile(join(profile, 'request-drafts.json'), 'utf8')).drafts
const card = (page: Page) => page.locator('.agent-request').filter({ has: page.getByRole('group', { name: 'Where should we go?' }) })
async function record(launched: LaunchedSotto, owner: Owner, hold = false): Promise<void> {
  await launched.app.evaluate(({ ipcMain }, { channel, hold }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, payload: { type?: string }) => unknown> })._invokeHandlers
    const original = handlers.get(channel)!
    globalThis.draftAnswerCalls = 0; globalThis.draftAnswerPayloads = []; globalThis.holdDraftAnswer = hold
    handlers.set(channel, async (event, payload) => {
      if (payload.type === 'answer') {
        globalThis.draftAnswerCalls++
        globalThis.draftAnswerPayloads.push(structuredClone(payload))
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
    await first.getByRole('radio', { name: 'Write my own answer', exact: true }).click()
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
    await expect(card(page).getByRole('radio', { name: 'Write my own answer', exact: true })).toBeChecked()
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


test('legacy option choices survive a full restart, stay bound to the original question and send only its exact native ID', async () => {
  test.setTimeout(90_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-legacy-request-draft-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: false }))
  const original: AgentRequest = { id: 'legacy-original', kind: 'question', text: 'Which route should we take?',
    options: [{ id: 'native:coast (Recommended)', label: 'Coast (Recommended)' }, { id: 'native:hills', label: 'Hills' }] }
  const reused: AgentRequest = { ...original, id: 'legacy-reused', text: 'Which route should the docs describe?' }
  const changed: AgentRequest = { ...reused, text: 'Which route should the release describe?' }
  const showRequest = (page: Page, request: AgentRequest) => page.evaluate(async request => {
    await window.sottoE2E!.agentEvent!({ type: 'question', threadId: 'workshop', text: request.text, request })
  }, request)
  const live = (page: Page, request: AgentRequest) => page.locator('.thread-questions .agent-request').filter({
    has: page.getByText(request.text, { exact: true }),
  })
  let launched = await launchSotto('success', profile)
  try {
    let page = launched.page
    await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: crypto.randomUUID(), text: 'Independent legacy follow-up draft' })
    })
    await record(launched, 'thread')
    await showRequest(page, original)
    await showRequest(page, reused)
    await open(page, 'thread')
    await live(page, original).getByRole('radio', { name: /Coast/u }).click()
    await live(page, reused).getByRole('radio', { name: 'Hills', exact: true }).click()
    await expect(live(page, original)).toHaveAttribute('data-save', 'saved')
    await expect(live(page, reused)).toHaveAttribute('data-save', 'saved')
    await expect.poll(async () => (await drafts(profile)).map(draft => draft.target.requestId).sort()).toEqual(['legacy-original', 'legacy-reused'])
    const before = await drafts(profile)
    expect(await launched.app.evaluate(() => globalThis.draftAnswerPayloads)).toEqual([])
    await closeSotto(launched)

    launched = await launchSotto('success', profile)
    page = launched.page
    await record(launched, 'thread')
    expect(await drafts(profile)).toEqual(before)
    await page.evaluate(() => window.sotto!.agents!.command({ type: 'connect' }))
    await showRequest(page, original)
    // Reusing both request and option IDs does not authorize a saved choice for different question text.
    await showRequest(page, changed)
    await open(page, 'thread')
    await expect(live(page, original).getByRole('radio', { name: /Coast/u })).toBeChecked()
    await expect(live(page, original).getByRole('button', { name: 'Send answer', exact: true })).toBeEnabled()
    await expect(live(page, changed).getByRole('radio', { name: 'Hills', exact: true })).toBeEnabled()
    await expect(live(page, changed).getByRole('radio', { name: 'Hills', exact: true })).not.toBeChecked()
    await expect(live(page, changed).getByRole('radio', { name: /Coast/u })).not.toBeChecked()
    await expect(live(page, changed).getByRole('button', { name: 'Send answer', exact: true })).toBeDisabled()
    const recovery = page.getByRole('region', { name: 'Saved answer', exact: true })
    await expect(recovery).toHaveCount(1)
    await expect(recovery).toContainText(reused.text)
    await expect(recovery).toContainText('Hills')
    await expect(recovery).toContainText('changed this question. This answer was not sent.')
    expect(await launched.app.evaluate(() => globalThis.draftAnswerPayloads)).toEqual([])
    await live(page, original).getByRole('radio', { name: /Coast/u }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'artifacts/question-choices/legacy-choice-restarted.png', animations: 'disabled' })
    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
      }, [width, height] as const)
      await expect.poll(() => page.evaluate(([width, height]) => innerWidth === width && Math.abs(innerHeight - height) <= 2, [width, height] as const)).toBe(true)
      expect(await page.locator('.thread-questions').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      // Hidden native legends retain their 1px accessible-only geometry instead of inheriting visible question widths.
      const legends = await live(page, original).locator('legend').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width))
      expect(legends).toEqual([1])
      await page.screenshot({ path: `artifacts/question-choices/legacy-choice-restarted-${width}.png`, animations: 'disabled' })
    }

    await live(page, original).getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect(live(page, original)).toHaveCount(0)
    expect(await launched.app.evaluate(() => globalThis.draftAnswerPayloads)).toEqual([
      { type: 'answer', threadId: 'workshop', requestId: original.id, answer: original.options[0]!.id },
    ])
    await expect.poll(async () => (await drafts(profile)).map(draft => draft.target.requestId)).toEqual(['legacy-reused'])
    // Successful delivery leaves no orphaned saved answer; the unrelated changed question remains recoverable.
    await expect(recovery).toHaveCount(1)
    await expect(recovery).not.toContainText(original.text)
    await expect(recovery).toContainText(reused.text)
    const composer = await page.evaluate(async () => (await window.sotto!.agents!.get()).threadDrafts!.find(draft => draft.threadId === 'workshop')!.text)
    expect(composer).toBe('Independent legacy follow-up draft')
  } finally { await closeSotto(launched) }
})
