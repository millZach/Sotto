import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentSkillCatalog } from '../../../src/shared/agentSkills'
import type { PersonalChat, PersonalChatBridge, PersonalChatState } from '../../../src/shared/personalChats'
import { PersonalChatsView } from '../../../src/renderer/src/agents/personal/PersonalChatsView'
import { PersonalDraftStore } from '../../../src/renderer/src/agents/personal/personalDrafts'
import { captureDictationDestination } from '../../../src/renderer/src/features/dictation/dictationDestination'
import { requestAnswerStore } from '../../../src/renderer/src/agents/requests/requestAnswers'

const AT = '2026-09-13T17:00:00.000Z'
const NOW = Date.parse(AT) + 5 * 60_000

function chat(patch: Partial<PersonalChat> = {}): PersonalChat {
  return {
    id: 'trip', kind: 'personal', providerId: 'codex', title: 'Trip ideas', modelId: 'codex:gpt-6-astra', createdAt: AT, updatedAt: AT,
    nativeState: 'ready', status: 'idle', requests: [], submissions: [], draft: { revision: 0, text: '', skills: [] },
    messages: [
      { id: 'u1', role: 'user', text: 'Where should we go in October?', createdAt: AT },
      { id: 'a1', role: 'assistant', text: 'Somewhere with **fall colour**.', createdAt: AT },
    ],
    ...patch,
  }
}

function snapshot(patch: Partial<PersonalChatState> = {}): PersonalChatState {
  return { selectedChatId: 'trip', chats: [chat()], connected: true, connecting: false, availability: { provider: 'codex', supported: true }, ...patch }
}

const CATALOG: AgentSkillCatalog = { threadId: 'trip', providerId: 'codex', cwd: 'personal', status: 'ready', errors: [],
  skills: [{ name: 'brainstorm', path: '/skills/brainstorm/SKILL.md', description: 'Explore the choices.', scope: 'user' }] }

/**
 * A stand-in for main's personal chat service at the bridge, recording calls in order. Drafts, sends and
 * answers follow the published contract: a send names a saved revision and is recorded as a submission.
 */
function fakeBridge(initial: PersonalChatState) {
  let state = structuredClone(initial)
  const listeners = new Set<(state: PersonalChatState) => void>()
  const calls: string[] = []
  const publish = (next: PersonalChatState = state): PersonalChatState => { state = next; listeners.forEach(listener => listener(structuredClone(state))); return structuredClone(state) }
  const update = (id: string, change: (chat: PersonalChat) => void): PersonalChatState => {
    const chats = state.chats.map(item => { if (item.id !== id) return item; const copy = structuredClone(item); change(copy); return copy })
    return publish({ ...state, chats })
  }
  const bridge = {
    onState: vi.fn((listener: (state: PersonalChatState) => void) => { calls.push('onState'); listeners.add(listener); return () => { calls.push('unsubscribe'); listeners.delete(listener) } }),
    get: vi.fn(async () => { calls.push('get'); return structuredClone(state) }),
    create: vi.fn(async () => {
      calls.push('create')
      const created = chat({ id: 'fresh', title: 'New chat', nativeState: 'unstarted', messages: [] })
      return publish({ ...state, selectedChatId: 'fresh', chats: [created, ...state.chats] })
    }),
    select: vi.fn(async (chatId: string | null) => { calls.push(`select:${chatId}`); return publish({ ...state, selectedChatId: chatId }) }),
    saveDraft: vi.fn(async (input: { chatId: string; revision: number; text: string; skills: PersonalChat['draft']['skills'] }) => {
      calls.push(`draft:${input.revision}:${input.text}`)
      return update(input.chatId, item => { if (input.revision > item.draft.revision) item.draft = { revision: input.revision, text: input.text, skills: input.skills } })
    }),
    send: vi.fn(async ({ chatId, revision }: { chatId: string; revision: number }) => {
      calls.push(`send:${revision}`)
      return update(chatId, item => { item.submissions.push({ ...item.draft, id: `s${revision}`, messageId: `m${revision}`, status: 'submitting', createdAt: AT }) })
    }),
    skills: vi.fn(async () => { calls.push('skills'); return CATALOG }),
    refresh: vi.fn(async (chatId: string) => { calls.push(`refresh:${chatId}`); return structuredClone(state) }),
    interrupt: vi.fn(async (chatId: string) => { calls.push(`interrupt:${chatId}`); return update(chatId, item => { item.status = 'idle' }) }),
    answer: vi.fn(async (input: { chatId: string; requestId: string }) => { calls.push(`answer:${input.requestId}`); return update(input.chatId, item => { item.requests = item.requests.filter(request => request.id !== input.requestId) }) }),
    connect: vi.fn(async () => { calls.push('connect'); return publish({ ...state, connected: true }) }),
    disconnect: vi.fn(async () => { calls.push('disconnect'); return publish({ ...state, connected: false }) }),
  }
  return { bridge: bridge as typeof bridge & PersonalChatBridge, calls, publish, update, state: () => state }
}

function mount(initial: PersonalChatState, props: Partial<React.ComponentProps<typeof PersonalChatsView>> = {}) {
  const fake = fakeBridge(initial)
  const store = new PersonalDraftStore()
  const view = render(<PersonalChatsView bridge={fake.bridge} store={store} now={NOW} {...props} />)
  return { ...fake, store, view }
}

afterEach(() => {
  cleanup()
  requestAnswerStore.prune('trip', [])
})

describe('Chats', () => {
  it('subscribes before reading, starts a chat that connects Codex and focuses its composer, and never disconnects on leaving', async () => {
    const { bridge, calls, view } = mount(snapshot({ selectedChatId: null, chats: [], connected: false }))
    expect(await screen.findByRole('heading', { name: 'Talk it through with Sotto' })).toBeVisible()
    expect(calls.slice(0, 2)).toEqual(['onState', 'get'])

    fireEvent.click(within(screen.getByRole('region', { name: 'Chat' })).getByRole('button', { name: 'New chat' }))
    const composer = await screen.findByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(composer).toHaveFocus())
    await waitFor(() => expect(bridge.connect).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled()
    expect(within(screen.getByRole('navigation', { name: 'Chats' })).getByRole('button', { name: /New chat\s*Not started/u })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible()

    view.unmount()
    expect(calls).toContain('unsubscribe')
    expect(bridge.disconnect).not.toHaveBeenCalled()
  })

  it('saves the draft revision before sending that revision, then empties the composer with a newer revision', async () => {
    const { bridge, calls, state } = mount(snapshot())
    const composer = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(composer, { target: { value: 'Somewhere quiet' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(bridge.send).toHaveBeenCalledWith({ chatId: 'trip', revision: 1 }))
    await waitFor(() => expect(calls).toContain('draft:2:'))
    expect(calls.filter(call => /^(draft|send)/u.test(call))).toEqual(['draft:1:Somewhere quiet', 'send:1', 'draft:2:'])
    expect(composer).toHaveValue('')
    // The submission shows as a pending message until history has it; sending more waits for confirmation.
    const pending = await screen.findByRole('article', { name: 'Pending message' })
    expect(within(pending).getByText('Somewhere quiet')).toBeVisible()
    expect(pending.querySelector('.thread-message__status')).toHaveTextContent('Sending')
    fireEvent.change(composer, { target: { value: 'And cheap' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.getByText('Waiting for your last message to be confirmed.')).toBeVisible()
    expect(state().chats[0]!.submissions).toHaveLength(1)
  })

  describe('a message Codex did not take after Sotto accepted the send', () => {
    const BRAINSTORM = { name: 'brainstorm', path: '/skills/brainstorm/SKILL.md' }
    const refuse = (update: ReturnType<typeof fakeBridge>['update']) => act(() => {
      update('trip', item => { const last = item.submissions.at(-1)!; last.status = 'failed'; last.error = 'Codex could not start this turn.' })
    })

    it('puts its text and skills back in the composer as a newer revision, only when asked, and never sends it again', async () => {
      const { bridge, calls, update } = mount(snapshot({ chats: [chat({ draft: { revision: 1, text: '$brainstorm a quiet October', skills: [BRAINSTORM] } })] }))
      const composer = await screen.findByRole('textbox', { name: 'Message' })
      fireEvent.keyDown(composer, { key: 'Enter' })
      // Main returns once the intent is saved as submitting; the composer empties then.
      await waitFor(() => expect(calls).toContain('draft:2:'))
      expect(composer).toHaveValue('')
      refuse(update)

      const pending = await screen.findByRole('article', { name: 'Pending message' })
      expect(pending.querySelector('.thread-message__status')).toHaveTextContent('Not sent')
      expect(within(pending).getByText('Codex did not take this message.')).toBeVisible()
      expect(within(pending).getByText('Codex could not start this turn.')).not.toBeVisible()
      expect(within(pending).queryByText(/Edit it in the composer/u)).not.toBeInTheDocument()
      expect(composer).toHaveValue('')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      expect(bridge.send).toHaveBeenCalledTimes(1)

      fireEvent.click(within(pending).getByRole('button', { name: 'Edit in composer' }))
      expect(composer).toHaveValue('$brainstorm a quiet October')
      expect(composer).toHaveFocus()
      await waitFor(() => expect(calls).toContain('draft:3:$brainstorm a quiet October'))
      expect(bridge.saveDraft.mock.calls.at(-1)![0].skills).toEqual([BRAINSTORM])
      expect(within(pending).queryByRole('button', { name: 'Edit in composer' })).not.toBeInTheDocument()
      expect(within(pending).getByText('It is in the composer.')).toBeVisible()
      expect(bridge.send).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    })

    it('gives a long diagnostic a short reason, keeps it whole behind Details, and still recovers after a newer draft', async () => {
      const diagnostic = String.raw`EPERM: operation not permitted, rename 'C:\Users\zache\AppData\Local\Temp\sotto-e2e-phase3-ui-failed-send-Xy12\e2e-personal-native.json.tmp-4812-1757790000000' -> 'C:\Users\zache\AppData\Local\Temp\sotto-e2e-phase3-ui-failed-send-Xy12\e2e-personal-native.json'`
      const { bridge, calls, update } = mount(snapshot({ chats: [chat({ draft: { revision: 1, text: '$brainstorm a quiet October', skills: [BRAINSTORM] } })] }))
      const composer = await screen.findByRole('textbox', { name: 'Message' })
      fireEvent.keyDown(composer, { key: 'Enter' })
      await waitFor(() => expect(calls).toContain('draft:2:'))
      fireEvent.change(composer, { target: { value: 'Somewhere cheap too' } })
      // The refusal arrives later, from main, after the send was accepted.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
      act(() => { update('trip', item => { const last = item.submissions.at(-1)!; last.status = 'failed'; last.error = diagnostic }) })

      const pending = await screen.findByRole('article', { name: 'Pending message' })
      expect(within(pending).getByText('$brainstorm a quiet October')).toBeVisible()
      expect(within(pending).getByText('Codex did not take this message.')).toBeVisible()
      const raw = within(pending).getByText(diagnostic)
      expect(raw).not.toBeVisible()
      expect(within(pending).getAllByText(/EPERM/u)).toHaveLength(1)
      const summary = within(pending).getByText('Details')
      expect(summary.tagName).toBe('SUMMARY')
      // Edit in composer comes before Details in the reading and tab order.
      const edit = within(pending).getByRole('button', { name: 'Edit in composer' })
      expect(edit.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

      fireEvent.click(summary)
      expect(summary.closest('details')).toHaveAttribute('open')
      expect(raw).toBeVisible()
      expect(bridge.send).toHaveBeenCalledTimes(1)
      expect(composer).toHaveValue('Somewhere cheap too')

      fireEvent.click(edit)
      expect(composer).toHaveValue('Somewhere cheap too\n\n$brainstorm a quiet October')
      await waitFor(() => expect(bridge.saveDraft.mock.calls.at(-1)![0]).toEqual({ chatId: 'trip', revision: 4, text: 'Somewhere cheap too\n\n$brainstorm a quiet October', skills: [BRAINSTORM] }))
      // The diagnostic stays with the card after recovery, for whoever investigates.
      expect(within(pending).getByText(diagnostic)).toBeVisible()
      expect(bridge.send).toHaveBeenCalledTimes(1)
    })

    it('keeps a draft typed while it was sending, and adds the message after it', async () => {
      const { bridge, calls, update } = mount(snapshot({ chats: [chat({ draft: { revision: 1, text: '$brainstorm a quiet October', skills: [BRAINSTORM] } })] }))
      const composer = await screen.findByRole('textbox', { name: 'Message' })
      fireEvent.keyDown(composer, { key: 'Enter' })
      await waitFor(() => expect(calls).toContain('draft:2:'))
      fireEvent.change(composer, { target: { value: 'Somewhere cheap too' } })
      refuse(update)
      expect(composer).toHaveValue('Somewhere cheap too')

      fireEvent.click(within(await screen.findByRole('article', { name: 'Pending message' })).getByRole('button', { name: 'Edit in composer' }))
      expect(composer).toHaveValue('Somewhere cheap too\n\n$brainstorm a quiet October')
      await waitFor(() => expect(bridge.saveDraft.mock.calls.at(-1)![0]).toEqual({ chatId: 'trip', revision: 4, text: 'Somewhere cheap too\n\n$brainstorm a quiet October', skills: [BRAINSTORM] }))
      expect(bridge.send).toHaveBeenCalledTimes(1)
    })

    it('offers the same recovery for a refusal saved before a restart', async () => {
      const { bridge } = mount(snapshot({ chats: [chat({ draft: { revision: 5, text: '', skills: [] },
        submissions: [{ id: 's4', messageId: 'm4', revision: 4, text: 'Book the cabin', skills: [], status: 'failed', error: 'Codex could not start this turn.', createdAt: AT }] })] }))
      const composer = await screen.findByRole('textbox', { name: 'Message' })
      expect(composer).toHaveValue('')
      fireEvent.click(within(screen.getByRole('article', { name: 'Pending message' })).getByRole('button', { name: 'Edit in composer' }))
      expect(composer).toHaveValue('Book the cabin')
      await waitFor(() => expect(bridge.saveDraft).toHaveBeenCalledWith({ chatId: 'trip', revision: 6, text: 'Book the cabin', skills: [] }))
      expect(bridge.send).not.toHaveBeenCalled()
    })

    it('adds only the missing skill when the composer already has the message as its own paragraph', async () => {
      const { bridge } = mount(snapshot({ chats: [chat({ draft: { revision: 5, text: 'Somewhere cheap too\n\n$brainstorm a quiet October', skills: [] },
        submissions: [{ id: 's4', messageId: 'm4', revision: 4, text: '$brainstorm a quiet October', skills: [BRAINSTORM], status: 'failed', error: 'Codex could not start this turn.', createdAt: AT }] })] }))
      const composer = await screen.findByRole('textbox', { name: 'Message' })
      const pending = screen.getByRole('article', { name: 'Pending message' })
      expect(within(pending).queryByText('It is in the composer.')).not.toBeInTheDocument()

      fireEvent.click(within(pending).getByRole('button', { name: 'Edit in composer' }))
      expect(composer).toHaveValue('Somewhere cheap too\n\n$brainstorm a quiet October')
      await waitFor(() => expect(bridge.saveDraft).toHaveBeenCalledWith({ chatId: 'trip', revision: 6, text: 'Somewhere cheap too\n\n$brainstorm a quiet October', skills: [BRAINSTORM] }))
      expect(within(pending).getByText('It is in the composer.')).toBeVisible()
      expect(bridge.send).not.toHaveBeenCalled()
    })

    it('does not count a short message found inside other words as being in the composer', async () => {
      const { bridge } = mount(snapshot({ chats: [chat({ draft: { revision: 5, text: 'Gondola rides', skills: [] },
        submissions: [{ id: 's4', messageId: 'm4', revision: 4, text: 'Go', skills: [], status: 'failed', error: 'Codex could not start this turn.', createdAt: AT }] })] }))
      const composer = await screen.findByRole('textbox', { name: 'Message' })
      const pending = screen.getByRole('article', { name: 'Pending message' })
      expect(within(pending).queryByText('It is in the composer.')).not.toBeInTheDocument()

      fireEvent.click(within(pending).getByRole('button', { name: 'Edit in composer' }))
      expect(composer).toHaveValue('Gondola rides\n\nGo')
      await waitFor(() => expect(bridge.saveDraft).toHaveBeenCalledWith({ chatId: 'trip', revision: 6, text: 'Gondola rides\n\nGo', skills: [] }))
      expect(within(pending).getByText('It is in the composer.')).toBeVisible()
      expect(bridge.send).not.toHaveBeenCalled()
    })
  })

  it('restores an unsent draft, and starts empty when the saved draft was already sent', async () => {
    const unsent = mount(snapshot({ chats: [chat({ draft: { revision: 3, text: 'Half a thought', skills: [] } })] }))
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Half a thought')
    unsent.view.unmount()
    mount(snapshot({ chats: [chat({ draft: { revision: 3, text: 'Sent already', skills: [] },
      submissions: [{ id: 's3', messageId: 'u1', revision: 3, text: 'Sent already', skills: [], status: 'accepted', createdAt: AT }] })] }))
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('')
  })

  it('holds sending while disconnected, running or unconfirmed, with the one action that moves it on', async () => {
    const { bridge, update, publish, state } = mount(snapshot({ connected: false, chats: [chat({ draft: { revision: 1, text: 'Next idea', skills: [] } })] }))
    await screen.findByRole('textbox', { name: 'Message' })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.getByText('Connect Codex to send. Your draft stays here.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Codex' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())

    act(() => { update('trip', item => { item.status = 'running' }) })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(bridge.interrupt).toHaveBeenCalledWith('trip'))

    act(() => { publish({ ...state(), chats: [chat({ draft: { revision: 1, text: 'Next idea', skills: [] }, submissions: [{ id: 's0', messageId: 'lost', revision: 0, text: 'Did this arrive?', skills: [], status: 'uncertain', createdAt: AT }] })] }) })
    expect(screen.getByText('Your last message is unconfirmed. Refresh this chat to check before sending more.')).toBeVisible()
    const pending = screen.getByRole('article', { name: 'Pending message' })
    expect(within(pending).getByText(/will not send it twice/u)).toBeVisible()
    fireEvent.click(within(pending).getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(bridge.refresh).toHaveBeenCalledWith('trip'))
    expect(within(screen.getByRole('navigation', { name: 'Chats' })).getByText('Unconfirmed message')).toBeVisible()
  })

  it('answers a native permission by its exact choice, and a plain question from the composer', async () => {
    const permission = { id: 'net', kind: 'permission' as const, text: 'Fetch a page', options: [],
      permissionChoices: [{ id: 'once', label: 'Allow once', kind: 'allow-once' as const }, { id: 'no', label: 'Deny', kind: 'deny' as const }] }
    const { bridge, update } = mount(snapshot({ chats: [chat({ status: 'running', requests: [permission] })] }))
    const card = (await screen.findByRole('button', { name: 'Allow once' })).closest('section')!
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.getByText('Answer the request above to continue.')).toBeVisible()
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(bridge.answer).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'trip', requestId: 'net', permissionChoice: 'once', approved: true })))

    act(() => { update('trip', item => { item.requests = [{ id: 'why', kind: 'question', text: 'What budget should I plan for?', options: [] }] }) })
    const answer = screen.getByRole('textbox', { name: 'Your answer' })
    fireEvent.click(screen.getByRole('button', { name: 'Write an answer' }))
    expect(answer).toHaveFocus()
    fireEvent.change(answer, { target: { value: 'Under a thousand' } })
    fireEvent.keyDown(answer, { key: 'Enter' })
    await waitFor(() => expect(bridge.answer).toHaveBeenLastCalledWith({ chatId: 'trip', requestId: 'why', answer: 'Under a thousand' }))
    expect(bridge.send).not.toHaveBeenCalled()
  })

  it('shows a refused answer in its card and holds an unconfirmed one until a refresh clears it', async () => {
    const question = { id: 'pick', kind: 'question' as const, text: 'Which?', options: [{ id: 'a', label: 'Coast' }, { id: 'b', label: 'Hills' }] }
    const { bridge, update } = mount(snapshot({ chats: [chat({ requests: [question] })] }))
    bridge.answer.mockRejectedValueOnce(new Error("Error invoking remote method 'personal-chat:command': Error: This request is no longer pending in this conversation."))
    fireEvent.click(await screen.findByRole('button', { name: 'Coast' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^This request is no longer pending in this conversation\.$/u)

    act(() => { update('trip', item => { item.decisions = [{ id: 'd1', requestId: 'pick', answer: 'b', createdAt: AT, status: 'uncertain' }] }) })
    expect(screen.getByText(/arrival could not be confirmed/u)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Hills' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(bridge.refresh).toHaveBeenCalledWith('trip'))
  })

  it('picks a native Codex skill with the keyboard and saves it with the draft', async () => {
    const { bridge } = mount(snapshot())
    const composer = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(composer, { target: { value: '$brain', selectionStart: 6, selectionEnd: 6 } })
    fireEvent.select(composer)
    expect(await screen.findByRole('option', { name: /\$brainstorm/u })).toBeVisible()
    expect(bridge.skills).toHaveBeenCalledWith('trip', false)
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(composer).toHaveValue('$brainstorm '))
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(bridge.send).toHaveBeenCalled())
    const saved = bridge.saveDraft.mock.calls.map(([input]) => input).find(input => input.text === '$brainstorm ')
    expect(saved?.skills).toEqual([expect.objectContaining({ name: 'brainstorm', path: '/skills/brainstorm/SKILL.md' })])
  })

  it('keeps saved chats readable when new chats are unavailable, and points to the coordinator setting', async () => {
    const onOpenCoordinatorSettings = vi.fn()
    const reason = 'Personal conversations with this coordinator are unavailable. Choose a native coordinator.'
    const second = chat({ id: 'garden', title: 'Garden plan', messages: [] })
    const { bridge } = mount(snapshot({ availability: { provider: 'unsupported', supported: false, reason }, chats: [chat(), second] }), { onOpenCoordinatorSettings })
    expect(await screen.findByText(reason)).toBeVisible()
    expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Coordinator settings' }))
    expect(onOpenCoordinatorSettings).toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Trip ideas' })).toBeVisible()
    expect(screen.getByText('fall colour')).toBeVisible()

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Chats' })).getByRole('button', { name: /Garden plan/u }))
    await waitFor(() => expect(bridge.select).toHaveBeenCalledWith('garden'))
    expect(await screen.findByRole('heading', { name: 'Garden plan' })).toBeVisible()
  })
})


it.each([['claude', 'Claude'], ['grok', 'Grok']] as const)('uses the saved %s identity throughout the composer and connection controls', async (providerId, label) => {
  const selected = chat({ providerId, modelId: `${providerId}:native-model` })
  mount(snapshot({ chats: [selected], connected: false, availability: { provider: 'codex', supported: true } }))
  expect(await screen.findByPlaceholderText(`Reply to ${label}`)).toBeVisible()
  expect(screen.getByRole('button', { name: `Connect ${label}` })).toBeVisible()
  expect(screen.getByText(`${label} disconnected`)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Connect Codex' })).not.toBeInTheDocument()
})


it.each(['codex', 'claude', 'grok'] as const)('dictation stays in its captured %s draft after selecting another chat and cannot send or answer', async providerId => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const original = chat({ providerId, draft: { revision: 0, text: 'Typed thought', skills: [] } })
  const other = chat({ id: 'other', title: 'Other chat', providerId })
  const h = mount(snapshot({ chats: [original, other] }))
  await screen.findByRole('textbox', { name: 'Message' })
  const deliver = captureDictationDestination()!
  expect(deliver).toBeDefined()
  await act(async () => { await h.bridge.select('other') })
  await act(async () => { await deliver({ text: 'Create a project and approve it.', autoPaste: true, pasteDelayMs: 0 }) })
  expect(h.bridge.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'trip', text: 'Typed thought\nCreate a project and approve it.' }))
  expect(h.bridge.send).not.toHaveBeenCalled()
  expect(h.bridge.answer).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  vi.restoreAllMocks()
})
