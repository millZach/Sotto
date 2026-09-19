import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { AppContextValue, AppNavigation } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { PageSidebar } from '../../../src/renderer/src/agents/PageSidebar'
import { SIDEBAR_MODE_KEY } from '../../../src/renderer/src/agents/SidebarFrame'
import { takeNewThreadIntent } from '../../../src/renderer/src/agents/threadIntent'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const sidebar = (): HTMLElement => screen.getByRole('complementary', { name: 'Thread sidebar' })

/** The sidebar beside a page, with the app's navigation and the agent state the page would have. */
function mount(state: AgentState | null, navigation: AppNavigation = 'home', error: string | null = null) {
  const navigate = vi.fn()
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation, platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    actions: { navigate, minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn() },
  } as unknown as AppContextValue)
  const live = state === null ? null : liveAgentState(state)
  const command = vi.fn(async (request: AgentCommand): Promise<AgentState | null> => live?.command(request) ?? null)
  vi.mocked(useAgents).mockImplementation(() => ({ ...(live?.useLive() ?? { state: null, threadDrafts: undefined }), error, command }) as unknown as ReturnType<typeof useAgents>)
  render(<PageSidebar updateControl={<button type="button">Check for updates</button>} now={1_700_000_000_000} />)
  return { navigate, command }
}

beforeEach(() => { vi.mocked(useAgents).mockReset(); localStorage.clear() })
afterEach(() => { cleanup(); localStorage.clear(); takeNewThreadIntent() })

describe('the Threads sidebar beside another page', () => {
  it('lists the threads with the open room lit in its foot and no heading of its own', () => {
    mount(threadsStateFixture())
    const nav = within(sidebar())
    expect(nav.getByRole('button', { name: 'Footer links' })).toBeInTheDocument()
    expect(nav.queryByRole('heading', { level: 1 })).toBeNull()
    expect(nav.getByText('Sotto')).toBeInTheDocument()
    expect(nav.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
    expect(nav.getByRole('tab', { name: 'Threads' })).toHaveAttribute('aria-selected', 'false')
    expect(nav.getByRole('link', { name: 'History' })).not.toHaveAttribute('aria-current')
    expect(nav.getByRole('button', { name: 'Check for updates' })).toBeInTheDocument()
    // No thread is current and no pane is open, so nothing can be opened beside anything.
    expect(nav.queryByRole('button', { name: /beside$/ })).toBeNull()
  })

  it('lights the page link of the open page and no room on a page outside both rooms', () => {
    mount(threadsStateFixture(), 'history')
    const nav = within(sidebar())
    expect(nav.getByRole('link', { name: 'History' })).toHaveAttribute('aria-current', 'page')
    expect(nav.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'false')
    expect(nav.getByRole('tab', { name: 'Threads' })).toHaveAttribute('aria-selected', 'false')
    expect(nav.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('tabindex', '0')
  })

  it('opens a thread on the Threads page', () => {
    const { navigate, command } = mount(threadsStateFixture())
    fireEvent.click(within(sidebar()).getByRole('button', { name: 'Footer links' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'footer-links' })
    expect(navigate).toHaveBeenCalledWith('threads')
  })

  it('hands a New thread to the Threads page, which opens the dialog once', () => {
    const { navigate } = mount(threadsStateFixture())
    fireEvent.click(within(sidebar()).getByRole('button', { name: 'New thread' }))
    expect(navigate).toHaveBeenCalledWith('threads')
    expect(takeNewThreadIntent()).toEqual({ projectId: undefined })
    expect(takeNewThreadIntent()).toBeNull()
  })

  it('leads to the Threads page when the switch is turned to Terminal, remembering the mode', () => {
    const { navigate } = mount(threadsStateFixture())
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sidebar mode' })).getByRole('radio', { name: 'Terminal' }))
    expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('terminals')
    expect(navigate).toHaveBeenCalledWith('threads')
  })

  it('stands as an empty frame with the way off the page until agent controls arrive', () => {
    mount(null)
    const nav = within(sidebar())
    expect(nav.getByText('Preparing agent controls...')).toBeInTheDocument()
    expect(nav.getByText('Sotto')).toBeInTheDocument()
    expect(nav.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
    expect(nav.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    expect(nav.getByRole('button', { name: 'Check for updates' })).toBeInTheDocument()
  })

  it('shows the error where the list would be when agent controls failed', () => {
    mount(null, 'home', 'Agent controls are unavailable.')
    expect(within(sidebar()).getByText('Agent controls are unavailable.')).toBeInTheDocument()
  })
})
