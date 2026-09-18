import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { AgentRequest } from '../../src/shared/agents'
import type { RequestDraft } from '../../src/shared/requestDrafts'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

/**
 * A native client may close pending questions when it shuts down. After a full process restart the provider does NOT
 * offer the question again, so the retained answer is reachable only through saved answer recovery. Nothing is sent.
 */
const form: AgentRequest = { id: 'durable-form', kind: 'question', text: 'Native restart fixture', options: [], questions: [
  { id: 'place', question: 'Where should we go?', multiSelect: false, allowFreeText: true, options: [{ id: 'coast', label: 'Coast' }, { id: 'hills', label: 'Hills' }] },
  { id: 'checks', question: 'Which checks?', multiSelect: true, allowFreeText: false, options: [{ id: 'unit', label: 'Unit checks' }, { id: 'types', label: 'Type checks' }] },
  { id: 'notes', question: 'Travel notes', multiSelect: false, allowFreeText: true, options: [] },
] }
/** The provider later reuses the request ID for a different question. */
const redefined: AgentRequest = { ...form, questions: [{ id: 'place', question: 'Which harbour instead?', multiSelect: false, allowFreeText: false,
  options: [{ id: 'north', label: 'North harbour' }, { id: 'south', label: 'South harbour' }] }] }
type Owner = 'thread' | 'personal'
declare global { var recoveryAnswerCalls: number; var holdRecoveryAnswer: boolean }
const shots = 'artifacts/phase-three-draft-recovery'
const drafts = async (profile: string): Promise<RequestDraft[]> => JSON.parse(await readFile(join(profile, 'request-drafts.json'), 'utf8')).drafts
const liveCard = (page: Page) => page.locator('.agent-request').filter({ has: page.getByRole('group', { name: 'Where should we go?' }) })
const savedCard = (page: Page, name = 'Saved answer') => page.getByRole('region', { name, exact: true })
/** The threaded fixture's Workshop thread runs on Claude; personal chats run on Codex. */
const providerOf = (owner: Owner): string => owner === 'thread' ? 'Claude' : 'Codex'

async function countAnswers(launched: LaunchedSotto, owner: Owner, hold = false): Promise<void> {
  await launched.app.evaluate(({ ipcMain }, { channel, hold }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, payload: { type?: string }) => unknown> })._invokeHandlers
    const original = handlers.get(channel)!
    globalThis.recoveryAnswerCalls = 0; globalThis.holdRecoveryAnswer = hold
    handlers.set(channel, async (event, payload) => {
      if (payload.type === 'answer') {
        globalThis.recoveryAnswerCalls++
        if (globalThis.holdRecoveryAnswer) await new Promise(() => {})
      }
      return original(event, payload)
    })
  }, { channel: owner === 'thread' ? 'sotto:agents:command' : 'personal-chat:command', hold })
}
const answerCalls = (launched: LaunchedSotto): Promise<number> => launched.app.evaluate(() => globalThis.recoveryAnswerCalls)
async function emit(page: Page, owner: Owner, id: string, request: AgentRequest): Promise<void> {
  await page.evaluate(async ({ owner, id, request }) => {
    await window.sottoE2E!.agentEvent!({ ...(owner === 'personal' ? { scope: 'personal' as const } : {}), type: 'question', threadId: id, text: request.text, request })
  }, { owner, id, request })
}
async function open(page: Page, owner: Owner): Promise<void> {
  if (owner === 'personal') await openPage(page, 'Chats')
  else await openThreads(page)
  if (owner === 'thread') await page.getByRole('button', { name: 'Workshop', exact: true }).click()
}
async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(400, 300)
    window.setContentSize(width!, height!)
  }, [width, height])
  // Fractional display scaling can round the renderer's height by a pixel or two.
  await expect.poll(async () => { const [w, h] = await launched.page.evaluate(() => [innerWidth, innerHeight]); return w === width && Math.abs(h! - height) <= 4 }).toBe(true)
}
async function appearance(page: Page, mode: 'light' | 'dark'): Promise<void> {
  await page.evaluate(async mode => { await window.sotto!.updateSettings({ appearance: mode }) }, mode)
  await page.waitForTimeout(250)
}
/** Captures the saved answer at the reviewed desktop sizes in both appearances, ending on 1280 dark. */
async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  const { page } = launched
  await mkdir(shots, { recursive: true })
  for (const [width, height] of [[1280, 860], [820, 560]] as const) {
    await size(launched, width, height)
    for (const mode of ['dark', 'light'] as const) {
      await appearance(page, mode)
      // A narrow window cannot show the whole card, so it is captured from its head and from its actions.
      await savedCard(page).first().evaluate(element => element.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: `${shots}/${name}-${width}-${mode}.png` })
      if (width < 1280) {
        await savedCard(page).first().getByRole('button', { name: 'Copy answer' }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${shots}/${name}-${width}-${mode}-actions.png` })
      }
    }
  }
  await size(launched, 1280, 860); await appearance(page, 'dark')
}

async function setUp(page: Page, owner: Owner): Promise<string> {
  const id = await page.evaluate(async owner => {
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: 'low' } })
    if (owner === 'thread') {
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: crypto.randomUUID(), text: 'Newer composer text' })
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
    await page.evaluate(async id => window.sotto!.personalChats!.saveDraft({ chatId: id, revision: 3, text: 'Newer composer text', skills: [] }), id)
  }
  return id
}
const composerText = (page: Page, owner: Owner, id: string): Promise<string | undefined> => page.evaluate(async ({ owner, id }) => owner === 'personal'
  ? (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)?.draft.text
  : (await window.sotto!.agents!.get()).threadDrafts?.find(draft => draft.threadId === id)?.text, { owner, id })

/** The personal fixture persists native requests; remove them as Codex does when it declines pending questions on shutdown. */
async function nativeClosesQuestions(profile: string, owner: Owner): Promise<void> {
  if (owner === 'thread') return // The threaded fixture's native requests live only in the exited process.
  const path = join(profile, 'e2e-personal-native.json')
  const native = JSON.parse(await readFile(path, 'utf8')) as { requests: AgentRequest[] }[]
  expect(native.flatMap(conversation => conversation.requests).map(request => request.id)).toContain('durable-form')
  await writeFile(path, JSON.stringify(native.map(conversation => ({ ...conversation, requests: [] }))))
}

for (const owner of ['thread', 'personal'] as const) test(`${owner}: an unsent answer whose native question closed across a full restart can be read, copied and discarded without sending`, async () => {
  test.setTimeout(90_000)
  const profile = await mkdtemp(join(tmpdir(), `sotto-e2e-draft-recovery-${owner}-`))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: false }))
  let launched = await launchSotto('success', profile)
  try {
    let page = launched.page
    const id = await setUp(page, owner)
    await countAnswers(launched, owner)
    await emit(page, owner, id, form); await open(page, owner)
    const card = liveCard(page)
    await card.getByRole('radio', { name: 'Other', exact: true }).click()
    await card.getByRole('textbox', { name: 'Other answer to: Where should we go?' }).fill('A quiet shore')
    await card.getByRole('checkbox', { name: 'Unit checks' }).click()
    await card.getByRole('checkbox', { name: 'Type checks' }).click()
    await card.getByRole('textbox', { name: 'Travel notes' }).fill('Unsent notes survive restart')
    await expect(card).toHaveAttribute('data-save', 'saved')
    // While the live card shows the request, its saved answer is not repeated as a recovery card.
    await expect(savedCard(page)).toHaveCount(0)
    const before = await drafts(profile)
    expect(await answerCalls(launched)).toBe(0)
    await closeSotto(launched)
    await nativeClosesQuestions(profile, owner)

    launched = await launchSotto('success', profile); page = launched.page
    await countAnswers(launched, owner)
    await size(launched, 1280, 860)
    // The threaded fixture reconnects on launch; disconnect it so the unknown state is observed before reconnecting.
    if (owner === 'thread') await page.evaluate(() => window.sotto!.agents!.command({ type: 'disconnect' }))
    await open(page, owner)
    expect(await drafts(profile)).toEqual(before)
    // While the provider is disconnected, Sotto cannot know whether the question is open, and says so.
    await expect(savedCard(page)).toContainText(`This answer was not sent. Reconnect ${providerOf(owner)} to see whether its question is still open.`)
    await mkdir(shots, { recursive: true })
    await savedCard(page).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${shots}/${owner}-disconnected-1280-dark.png` })

    // Reconnect. The provider does not offer the question again.
    if (owner === 'personal') await page.evaluate(() => window.sotto!.personalChats!.connect())
    else await page.evaluate(() => window.sotto!.agents!.command({ type: 'connect' }))
    const saved = savedCard(page)
    await expect(saved).toContainText(`${providerOf(owner)} no longer shows this question. This answer was not sent.`)
    await expect(liveCard(page)).toHaveCount(0)
    for (const [question, answer] of [['Where should we go?', 'Other: A quiet shore'], ['Which checks?', 'Unit checks, Type checks'], ['Travel notes', 'Unsent notes survive restart']] as const) {
      await expect(saved.locator('dt', { hasText: question }).locator('xpath=following-sibling::dd')).toHaveText(answer)
    }
    await expect(saved.getByRole('button')).toHaveText(['Copy answer', 'Discard'])
    expect(await drafts(profile)).toEqual(before)
    await capture(launched, `${owner}-question-closed`)

    // Copy through the main-owned output path; the E2E runtime's clipboard is isolated from the operating system's.
    await saved.getByRole('button', { name: 'Copy answer' }).click()
    await expect(saved.getByRole('status')).toHaveText('Copied')
    expect((await page.evaluate(() => window.sottoE2E!.snapshot())).clipboardText).toBe('Where should we go?\nOther: A quiet shore\n\nWhich checks?\nUnit checks, Type checks\n\nTravel notes\nUnsent notes survive restart')

    // The provider reuses the request ID for another question: a fresh live card, and the old answer stays recoverable.
    await emit(page, owner, id, redefined)
    await expect(page.getByRole('group', { name: 'Which harbour instead?' })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'North harbour' })).not.toBeChecked()
    await expect(saved).toContainText(`${providerOf(owner)} changed this question. This answer was not sent.`)
    await saved.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${shots}/${owner}-changed-question-1280-dark.png` })

    // Discard by keyboard: Discard, confirmation focuses Keep, Tab to Discard answer.
    await saved.getByRole('button', { name: 'Discard' }).focus()
    await page.keyboard.press('Enter')
    await expect(saved.getByRole('button', { name: 'Keep' })).toBeFocused()
    await expect(saved).toContainText('Discard this answer? It can’t be restored.')
    await page.screenshot({ path: `${shots}/${owner}-discard-confirm-1280-dark.png` })
    await page.keyboard.press('Escape')
    await expect(saved.getByRole('button', { name: 'Discard' })).toBeFocused()
    await page.keyboard.press('Enter'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter')
    await expect(savedCard(page)).toHaveCount(0)
    await expect.poll(async () => (await drafts(profile)).filter(draft => draft.target.ownerId === id).map(draft => draft.target.questions[0]!.question)).toEqual([])
    await expect(page.getByRole('group', { name: 'Which harbour instead?' })).toBeVisible()
    expect(await composerText(page, owner, id)).toBe('Newer composer text')
    expect(await answerCalls(launched)).toBe(0)
  } finally { await closeSotto(launched) }
})

test('thread: a held answer whose native question closed across a full restart stays unconfirmed and is never replayed', async () => {
  test.setTimeout(60_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-draft-recovery-held-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: false }))
  let launched = await launchSotto('success', profile)
  try {
    let page = launched.page
    const id = await setUp(page, 'thread')
    await emit(page, 'thread', id, form); await open(page, 'thread')
    await liveCard(page).getByRole('radio', { name: 'Coast', exact: true }).click()
    await liveCard(page).getByRole('checkbox', { name: 'Unit checks' }).click()
    await liveCard(page).getByRole('textbox', { name: 'Travel notes' }).fill('Held through restart')
    await countAnswers(launched, 'thread', true)
    await liveCard(page).getByRole('button', { name: 'Send answers' }).click()
    await expect.poll(() => answerCalls(launched)).toBe(1)
    await expect.poll(async () => (await drafts(profile))[0]?.held).toBe(true)
    await closeSotto(launched)

    launched = await launchSotto('success', profile); page = launched.page
    await countAnswers(launched, 'thread')
    await size(launched, 1280, 860)
    await page.evaluate(() => window.sotto!.agents!.command({ type: 'connect' }))
    await open(page, 'thread')
    const held = savedCard(page, 'Unconfirmed answer')
    await expect(held).toContainText('Claude no longer shows this question. The answer may have arrived, so Sotto won’t send it again.')
    await expect(held.locator('dd').nth(2)).toHaveText('Held through restart')
    await expect(held.getByRole('button')).toHaveText(['Copy answer', 'Discard'])
    await held.getByRole('button', { name: 'Discard' }).click()
    await expect(held).toContainText('Discard Sotto’s copy? This doesn’t cancel or resend the answer.')
    await mkdir(shots, { recursive: true })
    await held.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${shots}/thread-held-question-closed-1280-dark.png` })
    await held.getByRole('button', { name: 'Keep' }).click()
    await expect(held.getByRole('button', { name: 'Discard' })).toBeFocused()
    expect((await drafts(profile))[0]?.held).toBe(true)
    expect(await answerCalls(launched)).toBe(0)
  } finally { await closeSotto(launched) }
})
