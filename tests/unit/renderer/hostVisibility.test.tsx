import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { FinishedThreadWatch, showThreads, watchThreads } from '../../../src/renderer/src/agents/finishedThreads'
import { NewThreadDialog } from '../../../src/renderer/src/agents/NewThreadDialog'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const LOCAL = '11111111-1111-4111-8111-111111111111'
const FORGE = '22222222-2222-4222-8222-222222222222'

/** The Threads fixture split across this computer and a remote host named forge, as the router lists them. */
function twoHosts(): AgentState {
  const state = threadsStateFixture()
  const [first, ...rest] = state.host.projects
  state.host.projects = [{ ...first!, hostId: FORGE }, ...rest.map(project => ({ ...project, hostId: LOCAL }))]
  const onForge = new Set([first!.id])
  state.host.threads = state.host.threads.map(thread => {
    const hostId = onForge.has(thread.projectId) ? FORGE : LOCAL
    return { ...thread, hostId, hostLabel: hostId === FORGE ? 'forge' : 'This computer', remoteHost: hostId === FORGE }
  })
  state.connections = [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }, { hostId: FORGE, name: 'forge', kind: 'remote', connected: true }]
  state.hostId = LOCAL
  return state
}
function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<><FinishedThreadWatch /><ThreadsView onOpenAgents={vi.fn()} now={E2E_THREADS_NOW} /></>)
  return live
}
beforeEach(() => { vi.mocked(useAgents).mockReset(); watchThreads([]); showThreads([]) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the host is visible where work happens', () => {
  it('badges every project with its host once threads from more than one host are listed, this computer included', () => {
    const state = twoHosts()
    mount(state)
    const projects = screen.getByRole('region', { name: 'Projects' })
    const forgeProject = state.host.projects[0]!
    const toggle = within(projects).getByRole('button', { name: new RegExp(`^${forgeProject.title} on forge \\d+ threads?$`) })
    expect(toggle.querySelector('.host-badge')?.textContent).toBe('forge')
    const badges = [...projects.querySelectorAll('.host-badge')].map(badge => badge.textContent)
    expect(badges).toContain('This computer')
    expect(badges).toContain('forge')
  })

  it('shows no badge with only one host', () => {
    const state = threadsStateFixture()
    state.connections = [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }]
    mount(state)
    expect(document.querySelector('.host-badge')).toBeNull()
    expect(document.querySelector('.thread-host-chip')).toBeNull()
  })

  it('says in the composer which host the open thread runs on, without offering to change it', () => {
    const state = twoHosts()
    const thread = state.host.threads.find(item => item.hostId === FORGE)!
    state.activeThreadId = thread.id
    mount(state)
    const chip = document.querySelector('.thread-host-chip')!
    expect(chip.textContent).toBe('Runs on forge')
    expect(chip.closest('button')).toBeNull()
  })
})

describe('New thread chooses the host first', () => {
  function dialog(state: AgentState, command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)) {
    const select = vi.fn(async () => ({ hosts: [], localHostEnabled: true, localHostRunning: true }))
    vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => 'C:/New folder') }, hosts: { command: select } })
    render(<NewThreadDialog state={state} command={command} onCreated={vi.fn()} onClose={vi.fn()} />)
    return { command, select }
  }

  it('lists only the chosen host\'s projects, and offers a folder on disk only for this computer', async () => {
    const state = twoHosts()
    dialog(state)
    const hosts = screen.getByRole('group', { name: 'Host' })
    expect(within(hosts).getAllByRole('button').map(button => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([['This computer', 'true'], ['forge', 'false']])
    const titles = () => [...document.querySelectorAll('.new-thread-choice strong')].map(item => item.textContent)
    expect(titles()).toEqual(['Local folder', 'sotto-site', 'notes'])
    fireEvent.click(within(hosts).getByRole('button', { name: 'forge' }))
    expect(within(hosts).getByRole('button', { name: 'forge' }).getAttribute('aria-pressed')).toBe('true')
    expect(titles()).toEqual(['workshop'])
    // Arrow keys move among this host's projects only.
    const search = screen.getByRole('searchbox', { name: 'Search projects' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.querySelector('[data-highlighted]')?.textContent).toContain('workshop')
  })

  it('makes a new folder a project on this computer even when the host selected for new work was another', async () => {
    const state = twoHosts()
    state.hostId = FORGE
    const created = { ...state, host: { ...state.host, projects: [...state.host.projects, { id: 'new-folder', hostId: LOCAL, title: 'New folder', path: 'C:/New folder' }] } }
    const command = vi.fn(async (request: AgentCommand) => (request.type === 'create-project' ? created : state) as AgentState | null)
    const { select } = dialog(state, command)
    const user = userEvent.setup()
    await user.click(within(screen.getByRole('group', { name: 'Host' })).getByRole('button', { name: 'This computer' }))
    await user.click(screen.getByRole('button', { name: /Local folder/ }))
    await user.click(await screen.findByRole('button', { name: /Create thread/ }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-project', path: 'C:/New folder' })))
    expect(select).toHaveBeenCalledWith({ type: 'select', hostId: LOCAL })
    expect(select.mock.invocationCallOrder[0]!).toBeLessThan(command.mock.invocationCallOrder[0]!)
  })
})
