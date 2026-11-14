import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import type { MailGrantStop, PluginsBridge, ThreadMailGrant } from '../../../src/shared/plugins'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { WatcherIdentity } from '../../../src/shared/watcher'
import type { WatcherBridge, WatcherRoomResult, WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SidebarChromeProvider } from '../../../src/renderer/src/agents/SidebarFrame'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { WatcherRoomProvider } from '../../../src/renderer/src/watcher/watcherRoom'
import { roomView } from '../../../src/renderer/src/watcher/WatcherBeside'
import { WatcherView } from '../../../src/renderer/src/watcher/WatcherView'
import { firstMessage } from '../../../src/renderer/src/watcher/watcherFirstMessage'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { openSidebarFolders } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn() }))

/**
 * Ask before Watcher reads a mail account, in a ··· menu at the end of Watcher's strip (#2563; ADR-0205, decision 8;
 * Zach's pick A on November 13, 2026, of the tag prototype/watcher-mail-grant). Watcher is never settled, so this is
 * where its mail grant is ended. The menu is there only while it has a row, so the strip is as it was the rest of
 * the time, and on stable there is none of it.
 */
const NOW = E2E_THREADS_NOW
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const at = new Date(NOW).toISOString()
const MENU = 'More actions'
const identity: WatcherIdentity = { target: { hostId: HOST, threadId: 'watcher' }, projectId: 'workshop', provider: 'codex',
  creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at }
/** Made-up accounts, by Sotto's IDs for them and the names the user gave them. */
const PERSONAL: ThreadMailGrant = { accountId: '33333333-3333-4333-8333-000000000001', plugin: 'gmail', name: 'Personal' }
const WORK: ThreadMailGrant = { accountId: '33333333-3333-4333-8333-000000000002', plugin: 'gmail', name: 'Work' }

function watcherThread(): AgentThread {
  return { id: 'watcher', kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'idle', requests: [],
    messages: [{ id: 'watcher-1', role: 'user', text: 'Find the invoice Ann sent last week.', createdAt: new Date(NOW - 60_000).toISOString() },
      { id: 'watcher-2', role: 'assistant', text: 'It is in Personal, from Tuesday.', createdAt: new Date(NOW - 30_000).toISOString() }] }
}
function agentState(): AgentState {
  const state = threadsStateFixture()
  state.host.threads.push(watcherThread())
  openSidebarFolders(state)
  return state
}
const room: WatcherRoomState = {
  current: identity, currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [],
  requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: at,
  context: { tokens: 190_000, compactAt: 400_000, canCompact: true, compacting: false }, state: { watching: [], waitingOnUser: [], kept: { decisions: [], rules: [], issues: [], updatedAt: null } },
}

/** The part of the plugins bridge the menu uses, over the mail grants each thread holds. */
function mail(held: Record<string, ThreadMailGrant[]>, options: { stops?: boolean } = {}) {
  const listeners = new Set<() => void>()
  const stopped: MailGrantStop[] = []
  const asked: string[] = []
  const bridge = {
    mailGrants: async (threadId: string) => { asked.push(threadId); return [...held[threadId] ?? []] },
    stopMailGrant: async (request: MailGrantStop) => {
      stopped.push(request)
      if (options.stops === false) return false
      held[request.threadId] = (held[request.threadId] ?? []).filter(grant => grant.accountId !== request.accountId)
      for (const listener of [...listeners]) listener()
      return true
    },
    onMailGrantsChanged: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } as unknown as PluginsBridge
  return { bridge, stopped, asked, changed: () => { for (const listener of [...listeners]) listener() } }
}

function renderRoom(plugins: PluginsBridge, owl = true): void {
  const state = agentState()
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation: 'watcher', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { watcherEnabled: true, owlFeatures: { watcher: true, plugins: owl } }, actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() },
  } as unknown as AppContextValue)
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  const connection = agentContextFixture(state, command, { threadDrafts: new ThreadDraftStore(command) })
  vi.mocked(useAgents).mockReturnValue(connection)
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  const ok: WatcherRoomResult = { status: 'ok', state: room }
  const watcher = { get: vi.fn(async () => ok), open: vi.fn(async () => ok), prepareStopAll: vi.fn(), stopAll: vi.fn(), onChanged: vi.fn(() => () => {}) } as unknown as WatcherBridge
  vi.stubGlobal('sotto', { plugins })
  render(<WatcherRoomProvider bridge={watcher}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
}
/** Watcher's strip once its conversation is up: the room's header, which holds its name, All threads and what sits at its end. */
async function strip(): Promise<HTMLElement> {
  await screen.findByText('It is in Personal, from Tuesday.')
  return screen.getByRole('heading', { level: 1, name: 'Watcher' }).closest('header')!
}

beforeEach(() => { vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset(); localStorage.clear(); sessionStorage.clear(); roomView.set({ besideId: null, share: 0.5 }); firstMessage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })

it('has no ··· menu in Watcher’s strip while Watcher can read no mail account', async () => {
  const m = mail({ watcher: [] })
  renderRoom(m.bridge)
  const head = await strip()
  await waitFor(() => expect(m.asked).toEqual(['watcher']))
  expect(within(head).queryByRole('button', { name: MENU })).toBeNull()
  expect(document.querySelector('.pane-menu')).toBeNull()
})

it('offers Ask before Watcher reads for each mail account Watcher can read, last in its strip, and a press ends that grant', async () => {
  const user = userEvent.setup()
  const m = mail({ watcher: [PERSONAL, WORK] })
  renderRoom(m.bridge)
  const head = await strip()
  const menu = await within(head).findByRole('button', { name: MENU })
  // The last thing in the strip, after All threads.
  expect(head.querySelector('.thread-workspace__actions')!.lastElementChild).toBe(menu.closest('.pane-menu'))
  expect(menu).toHaveAttribute('aria-expanded', 'false')
  await user.click(menu)
  const rows = within(head).getByRole('menu', { name: MENU })
  expect(within(rows).getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Ask before Watcher reads Personal', 'Ask before Watcher reads Work'])
  // The first row holds focus, and Escape puts the menu away and gives focus back to its button.
  expect(within(rows).getByRole('menuitem', { name: 'Ask before Watcher reads Personal' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(within(head).queryByRole('menu')).toBeNull()
  expect(menu).toHaveFocus()

  await user.click(menu)
  await user.click(within(head).getByRole('menuitem', { name: 'Ask before Watcher reads Personal' }))
  expect(m.stopped).toEqual([{ threadId: 'watcher', accountId: PERSONAL.accountId }])
  await user.click(await within(head).findByRole('button', { name: MENU }))
  await waitFor(() => expect(within(head).getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Ask before Watcher reads Work']))
  // The last grant ended, the menu goes: the strip is as it was.
  await user.click(within(head).getByRole('menuitem', { name: 'Ask before Watcher reads Work' }))
  await waitFor(() => expect(within(head).queryByRole('button', { name: MENU })).toBeNull())
  expect(screen.queryByRole('alert')).toBeNull()
  // Watcher's own pane does not ask for the same rows a second time: the room asked once, and once after each change.
  expect(m.asked.every(id => id === 'watcher')).toBe(true)
  expect(m.asked.length).toBeLessThanOrEqual(5)
})

it('shows the menu once Watcher is let read an account, as main says a grant changed', async () => {
  const held: Record<string, ThreadMailGrant[]> = { watcher: [] }
  const m = mail(held)
  renderRoom(m.bridge)
  const head = await strip()
  await waitFor(() => expect(m.asked).toEqual(['watcher']))
  held.watcher = [PERSONAL]
  await act(async () => { m.changed() })
  expect(await within(head).findByRole('button', { name: MENU })).toBeInTheDocument()
})

it('moves focus to All threads when the last row is chosen from the keyboard, rather than nowhere', async () => {
  const user = userEvent.setup()
  const m = mail({ watcher: [PERSONAL] })
  renderRoom(m.bridge)
  const head = await strip()
  const menu = await within(head).findByRole('button', { name: MENU })
  menu.focus()
  await user.keyboard('{Enter}')
  expect(within(head).getByRole('menuitem', { name: 'Ask before Watcher reads Personal' })).toHaveFocus()
  await user.keyboard('{Enter}')
  // The grant ended, so the menu and its button are gone. Focus is on the strip's All threads, not on the page.
  await waitFor(() => expect(within(head).queryByRole('button', { name: MENU })).toBeNull())
  expect(m.stopped).toEqual([{ threadId: 'watcher', accountId: PERSONAL.accountId }])
  expect(within(head).getByRole('button', { name: /^All threads, \d+\. Show the list$/u })).toHaveFocus()
})

it('closes an open menu whose last grant ends some other way, so it is closed when Watcher is next let read', async () => {
  const user = userEvent.setup()
  const held: Record<string, ThreadMailGrant[]> = { watcher: [PERSONAL] }
  const m = mail(held)
  renderRoom(m.bridge)
  const head = await strip()
  await user.click(await within(head).findByRole('button', { name: MENU }))
  expect(within(head).getByRole('menu', { name: MENU })).toBeInTheDocument()
  // The account is removed while the menu is open: the menu goes, and focus, which was on its row, goes to All threads.
  held.watcher = []
  await act(async () => { m.changed() })
  await waitFor(() => expect(within(head).queryByRole('button', { name: MENU })).toBeNull())
  expect(within(head).getByRole('button', { name: /^All threads, \d+\. Show the list$/u })).toHaveFocus()
  // Watcher is let read an account again: the menu's button is back, closed.
  held.watcher = [WORK]
  await act(async () => { m.changed() })
  const again = await within(head).findByRole('button', { name: MENU })
  expect(again).toHaveAttribute('aria-expanded', 'false')
  expect(within(head).queryByRole('menu')).toBeNull()
})

it('leaves focus where it is when the last grant ends while the keyboard is elsewhere', async () => {
  const held: Record<string, ThreadMailGrant[]> = { watcher: [PERSONAL] }
  const m = mail(held)
  renderRoom(m.bridge)
  const head = await strip()
  await within(head).findByRole('button', { name: MENU })
  const prompt = screen.getByRole('textbox', { name: 'Watcher message' })
  prompt.focus()
  held.watcher = []
  await act(async () => { m.changed() })
  await waitFor(() => expect(within(head).queryByRole('button', { name: MENU })).toBeNull())
  expect(prompt).toHaveFocus()
})

it('says so in Watcher’s room when a grant could not be ended, and leaves the row', async () => {
  const user = userEvent.setup()
  const m = mail({ watcher: [PERSONAL] }, { stops: false })
  renderRoom(m.bridge)
  const head = await strip()
  await user.click(await within(head).findByRole('button', { name: MENU }))
  await user.click(within(head).getByRole('menuitem', { name: 'Ask before Watcher reads Personal' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Sotto could not stop Watcher reading Personal, so it can still read it. Try again.')
  // Said once, by the room, not a second time by Watcher's own pane.
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  await user.click(within(head).getByRole('button', { name: MENU }))
  expect(within(head).getByRole('menuitem', { name: 'Ask before Watcher reads Personal' })).toBeInTheDocument()
})

it('shows and asks nothing of it on stable, where plugins are held', async () => {
  const m = mail({ watcher: [PERSONAL] })
  renderRoom(m.bridge, false)
  const head = await strip()
  await act(async () => undefined)
  expect(within(head).queryByRole('button', { name: MENU })).toBeNull()
  expect(m.asked).toEqual([])
})
