import { expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchSotto, closeSotto } from './support/sottoLaunch'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'

test('makes an editable prompt, copies the edited text and preserves the original chat without project work', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase4-prompts-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: true }))
  const app = await launchSotto('success', profile)
  try {
    await app.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(820, 560) })
    const before = await app.page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'light', reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test' } })
      const bridge = window.sotto!.personalChats!
      await bridge.connect()
      const state = await bridge.create(), id = state.selectedChatId!
      await bridge.saveDraft({ chatId: id, revision: 1, text: 'Build a calm reading app with local bookmarks.', skills: [] })
      await bridge.send({ chatId: id, revision: 1 })
      return { id, agents: await window.sotto!.agents!.get() }
    })
    await expect.poll(() => app.page.evaluate(async id => (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)?.status, before.id)).toBe('idle')
    await expect.poll(() => app.page.evaluate(async id => (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)?.messages.length, before.id)).toBeGreaterThan(1)
    const chatBefore = await app.page.evaluate(async id => {
      await window.sotto!.personalChats!.saveDraft({ chatId: id, revision: 2, text: 'An unsent newer thought', skills: [] })
      return (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)!
    }, before.id)
    await app.page.getByRole('link', { name: 'Chats', exact: true }).click()
    await app.page.getByRole('button', { name: 'Make prompt', exact: true }).click()
    const dialog = app.page.getByRole('dialog', { name: 'Prompt from this chat' })
    await expect(dialog.getByRole('textbox', { name: 'Editable prompt' })).toHaveValue(/local bookmarks/)
    await dialog.getByRole('textbox', { name: 'Editable prompt' }).fill('Build the reviewed reading app. No account required.')
    await dialog.getByRole('button', { name: 'Copy prompt' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Copied')
    expect(await app.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Build the reviewed reading app. No account required.')
    await app.page.keyboard.press('Escape')
    await expect(app.page.getByRole('button', { name: 'Edit prompt' })).toBeFocused()
    await app.page.getByRole('button', { name: 'Edit prompt' }).click()
    await expect(dialog.getByRole('textbox', { name: 'Editable prompt' })).toHaveValue('Build the reviewed reading app. No account required.')
    const after = await app.page.evaluate(async id => ({ chat: (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id), agents: await window.sotto!.agents!.get() }), before.id)
    expect(after.chat).toEqual(chatBefore)
    expect(after.agents.host.projects).toEqual(before.agents.host.projects)
    expect(after.agents.host.threads.map(thread => thread.id)).toEqual(before.agents.host.threads.map(thread => thread.id))
    expect(after.agents.assignments).toEqual(before.agents.assignments)
    await app.page.keyboard.press('Escape')
    await app.page.evaluate(async id => {
      await window.sotto!.personalChats!.saveDraft({ chatId: id, revision: 3, text: 'Correction: use a local reading queue instead of bookmarks.', skills: [] })
      await window.sotto!.personalChats!.send({ chatId: id, revision: 3 })
    }, before.id)
    await expect.poll(() => app.page.evaluate(async id => (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)?.messages.filter(message => message.role === 'user').length, before.id)).toBe(2)
    await expect.poll(() => app.page.evaluate(async id => (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)?.status, before.id)).toBe('idle')
    await app.page.getByRole('button', { name: 'Edit prompt' }).click()
    await expect(dialog.getByRole('textbox', { name: 'Editable prompt' })).toHaveValue('Build the reviewed reading app. No account required.')
    await expect(dialog.getByText('This discussion has changed. Regenerate to include the latest messages and replace this draft.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Regenerate prompt' }).click()
    await expect(dialog.getByRole('textbox', { name: 'Editable prompt' })).toHaveValue(/local reading queue/)
    await app.page.screenshot({ path: 'artifacts/phase-four-prompts/editor-regenerated-820-light.png' })
  } finally { await closeSotto(app) }
})
