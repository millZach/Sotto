import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentFollowup, AgentMessage, AgentState, AgentThread } from '../../../src/shared/agents'
import { limitRestartNote } from '../../../src/shared/limitRestart'
import { RESUME_NOTE } from '../../../src/shared/restartResume'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { ThreadFollowups } from '../../../src/renderer/src/agents/ThreadFollowups'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { clockLabel, describeThreads, rowStatus } from '../../../src/renderer/src/agents/threadFacts'
import { isRestartNoteText, restartGroups, restartWhen } from '../../../src/renderer/src/agents/restartWords'
import { SettingsView } from '../../../src/renderer/src/features/settings/SettingsView'
import { GitSettings } from '../../../src/renderer/src/features/settings/GitSettings'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'
import { baseProps, selectCategory } from '../../fixtures/renderer/settingsViewHarness'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(),
  useAgents: vi.fn(),
}))

/**
 * Restarting stopped threads in the window (ADR-0144; Zach's picks B and C of design/limit-restart/mockup.html): a band
 * at the top of the Threads sidebar, a strip over the stopped thread's composer, rows that say when, the note tagged
 * Restarted, and babysitting gone. Stable, with the Owl feature off, shows none of it.
 */

// On this computer's own clock, so the times read the same in every zone the suite runs in.
const NOW = new Date(2026, 9, 26, 11, 42).valueOf()
const RESET = new Date(2026, 9, 26, 15, 0).valueOf()
const iso = (at: number): string => new Date(at).toISOString()
const minutesAgo = (minutes: number): string => iso(NOW - minutes * 60_000)
const clock = clockLabel(RESET)

const navigate = vi.fn()
function owl(options: { readonly restart?: boolean; readonly watcher?: boolean } = {}): void {
  const restart = options.restart !== false
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { owlFeatures: { 'restart-stopped-threads': restart, watcher: options.watcher === true, 'resume-after-restart': true } },
    actions: { navigate, minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
}

function stopped(id: string, title: string, patch: Partial<AgentThread> = {}): AgentThread {
  return { id, projectId: 'workshop', title, modelId: 'claude:sonnet', providerId: 'claude', status: 'error', requests: [],
    messages: [{ id: `${id}-ask`, role: 'user', text: 'Fix the review findings and push once tests pass.', createdAt: minutesAgo(30) }],
    updatedAt: minutesAgo(1), worktree: { mode: 'shared', status: 'ready', path: 'C:/workshop', branch: 'main' }, workingDirectory: 'C:/workshop',
    scheduledRestart: { provider: 'claude', stoppedAt: minutesAgo(1), at: iso(RESET) }, ...patch }
}

function mount(threads: AgentThread[], options: { readonly restart?: boolean; readonly watcher?: boolean; readonly active?: string } = {}) {
  owl(options)
  const state = threadsStateFixture()
  state.host.threads = [...threads, ...state.host.threads]
  state.activeThreadId = options.active ?? threads.find(thread => thread.kind !== 'watcher')?.id ?? null
  state.activeProjectId = 'workshop'
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={NOW} />)
  return live
}

const sent = <T extends AgentCommand['type']>(live: ReturnType<typeof liveAgentState>, type: T): Extract<AgentCommand, { type: T }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)
const bands = () => [...document.querySelectorAll<HTMLElement>('.restart-band')]
const strip = () => document.querySelector<HTMLElement>('.restart-strip')
// The band names the thread too, so the row is found among the rows.
const rowStatusOf = (title: string): HTMLElement => [...document.querySelectorAll('.thread-nav__item')].find(item => item.getAttribute('aria-label') === title)!.querySelector('.thread-nav__status')!

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(useAgents).mockReset()
  vi.mocked(useOptionalApp).mockReset()
  navigate.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('when a restart is due', () => {
  it('says the time today, tomorrow, a day this week, or a date beyond it', () => {
    expect(restartWhen(RESET, NOW)).toBe(`at ${clock}`)
    expect(restartWhen(RESET + 24 * 60 * 60_000, NOW)).toBe(`tomorrow at ${clock}`)
    const thursday = new Date(2026, 9, 29, 15, 0).valueOf()
    expect(restartWhen(thursday, NOW)).toBe(`Thursday at ${clock}`)
    expect(restartWhen(new Date(2026, 10, 3, 15, 0).valueOf(), NOW)).toBe(`on Nov 3 at ${clock}`)
    // Passed, as while Sotto waits for the provider to connect again: no time is claimed.
    expect(restartWhen(NOW - 60_000, NOW)).toBeNull()
  })

  it('tells a restart note by how Sotto’s note begins, whichever provider it names, and the resume note too', () => {
    expect(isRestartNoteText(limitRestartNote('Claude Code'))).toBe(true)
    expect(isRestartNoteText(`  ${limitRestartNote('DeepSeek Harness')}\n\nAlso: two checks failed.`)).toBe(true)
    expect(isRestartNoteText(RESUME_NOTE)).toBe(true)
    expect(isRestartNoteText('Pull request #74: 2 checks failed.')).toBe(false)
    expect(isRestartNoteText(`Please read this: ${'x'.repeat(80)} ${limitRestartNote('Codex')}`)).toBe(false)
  })

  it('groups one band per provider and moment, soonest first, Watcher first among its own', () => {
    const watcher = stopped('watcher-1', 'Watcher', { kind: 'watcher', scheduledRestart: { provider: 'claude', stoppedAt: minutesAgo(1), at: iso(RESET) } })
    const early = stopped('a', 'Merge-train fixes', { scheduledRestart: { provider: 'claude', stoppedAt: minutesAgo(5), at: iso(RESET) } })
    const devin = stopped('d', 'Release notes draft', { providerId: 'devin', scheduledRestart: { provider: 'devin', stoppedAt: minutesAgo(3) } })
    const groups = restartGroups([devin, early, watcher], true)
    expect(groups.map(group => [group.name, group.threads.map(thread => thread.id), group.watcherFirst])).toEqual([
      ['Claude Code', ['watcher-1', 'a'], true], ['Devin', ['d'], false]])
    // With Watcher off, its thread counts nowhere.
    expect(restartGroups([early, watcher], false)[0]!.threads.map(thread => thread.id)).toEqual(['a'])
    // An archived thread is never restarted, so it is never named.
    expect(restartGroups([stopped('x', 'Gone', { archivedAt: minutesAgo(1) })], true)).toEqual([])
  })
})

describe('the band at the top of the Threads sidebar', () => {
  it('says when the limit resets, how many threads restart then, Watcher first, and names each', () => {
    const live = mount([stopped('a', 'Merge-train fixes'), stopped('b', 'Usage page tidy'),
      stopped('watcher-1', 'Watcher', { kind: 'watcher' })], { watcher: true })
    const [band] = bands()
    expect(band).toHaveTextContent(`Claude Code’s limit resets at ${clock}. Sotto restarts 3 threads then, Watcher first.`)
    expect(within(band!).getByText(`Claude Code’s limit resets at ${clock}.`).tagName).toBe('STRONG')
    const names = within(within(band!).getByRole('list', { name: 'Threads to restart' })).getAllByRole('button')
    expect(names.map(name => name.textContent)).toEqual(['Watcher', 'Merge-train fixes', 'Usage page tidy'])
    // It sits under the search, before the projects, and nothing in it announces itself.
    const search = document.querySelector('.threads-search')!
    expect(search.compareDocumentPosition(band!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(band!.querySelector('[role="status"], [aria-live]')).toBeNull()
    // A title opens its thread; Watcher's opens its room.
    fireEvent.click(names[1]!)
    expect(sent(live, 'select-thread').at(-1)).toEqual({ type: 'select-thread', threadId: 'a' })
    fireEvent.click(names[0]!)
    expect(navigate).toHaveBeenCalledWith('watcher')
  })

  it('Don’t restart them sends one cancel for each thread, in reading order after the names', async () => {
    const live = mount([stopped('a', 'Merge-train fixes'), stopped('b', 'Usage page tidy')])
    const [band] = bands()
    const cancel = within(band!).getByRole('button', { name: 'Don’t restart Claude Code’s 2 threads' })
    expect(cancel).toHaveTextContent('Don’t restart them')
    const focusable = [...band!.querySelectorAll('button')]
    expect(focusable.at(-1)).toBe(cancel)
    cancel.focus()
    fireEvent.click(cancel)
    await waitFor(() => expect(sent(live, 'cancel-restart')).toEqual([{ type: 'cancel-restart', threadId: 'a' }, { type: 'cancel-restart', threadId: 'b' }]))
    // The host clears the restarts, and the band goes with them.
    act(() => { live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => ({ ...thread, scheduledRestart: undefined })) } }) })
    expect(bands()).toEqual([])
    // Focus, which went with the band, waits in the search field above it.
    expect(screen.getByRole('searchbox', { name: 'Search threads' })).toHaveFocus()
  })

  it('says why when the host refuses, and keeps the band', async () => {
    const live = mount([stopped('a', 'Merge-train fixes')])
    live.command.mockImplementation(async request => request.type === 'cancel-restart' ? { ...live.state, error: 'This thread is no longer scheduled to restart.' } : live.state)
    fireEvent.click(screen.getByRole('button', { name: 'Don’t restart Claude Code’s 1 thread' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This thread is no longer scheduled to restart.')
    expect(bands()).toHaveLength(1)
  })

  it('leaves a provider that never said when its limit resets to the user, with no button', () => {
    mount([stopped('d1', 'Release notes draft', { providerId: 'devin', scheduledRestart: { provider: 'devin', stoppedAt: minutesAgo(3) } }),
      stopped('d2', 'iPhone sheet copy', { providerId: 'devin', scheduledRestart: { provider: 'devin', stoppedAt: minutesAgo(2) } })])
    const [band] = bands()
    expect(band).toHaveTextContent('Devin didn’t say when its limit resets, so Sotto can’t restart its 2 threads on its own. Send again once it resets.')
    expect(within(band!).queryByRole('button', { name: /Don’t restart/ })).toBeNull()
  })

  it('names the day when the reset is not today', () => {
    mount([stopped('a', 'Merge-train fixes', { scheduledRestart: { provider: 'claude', stoppedAt: minutesAgo(1), at: iso(RESET + 24 * 60 * 60_000) } })])
    expect(bands()[0]).toHaveTextContent(`Claude Code’s limit resets tomorrow at ${clock}. Sotto restarts 1 thread then.`)
  })

  it('is not there on stable', () => {
    mount([stopped('a', 'Merge-train fixes')], { restart: false })
    expect(bands()).toEqual([])
    expect(strip()).toBeNull()
  })
})

describe('the stopped thread', () => {
  it('row says when it restarts, in the muted colour, in place of its failure line', () => {
    mount([stopped('a', 'Merge-train fixes'), stopped('b', 'Usage page tidy')])
    const status = rowStatusOf('Usage page tidy')
    expect(status).toHaveTextContent(`Restarts at ${clock}`)
    expect(status).toHaveAttribute('data-restart', 'true')
    cleanup()
    mount([stopped('a', 'Merge-train fixes'), stopped('b', 'Usage page tidy')], { restart: false })
    expect(rowStatusOf('Usage page tidy')).not.toHaveTextContent('Restarts')
    expect(rowStatusOf('Usage page tidy')).not.toHaveAttribute('data-restart')
  })

  it('strip over the composer says when, and Don’t restart comes before the prompt', async () => {
    const live = mount([stopped('a', 'Merge-train fixes')])
    const shown = strip()!
    expect(shown).toHaveTextContent(`Restarts at ${clock}, when Claude Code’s limit resets.`)
    const cancel = within(shown).getByRole('button', { name: 'Don’t restart this thread' })
    expect(cancel).toHaveTextContent('Don’t restart')
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    expect(cancel.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const user = userEvent.setup({ advanceTimers: () => undefined })
    cancel.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(sent(live, 'cancel-restart')).toEqual([{ type: 'cancel-restart', threadId: 'a' }]))
    await waitFor(() => expect(prompt).toHaveFocus())
  })

  it('strip has no button where the provider said no time', () => {
    mount([stopped('d', 'Release notes draft', { providerId: 'devin', scheduledRestart: { provider: 'devin', stoppedAt: minutesAgo(3) } })])
    expect(strip()).toHaveTextContent('Devin didn’t say when its limit resets. Send again once it has.')
    expect(within(strip()!).queryByRole('button')).toBeNull()
  })

  it('pane shows no babysitting pose over the composer with the feature on, and stable keeps it', () => {
    const babysat = stopped('p', 'Greeting', { status: 'idle', scheduledRestart: undefined,
      babysitting: [{ url: 'https://github.com/o/r/pull/74', number: 74, startedBy: 'agent', startedAt: minutesAgo(9) }] })
    mount([babysat])
    expect(document.querySelector('[data-ornament="babysitting"]')).toBeNull()
    cleanup()
    mount([babysat], { restart: false })
    expect(document.querySelector('[data-ornament="babysitting"]')).not.toBeNull()
  })

  it('row says no Babysitting with the feature on', () => {
    const state = threadsStateFixture()
    state.host.threads = [stopped('p', 'Greeting', { status: 'idle', scheduledRestart: undefined, babysitting: [{ url: 'https://github.com/o/r/pull/74', number: 74, startedBy: 'agent', startedAt: minutesAgo(9) }] })]
    const row = describeThreads(state, NOW).find(item => item.thread.id === 'p')!
    expect(rowStatus(row).text).toBe('Babysitting #74')
    expect(rowStatus(row, { restart: true })).toMatchObject({ babysitting: false, background: false })
    expect(rowStatus(row, { restart: true }).text).not.toMatch(/Babysitting/)
  })
})

const context: ActivityContext = { liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }
const note = (text: string, patch: Partial<AgentMessage> = {}): AgentMessage => ({ id: 'r1', role: 'user', text, createdAt: iso(RESET), wakeUp: true, ...patch })

describe('Sotto’s restart note', () => {
  it('is tagged Restarted in the thread, for a reset limit and after Sotto itself restarted', () => {
    owl()
    for (const text of [limitRestartNote('Claude Code'), RESUME_NOTE]) {
      render(<MessageList messages={[note(text)]} provider="Claude Code" running={false} placement={placeActivities([note(text)], [note(text)], [])} context={context} />)
      const header = document.querySelector('.thread-message header') as HTMLElement
      expect(within(header).getByText('Restarted')).toBeVisible()
      expect(header).not.toHaveTextContent('Resumed')
      cleanup()
    }
    // Stable keeps Resumed for the resume note.
    owl({ restart: false })
    render(<MessageList messages={[note(RESUME_NOTE)]} provider="Claude Code" running={false} placement={placeActivities([note(RESUME_NOTE)], [note(RESUME_NOTE)], [])} context={context} />)
    expect(document.querySelector('.thread-message header')).toHaveTextContent('Resumed')
  })

  it('reads Sotto · Restart while it waits in the queue, and its remove says what it does', () => {
    const queue = (restart: boolean): void => {
      owl({ restart })
      const item: AgentFollowup = { id: '11111111-1111-4111-8111-111111111111', threadId: 'footer-links', draftId: '22222222-2222-4222-8222-222222222222', text: limitRestartNote('Claude Code'),
        attachments: [], createdAt: iso(RESET), updatedAt: iso(RESET), status: 'queued', wakeUp: true }
      const state: AgentState = { ...threadsStateFixture(), followups: [item] }
      const row = describeThreads(state, NOW).find(entry => entry.thread.id === 'footer-links')!
      render(<ThreadFollowups row={row} state={state} command={vi.fn(async () => state) as never} store={new ThreadDraftStore(vi.fn(async () => null), 0)} onRetryAdmission={vi.fn()} />)
      const toggle = screen.queryByRole('button', { name: /queued/i })
      if (toggle !== null && toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
    }
    queue(true)
    expect(document.querySelector('.thread-followup__sotto')).toHaveTextContent('Sotto · Restart')
    const remove = screen.getByRole('button', { name: 'Remove the restart note from the queue' })
    expect(remove).toHaveAttribute('title', 'Remove the restart note. The thread waits for your next message.')
    cleanup()
    queue(false)
    expect(document.querySelector('.thread-followup__sotto')).toHaveTextContent('Sotto · Wake-up')
    expect(screen.getByRole('button', { name: 'Remove the wake-up from the queue' })).toHaveAttribute('title', 'Remove the wake-up. Babysitting goes on.')
  })
})

describe('Settings', () => {
  it('shows Restart stopped threads where Resume threads after a restart was, on by default, saying what each value does', async () => {
    vi.useRealTimers()
    owl()
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const view = render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Threads')
    expect(screen.queryByRole('switch', { name: 'Resume threads after a restart', hidden: true })).toBeNull()
    const toggle = screen.getByRole('switch', { name: 'Restart stopped threads' })
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAccessibleDescription('When a provider’s usage limit resets, or Sotto opens again after closing, every thread that was working carries on, with a short note from Sotto in the thread.')
    const switches = screen.getAllByRole('switch').map(item => item.getAttribute('aria-label'))
    expect(switches.indexOf('Restart stopped threads')).toBe(switches.indexOf('Generated thread titles') + 1)
    await user.click(toggle)
    expect(update).toHaveBeenCalledWith({ restartStoppedThreads: false })
    view.rerender(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, restartStoppedThreads: false } })} />)
    expect(screen.getByRole('switch', { name: 'Restart stopped threads' })).toHaveAccessibleDescription('A thread stopped by a usage limit or by Sotto closing waits for your next message.')
  })

  it('keeps Resume threads after a restart on stable', async () => {
    vi.useRealTimers()
    owl({ restart: false })
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Threads')
    expect(screen.getByRole('switch', { name: 'Resume threads after a restart' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Restart stopped threads', hidden: true })).toBeNull()
  })

  it('drops Let agents babysit pull requests from Git & worktrees with the feature on, and keeps it on stable', () => {
    owl()
    render(<GitSettings settings={DEFAULT_SETTINGS} onSave={vi.fn(async () => true)} />)
    expect(screen.queryByRole('switch', { name: 'Let agents babysit pull requests' })).toBeNull()
    cleanup()
    owl({ restart: false })
    render(<GitSettings settings={DEFAULT_SETTINGS} onSave={vi.fn(async () => true)} />)
    expect(screen.getByRole('switch', { name: 'Let agents babysit pull requests' })).toBeInTheDocument()
  })
})
