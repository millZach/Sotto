import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

test('personal chats retain separate identity and drafts across full app restart without creating project work', async () => {
  test.setTimeout(60_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase3-personal-'))
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const initial = await launched.page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, historyEnabled: true })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: 'low' } })
      await agents.command({ type: 'connect' })
      const before = await agents.get()
      const bridge = window.sotto!.personalChats!
      await bridge.connect()
      const first = (await bridge.create()).selectedChatId!
      await bridge.saveDraft({ chatId: first, revision: 1, text: 'First personal idea', skills: [] })
      const second = (await bridge.create()).selectedChatId!
      await bridge.saveDraft({ chatId: second, revision: 1, text: 'Second chat stays unsent', skills: [] })
      await bridge.select(first)
      await bridge.send({ chatId: first, revision: 1 })
      return { first, second, projectIds: before.host.projects.map(project => project.id), threadIds: before.host.threads.map(thread => thread.id) }
    })
    await expect.poll(() => launched!.page.evaluate(async id => {
      const state = await window.sotto!.personalChats!.get()
      return state.chats.find(chat => chat.id === id)?.submissions[0]?.status
    }, initial.first)).toBe('accepted')
    const beforeRestart = await launched.page.evaluate(async ({ first, second }) => {
      const bridge = window.sotto!.personalChats!
      await bridge.saveDraft({ chatId: first, revision: 2, text: 'A newer independent draft', skills: [] })
      const state = await bridge.select(second)
      return state.chats.find(chat => chat.id === first)!.messages.map(message => ({ id: message.id, role: message.role, commandId: message.commandId }))
    }, initial)
    expect(beforeRestart.filter(message => message.role === 'user')).toHaveLength(1)
    await closeSotto(launched)
    launched = await launchSotto('success', profile)
    const restored = await launched.page.evaluate(async () => window.sotto!.personalChats!.get())
    expect(restored.selectedChatId).toBe(initial.second)
    expect(restored.chats.find(chat => chat.id === initial.first)?.draft.text).toBe('A newer independent draft')
    expect(restored.chats.find(chat => chat.id === initial.second)?.draft.text).toBe('Second chat stays unsent')
    expect(restored.chats.every(chat => !('projectId' in chat))).toBe(true)
    const after = await launched.page.evaluate(async ({ first }) => {
      const bridge = window.sotto!.personalChats!
      await window.sotto!.agents!.command({ type: 'configure', patch: { reasoning: 'claude', reasoningModel: 'changed-default' } })
      await bridge.connect()
      await bridge.refresh(first)
      let creationRejected = false
      try { await bridge.create() } catch { creationRejected = true }
      return { state: await bridge.get(), agents: await window.sotto!.agents!.get(), creationRejected }
    }, initial)
    expect(after.creationRejected).toBe(true)
    expect(after.state.availability.supported).toBe(false)
    const first = after.state.chats.find(chat => chat.id === initial.first)!
    expect(first.providerId).toBe('codex')
    expect(first.modelId).toBe('codex:test')
    expect(first.messages.map(message => ({ id: message.id, role: message.role, commandId: message.commandId }))).toEqual(beforeRestart)
    expect(first.draft.text).toBe('A newer independent draft')
    expect(after.agents.host.projects.map(project => project.id)).toEqual(initial.projectIds)
    expect(after.agents.host.threads.map(thread => thread.id)).toEqual(initial.threadIds)
    expect(after.agents.assignments).toEqual([])
  } finally { if (launched) await closeSotto(launched) }
})
