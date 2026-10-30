import { promptText, setPromptText } from './helpers/promptEditor'
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState, AgentThread } from '../../../src/shared/agents'
import type { NextPrompt } from '../../../src/shared/nextPrompt'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import type { WatcherBridge, WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SidebarChromeProvider } from '../../../src/renderer/src/agents/SidebarFrame'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { nextPromptStore } from '../../../src/renderer/src/agents/nextPrompts'
import { WatcherRoomProvider } from '../../../src/renderer/src/watcher/watcherRoom'
import { roomView } from '../../../src/renderer/src/watcher/WatcherBeside'
import { WatcherView } from '../../../src/renderer/src/watcher/WatcherView'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'

const owl = vi.hoisted(() => ({ quiet: false }))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>()
  return { ...actual, useOwlFeature: (id: string) => id === 'quiet-composer' ? owl.quiet : id === 'next-prompt' || actual.useOwlFeature(id as never) }
})

/**
 * The next prompt in Watcher's composer (ADR-0132, October 26, 2026): after Watcher replies, its conversation offers the
 * next prompt as a ghost exactly as a thread's composer does, Tab takes it, and the same setting turns it off.
 */
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const WATCHER = 'watcher-a'
const at = new Date(E2E_THREADS_NOW).toISOString()
const said = [{ id: 'm1', role: 'user' as const, text: 'What is waiting on me?', createdAt: at }, { id: 'm2', role: 'assistant' as const, text: 'Two threads wait on you.', createdAt: at }]
const PROMPT: NextPrompt = {
  headline: 'Two threads wait on you.', ghost: 'Show me the first one',
  suggestions: [{ intent: 'continue', label: 'Open the first', text: 'Open the first thread that waits' }], answers: [],
}

function renderRoom(settings: AppSettings = DEFAULT_SETTINGS, quiet = false) {
  owl.quiet = quiet
  const thread: AgentThread = { id: WATCHER, kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'claude:sonnet', providerId: 'claude', hostId: HOST, status: 'idle', requests: [], messages: said }
  const state: AgentState = threadsStateFixture()
  state.hostId = HOST
  state.host.threads.push(thread)
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation: 'watcher', platform: 'win32', windowMaximized: false, settings,
    update: { watcherEnabled: true }, actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() },
  } as unknown as AppContextValue)
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  const connection = agentContextFixture(state, command, { threadDrafts: new ThreadDraftStore(command) })
  vi.mocked(useAgents).mockReturnValue(connection)
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  const room: WatcherRoomState = {
    current: { target: { hostId: HOST, threadId: WATCHER }, projectId: 'workshop', provider: 'claude', creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at },
    currentOptions: { modelId: 'claude:sonnet', reasoningEffort: null, runtimeMode: 'approval-required', status: 'idle', connected: true },
    history: [], runtimeMode: 'approval-required', standingWatches: [], ownChanges: [],
    requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: at, handover: null,
  }
  const bridge = { get: vi.fn(async () => ({ status: 'ok' as const, state: room })), onChanged: vi.fn(() => () => undefined) }
  nextPromptStore.apply({ threadId: WATCHER, afterUserMessageId: 'm1', prompt: PROMPT })
  render(<WatcherRoomProvider bridge={bridge as unknown as WatcherBridge}><SidebarChromeProvider updateControl={null}><WatcherView now={E2E_THREADS_NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
}

const prompt = async () => within(await screen.findByRole('region', { name: 'Watcher' })).findByRole('textbox', { name: 'Watcher message' })
const ghost = (): HTMLElement | null => document.querySelector('.prompt-editor__ghost')

beforeEach(() => {
  owl.quiet = false
  vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset()
  localStorage.clear(); roomView.set({ besideId: null, share: 0.5 })
})
afterEach(() => { cleanup(); localStorage.clear(); nextPromptStore.sent(WATCHER, '\u0000') })

describe('the next prompt in Watcher’s composer', () => {
  it.each([false, true])('shows the ghost, opens its list and completes it with quiet composer %s', async quiet => {
    renderRoom(DEFAULT_SETTINGS, quiet)
    const field = await prompt()
    expect(ghost()).toHaveTextContent('Show me the first oneTab')
    field.focus()
    expect(fireEvent.keyDown(field, { key: 'ArrowUp' })).toBe(false)
    expect(screen.getByRole('listbox', { name: 'Next prompts' })).toBeInTheDocument()
    expect(ghost()).toBeNull()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Next prompts' })).toBeNull()
    setPromptText(field, 'show me')
    expect(ghost()!.firstChild!.textContent).toBe(' the first one')
    expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(false)
    expect(promptText(field)).toBe('Show me the first one')
    expect(ghost()).toBeNull()
    expect(field).toHaveFocus()
  })

  it('offers nothing while Suggest a next prompt after each turn is off', async () => {
    renderRoom({ ...DEFAULT_SETTINGS, nextPromptSuggestions: false })
    await prompt()
    expect(ghost()).toBeNull()
  })
})
