import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRequest, AgentThread } from '../../../../src/shared/agents'
import type { PopupBridge } from '../../../../src/shared/popup'
import { DEFAULT_SETTINGS } from '../../../../src/shared/settings'
import type { WatcherRoomResult } from '../../../../src/shared/watcherRoom'
import { PopupApp } from '../../../../src/renderer/src/popup/PopupApp'
import { POPUP_MEMORY_KEY } from '../../../../src/renderer/src/popup/popupLogic'
import { MessageLinks } from '../../../../src/renderer/src/agents/requests/AgentRequestCard'
import { requestAnswerStore } from '../../../../src/renderer/src/agents/requests/requestAnswers'
import { agentThread, threadsStateFixture } from '../../../fixtures/agentState'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  // The popup must work without the main window's bridge or app context.
  vi.stubGlobal('sotto', undefined)
})
afterEach(() => {
  cleanup()
  requestAnswerStore.prune('thread', [])
  vi.unstubAllGlobals()
})

function mount(patch: Partial<AgentThread> = {}, watcher?: WatcherRoomResult) {
  const thread = agentThread(patch)
  const state = threadsStateFixture({ threads: [thread], projects: [{ id: thread.projectId }],
    topLevel: { activeThreadId: thread.id, activeProjectId: thread.projectId } })
  localStorage.setItem(POPUP_MEMORY_KEY, JSON.stringify({ target: 'thread', threadId: thread.id, projectId: thread.projectId }))
  let shown = (): void => undefined
  let update: (thread: AgentThread) => void = () => undefined
  const command = vi.fn<PopupBridge['command']>(async () => ({ ...state,
    host: { ...state.host, models: { revision: 1, omitted: true }, clientHosts: [] },
  }))
  const bridge: PopupBridge = {
    platform: 'darwin', getSettings: vi.fn(async () => DEFAULT_SETTINGS), onSettingsChanged: () => () => undefined,
    shell: vi.fn(async () => state), command,
    threadDetail: vi.fn(async () => ({ threadId: thread.id, revision: 1, messages: thread.messages, activities: [] })),
    onThread: listener => { update = listener; return () => undefined }, onThreadDetail: () => () => undefined,
    openExternalLink: vi.fn(async () => ({ ok: true })), hide: vi.fn(async () => undefined),
    fit: vi.fn(async () => undefined), open: vi.fn(async () => undefined),
    onShown: listener => { shown = listener; return () => undefined },
    ...(watcher ? { watcher: vi.fn(async () => watcher) } : {}),
  }
  vi.stubGlobal('sottoPopup', bridge)
  const view = render(<PopupApp bridge={bridge} />)
  return { bridge, command, view, thread, shown: () => act(shown), update: (next: AgentThread) => act(() => update(next)) }
}

const liveTurns: Partial<AgentThread>[] = [
  { status: 'running' },
  { status: 'idle', lastTurn: { id: 'turn', status: 'running' } },
]

describe('the popup running-turn affordances', () => {
  it.each(liveTurns)('uses the same running state for Stop, Escape, the owl and queueing: %j', async patch => {
    const f = mount(patch)
    const stop = await screen.findByRole('button', { name: 'Stop the running turn' })
    expect(screen.getByText('Esc stops it')).toBeVisible()
    expect(f.view.container.querySelector('.popup-owl')).toHaveClass('is-working')
    fireEvent.click(stop)
    expect(f.command).toHaveBeenCalledWith({ type: 'interrupt', threadId: 'thread' })
    f.command.mockClear()
    const prompt = screen.getByRole('textbox')
    fireEvent.keyDown(prompt, { key: 'Escape' })
    expect(f.command).toHaveBeenCalledWith({ type: 'interrupt', threadId: 'thread' })
    expect(f.bridge.hide).not.toHaveBeenCalled()
    fireEvent.change(prompt, { target: { value: 'Next prompt' } })
    fireEvent.keyDown(prompt, { key: 'Enter' })
    await waitFor(() => expect(f.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'queue-followup', text: 'Next prompt' })))
    expect(f.command.mock.calls.some(([command]) => command.type === 'manual-send')).toBe(false)
    f.update({ ...f.thread, status: 'idle', lastTurn: { id: 'turn', status: 'completed' } })
    expect(screen.queryByRole('button', { name: 'Stop the running turn' })).toBeNull()
    expect(f.view.container.querySelector('.popup-owl')).not.toHaveClass('is-working')
    fireEvent.keyDown(prompt, { key: 'Escape' })
    expect(f.bridge.hide).toHaveBeenCalledTimes(1)
  })

  it('queues behind a question at rest, and answers only on the user’s explicit send', async () => {
    const f = mount({ requests: [{ id: 'question', kind: 'question', text: 'Choose a path', options: [], questions: [
      { id: 'path', question: 'Which path?', options: [{ id: 'a', label: 'Path A' }], multiSelect: false, allowFreeText: false },
    ] }] })
    await screen.findByText('Which path?')
    expect(f.command.mock.calls.some(([command]) => command.type === 'answer')).toBe(false)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'After the answer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(f.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'queue-followup', text: 'After the answer' })))
    fireEvent.click(screen.getByRole('radio', { name: 'Path A' }))
    expect(f.command.mock.calls.some(([command]) => command.type === 'answer')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() => expect(f.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', requestId: 'question', threadId: 'thread' })))
  })

  it('sends normally at rest and gives the slash menu first Escape', async () => {
    const f = mount()
    const prompt = await screen.findByRole('textbox')
    await waitFor(() => expect(f.bridge.threadDetail).toHaveBeenCalled())
    fireEvent.change(prompt, { target: { value: '/' } })
    fireEvent.keyDown(prompt, { key: 'Escape' })
    expect(prompt).toHaveValue('')
    expect(f.bridge.hide).not.toHaveBeenCalled()
    fireEvent.change(prompt, { target: { value: 'Continue' } })
    fireEvent.keyDown(prompt, { key: 'Enter' })
    await waitFor(() => expect(f.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send', text: 'Continue' })))
  })
})

describe('links in popup request cards', () => {
  it.each([
    { id: 'question', kind: 'question', text: 'Read https://example.com/question', options: [] },
    { id: 'permission', kind: 'permission', text: 'Allow this?', options: [], permissionChoices: [
      { id: 'once', label: 'Allow once', kind: 'allow-once', description: 'Read https://example.com/permission' },
    ] },
  ] satisfies AgentRequest[])('opens a $kind link through the popup bridge without answering it', async request => {
    const f = mount({ requests: [request] })
    const link = await screen.findByRole('link')
    fireEvent.click(link)
    expect(f.bridge.openExternalLink).toHaveBeenCalledExactlyOnceWith(link.getAttribute('href'))
    expect(f.command.mock.calls.some(([command]) => command.type === 'answer')).toBe(false)
  })

  it('opens Markdown links in a permission plan with the popup bridge', async () => {
    const f = mount({ requests: [{ id: 'plan', kind: 'permission', text: '[Read the plan](https://example.com/plan)', options: [],
      context: { toolName: 'cursor/create_plan' } }] })
    fireEvent.click(await screen.findByRole('link', { name: 'Read the plan' }))
    await waitFor(() => expect(f.bridge.openExternalLink).toHaveBeenCalledExactlyOnceWith('https://example.com/plan'))
    expect(f.command.mock.calls.some(([command]) => command.type === 'answer')).toBe(false)
  })

  it('opens message-link rows through the same bridge', async () => {
    const f = mount()
    render(<MessageLinks links={['https://example.com/rows']} />)
    fireEvent.click(screen.getByRole('link', { name: 'Open the link, example.com/rows' }))
    expect(f.bridge.openExternalLink).toHaveBeenCalledExactlyOnceWith('https://example.com/rows')
  })

  it.each(['click', 'Enter'])('routes a prototype page to its owning thread by %s', async action => {
    const f = mount({ requests: [{ id: 'prototype', kind: 'question', text: 'Review the prototype', options: [],
      pages: [{ token: 'a'.repeat(32), kind: 'file', name: 'prototype.html', start: '' }] }] })
    const link = await screen.findByRole('link', { name: 'Open the prototype, prototype.html' })
    if (action === 'click') fireEvent.click(link)
    else fireEvent.keyDown(link, { key: 'Enter' })
    expect(f.bridge.open).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', watcher: false })
    expect(f.bridge.openExternalLink).not.toHaveBeenCalled()
    expect(f.command.mock.calls.some(([command]) => command.type === 'answer')).toBe(false)
  })

  it('shows the existing page failure if routing to the thread fails', async () => {
    const f = mount({ requests: [{ id: 'prototype', kind: 'question', text: 'Review', options: [],
      pages: [{ token: 'a'.repeat(32), kind: 'file', name: 'prototype.html', start: '' }] }] })
    vi.mocked(f.bridge.open).mockRejectedValueOnce(new Error('window unavailable'))
    fireEvent.click(await screen.findByRole('link', { name: 'Open the prototype, prototype.html' }))
    await screen.findByText('Sotto could not open that page. Nothing else changed. Try again.')
  })
})

it('focuses the prompt on show, keeps card focus during updates, and opens the thread on Command+O', async () => {
  const f = mount({ requests: [{ id: 'question', kind: 'question', text: 'Choose', options: [{ id: 'a', label: 'Path A' }] }] })
  const radio = await screen.findByRole('radio', { name: 'Path A' })
  const prompt = screen.getByRole('textbox')
  expect(prompt).toHaveFocus()
  radio.focus()
  f.update({ ...f.thread, title: 'Renamed' })
  expect(radio).toHaveFocus()
  f.shown()
  expect(prompt).toHaveFocus()
  fireEvent.keyDown(prompt, { key: 'o', metaKey: true })
  expect(f.bridge.open).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', watcher: false })
})

it('switches to Watcher, queues its running turn, and opens its room', async () => {
  const hostId = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
  const f = mount({ status: 'idle', lastTurn: { id: 'watcher-turn', status: 'running' } }, { status: 'ok', state: {
    current: { target: { hostId, threadId: 'thread' }, projectId: 'project', provider: 'codex',
      creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: '2026-11-03T00:00:00.000Z' },
    currentOptions: null, history: [], requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: '2026-11-03T00:00:00.000Z',
  } })
  fireEvent.click(await screen.findByRole('button', { name: 'Talking to the thread. Switch to Watcher' }))
  const prompt = screen.getByRole('textbox', { name: 'Message Watcher' })
  expect(screen.queryByRole('button', { name: 'Stop the running turn' })).toBeNull()
  fireEvent.change(prompt, { target: { value: 'Next for Watcher' } })
  fireEvent.keyDown(prompt, { key: 'Enter' })
  await waitFor(() => expect(f.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'queue-followup', text: 'Next for Watcher' })))
  fireEvent.change(prompt, { target: { value: '/open' } })
  fireEvent.keyDown(prompt, { key: 'Enter' })
  expect(f.bridge.open).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', watcher: true })
})
