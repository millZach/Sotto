import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { RequestDraft } from '../../src/shared/requestDrafts'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const evidence = evidenceDirectory('artifacts/remove-personal-chats')

const notice = 'Saved chat history could not be fully cleared. Some local chat data was left in place. Repair local storage, then save Settings or restart Sotto to try again.'
const answerNotice = 'Saved answer cleanup could not finish. The original file was preserved. Repair local storage, then restart Sotto to try again.'
const crashCopy = 'chats.json.tmp-123-12345678-1234-1234-1234-123456789abc'

function savedChats() {
  const request = { id: 'retired-question', kind: 'question', text: 'Private submitted question', options: [] }
  return { selectedChatId: 'retired-chat', chats: [{
    id: 'retired-chat', kind: 'personal', providerId: 'codex', title: 'Private conversation title', modelId: 'model', status: 'idle',
    createdAt: 'then', updatedAt: 'now', nativeState: 'ready', connected: false,
    messages: [{ id: 'message', role: 'user', text: 'Private transcript', createdAt: 'then' }], requests: [request],
    activities: [{ id: 'activity', turnId: 'turn', sequence: 0, kind: 'reasoning', status: 'completed', title: 'Private activity' }],
    draft: { revision: 2, text: 'Keep this unsent composer draft', skills: [] },
    submissions: [{ id: 'submission', messageId: 'message', revision: 1, text: 'Private submitted prompt', skills: [], status: 'uncertain', createdAt: 'then' }],
    decisions: ['accepted', 'uncertain'].map(status => ({ id: `decision-${status}`, requestId: request.id, request,
      questionsDigest: 'a'.repeat(64), answer: 'Private submitted answer',
      questionAnswers: { question: { optionIds: [], text: 'Private structured answer' } }, permissionChoice: 'allow-once',
      status, createdAt: 'then', error: 'Private diagnostic',
    })),
  }] }
}

function answerForm(kind: RequestDraft['target']['kind'], requestId: string, held: boolean): RequestDraft {
  return {
    target: { kind, ownerId: kind === 'personal' ? 'retired-chat' : 'saved-thread', providerId: 'codex', requestId,
      questions: [{ id: 'answer', question: `${requestId} question`, multiSelect: false, allowFreeText: true, options: [] }] },
    revision: 1, held, ...(held ? { decisionId: `attempt-${requestId}` } : {}),
    selections: { answer: { optionIds: [], other: false, text: `${requestId} answer` } },
  }
}

const submitted = answerForm('personal', 'submitted-personal', true)
const unsent = answerForm('personal', 'unsent-personal', false)
const thread = answerForm('thread', 'held-thread', true)
const sourceChats = `${JSON.stringify(savedChats(), null, 3)}\n`
const sourceForms = `${JSON.stringify({ version: 1, drafts: [submitted, unsent, thread] }, null, 3)}\n`

interface Fixture {
  readonly launched: LaunchedSotto
  readonly chatsFile: string
  readonly formsFile: string
  readonly personalDirectory: string
}

async function withProfile(historyEnabled: boolean, chats: string | null, run: (fixture: Fixture) => Promise<void>, forms: string = sourceForms): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-retired-privacy-'))
  let launched: LaunchedSotto | undefined
  try {
    const personalDirectory = join(profile, 'personal-chat')
    const chatsFile = join(personalDirectory, 'chats.json')
    const formsFile = join(profile, 'request-drafts.json')
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS,
      onboardingComplete: true, historyEnabled, appearance: 'dark', reducedMotion: 'on', showWidgetWhenIdle: false,
    }), 'utf8')
    await writeFile(formsFile, forms, 'utf8')
    if (chats !== null) {
      await mkdir(personalDirectory)
      await writeFile(chatsFile, chats, 'utf8')
      await writeFile(join(personalDirectory, crashCopy), 'Private abandoned snapshot', 'utf8')
      await mkdir(join(personalDirectory, 'codex'))
      await writeFile(join(personalDirectory, 'codex', 'native.json'), 'Provider-owned history', 'utf8')
    }
    launched = await launchSotto('success', profile)
    await run({ launched, chatsFile, formsFile, personalDirectory })
  } finally {
    if (launched) await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
}

async function expectRedacted({ chatsFile, formsFile, personalDirectory }: Fixture): Promise<void> {
  const original = savedChats()
  const chat = original.chats[0]!
  const expected = { ...original, chats: [{ ...chat, title: 'Personal chat', messages: [], requests: [],
    submissions: chat.submissions.map(submission => ({ ...submission, text: '', skills: [] })),
    decisions: chat.decisions.map(({ id, requestId, questionsDigest, status, createdAt }) => ({
      id, requestId, questionsDigest, status, createdAt, answer: '', error: 'Answer could not be confirmed. Local history is off.',
    })),
  }] }
  // Activities, copied requests and permission choices contain submitted history too.
  const expectedChat: Record<string, unknown> = expected.chats[0]!
  delete expectedChat.activities
  await expect.poll(async () => JSON.parse(await readFile(chatsFile, 'utf8'))).toEqual(expected)
  await expect.poll(async () => JSON.parse(await readFile(formsFile, 'utf8'))).toEqual({ version: 2, drafts: [unsent, thread], retirements: [] })
  expect(await readdir(personalDirectory)).not.toContain(crashCopy)
  expect(await readFile(join(personalDirectory, 'codex', 'native.json'), 'utf8')).toBe('Provider-owned history')
}

test.describe('retired Chats follow Keep local history', () => {
  test.setTimeout(120_000)

  test('history on preserves saved Chats and held personal answers byte for byte at startup', async () => {
    await withProfile(true, sourceChats, async ({ launched, chatsFile, formsFile, personalDirectory }) => {
      await expect(launched.page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
      expect(await readFile(chatsFile, 'utf8')).toBe(sourceChats)
      expect(await readFile(formsFile, 'utf8')).toBe(sourceForms)
      expect(await readFile(join(personalDirectory, crashCopy), 'utf8')).toBe('Private abandoned snapshot')
      await expect(launched.page.getByText(notice, { exact: true })).toHaveCount(0)
    })
  })

  test('turning history off in Settings redacts submitted history and retains unsent and thread forms', async () => {
    await withProfile(true, sourceChats, async fixture => {
      const { page } = fixture.launched
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Application', exact: true }).click()
      const toggle = page.getByRole('switch', { name: 'Keep local history', exact: true })
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expectRedacted(fixture)
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await expectRedacted(fixture)
    })
  })

  test('history off applies the same cleanup before the first window opens', async () => {
    await withProfile(false, sourceChats, expectRedacted)
  })

  test('malformed answer storage is preserved until repair and restart allow cleanup', async () => {
    const invalid = '{"version":1,"drafts":[{"retained":"Private unparsed answer"}]}\n'
    await withProfile(false, null, async ({ launched, chatsFile, formsFile }) => {
      await expect(launched.page.getByRole('status').filter({ hasText: answerNotice })).toBeVisible()
      await expect(launched.page.getByText(notice, { exact: true })).toHaveCount(0)
      expect(await readFile(formsFile, 'utf8')).toBe(invalid)
      expect((await readdir(launched.userData)).filter(name => name.startsWith('request-drafts.json'))).toEqual(['request-drafts.json'])
      await expect(readFile(chatsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await launched.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(820, 560)
      })
      await expect.poll(() => launched.page.evaluate(() => Math.max(Math.abs(innerWidth - 820), Math.abs(innerHeight - 560)))).toBeLessThanOrEqual(2)
      await expect.poll(() => launched.page.evaluate(() => [
        Math.max(0, document.documentElement.scrollWidth - innerWidth),
        Math.max(0, document.documentElement.scrollHeight - innerHeight),
      ])).toEqual([0, 0])
      await expect(launched.page.getByRole('status').filter({ hasText: answerNotice })).toBeVisible()
      await mkdir(evidence, { recursive: true })
      await launched.page.screenshot({ path: join(evidence, 'answer-cleanup-notice-820x560.png'),
        clip: { x: 0, y: 0, width: 820, height: 560 }, scale: 'css' })

      await writeFile(formsFile, sourceForms, 'utf8')
      // A Settings save cannot reread a store held read-only for this process.
      expect(await launched.page.evaluate(async () => {
        const saved = await window.sotto!.updateSettings({ appearance: 'light' })
        return saved.appearance
      })).toBe('light')
      expect(await readFile(formsFile, 'utf8')).toBe(sourceForms)
      await closeSotto(launched)
      const restarted = await launchSotto('success', launched.userData)
      try {
        await expect(restarted.page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
        expect(JSON.parse(await readFile(formsFile, 'utf8'))).toEqual({ version: 2, drafts: [unsent, thread], retirements: [] })
        await expect(restarted.page.getByText(answerNotice, { exact: true })).toHaveCount(0)
        await expect(restarted.page.getByText(notice, { exact: true })).toHaveCount(0)
        await expect(readFile(chatsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } finally { await closeSotto(restarted) }
    }, invalid)
  })

  test('an invalid primary stays intact and reports incomplete cleanup without blocking answer cleanup', async () => {
    const invalid = '{"selectedChatId":"retired-chat","chats":[{"private":"Unreadable saved history"}]}\n'
    await withProfile(false, invalid, async ({ launched, chatsFile, formsFile, personalDirectory }) => {
      const { page, app } = launched
      await expect(page.getByRole('status').filter({ hasText: notice })).toBeVisible()
      await expect(page.getByText(answerNotice, { exact: true })).toHaveCount(0)
      expect(await readFile(chatsFile, 'utf8')).toBe(invalid)
      expect((await readdir(personalDirectory)).sort()).toEqual(['chats.json', crashCopy, 'codex'].sort())
      expect(await readFile(join(personalDirectory, crashCopy), 'utf8')).toBe('Private abandoned snapshot')
      expect(JSON.parse(await readFile(formsFile, 'utf8'))).toEqual({ version: 2, drafts: [unsent, thread], retirements: [] })
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(820, 560)
      })
      // Native frame sizing at fractional Windows display scale can round the content height by two pixels.
      await expect.poll(() => page.evaluate(() => Math.max(Math.abs(innerWidth - 820), Math.abs(innerHeight - 560)))).toBeLessThanOrEqual(2)
      await expect(page.getByRole('status').filter({ hasText: notice })).toBeVisible()
      // React settles its responsive sidebar after the native resize event.
      await expect.poll(() => page.evaluate(() => [
        Math.max(0, document.documentElement.scrollWidth - innerWidth),
        Math.max(0, document.documentElement.scrollHeight - innerHeight),
      ])).toEqual([0, 0])
      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: join(evidence, 'privacy-cleanup-notice-820x560.png'),
        clip: { x: 0, y: 0, width: 820, height: 560 }, scale: 'css' })
    })
  })
})
