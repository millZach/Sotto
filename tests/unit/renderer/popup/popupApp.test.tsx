import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRequest, AgentThread, AgentThreadDetail } from '../../../../src/shared/agents'
import type { PopupBridge } from '../../../../src/shared/popup'
import { DEFAULT_SETTINGS } from '../../../../src/shared/settings'
import type { WatcherRoomResult } from '../../../../src/shared/watcherRoom'
import { PopupApp } from '../../../../src/renderer/src/popup/PopupApp'
import { POPUP_MEMORY_KEY, readPopupMemory, writePopupMemory, type PopupTarget } from '../../../../src/renderer/src/popup/popupLogic'
import { requestAnswerStore } from '../../../../src/renderer/src/agents/requests/requestAnswers'
import { agentThread, threadsStateFixture } from '../../../fixtures/agentState'
import { deferred } from '../../../fixtures/deferred'

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  // The popup must work without the main window's bridge or app context.
  vi.stubGlobal('sotto', undefined)
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
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
    stageAttachment: vi.fn(async request => ({ id: crypto.randomUUID(), digest: 'a'.repeat(64), name: request.name, mimeType: request.mimeType, sizeBytes: request.bytes.length })),
    attachmentContent: vi.fn(async () => null), attachmentPreview: vi.fn(async () => null),
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

const watcherRoom: WatcherRoomResult = { status: 'ok', state: {
  current: { target: { hostId: '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10', threadId: 'thread' }, projectId: 'project', provider: 'codex',
    creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: '2026-11-03T00:00:00.000Z' },
  currentOptions: null, history: [], requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: '2026-11-03T00:00:00.000Z',
} }

describe('the popup running-turn affordances', () => {
  it.each(liveTurns)('uses the same running state for Stop, Escape, the owl and queueing: %j', async patch => {
    const f = mount(patch)
    const stop = await screen.findByRole('button', { name: 'Stop the running turn' })
    expect(screen.getByText('Working…')).toBeVisible()
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
    expect(f.view.container.querySelector('.popup-owl.is-working')).toBeNull()
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

  it.each([false, true])('routes a Watcher prototype to its room (structured question: %s)', async structured => {
    const f = mount({ requests: [{ id: 'prototype', kind: 'question', text: 'Review the prototype', options: [],
      ...(structured ? { questions: [{ id: 'review', question: 'Review the prototype', options: [], multiSelect: false, allowFreeText: true }] } : {}),
      pages: [{ token: 'a'.repeat(32), kind: 'file', name: 'prototype.html', start: '' }] }] }, watcherRoom)
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Watcher' }))
    const link = await screen.findByRole('link', { name: 'Open the prototype, prototype.html' })
    for (const action of ['click', 'Enter']) {
      vi.mocked(f.bridge.open).mockClear()
      if (action === 'click') fireEvent.click(link)
      else fireEvent.keyDown(link, { key: 'Enter' })
      expect(f.bridge.open).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', watcher: true })
    }
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
  const f = mount({ status: 'idle', lastTurn: { id: 'watcher-turn', status: 'running' } }, watcherRoom)
  fireEvent.click(await screen.findByRole('button', { name: 'Ask Watcher' }))
  const prompt = screen.getByRole('textbox', { name: 'Message Watcher' })
  expect(screen.queryByRole('button', { name: 'Stop the running turn' })).toBeNull()
  fireEvent.change(prompt, { target: { value: 'Next for Watcher' } })
  fireEvent.keyDown(prompt, { key: 'Enter' })
  await waitFor(() => expect(f.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'queue-followup', text: 'Next for Watcher' })))
  fireEvent.change(prompt, { target: { value: '/open' } })
  fireEvent.keyDown(prompt, { key: 'Enter' })
  expect(f.bridge.open).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', watcher: true })
})

async function setup({ thread = agentThread(), target = 'thread' }: { thread?: AgentThread; target?: PopupTarget } = {}) {
  const state = threadsStateFixture({ projects: [{ id: thread.projectId }], threads: [thread] })
  writePopupMemory(localStorage, { target, threadId: thread.id, projectId: thread.projectId })
  let shown = (): void => undefined
  let pushed: (thread: AgentThread) => void = () => undefined
  const bridge = {
    platform: 'darwin',
    getSettings: async () => DEFAULT_SETTINGS,
    onSettingsChanged: () => () => undefined,
    shell: vi.fn(async () => state),
    watcher: vi.fn(async () => ({ status: 'ok' as const, state: {
      current: null, currentOptions: null, history: [], requests: [], watchedThreads: [], receipts: [],
      recoveryNotice: null, observedAt: '2026-11-03T00:00:00.000Z',
    } })),
    threadDetail: vi.fn(async () => ({ threadId: thread.id, revision: 1, messages: [], activities: [] })),
    onThreadDetail: () => () => undefined,
    onThread: (listener: (thread: AgentThread) => void) => { pushed = listener; return () => undefined },
    command: vi.fn<PopupBridge['command']>(async () => ({ ...state, host: {
      ...state.host, models: { revision: 1, omitted: true }, clientHosts: [],
    } })),
    openExternalLink: async () => ({ ok: true }),
    stageAttachment: async () => { throw new Error('unused') }, attachmentContent: async () => null, attachmentPreview: async () => null,
    hide: vi.fn(async () => undefined),
    fit: async () => undefined,
    open: async () => undefined,
    onShown: (listener: () => void) => { shown = listener; return () => undefined },
  } satisfies PopupBridge
  const view = render(<PopupApp bridge={bridge} />)
  await screen.findByRole('textbox', { name: `Message ${thread.title}` })
  return { bridge, view, thread, show: () => shown(), push: (next: AgentThread) => pushed(next) }
}

const lastTurn = { id: 'turn', status: 'running' as const }

describe('the popup regressions from #2061 (ADR-0181)', () => {
  it('shows Working and a Stop button when an idle thread still reports its last turn running', async () => {
    const { bridge, thread } = await setup({ thread: agentThread({ status: 'idle', lastTurn }) })
    expect(screen.getByRole('status')).toHaveTextContent('Working…')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop the running turn' })) })
    expect(bridge.command).toHaveBeenCalledWith({ type: 'interrupt', threadId: thread.id })
    expect(bridge.hide).not.toHaveBeenCalled()
  })

  it('stops on Escape while the last turn runs, then hides once that turn completes', async () => {
    const { bridge, thread, push } = await setup({ thread: agentThread({ status: 'idle', lastTurn }) })
    const prompt = screen.getByRole('textbox')
    await act(async () => { fireEvent.keyDown(prompt, { key: 'Escape' }) })
    expect(bridge.command).toHaveBeenCalledWith({ type: 'interrupt', threadId: thread.id })
    expect(bridge.hide).not.toHaveBeenCalled()

    await act(async () => { push({ ...thread, lastTurn: { ...lastTurn, status: 'completed' } }) })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop the running turn' })).not.toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(prompt, { key: 'Escape' }) })
    expect(bridge.hide).toHaveBeenCalledOnce()
  })

  it('queues a prompt behind the last running turn, then sends normally after it completes', async () => {
    const { bridge, thread, push } = await setup({ thread: agentThread({ status: 'idle', lastTurn }) })
    const prompt = screen.getByRole('textbox')
    fireEvent.change(prompt, { target: { value: 'Do this next' } })
    await act(async () => { fireEvent.keyDown(prompt, { key: 'Enter' }) })
    expect(bridge.command).toHaveBeenCalledWith({
      type: 'queue-followup', threadId: thread.id, draftId: expect.any(String), text: 'Do this next',
    })
    expect(bridge.command.mock.calls.some(([command]) => command.type === 'manual-send')).toBe(false)

    await act(async () => { push({ ...thread, lastTurn: { ...lastTurn, status: 'completed' } }) })
    fireEvent.change(prompt, { target: { value: 'Do this now' } })
    await act(async () => { fireEvent.keyDown(prompt, { key: 'Enter' }) })
    expect(bridge.command).toHaveBeenCalledWith({
      type: 'manual-send', threadId: thread.id, draftId: expect.any(String), text: 'Do this now',
    })
  })

  it('says Watcher is not running once and keeps the thread target across shows and a remount', async () => {
    const { bridge, view, thread, show } = await setup({ target: 'watcher' })
    expect(screen.getByRole('alert')).toHaveTextContent('Watcher isn’t running, so the popup is on your thread.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await act(async () => { show() })
    expect(bridge.shell).toHaveBeenCalledTimes(2)
    expect(bridge.watcher).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(readPopupMemory(localStorage)).toEqual({ target: 'thread', threadId: thread.id, projectId: thread.projectId })

    view.unmount()
    await act(async () => { render(<PopupApp bridge={bridge} />) })
    expect(bridge.shell).toHaveBeenCalledTimes(3)
    expect(bridge.watcher).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('textbox', { name: `Message ${thread.title}` })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

function bridgeFixture(patch: Partial<PopupBridge> = {}): PopupBridge {
  const state = threadsStateFixture({ threads: [{ id: 'thread', title: 'Work' }] })
  return {
    platform: 'darwin', getSettings: async () => DEFAULT_SETTINGS,
    onSettingsChanged: () => () => undefined,
    shell: async () => state, threadDetail: async () => ({ threadId: 'thread', revision: 0, messages: [] }),
    onThreadDetail: () => () => undefined, onThread: () => () => undefined,
    command: async () => ({ ...state, host: { ...state.host, models: { revision: 0, omitted: true }, clientHosts: [] } }), openExternalLink: async () => ({ ok: true }),
    stageAttachment: async () => { throw new Error('unused') }, attachmentContent: async () => null, attachmentPreview: async () => null,
    hide: async () => undefined, fit: async () => undefined, open: async () => undefined, onShown: () => () => undefined,
    ...patch,
  }
}

it('reports a failed shell read using the existing popup notice', async () => {
  render(<PopupApp bridge={bridgeFixture({ shell: async () => { throw new Error('ENOENT /private/threads.json') } })} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Sotto could not read the threads. Reopen the popup and try again.')
  expect(document.body).not.toHaveTextContent('/private/')
})

it('reports a rejected thread history without replacing it with a raw failure', async () => {
  writePopupMemory(window.localStorage, { target: 'thread', threadId: 'thread', projectId: null })
  render(<PopupApp bridge={bridgeFixture({ threadDetail: async () => {
    throw new Error('ENOENT /private/messages.json')
  } })} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this thread’s messages. Open it in Sotto or reopen the popup to try again.')
  expect(document.body).not.toHaveTextContent('/private/')
})

it('prunes a removed thread while keeping the Watcher choice when its room read fails', async () => {
  writePopupMemory(window.localStorage, { target: 'watcher', threadId: 'removed', projectId: null })
  render(<PopupApp bridge={bridgeFixture({ watcher: async () => { throw new Error('room unavailable') } })} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Sotto could not read Watcher’s room. Reopen the popup and try again.')
  expect(readPopupMemory(window.localStorage)).toMatchObject({ target: 'watcher', threadId: null })
  expect(document.body).not.toHaveTextContent('Watcher isn’t running')
})

it('forgets a removed thread without reporting a read failure', async () => {
  const state = threadsStateFixture({ threads: [] })
  writePopupMemory(window.localStorage, { target: 'thread', threadId: 'removed', projectId: null })
  await act(async () => { render(<PopupApp bridge={bridgeFixture({ shell: async () => state, threadDetail: async () => null })} />) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('textbox')).toHaveAccessibleName(/^Message New thread/u)
})

it('ignores a failed read after the user starts a new thread', async () => {
  const pending = deferred<AgentThreadDetail | null>()
  writePopupMemory(window.localStorage, { target: 'thread', threadId: 'thread', projectId: null })
  render(<PopupApp bridge={bridgeFixture({ threadDetail: () => pending.promise })} />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'n', metaKey: true })
  await act(async () => { pending.reject(new Error('old read')) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('clears a history read notice when reopening successfully reads it', async () => {
  let show!: () => void
  let fail = true
  writePopupMemory(window.localStorage, { target: 'thread', threadId: 'thread', projectId: null })
  render(<PopupApp bridge={bridgeFixture({
    onShown: listener => { show = listener; return () => undefined },
    threadDetail: async () => {
      if (fail) throw new Error('history unavailable')
      return { threadId: 'thread', revision: 0, messages: [] }
    },
  })} />)
  await screen.findByRole('alert')
  fail = false
  await act(async () => { show() })
  expect(screen.queryByRole('alert')).toBeNull()
})

describe('moving between Watcher and threads', () => {
  type Said = readonly AgentThread['messages'][number][]
  const twoThreads = (said: { readonly mine?: Said; readonly room?: Said } = {}, settings: Partial<typeof DEFAULT_SETTINGS> = {}) => {
    const mine = agentThread({ id: 'mine', title: 'My thread', messages: [...said.mine ?? [{ id: 'm1', role: 'assistant', text: 'From my thread', createdAt: '2026-11-03T00:00:00.000Z' }]] })
    const room = agentThread({ id: 'room', title: 'Watcher', kind: 'watcher', messages: [...said.room ?? [{ id: 'w1', role: 'assistant', text: 'From Watcher', createdAt: '2026-11-03T00:00:00.000Z' }]] })
    const other = agentThread({ id: 'other', title: 'Another thread', messages: [] })
    const state = threadsStateFixture({ threads: [mine, room, other], projects: [{ id: mine.projectId }] })
    const hostId = state.hostId ?? state.host.hostId!
    const watcher = vi.fn(async () => ({ ...watcherRoom, state: { ...watcherRoom.state, current: { ...watcherRoom.state.current!, target: { hostId, threadId: 'room' } } } }) as WatcherRoomResult)
    const fit = vi.fn<PopupBridge['fit']>(async () => undefined)
    const hide = vi.fn<PopupBridge['hide']>(async () => undefined)
    const details: Readonly<Record<string, AgentThread>> = { mine, room, other }
    const threadDetail = vi.fn(async (id: string) => ({ threadId: id, revision: 1, messages: details[id]!.messages, activities: [] }))
    const command = vi.fn<PopupBridge['command']>(async () => ({ ...state, host: { ...state.host, models: { revision: 1, omitted: true }, clientHosts: [] } }))
    let pushed: (thread: AgentThread) => void = () => undefined
    writePopupMemory(localStorage, { target: 'thread', threadId: 'mine', projectId: mine.projectId })
    const view = render(<PopupApp bridge={bridgeFixture({ shell: async () => state, watcher, fit, hide, threadDetail, command,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, ...settings }), onThread: listener => { pushed = listener; return () => undefined } })} />)
    return { fit, hide, threadDetail, command, room, container: view.container, push: (thread: AgentThread) => pushed(thread) }
  }

  it('observes both targets, and a switch shows the other at once with no read and the window no shorter', async () => {
    const f = twoThreads()
    await screen.findByText('From my thread')
    await waitFor(() => expect(f.threadDetail).toHaveBeenCalledWith('room'))
    expect(f.command).toHaveBeenCalledWith({ type: 'observe-threads', threadIds: ['room', 'mine'] })
    const reads = f.threadDetail.mock.calls.length
    const tallest = () => Math.max(0, ...f.fit.mock.calls.map(([height]) => height))
    const before = tallest()
    f.fit.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Ask Watcher' }))
    expect(screen.getByText('From Watcher')).toBeInTheDocument()
    expect(screen.queryByText('From my thread')).toBeNull()
    expect(f.threadDetail).toHaveBeenCalledTimes(reads)
    for (const [height] of f.fit.mock.calls) expect(height).toBeGreaterThanOrEqual(before)
  })

  it('keeps a pushed record and reads no history again when the user picks another thread', async () => {
    const f = twoThreads()
    await screen.findByText('From my thread')
    await waitFor(() => expect(f.threadDetail).toHaveBeenCalledWith('room'))
    await screen.findByRole('button', { name: 'Ask Watcher' })
    act(() => f.push({ ...f.room, status: 'running' }))
    f.threadDetail.mockClear()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'n', metaKey: true })
    expect(f.threadDetail).not.toHaveBeenCalledWith('room')
    fireEvent.click(screen.getByRole('button', { name: 'Ask Watcher' }))
    expect(screen.getByText('Working…')).toBeInTheDocument()
  })

  it('parts Watcher\'s reports with a rule and the time, and a thread\'s messages with neither', async () => {
    const f = twoThreads({ mine: [
      { id: 'a', role: 'assistant', text: 'One', createdAt: '2026-11-03T00:00:00.000Z' }, { id: 'b', role: 'assistant', text: 'Two', createdAt: '2026-11-03T00:01:00.000Z' },
    ], room: [
      { id: 'c', role: 'assistant', text: 'Report one', createdAt: '2026-11-03T00:00:00.000Z' }, { id: 'd', role: 'assistant', text: 'Report two', createdAt: '2026-11-03T00:01:00.000Z' },
    ] })
    await screen.findByText('Two')
    expect(f.container.querySelector('.popup-rule')).toBeNull()
    await waitFor(() => { fireEvent.click(screen.getByRole('button', { name: 'Ask Watcher' })); expect(screen.getByText('Report two')).toBeInTheDocument() })
    expect(f.container.querySelectorAll('.popup-rule')).toHaveLength(1)
  })

  it('leaves a chord the dictation hotkey holds to dictation, and says nothing of those keys', async () => {
    twoThreads({}, { hotkey: 'CommandOrControl+K' })
    await screen.findByText('From my thread')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose a thread' })).toHaveAttribute('title', 'Choose a thread'))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'k', metaKey: true })
    expect(screen.queryByRole('listbox', { name: 'Threads' })).toBeNull()
  })

  it('closes the list on Escape wherever the keyboard is, and neither stops a turn nor hides the card', async () => {
    const f = twoThreads()
    await screen.findByText('From my thread')
    fireEvent.click(screen.getByRole('button', { name: 'Choose a thread' }))
    const elsewhere = screen.getByRole('button', { name: 'Send' })
    fireEvent.keyDown(elsewhere, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Threads' })).toBeNull()
    expect(f.hide).not.toHaveBeenCalled()
  })

  it('keeps the words typed across a switch, and flips with Command+1 and Command+2', async () => {
    twoThreads()
    await screen.findByText('From my thread')
    const prompt = screen.getByRole('textbox')
    fireEvent.change(prompt, { target: { value: 'Half a thought' } })
    await screen.findByRole('button', { name: 'Ask Watcher' })
    await waitFor(() => { fireEvent.keyDown(prompt, { key: '1', metaKey: true }); expect(screen.getByText('From Watcher')).toBeInTheDocument() })
    expect(screen.getByRole('textbox')).toHaveValue('Half a thought')
    expect(screen.getByRole('button', { name: 'Ask Watcher' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(prompt, { key: '2', metaKey: true })
    expect(screen.getByText('From my thread')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('Half a thought')
  })

  it('lists the recent threads on Command+K; the arrows and Return choose one and Escape closes the list', async () => {
    twoThreads()
    await screen.findByText('From my thread')
    const prompt = screen.getByRole('textbox')
    fireEvent.keyDown(prompt, { key: 'k', metaKey: true })
    const list = screen.getByRole('listbox', { name: 'Threads' })
    expect(within(list).queryByText('Watcher')).toBeNull()
    expect(within(list).getByText('Another thread')).toBeInTheDocument()
    fireEvent.keyDown(prompt, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Threads' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a thread' }))
    const rows = within(screen.getByRole('listbox', { name: 'Threads' })).getAllByRole('option')
    const another = rows.findIndex(row => row.textContent?.includes('Another thread'))
    for (let press = 0; press < another; press++) fireEvent.keyDown(prompt, { key: 'ArrowDown' })
    fireEvent.keyDown(prompt, { key: 'Enter' })
    expect(screen.getByRole('textbox', { name: 'Message Another thread' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ask Another thread' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('photos in the popup', () => {
  const photo = () => new File([new Uint8Array([1, 2, 3])], 'crash.png', { type: 'image/png' })
  const attach = async (view: ReturnType<typeof render>) => {
    const picker = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    await act(async () => { fireEvent.change(picker, { target: { files: [photo()] } }) })
  }

  it('stages a photo through the popup\'s bridge and sends its handle with the words, then clears the box', async () => {
    const f = mount()
    await screen.findByRole('textbox', { name: `Message ${f.thread.title}` })
    await attach(f.view)
    await waitFor(() => expect(f.bridge.stageAttachment).toHaveBeenCalledWith(expect.objectContaining({ threadId: f.thread.id, name: 'crash.png', mimeType: 'image/png' })))
    await screen.findByRole('button', { name: 'Remove crash.png' })
    const prompt = screen.getByRole('textbox')
    fireEvent.change(prompt, { target: { value: 'Same crash?' } })
    fireEvent.keyDown(prompt, { key: 'Enter' })
    await waitFor(() => expect(f.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send', text: 'Same crash?', attachments: [expect.objectContaining({ name: 'crash.png' })] })))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove crash.png' })).toBeNull())
  })

  it('sends a photo with no words, and puts the photo back when main refuses it', async () => {
    const f = mount()
    await screen.findByRole('textbox', { name: `Message ${f.thread.title}` })
    await attach(f.view)
    await screen.findByRole('button', { name: 'Remove crash.png' })
    const refusal = { ...(await f.command({ type: 'observe-threads', threadIds: [] })), error: 'This model does not support screenshots.' }
    f.command.mockImplementation(async request => request.type === 'manual-send' ? refusal : { ...refusal, error: null })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('This model does not support screenshots.')
    expect(screen.getByRole('button', { name: 'Remove crash.png' })).toBeInTheDocument()
  })
})
