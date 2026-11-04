import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UpdateStatus } from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { TO_DO_UNDO_MS, type ToDo, type ToDosBridge, type ToDosView, type ToDoWindowRequest } from '../../../src/shared/toDos'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { ToDoCorner } from '../../../src/renderer/src/features/toDos/ToDoCorner'
import { toDoClientOf } from '../../../src/renderer/src/features/toDos/toDoClient'
import { toolsPanelStore } from '../../../src/renderer/src/tools/toolsPanelStore'
import type { BrowserPage } from '../../../src/shared/browser'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'

const agentsState = vi.hoisted(() => ({ value: null as { command: ReturnType<typeof vi.fn>; state: unknown } | null }))
vi.mock('../../../src/renderer/src/agents/AgentContext', async original => ({ ...await original<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: () => agentsState.value }))

afterEach(() => { cleanup(); vi.useRealTimers() })

const HOST = 'this-computer'
const item = (id: string, over: Partial<ToDo> = {}): ToDo => ({ id, title: `Do ${id}`, by: 'thread', waits: false, seen: true, addedAt: '2026-11-03T00:00:00.000Z', ...over })

/** Each computer's side, as the bridge sees it. A press changes the list and sends the whole view, as main does. */
function lists(initial: readonly ToDo[], { fail = false, machines }: { fail?: boolean; machines?: ToDosView['machines'] } = {}) {
  let view: ToDosView = { machines: machines ?? [{ hostId: HOST, thisComputer: true, items: [...initial] }] }
  const listeners = new Set<(next: ToDosView) => void>()
  const publish = (next: ToDosView): void => { view = next; act(() => { for (const listener of listeners) listener(next) }) }
  const change = (hostId: string, work: (items: readonly ToDo[]) => ToDo[]): void => { publish({ machines: view.machines.map(machine => machine.hostId === hostId ? { ...machine, items: work(machine.items) } : machine) }) }
  const request = vi.fn(async ({ hostId, request: press }: ToDoWindowRequest) => {
    if (fail) throw new Error('Not connected')
    if (press.kind === 'seen') change(hostId, items => items.map(entry => ({ ...entry, seen: true })))
    if (press.kind === 'check') change(hostId, items => items.filter(entry => entry.id !== press.id))
    if (press.kind === 'add') change(hostId, items => [...items, item('mine', { title: press.title, by: 'user' })])
  })
  const bridge: ToDosBridge = { read: async () => view, request, onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  return { bridge, request, publish, change }
}

function update(owl: boolean): UpdateStatus {
  return { currentVersion: owl ? '0.1.38-owl.20261103.1' : '0.1.38', releaseTrack: owl ? 'owl' : 'stable', owlFeatures: { 'to-do-list': owl }, phase: { phase: 'unsupported', reason: 'test' } } as unknown as UpdateStatus
}
function shown(bridge: ToDosBridge, owl = true) {
  return render(<AppProvider bridge={createBridge({ getUpdateStatus: async () => update(owl), getSettings: async () => DEFAULT_SETTINGS })} createController={createController}><ToDoCorner bridge={bridge} /></AppProvider>)
}
const icon = (name: RegExp = /to-do/iu) => screen.findByRole('button', { name })
const seenPress = (request: ReturnType<typeof lists>['request']) => request.mock.calls.filter(([call]) => call.request.kind === 'seen')

describe('the to-do list icon', () => {
  it('stands nowhere on stable, and reads no list', async () => {
    const { bridge } = lists([item('a')])
    const read = vi.spyOn(bridge, 'read')
    const { container } = shown(bridge, false)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('.to-do')).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('shows an orange count of what is new, and a quiet count of what is left once opened', async () => {
    const { bridge, request } = lists([item('a'), item('b', { seen: false })])
    const user = userEvent.setup()
    const { container } = shown(bridge)
    const button = await icon(/2 to do, 1 new\. Unroll/u)
    const badge = (): HTMLElement => container.querySelector<HTMLElement>('.to-do__badge')!
    expect(badge()).toHaveTextContent('1')
    expect(badge()).toHaveAttribute('data-loud')
    await user.click(button)
    expect(button).toHaveAccessibleName('To-do, 2 to do. Roll up the list.')
    expect(badge()).toHaveTextContent('2')
    expect(badge()).not.toHaveAttribute('data-loud')
    await waitFor(() => { expect(seenPress(request)).toHaveLength(1) })
    expect(request).toHaveBeenCalledWith({ hostId: HOST, request: { kind: 'seen' } })
    // What was new stays marked until it rolls up, though the badge has gone quiet.
    expect(within(screen.getByRole('dialog')).getAllByRole('img', { name: 'New' })).toHaveLength(1)
  })
  it('shows no badge with nothing left', async () => {
    const { bridge } = lists([])
    const { container } = shown(bridge)
    await icon(/0 to do/u)
    expect(container.querySelector('.to-do__badge')).toBeNull()
  })
})

describe('unrolling and rolling up', () => {
  it('moves focus to the heading, and every way out rolls it up', async () => {
    const { bridge } = lists([item('a')])
    const user = userEvent.setup()
    shown(bridge)
    const button = await icon()
    await user.click(button)
    expect(screen.getByRole('heading', { name: 'To-do' })).toHaveFocus()
    expect(button).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('{Escape}')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()

    await user.click(button)
    await user.click(screen.getByRole('button', { name: 'Roll up' }))
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()

    await user.click(button)
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')

    await user.click(button)
    await user.click(document.body)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => { expect(screen.queryByRole('dialog', { hidden: true })).toBeNull() })
  })
  it('stays open when opened empty, to take the user\'s own', async () => {
    const { bridge, request } = lists([])
    const user = userEvent.setup()
    shown(bridge)
    await user.click(await icon())
    expect(screen.getByText('Nothing left to do.')).toBeVisible()
    await user.type(screen.getByRole('textbox', { name: 'Add a to-do of your own' }), 'Call the plant{Enter}')
    expect(request).toHaveBeenCalledWith({ hostId: HOST, request: { kind: 'add', title: 'Call the plant' } })
    expect(await screen.findByText('Call the plant')).toBeVisible()
    expect(screen.getByText('You added this')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Add a to-do of your own' })).toHaveValue('')
  })
  it('folds a to-do\'s steps open and shut', async () => {
    const { bridge } = lists([item('a', { steps: ['Open it', 'Press it'] })])
    const user = userEvent.setup()
    shown(bridge)
    await user.click(await icon())
    expect(screen.queryByText('Press it')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show 2 steps' }))
    expect(screen.getByText('Press it')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Hide 2 steps' }))
    expect(screen.queryByText('Press it')).toBeNull()
  })
})

describe('checking one off', () => {
  const timed = () => userEvent.setup({ advanceTimers: ms => { vi.advanceTimersByTime(ms) } })
  it('sends nothing for five seconds, Undo takes it back, and it survives rolling up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { bridge, request } = lists([item('a'), item('b')])
    const user = timed()
    shown(bridge)
    const button = await icon()
    await user.click(button)
    await user.click(screen.getByRole('checkbox', { name: 'Check off: Do a' }))
    const undo = screen.getByRole('button', { name: 'Undo checking off: Do a' })
    expect(undo).toHaveFocus()
    expect(button).toHaveAccessibleName('To-do, 1 to do. Roll up the list.')
    await user.click(undo)
    expect(screen.getByRole('checkbox', { name: 'Check off: Do a' })).toHaveFocus()
    act(() => { vi.advanceTimersByTime(TO_DO_UNDO_MS + 10) })
    expect(request.mock.calls.filter(([call]) => call.request.kind === 'check')).toEqual([])

    await user.click(screen.getByRole('checkbox', { name: 'Check off: Do a' }))
    await user.keyboard('{Escape}')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    act(() => { vi.advanceTimersByTime(TO_DO_UNDO_MS - 100) })
    expect(request.mock.calls.filter(([call]) => call.request.kind === 'check')).toEqual([])
    await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve() })
    expect(request).toHaveBeenCalledWith({ hostId: HOST, request: { kind: 'check', id: 'a' } })
  })
  it('hands focus on when a row goes, and rolls up with the last', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { bridge } = lists([item('a'), item('b')])
    const user = timed()
    shown(bridge)
    const button = await icon()
    await user.click(button)
    await user.click(screen.getByRole('checkbox', { name: 'Check off: Do a' }))
    await act(async () => { vi.advanceTimersByTime(TO_DO_UNDO_MS + 10); await Promise.resolve() })
    expect(screen.getByRole('checkbox', { name: 'Check off: Do b' })).toHaveFocus()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('checkbox', { name: 'Check off: Do b' }))
    await act(async () => { vi.advanceTimersByTime(TO_DO_UNDO_MS + 10); await Promise.resolve() })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()
  })
  it('keeps waiting across another page\'s corner, since the wait is the window\'s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { bridge, request } = lists([item('a')])
    const client = toDoClientOf(bridge)
    await act(async () => { await Promise.resolve() })
    client.check({ key: `${HOST}\u0000a`, hostId: HOST, item: item('a') })
    await act(async () => { vi.advanceTimersByTime(TO_DO_UNDO_MS + 10); await Promise.resolve() })
    expect(request).toHaveBeenCalledWith({ hostId: HOST, request: { kind: 'check', id: 'a' } })
  })
  it('says so when the press fails, and the item comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { bridge } = lists([item('a'), item('b')], { fail: true })
    const user = timed()
    shown(bridge)
    await user.click(await icon())
    await user.click(screen.getByRole('checkbox', { name: 'Check off: Do a' }))
    await act(async () => { vi.advanceTimersByTime(TO_DO_UNDO_MS + 10); await Promise.resolve() })
    expect(await screen.findByRole('alert')).toHaveTextContent('Sotto could not check off “Do a”, so it is still on your list.')
    expect(screen.getByRole('checkbox', { name: 'Check off: Do a' })).toBeVisible()
  })
  it('keeps the last item standing until the press has an answer, and says so if it fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { bridge } = lists([item('a')], { fail: true })
    const user = timed()
    shown(bridge)
    const button = await icon()
    await user.click(button)
    await user.click(screen.getByRole('checkbox', { name: 'Check off: Do a' }))
    await act(async () => { vi.advanceTimersByTime(TO_DO_UNDO_MS + 10); await Promise.resolve() })
    expect(await screen.findByRole('alert')).toBeVisible()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('checkbox', { name: 'Check off: Do a' })).toBeVisible()
  })
  it('unrolls to say a press failed after the list was rolled up, leaving the focus alone, and rolling up reads it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { bridge } = lists([item('a'), item('b')], { fail: true })
    const user = timed()
    shown(bridge)
    const button = await icon()
    await user.click(button)
    await user.click(screen.getByRole('checkbox', { name: 'Check off: Do a' }))
    await user.keyboard('{Escape}')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await act(async () => { vi.advanceTimersByTime(TO_DO_UNDO_MS + 10); await Promise.resolve() })
    expect(await screen.findByRole('alert')).toBeVisible()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(button).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('drops the wait when another client checks it off first, and sends nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { bridge, request, change } = lists([item('a'), item('b')])
    const user = timed()
    shown(bridge)
    await user.click(await icon())
    await user.click(screen.getByRole('checkbox', { name: 'Check off: Do a' }))
    change(HOST, items => items.filter(entry => entry.id !== 'a'))
    act(() => { vi.advanceTimersByTime(TO_DO_UNDO_MS + 10) })
    expect(request.mock.calls.filter(([call]) => call.request.kind === 'check')).toEqual([])
  })
})

describe('a prototype waiting for review', () => {
  it('reads in Sotto\'s words, with no note to send, and checks off like any other', async () => {
    const { bridge } = lists([item('p', { by: 'prototype', title: 'Sent from a host in its own language', threadId: 't1' })])
    const user = userEvent.setup()
    shown(bridge)
    await user.click(await icon())
    expect(screen.getByText('Review the prototype')).toBeVisible()
    expect(screen.queryByText('Sent from a host in its own language')).toBeNull()
    expect(screen.queryByRole('button', { name: 'It didn\'t work' })).toBeNull()
    expect(screen.queryByText('A thread added this')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Check off: Review the prototype' })).toBeVisible()
  })
})

describe('opening a prototype\'s page from the list', () => {
  const page = { token: 't'.repeat(32), kind: 'file' as const, name: 'greeting.html', start: 'greeting.html' }
  const opening = (result: unknown) => {
    const { bridge, publish } = lists([item('p', { by: 'prototype', threadId: 't1' })])
    agentsState.value = { command: vi.fn(async () => undefined), state: { connections: [], host: { threads: [{ id: 't1', title: 'Greeting', prototypeReady: { source: 'reply:one', pages: [page] } }] } } }
    const open = vi.fn(async () => result)
    ;(window as unknown as { sotto?: unknown }).sotto = { openQuestionPage: open }
    return { bridge, publish, open }
  }
  afterEach(() => { agentsState.value = null; delete (window as unknown as { sotto?: unknown }).sotto })
  it('opens by its token and leaves the page where it is when the system browser took it', async () => {
    const { bridge, open } = opening({ ok: true })
    const shown = vi.spyOn(toolsPanelStore, 'showBrowserPage')
    const user = userEvent.setup()
    render(<AppProvider bridge={createBridge({ getUpdateStatus: async () => update(true), getSettings: async () => DEFAULT_SETTINGS })} createController={createController}><ToDoCorner bridge={bridge} /></AppProvider>)
    await user.click(await icon())
    await user.click(screen.getByRole('link', { name: 'Open the prototype, greeting.html' }))
    expect(open).toHaveBeenCalledWith({ threadId: 't1', token: page.token })
    expect(agentsState.value!.command).not.toHaveBeenCalled()
    expect(shown).not.toHaveBeenCalled()
    shown.mockRestore()
  })
  it('takes the user to the thread and its browser when Sotto\'s browser took it, so the page is seen before its to-do goes', async () => {
    const browserPage = { workspace: { threadId: 't1' } } as unknown as BrowserPage
    const { bridge } = opening({ ok: true, page: browserPage })
    const shown = vi.spyOn(toolsPanelStore, 'showBrowserPage').mockReturnValue('opened')
    const user = userEvent.setup()
    render(<AppProvider bridge={createBridge({ getUpdateStatus: async () => update(true), getSettings: async () => DEFAULT_SETTINGS })} createController={createController}><ToDoCorner bridge={bridge} /></AppProvider>)
    const button = await icon()
    await user.click(button)
    await user.click(screen.getByRole('link', { name: 'Open the prototype, greeting.html' }))
    await waitFor(() => { expect(shown).toHaveBeenCalledWith(browserPage, true) })
    expect(agentsState.value!.command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 't1' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    shown.mockRestore()
  })
})

describe('It didn\'t work', () => {
  it('stands only on one a thread waits on, and sends the user\'s words at once', async () => {
    const { bridge, request } = lists([item('a'), item('b', { waits: true, threadId: 't1' })])
    const user = userEvent.setup()
    shown(bridge)
    await user.click(await icon())
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]!).queryByRole('button', { name: 'It didn\'t work' })).toBeNull()
    await user.click(within(rows[1]!).getByRole('button', { name: 'It didn\'t work' }))
    const words = screen.getByRole('textbox', { name: 'What happened with Do b' })
    expect(words).toHaveFocus()
    const tell = screen.getByRole('button', { name: 'Tell the thread' })
    expect(tell).toBeDisabled()
    await user.type(words, 'It opened twice{Enter}')
    expect(request).toHaveBeenCalledWith({ hostId: HOST, request: { kind: 'check', id: 'b', didNotWork: 'It opened twice' } })
  })
  it('Escape closes the note and leaves the list open', async () => {
    const { bridge, request } = lists([item('b', { waits: true, threadId: 't1' })])
    const user = userEvent.setup()
    shown(bridge)
    const button = await icon()
    await user.click(button)
    const opener = screen.getByRole('button', { name: 'It didn\'t work' })
    await user.click(opener)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'What happened with Do b' })).toBeNull()
    expect(screen.getByRole('button', { name: 'It didn\'t work' })).toHaveFocus()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(request.mock.calls.filter(([call]) => call.request.kind === 'check')).toEqual([])
  })
  it('Escape closes the note from its buttons too', async () => {
    const { bridge } = lists([item('b', { waits: true, threadId: 't1' })])
    const user = userEvent.setup()
    shown(bridge)
    const button = await icon()
    await user.click(button)
    await user.click(screen.getByRole('button', { name: 'It didn\'t work' }))
    screen.getByRole('button', { name: 'Cancel' }).focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'What happened with Do b' })).toBeNull()
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })
  it('keeps the words when they could not be sent', async () => {
    const { bridge } = lists([item('b', { waits: true, threadId: 't1' })], { fail: true })
    const user = userEvent.setup()
    shown(bridge)
    await user.click(await icon())
    await user.click(screen.getByRole('button', { name: 'It didn\'t work' }))
    await user.type(screen.getByRole('textbox', { name: 'What happened with Do b' }), 'It opened twice{Enter}')
    expect(await screen.findByRole('alert')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'What happened with Do b' })).toHaveValue('It opened twice')
  })
})

describe('every computer\'s list', () => {
  it('names a thread as the source when its thread is out of reach', async () => {
    const { bridge } = lists([item('a', { threadId: 'gone' })])
    const user = userEvent.setup()
    shown(bridge)
    await user.click(await icon())
    expect(screen.getByText('A thread added this')).toBeVisible()
  })
  it('sends a press back to the computer that holds the item, and the user\'s own to this one', async () => {
    const { bridge, request } = lists([], { machines: [{ hostId: HOST, thisComputer: true, items: [] }, { hostId: 'forge', thisComputer: false, items: [item('f', { seen: false })] }] })
    const user = userEvent.setup()
    shown(bridge)
    await user.click(await icon(/1 new/u))
    await waitFor(() => { expect(request).toHaveBeenCalledWith({ hostId: 'forge', request: { kind: 'seen' } }) })
    expect(seenPress(request)).toHaveLength(1)
    await user.type(screen.getByRole('textbox', { name: 'Add a to-do of your own' }), 'Mine{Enter}')
    expect(request).toHaveBeenCalledWith({ hostId: HOST, request: { kind: 'add', title: 'Mine' } })
  })
  it('offers no box where this computer keeps no list, rather than filling another\'s', async () => {
    const { bridge, request } = lists([], { machines: [{ hostId: 'forge', thisComputer: false, items: [item('f')] }] })
    const user = userEvent.setup()
    shown(bridge)
    await user.click(await icon())
    expect(screen.getByRole('textbox', { name: 'Add a to-do of your own' })).toBeDisabled()
    expect(screen.getByPlaceholderText('This computer keeps no list right now')).toBeVisible()
    expect(request.mock.calls.filter(([call]) => call.request.kind === 'add')).toEqual([])
  })
  it('keeps a newer draft when an earlier add fails', async () => {
    let refuse: (error: Error) => void = () => undefined
    const { bridge, request } = lists([])
    request.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject }))
    const user = userEvent.setup()
    shown(bridge)
    await user.click(await icon())
    const box = screen.getByRole('textbox', { name: 'Add a to-do of your own' })
    await user.type(box, 'First{Enter}')
    await user.type(box, 'Second')
    await act(async () => { refuse(new Error('Full')); await Promise.resolve() })
    expect(await screen.findByRole('alert')).toHaveTextContent('Sotto could not add “First”')
    expect(box).toHaveValue('Second')
  })
})
