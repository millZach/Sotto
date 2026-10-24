import { promptText, setPromptText } from './helpers/promptEditor'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentCommand, AgentProviderStatus, AgentRuntimeMode, AgentState, AgentThread, HandoverCounts } from '../../../src/shared/agents'
import type { ContinueBridge, ContinueRead, ContinueStart, ContinueStartRequest } from '../../../src/shared/continueThread'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { claudeUsageLimitSentence } from '../../../src/shared/limitStops'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { continueStore } from '../../../src/renderer/src/agents/continuations'
import { replyQuoteStore } from '../../../src/renderer/src/agents/replyQuotes'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'
import { openPaneMenu, paneMenuItems } from '../../fixtures/renderer/paneMenu'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

/**
 * Continuing a thread on another provider in the window (ADR-0089, #1027; Zach's pick B, in place): the chips under a
 * usage-limit stop and the model chip begin it, the composer becomes "Continue on Codex" under a strip, and the first
 * message goes to main's bridge, which makes the new thread. Each thread links to the other. Stable shows none of it.
 */
const SOURCE = 'wav-preview'
const CONTINUED = 'wav-preview-codex'
const at = (minutes: number): string => new Date(E2E_THREADS_NOW - minutes * 60_000).toISOString()
const counts: HandoverCounts = { total: 4, carried: 3, tooLong: 1, notCarried: 0, images: 1, files: 0, visuals: 0, toolRecords: 9, historyKept: true, answered: false }
const WORDS = 'This is a handover from another Sotto thread. The history below is context, not a new request.\n\nThe user, 2026-07-12 11:51 UTC:\nThe WAV preview stalls.'
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
const status = (id: AgentProviderStatus['id'], name: string, patch: Partial<AgentProviderStatus> = {}): AgentProviderStatus => ({ id, connection: 'connected', name, version: '1', capabilities, ...patch })

function stopped(patch: Partial<AgentThread> = {}): AgentThread {
  const turn: AgentActivity = { id: 'turn-limit', turnId: 'ask', sequence: 1, afterMessageId: 'ask', kind: 'turn', status: 'failed', title: 'Turn',
    error: claudeUsageLimitSentence('6pm'), startedAt: at(20), completedAt: at(19) }
  return { id: SOURCE, projectId: 'workshop', title: 'WAV preview stall', modelId: 'claude:sonnet', providerId: 'claude', status: 'error', requests: [],
    messages: [{ id: 'first', role: 'user', text: 'The WAV preview stalls after two seconds. Find out why.', createdAt: at(60) },
      { id: 'answer', role: 'assistant', text: 'Fixed: the length marker is patched after every chunk.', createdAt: at(55) },
      { id: 'ask', role: 'user', text: 'Also add a test for a stream that ends mid-chunk.', createdAt: at(20) }],
    activities: [turn], updatedAt: at(19), worktree: { mode: 'shared', status: 'ready', path: 'C:/workshop', branch: 'main' }, workingDirectory: 'C:/workshop', ...patch }
}

function stateWith(threads: AgentThread[], options: { readonly grok?: 'signed-out' | 'connected'; readonly newThreadRuntimeMode?: AgentRuntimeMode } = {}): AgentState {
  const state = threadsStateFixture()
  state.configuration = { ...state.configuration, enabledProviders: ['claude', 'codex', 'grok'], newThreadRuntimeMode: options.newThreadRuntimeMode ?? 'approval-required' }
  state.host.capabilities = capabilities
  state.host.models = [
    { id: 'claude:sonnet', provider: 'Claude Code', providerId: 'claude', name: 'Sonnet 4.5', ready: true, runtimeModes: ['approval-required', 'full-access'] },
    { id: 'codex:gpt', provider: 'Codex', providerId: 'codex', name: 'GPT-5.4', ready: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', runtimeModes: ['approval-required', 'auto-accept-edits'] },
    { id: 'codex:mini', provider: 'Codex', providerId: 'codex', name: 'GPT-5.4 mini', ready: true, runtimeModes: ['approval-required'] },
    { id: 'grok:4', provider: 'Grok Build', providerId: 'grok', name: 'Grok 4.6', ready: options.grok === 'connected', runtimeModes: ['approval-required'] },
  ]
  state.host.providers = [status('claude', 'Claude Code'), status('codex', 'Codex'),
    status('grok', 'Grok Build', options.grok === 'connected' ? {} : { connection: 'disconnected', problem: 'signed-out' })]
  state.host.threads = [...threads, ...state.host.threads]
  state.activeThreadId = threads[0]!.id
  state.activeProjectId = 'workshop'
  return state
}

function fakeBridge() {
  const bridge = {
    read: vi.fn(async ({ words }: { threadId: string; words?: boolean }): Promise<ContinueRead> => ({ status: 'ok', counts, ...(words ? { text: WORDS } : {}) })),
    start: vi.fn(async (request: ContinueStartRequest): Promise<ContinueStart> => { void request; return { status: 'ok', threadId: CONTINUED } }),
  }
  return bridge as ContinueBridge & typeof bridge
}

function mount(threads: AgentThread[] = [stopped()], options: { readonly owl?: boolean; readonly bridge?: boolean; readonly grok?: 'signed-out' | 'connected'; readonly newThreadRuntimeMode?: AgentRuntimeMode } = {}) {
  const on = options.owl !== false
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { owlFeatures: { 'continue-on-provider': on, 'reply-quote': on } },
    actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
  const bridge = fakeBridge()
  Object.assign(window, { sotto: options.bridge === false ? {} : { continueThread: bridge } })
  const state = stateWith(threads, options)
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={E2E_THREADS_NOW} />)
  return { live, bridge, prompt: () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLElement }
}

const requests = <T extends AgentCommand['type']>(live: ReturnType<typeof liveAgentState>, type: T): Extract<AgentCommand, { type: T }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)
const chips = () => screen.queryByRole('group', { name: 'Continue now on another provider' })
const strip = () => screen.queryByRole('region', { name: /^Continue on / })

const clearQuotes = (): void => replyQuoteStore.sent(SOURCE, replyQuoteStore.list(SOURCE).map(quote => quote.id))
beforeEach(() => { vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalApp).mockReset(); continueStore.set(SOURCE, undefined); clearQuotes() })
afterEach(() => { cleanup(); continueStore.set(SOURCE, undefined); clearQuotes(); delete (window as { sotto?: unknown }).sotto })

describe('under a usage-limit stop', () => {
  it('offers each other connected provider on its default model, and one that is not signed in with why', () => {
    mount()
    const group = chips()!
    expect(group).toHaveTextContent('Or continue now on')
    const codex = within(group).getByRole('button', { name: 'Continue on Codex, GPT-5.4' })
    expect(codex).toHaveAttribute('aria-pressed', 'false')
    const grok = within(group).getByRole('button', { name: 'Grok Build: Grok Build isn’t signed in. Sign in under Settings → Providers to continue there.' })
    expect(grok).toHaveAttribute('aria-disabled', 'true')
    expect(grok).toHaveTextContent('Grok Build· not signed in')
    // Codex has a second model, so More offers the rest.
    expect(within(group).getByRole('button', { name: 'More models to continue on' })).toBeInTheDocument()
    // The thread's own provider is never offered.
    expect(within(group).queryByRole('button', { name: /Claude/ })).toBeNull()
  })

  it('offers nothing for another error, while a turn runs, or once the thread was continued since', () => {
    mount([stopped({ activities: [{ ...stopped().activities![0]!, error: 'Claude’s servers were busy or had a problem, so this turn stopped.' }] })])
    expect(chips()).toBeNull()
    cleanup()
    mount([stopped({ status: 'running', lastTurn: { id: 'ask', status: 'running' } })])
    expect(chips()).toBeNull()
    cleanup()
    mount([stopped({ continuedIn: [{ threadId: CONTINUED, provider: 'codex', at: at(10) }] })])
    expect(chips()).toBeNull()
  })

  it('shows nothing on stable, or where main offered no bridge', () => {
    mount([stopped()], { owl: false })
    expect(chips()).toBeNull()
    cleanup()
    mount([stopped()], { bridge: false })
    expect(chips()).toBeNull()
  })
})

describe('the composer while continuing', () => {
  it('becomes Continue on Codex under a strip that says where the new thread works and what the handover carries', async () => {
    const { bridge, prompt } = mount()
    fireEvent.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    const region = strip()!
    expect(region).toHaveAccessibleName('Continue on Codex')
    expect(region).toHaveTextContent('Sending starts a new Codex thread with a handover of this one.')
    expect(within(region).getByRole('combobox', { name: 'Where the new thread works' })).toHaveTextContent('Same folder')
    expect(region).toHaveTextContent('This computer')
    await waitFor(() => expect(region).toHaveTextContent('Handover first: it carries 3 of 4 messages and leaves out 1 message too long to carry, 1 image and 9 records of its work.'))
    expect(bridge.read).toHaveBeenCalledWith({ threadId: SOURCE })
    // The composer writes the new thread's first message, on Codex's model, effort and the new-thread permission.
    expect(prompt()).toHaveAttribute('data-placeholder', 'What should Codex do next? It goes after the handover.')
    expect(screen.getByRole('combobox', { name: 'Model the new thread starts on' })).toHaveTextContent('GPT-5.4')
    expect(screen.getByRole('combobox', { name: 'Permissions the new thread starts on' })).toHaveTextContent('Ask for approval')
    expect(screen.getByRole('button', { name: 'Continue on Codex' })).toBeDisabled()
    // The chip that began it says so.
    expect(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' })).toHaveAttribute('aria-pressed', 'true')
    // Focus goes to the composer, to write the first message.
    expect(prompt()).toHaveFocus()
  })

  it('sends the draft to main, which makes the new thread, then opens it and empties this composer', async () => {
    const { live, bridge, prompt } = mount()
    fireEvent.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    setPromptText(prompt(), 'Carry on with the mid-chunk test.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Codex' }))
    await waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(1))
    const [request] = bridge.start.mock.calls[0]!
    expect(request).toEqual({ threadId: SOURCE, newThreadId: expect.stringMatching(/^[0-9a-f-]{36}$/u), modelId: 'codex:gpt', reasoningEffort: 'high',
      runtimeMode: 'approval-required', workingCopy: 'same', draftId: expect.stringMatching(/^[0-9a-f-]{36}$/u), text: 'Carry on with the mid-chunk test.' })
    await waitFor(() => expect(requests(live, 'select-thread')).toEqual([{ type: 'select-thread', threadId: CONTINUED }]))
    expect(strip()).toBeNull()
    expect(promptText(prompt())).toBe('')
    // Nothing went to this thread itself.
    expect(requests(live, 'manual-send')).toEqual([])
  })

  it('starts the new thread in a new worktree from the source’s branch when chosen', async () => {
    const user = userEvent.setup()
    const { bridge, prompt } = mount()
    await user.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    const where = within(strip()!).getByRole('combobox', { name: 'Where the new thread works' })
    await user.click(where)
    const list = screen.getByRole('listbox', { name: 'Where the new thread works' })
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual([
      'Same folderThis thread’s project folder, on main. Both threads change the same files.',
      'New worktree from mainStarts from main’s last commit. Uncommitted changes stay where they are.'])
    await user.click(within(list).getByRole('option', { name: /^New worktree from main/u }))
    expect(where).toHaveTextContent('New worktree from main')
    expect(where).toHaveFocus()
    setPromptText(prompt(), 'Carry on.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Codex' }))
    await waitFor(() => expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({ workingCopy: 'new-worktree' })))
  })

  it('starts on the source’s permission, says so when the new-thread default narrows it, and a choice in the composer wins', async () => {
    const { bridge, prompt } = mount([stopped({ runtimeMode: 'auto-accept-edits' })])
    fireEvent.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    // The source is on Allow edits; the new-thread default, Ask for approval, caps it.
    expect(screen.getByRole('combobox', { name: 'Permissions the new thread starts on' })).toHaveTextContent('Ask for approval')
    expect(strip()).toHaveTextContent('It starts on Ask for approval, not this thread’s Allow edits, since your new-thread default allows no more. You can change it below.')
    await userEvent.setup().click(screen.getByRole('combobox', { name: 'Permissions the new thread starts on' }))
    await userEvent.setup().click(screen.getByRole('option', { name: /^Allow edits/u }))
    expect(screen.getByRole('combobox', { name: 'Permissions the new thread starts on' })).toHaveTextContent('Allow edits')
    expect(strip()).not.toHaveTextContent('It starts on')
    setPromptText(prompt(), 'Carry on.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Codex' }))
    await waitFor(() => expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({ runtimeMode: 'auto-accept-edits' })))
  })

  it('starts on the source’s own permission where the default allows it', () => {
    mount([stopped({ runtimeMode: 'auto-accept-edits' })], { newThreadRuntimeMode: 'full-access' })
    fireEvent.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    expect(screen.getByRole('combobox', { name: 'Permissions the new thread starts on' })).toHaveTextContent('Allow edits')
    expect(strip()).not.toHaveTextContent('It starts on')
  })

  it('keeps the draft and says why in the strip when main refuses, and a retry names the same new thread', async () => {
    const { bridge, prompt } = mount()
    bridge.start.mockResolvedValueOnce({ status: 'refused', message: 'Codex didn’t take the first message, so nothing was sent. Check it under Settings → Providers, then continue again.' })
    fireEvent.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    setPromptText(prompt(), 'Carry on.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Codex' }))
    expect(await within(strip()!).findByRole('alert')).toHaveTextContent('Codex didn’t take the first message, so nothing was sent.')
    expect(promptText(prompt())).toBe('Carry on.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Codex' }))
    await waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(2))
    expect(bridge.start.mock.calls[1]![0].newThreadId).toBe(bridge.start.mock.calls[0]![0].newThreadId)
  })

  it('carries a reply quote once however many times a refused continuation is tried, and takes it off once it starts', async () => {
    const { bridge, prompt } = mount()
    bridge.start.mockResolvedValueOnce({ status: 'refused', message: 'Codex didn’t take the first message, so nothing was sent. Check it under Settings → Providers, then continue again.' })
    act(() => { replyQuoteStore.add(SOURCE, { messageId: 'answer', text: 'the length marker is patched' }) })
    fireEvent.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    setPromptText(prompt(), 'Carry on.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Codex' }))
    expect(await within(strip()!).findByRole('alert')).toHaveTextContent('nothing was sent')
    // Refused, the draft and the chip are as they were.
    expect(promptText(prompt())).toBe('Carry on.')
    expect(replyQuoteStore.list(SOURCE)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Codex' }))
    await waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(2))
    const sent = 'From your earlier reply:\n> the length marker is patched\n\nCarry on.'
    expect(bridge.start.mock.calls.map(([request]) => request.text)).toEqual([sent, sent])
    await waitFor(() => expect(replyQuoteStore.list(SOURCE)).toEqual([]))
  })

  it('reads the handover on request; Escape folds it, then puts the continuation away and returns to the composer', async () => {
    const user = userEvent.setup()
    const { bridge, prompt } = mount()
    await user.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    const region = strip()!
    await user.click(within(region).getByRole('button', { name: 'Read it' }))
    const words = await within(region).findByRole('region', { name: 'The handover, word for word' })
    expect(words).toHaveTextContent('The history below is context, not a new request.')
    expect(bridge.read).toHaveBeenLastCalledWith({ threadId: SOURCE, words: true })
    words.focus()
    await user.keyboard('{Escape}')
    expect(within(region).queryByRole('region', { name: 'The handover, word for word' })).toBeNull()
    expect(within(region).getByRole('button', { name: 'Read it' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(strip()).toBeNull()
    expect(prompt()).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeInTheDocument()
    expect(bridge.start).not.toHaveBeenCalled()
  })

  it('puts the continuation away from X, and from Escape in the composer once nothing open there takes the key', async () => {
    const user = userEvent.setup()
    const { prompt } = mount()
    await user.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    await user.click(within(strip()!).getByRole('button', { name: 'Don’t continue: keep writing to this thread' }))
    expect(strip()).toBeNull()
    expect(prompt()).toHaveFocus()
    await user.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    await user.keyboard('{Escape}')
    expect(strip()).toBeNull()
  })

  it('leaves the continuation when Escape closes the model picker or a chip’s list in the composer', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    const model = screen.getByRole('combobox', { name: 'Model the new thread starts on' })
    await user.click(model)
    const dialog = screen.getByRole('dialog', { name: 'Choose model' })
    // The key reaches the window before the dialog's own cancel, which a browser fires after it and jsdom does not.
    await user.keyboard('{Escape}')
    fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }))
    expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull()
    expect(strip()).toBeInTheDocument()
    const permissions = screen.getByRole('combobox', { name: 'Permissions the new thread starts on' })
    await user.click(permissions)
    await user.keyboard('{Escape}')
    expect(permissions).toHaveFocus()
    expect(strip()).toBeInTheDocument()
  })

  it('keeps words written while main started the new thread, and an answer it lost keeps the draft and says so', async () => {
    const { bridge, prompt } = mount()
    let finish: (result: ContinueStart) => void = () => undefined
    bridge.start.mockImplementationOnce(() => new Promise(done => { finish = done }))
    fireEvent.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    setPromptText(prompt(), 'Carry on.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Codex' }))
    await waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Starting the Codex thread…')).toBeInTheDocument()
    setPromptText(prompt(), 'Carry on. And one more thing.')
    await act(async () => { finish({ status: 'ok', threadId: CONTINUED }) })
    expect(promptText(prompt())).toBe('Carry on. And one more thing.')
    cleanup()
    const again = mount()
    again.bridge.start.mockRejectedValueOnce(new Error('lost'))
    fireEvent.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    setPromptText(again.prompt(), 'Carry on.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Codex' }))
    expect(await within(strip()!).findByRole('alert')).toHaveTextContent('Sotto could not confirm whether the Codex thread started. Your message is kept here.')
    expect(promptText(again.prompt())).toBe('Carry on.')
  })

  it('offers only a new worktree where the thread’s own worktree was put away', async () => {
    const { bridge, prompt } = mount([stopped({ worktree: { mode: 'independent', status: 'ready', branch: 'sotto/wav', reclaimedAt: at(30) } })])
    fireEvent.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    expect(within(strip()!).queryByRole('combobox', { name: 'Where the new thread works' })).toBeNull()
    expect(strip()).toHaveTextContent('New worktree from sotto/wav')
    setPromptText(prompt(), 'Carry on.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Codex' }))
    await waitFor(() => expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({ workingCopy: 'new-worktree' })))
  })

  it('refuses a draft with skills, which are this provider’s own', async () => {
    const { live, prompt } = mount()
    fireEvent.click(within(chips()!).getByRole('button', { name: 'Continue on Codex, GPT-5.4' }))
    act(() => { live.threadDrafts.edit(SOURCE, { text: 'Use it.', skills: [{ name: 'review', path: 'C:/skills/review/SKILL.md' }] as never }) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue on Codex' })).toBeDisabled())
    expect(screen.getByText('Skills are Claude Code’s own. Remove them to continue on Codex.')).toBeInTheDocument()
    void prompt
  })
})

describe('the pane’s More menu', () => {
  const head = (): HTMLElement => document.querySelector('.thread-workspace__head')!

  it('begins the continuation with the model picker open on the other providers', async () => {
    mount([stopped({ activities: [], status: 'idle' })])
    const menu = openPaneMenu(head())
    expect(paneMenuItems(menu)).toContain('Continue on another provider…')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Continue on another provider…' }))
    expect(strip()).toHaveAccessibleName('Continue on Codex')
    expect(await screen.findByRole('dialog', { name: 'Choose model' })).toHaveTextContent('Your first message starts a new thread on the model you pick, with a handover of this one.')
  })

  it('lists it disabled with why while a turn runs, and not at all on stable', () => {
    mount([stopped({ activities: [], status: 'running', lastTurn: { id: 'ask', status: 'running' } })])
    const item = within(openPaneMenu(head())).getByRole('menuitem', { name: /^Continue on another provider…/u })
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', 'Wait for this turn to finish, or stop it. A handover carries finished turns.')
    cleanup()
    mount([stopped({ activities: [], status: 'idle' })], { owl: false })
    expect(paneMenuItems(openPaneMenu(head()))).not.toContain('Continue on another provider…')
  })
})

describe('the model chip of a started thread', () => {
  it('lists another provider’s models under Continue in a new thread on, and picking one begins the continuation', async () => {
    const user = userEvent.setup()
    mount([stopped({ activities: [], status: 'idle' })], { grok: 'connected' })
    expect(chips()).toBeNull()
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const picker = screen.getByRole('dialog', { name: 'Choose model' })
    await user.click(within(picker).getByRole('tab', { name: 'Codex' }))
    expect(picker).toHaveTextContent('Continue in a new thread on Codex')
    expect(picker).toHaveTextContent('Picking one starts a new thread there with a handover of this one. This thread stays as it is.')
    await user.click(within(picker).getByRole('option', { name: 'GPT-5.4 mini' }))
    expect(strip()).toHaveAccessibleName('Continue on Codex')
    expect(screen.getByRole('combobox', { name: 'Model the new thread starts on' })).toHaveTextContent('GPT-5.4 mini')
  })

  it('names a provider that cannot take the thread, with why', async () => {
    const user = userEvent.setup()
    mount([stopped({ activities: [], status: 'idle' })])
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const picker = screen.getByRole('dialog', { name: 'Choose model' })
    await user.click(within(picker).getByRole('tab', { name: 'Grok Build' }))
    expect(within(picker).getByRole('note')).toHaveTextContent('Grok Build isn’t signed in. Sign in under Settings → Providers to continue there.')
  })
})

describe('a continued thread’s row', () => {
  const lead = 'This is a handover from another Sotto thread. The history below is context, not a new request.'
  const prefix = `${lead}\n\n[End of the handover. The user’s message follows.]\n\n`
  const row = (continued: boolean, messageId = 'go') => {
    const state = stateWith([{ id: CONTINUED, projectId: 'workshop', title: 'WAV preview stall', modelId: 'codex:gpt', providerId: 'codex', status: 'running', requests: [], messages: [],
      continuedFrom: { threadId: SOURCE, provider: 'claude', at: at(10), handover: { prefixLength: prefix.length, prefixDigest: 'a'.repeat(64), counts, messageId } },
      summary: { messageCount: 1, activityCount: 0, lastMessageAt: at(10), lastUser: { id: 'go', text: `${prefix}Carry on with the mid-chunk test.`, createdAt: at(10) } } }])
    return describeThreads(state, E2E_THREADS_NOW, { continued }).find(item => item.thread.id === CONTINUED)!
  }

  it('says the user’s words, never the handover ahead of them', () => {
    expect(row(true).sentence).toBe('Working on “Carry on with the mid-chunk test.”.')
    // Only the message the record names is split; stable shows the record as it is.
    expect(row(true, 'another').sentence.startsWith(`Working on “${lead}`)).toBe(true)
    expect(row(false).sentence.startsWith(`Working on “${lead}`)).toBe(true)
  })
})

describe('the links between the two threads', () => {
  const continued = (): AgentThread => ({ id: CONTINUED, projectId: 'workshop', title: 'WAV preview stall', modelId: 'codex:gpt', providerId: 'codex', status: 'running', requests: [],
    lastTurn: { id: 'go', status: 'running' }, updatedAt: at(9),
    continuedFrom: { threadId: SOURCE, provider: 'claude', at: at(10), handover: { prefixLength: WORDS.length + 2, prefixDigest: 'a'.repeat(64), counts } },
    messages: [{ id: 'go', role: 'user', text: 'Carry on with the mid-chunk test.', createdAt: at(10), handover: { text: WORDS, provider: 'claude', counts } }] })

  it('opens the continued thread on the handover from the source, as Sotto’s, and a link back', () => {
    const { live } = mount([continued(), stopped({ continuedIn: [{ threadId: CONTINUED, provider: 'codex', at: at(10) }] })])
    const note = screen.getByText(/Continued from/u).closest('[role="note"]') as HTMLElement
    expect(note).toHaveTextContent('Continued from WAV preview stall on Claude Code. It stays readable there. Open it')
    const card = screen.getByRole('article', { name: 'Handover from WAV preview stall' })
    expect(card).toHaveTextContent('From WAV preview stall on Claude Code. Context, not a new request.')
    expect(card).toHaveTextContent('Carried 3 of 4 messages. Left out 1 message too long to carry, 1 image and 9 records of its work.')
    fireEvent.click(within(note).getByRole('button', { name: 'Open WAV preview stall, the thread this one continues' }))
    expect(requests(live, 'select-thread')).toEqual([{ type: 'select-thread', threadId: SOURCE }])
  })

  it('shows the source where it was continued, and that it can still be sent to once its limit resets', () => {
    const { live } = mount([stopped({ continuedIn: [{ threadId: CONTINUED, provider: 'codex', at: at(10) }] }), continued()])
    const note = screen.getByText(/Continued in/u, { selector: '.continue-note p' }).closest('[role="note"]') as HTMLElement
    expect(note).toHaveTextContent(/^Continued in WAV preview stall on Codex, .+, with a handover of this thread\. Open it$/u)
    expect(screen.getByText('Continued in a Codex thread. You can still send here once Claude’s limit resets at 6pm.')).toBeInTheDocument()
    fireEvent.click(within(note).getByRole('button', { name: 'Open WAV preview stall on Codex, the thread that continues this one' }))
    expect(requests(live, 'select-thread')).toEqual([{ type: 'select-thread', threadId: CONTINUED }])
  })

  it('shows neither link on stable', () => {
    mount([stopped({ continuedIn: [{ threadId: CONTINUED, provider: 'codex', at: at(10) }] }), continued()], { owl: false })
    expect(screen.queryByText(/Continued in/u)).toBeNull()
    expect(screen.queryByText(/You can still send here/u)).toBeNull()
  })
})
