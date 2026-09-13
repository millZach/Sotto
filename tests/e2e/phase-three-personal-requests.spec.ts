import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto } from './support/sottoLaunch'

// Provider effects alone are fixtures; the personal service, durable decisions, IPC and rendered cards are real.
test('personal native questions and exact approvals work in the complete app and retain a refused answer', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-personal-requests-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: true }))
  const launched = await launchSotto('success', profile)
  const { page } = launched
  try {
    const id = await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: 'low' } })
      const bridge = window.sotto!.personalChats!
      await bridge.connect()
      const id = (await bridge.create()).selectedChatId!
      await bridge.saveDraft({ chatId: id, revision: 1, text: 'Plan a weekend', skills: [] })
      await bridge.send({ chatId: id, revision: 1 })
      return id
    })
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)?.submissions[0]?.status, id)).toBe('accepted')
    await page.getByRole('link', { name: 'Chats', exact: true }).click()
    await page.evaluate(async id => {
      const emit = window.sottoE2E!.agentEvent!
      await emit({ scope: 'personal', type: 'question', threadId: id, text: '', request: {
        id: 'weekend-plan', kind: 'question', text: 'Weekend preferences', options: [], questions: [
          { id: 'destination', question: 'Where would you like to go?', multiSelect: false, allowFreeText: false, options: [{ id: 'coast', label: 'The coast' }, { id: 'mountains', label: 'The mountains' }] },
          { id: 'notes', question: 'Anything else?', multiSelect: false, allowFreeText: true, required: false, options: [] },
        ],
      } })
      await emit({ scope: 'personal', type: 'permission', threadId: id, text: '', request: {
        id: 'look-up-trains', kind: 'permission', text: 'Look up train times', options: [],
        permissionChoices: [{ id: 'native:once', label: 'Allow this lookup', kind: 'allow-once' }, { id: 'native:deny', label: 'Skip lookup', kind: 'deny' }],
      } })
    }, id)
    const form = page.locator('.agent-request[data-kind="question"]')
    await expect(form.getByRole('group')).toHaveCount(2)
    await form.getByRole('radio', { name: 'The coast' }).click()
    await page.evaluate(async id => window.sottoE2E!.agentEvent!({ scope: 'personal', type: 'reject', threadId: id, text: 'Native provider refused this answer. Try again.' }), id)
    await form.getByRole('button', { name: 'Send answers' }).click()
    await expect(form.getByRole('alert')).toHaveText('Native provider refused this answer. Try again.')
    await expect(form.getByRole('radio', { name: 'The coast' })).toBeChecked()
    await form.getByRole('button', { name: 'Send answers' }).click()
    await expect(form).toHaveCount(0)
    await page.getByRole('button', { name: 'Allow this lookup' }).click()
    await expect(page.locator('.agent-request')).toHaveCount(0)
    const chat = await page.evaluate(async id => (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)!, id)
    expect(chat.decisions?.map(decision => decision.status)).toEqual(['failed', 'accepted', 'accepted'])
    expect(chat.decisions?.[1]?.questionAnswers).toEqual({ destination: { optionIds: ['coast'] } })
    expect(chat.decisions?.[2]?.permissionChoice).toBe('native:once')
    expect(chat.decisions?.[2]?.answer).toBe('Allow this lookup')
    expect(chat.decisions?.[2]?.approved).toBe(true)
    expect(chat.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(chat.providerId).toBe('codex')
    expect('projectId' in chat).toBe(false)
  } finally { await closeSotto(launched) }
})
