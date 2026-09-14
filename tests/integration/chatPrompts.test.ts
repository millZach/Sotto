// @vitest-environment node
import { expect, it } from 'vitest'
import { ChatPromptService } from '../../src/main/agents/chatPrompts'
import type { ChatPromptOutline } from '../../src/shared/chatPrompts'
import type { PersonalChatState } from '../../src/shared/personalChats'

const at = '2026-09-13T10:00:00.000Z'
const state = (): PersonalChatState => ({ selectedChatId: 'ideas', connected: true, connecting: false, availability: { provider: 'codex', supported: true },
  chats: [{ id: 'ideas', kind: 'personal', providerId: 'codex', modelId: 'gpt-6-astra', title: 'Garden app', status: 'idle', nativeState: 'ready', createdAt: at, updatedAt: at,
    requests: [], submissions: [], draft: { revision: 2, text: 'Unsent thought', skills: [] }, messages: [
      { id: 'u1', role: 'user', text: 'Build a garden planner. Keep it offline.', createdAt: at },
      { id: 'a1', role: 'assistant', text: 'We could add weather alerts.', createdAt: at },
    ] }],
})
const outline = (): ChatPromptOutline => ({ objective: [{ text: 'Build a garden planner.', evidence: [{ messageId: 'u1', quote: 'Build a garden planner.' }] }],
  constraints: [{ text: 'Keep it offline.', evidence: [{ messageId: 'u1', quote: 'Keep it offline.' }] }],
  suggestions: [{ text: 'Weather alerts are a suggestion to review.', evidence: [{ messageId: 'a1', quote: 'We could add weather alerts.' }] }],
  context: [], decisions: [], deliverables: [], acceptanceChecks: [], unresolvedQuestions: [],
})

it('does not deliver stale requirements if a newer correction arrives while the prompt is being generated', async () => {
  const saved = state()
  let finish!: (value: unknown) => void
  const service = new ChatPromptService({ get: () => structuredClone(saved) }, () => new Promise(resolve => { finish = resolve }))
  const generated = service.generate({ chatId: 'ideas' })
  saved.chats[0]!.messages.push({ id: 'u2', role: 'user', text: 'Correction: this must sync online.', createdAt: at })
  finish(outline())
  await expect(generated).rejects.toThrow(/changed/i)
})

it('produces copyable sections with suggestions separate and leaves the chat, its draft and binding intact', async () => {
  const saved = state(), before = structuredClone(saved)
  const service = new ChatPromptService({ get: () => structuredClone(saved) }, async (_system, input, chat) => {
    expect(input.messages.map(message => message.id)).toEqual(['u1', 'a1'])
    expect(chat.providerId).toBe('codex')
    return outline()
  })
  const result = await service.generate({ chatId: 'ideas' })
  expect(result.text).toBe('## Objective\n- Build a garden planner.\n\n## Constraints and non-goals\n- Keep it offline.\n\n## Suggestions to review\n- Weather alerts are a suggestion to review.')
  expect(result.sourceMessageIds).toEqual(['u1', 'a1'])
  expect(saved).toEqual(before)
})

it('rejects assistant suggestions promoted to requirements and fabricated source quotes', async () => {
  const saved = state(), proposed = outline()
  proposed.decisions = proposed.suggestions; proposed.suggestions = []
  const service = new ChatPromptService({ get: () => saved }, async () => proposed)
  await expect(service.generate({ chatId: 'ideas' })).rejects.toThrow('suggestion as a requirement')
  proposed.decisions = []; proposed.objective[0]!.evidence[0]!.quote = 'Publish it to the cloud'
  await expect(service.generate({ chatId: 'ideas' })).rejects.toThrow('missing source text')
})

it('rejects overlapping generation, recovers after a model failure and does not omit oversized context', async () => {
  const saved = state()
  let fail!: (error: Error) => void
  const service = new ChatPromptService({ get: () => saved }, () => new Promise((_resolve, reject) => { fail = reject }))
  const pending = service.generate({ chatId: 'ideas' })
  await expect(service.generate({ chatId: 'ideas' })).rejects.toThrow('already')
  fail(new Error('Native connection unavailable'))
  await expect(pending).rejects.toThrow('Native connection unavailable')
  saved.chats[0]!.messages[0]!.text = 'Long '.repeat(40000)
  await expect(service.generate({ chatId: 'ideas' })).rejects.toThrow('too large')
})

it.each(['running', 'loading', 'error', 'uncertain', 'permission'] as const)('requires a complete settled source before generating: %s', async mode => {
  const saved = state(), chat = saved.chats[0]!
  if (mode === 'running') chat.status = 'running'
  else if (mode === 'loading' || mode === 'error') chat.historyStatus = mode
  else if (mode === 'uncertain') chat.nativeState = mode
  else chat.requests.push({ id: 'permission', kind: 'permission', text: 'Approve?', options: [] })
  let called = false
  const service = new ChatPromptService({ get: () => saved }, async () => { called = true; return outline() })
  await expect(service.generate({ chatId: 'ideas' })).rejects.toThrow('pending work')
  expect(called).toBe(false)
})
