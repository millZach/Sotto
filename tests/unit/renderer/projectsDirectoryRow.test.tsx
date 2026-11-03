import { threadsStateFixture } from '../../fixtures/agentState'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
import type { HostFoldersClientRequest, HostFoldersResult } from '../../../src/shared/hostFolders'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { AgentSetupFields } from '../../../src/renderer/src/agents/AgentAccountSettings'
import { agentContextFixture } from '../../fixtures/agentContext'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))

const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
const LOCAL = '11111111-1111-4111-8111-111111111111'
const FORGE = '22222222-2222-4222-8222-222222222222'

function oneComputer(projectsDirectory = ''): AgentState {
  const state = threadsStateFixture({ cloneOverrides: false, configuration: { ...defaultAgentConfiguration(), projectsDirectory },
    host: { connected: true, name: 'Agents', version: '', capabilities: caps, projects: [], models: [], threads: [] },
    topLevel: { activeThreadId: null, activeProjectId: null } })
  state.hostId = LOCAL
  return state
}
/** This computer with no folder chosen, and forge with `/home/zach/projects`. */
function twoComputers({ forgeConnected = true, local = '', forge = '/home/zach/projects' } = {}): AgentState {
  const state = oneComputer()
  state.connections = [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }, { hostId: FORGE, name: 'forge', kind: 'remote', connected: forgeConnected }]
  state.host.clientHosts = [
    { hostId: LOCAL, connected: true, models: [], capabilities: caps, projectsDirectory: local, mayAnswer: true },
    { hostId: FORGE, connected: forgeConnected, models: [], capabilities: caps, projectsDirectory: forge, mayAnswer: true },
  ]
  return state
}
function provide(state: AgentState, reply: (current: AgentState) => AgentState = current => current) {
  const command = vi.fn(async (): Promise<AgentState> => reply(state))
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  return command
}

/** forge's folders on Linux: its home, the saved projects folder, and anything else empty. */
function forgeListing(path: string): HostFoldersResult {
  const parts = path.split('/').filter(Boolean)
  const folders = path === '/home/zach' ? [{ name: 'projects', path: '/home/zach/projects', git: false }, { name: 'code', path: '/home/zach/code', git: false }]
    : path === '/home/zach/projects' ? [{ name: 'site', path: '/home/zach/projects/site', git: true }] : []
  return { status: 'listed', path, home: '/home/zach', separator: '/', truncated: false, folders,
    crumbs: [{ name: '/', path: '/' }, ...parts.map((name, index) => ({ name, path: '/' + parts.slice(0, index + 1).join('/') }))] }
}
const localHome: HostFoldersResult = { status: 'listed', path: 'C:\\Users\\zache', home: 'C:\\Users\\zache', separator: '\\', truncated: false,
  crumbs: [{ name: 'Drives', path: null }, { name: 'C:', path: 'C:\\' }, { name: 'Users', path: 'C:\\Users' }, { name: 'zache', path: 'C:\\Users\\zache' }],
  folders: [{ name: 'Projects', path: 'C:\\Users\\zache\\Projects', git: false }] }
const localProjects: HostFoldersResult = { ...localHome, path: 'C:\\Users\\zache\\Projects', folders: [],
  crumbs: [...localHome.crumbs, { name: 'Projects', path: 'C:\\Users\\zache\\Projects' }] }

function stubFolders(missing: readonly string[] = []) {
  const hostFolders = vi.fn(async (request: HostFoldersClientRequest): Promise<HostFoldersResult> => {
    if (request.path && missing.includes(request.path)) return { status: 'missing', path: request.path }
    if (request.hostId === FORGE) return forgeListing(request.path ?? '/home/zach')
    return request.path === 'C:\\Users\\zache\\Projects' ? localProjects : localHome
  })
  vi.stubGlobal('sotto', { agents: { hostFolders } })
  return hostFolders
}
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

const projectsCard = () => screen.getByRole('region', { name: 'Projects' })
const folderDialog = () => screen.getByRole('dialog')
const use = () => within(folderDialog()).getByRole('button', { name: 'Use this folder' })

describe('Default projects directory, chosen in the folder browser', () => {
  it('writes each computer’s folder out with no text box to type in', () => {
    provide(twoComputers())
    render(<AgentSetupFields />)
    const card = projectsCard()
    expect(within(card).queryByRole('textbox')).toBeNull()
    expect(within(card).getByText('No folder chosen')).toBeInTheDocument()
    expect(within(card).getByText('/home/zach/projects')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Choose the default projects directory on this computer' })).toHaveTextContent('Choose…')
    expect(within(card).getByRole('button', { name: 'Change the default projects directory on forge' })).toHaveTextContent('Change…')
  })

  it('chooses forge’s folder in forge’s own folders, starting at the saved one, and saves it on forge', async () => {
    const hostFolders = stubFolders()
    const command = provide(twoComputers())
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Change the default projects directory on forge' }))
    await within(folderDialog()).findByRole('button', { name: /^site/ })
    expect(hostFolders).toHaveBeenCalledWith({ hostId: FORGE, path: '/home/zach/projects' })
    // Opening the saved folder never offers it as a project to open.
    expect(within(folderDialog()).queryByRole('button', { name: 'Open project' })).toBeNull()
    fireEvent.click(within(folderDialog()).getByRole('button', { name: /Home/ }))
    await within(folderDialog()).findByRole('button', { name: 'code' })
    fireEvent.click(within(folderDialog()).getByRole('button', { name: 'code' }))
    await waitFor(() => expect(hostFolders).toHaveBeenLastCalledWith({ hostId: FORGE, path: '/home/zach/code' }))
    await waitFor(() => expect(use()).toBeEnabled())
    fireEvent.click(use())
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { projectsDirectory: '/home/zach/code' }, hostId: FORGE }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('starts this computer’s browser at its home folder when none is chosen, and saves the folder for this computer', async () => {
    const hostFolders = stubFolders()
    const command = provide(twoComputers())
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose the default projects directory on this computer' }))
    fireEvent.click(await within(folderDialog()).findByRole('button', { name: 'Projects' }))
    expect(hostFolders).toHaveBeenNthCalledWith(1, { hostId: LOCAL })
    await waitFor(() => expect(use()).toBeEnabled())
    fireEvent.click(use())
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { projectsDirectory: 'C:\\Users\\zache\\Projects' }, hostId: LOCAL }))
  })

  it('saves nothing when the browser is closed', async () => {
    stubFolders()
    const command = provide(twoComputers())
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Change the default projects directory on forge' }))
    await within(folderDialog()).findByRole('button', { name: /^site/ })
    fireEvent.click(within(folderDialog()).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(command).not.toHaveBeenCalled()
    expect(within(projectsCard()).getByText('/home/zach/projects')).toBeInTheDocument()
  })

  it('keeps a disconnected computer’s folder shown and unchangeable until it connects', () => {
    provide(twoComputers({ forgeConnected: false }))
    render(<AgentSetupFields />)
    const card = projectsCard()
    expect(within(card).getByText('/home/zach/projects')).toBeInTheDocument()
    expect(within(card).getByText('Connect forge to change its projects directory.')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Change the default projects directory on forge' })).toBeDisabled()
    expect(within(card).queryByRole('button', { name: 'Clear the default projects directory on forge' })).toBeNull()
  })

  it('stops a choice when forge drops while its folders are open', async () => {
    stubFolders()
    const command = provide(twoComputers())
    const { rerender } = render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Change the default projects directory on forge' }))
    await within(folderDialog()).findByRole('button', { name: /^site/ })
    provide(twoComputers({ forgeConnected: false }))
    rerender(<AgentSetupFields />)
    expect(await within(folderDialog()).findByRole('alert')).toHaveTextContent('forge is not connected, so its folders can\'t be listed. Nothing was changed.')
    expect(use()).toBeDisabled()
    expect(command).not.toHaveBeenCalled()
  })

  it('clears a computer’s folder back to none', async () => {
    const command = provide(twoComputers())
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear the default projects directory on forge' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { projectsDirectory: '' }, hostId: FORGE }))
    expect(screen.getByRole('button', { name: 'Change the default projects directory on forge' })).toHaveFocus()
  })

  it('drops a listing that arrives after forge has dropped', async () => {
    let answer: (result: HostFoldersResult) => void = () => {}
    vi.stubGlobal('sotto', { agents: { hostFolders: vi.fn(() => new Promise<HostFoldersResult>(resolve => { answer = resolve })) } })
    const command = provide(twoComputers())
    const { rerender } = render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Change the default projects directory on forge' }))
    provide(twoComputers({ forgeConnected: false }))
    rerender(<AgentSetupFields />)
    await within(folderDialog()).findByRole('alert')
    answer(forgeListing('/home/zach/projects'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(within(folderDialog()).queryByRole('button', { name: /^site/ })).toBeNull()
    expect(use()).toBeDisabled()
    expect(command).not.toHaveBeenCalled()
  })

  it('lets `/` be the folder new projects go in, though a project can’t be there', async () => {
    stubFolders()
    const command = provide(twoComputers())
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Change the default projects directory on forge' }))
    await within(folderDialog()).findByRole('button', { name: /^site/ })
    fireEvent.click(within(folderDialog()).getByRole('button', { name: '/' }))
    await waitFor(() => expect(within(folderDialog()).getByRole('button', { name: '/' })).toHaveAttribute('aria-current', 'location'))
    await waitFor(() => expect(use()).toBeEnabled())
    fireEvent.click(use())
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { projectsDirectory: '/' }, hostId: FORGE }))
  })

  it('opens at the home folder when the saved folder has gone', async () => {
    const hostFolders = stubFolders(['/home/zach/projects'])
    provide(twoComputers())
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Change the default projects directory on forge' }))
    await within(folderDialog()).findByRole('button', { name: 'code' })
    expect(hostFolders).toHaveBeenLastCalledWith({ hostId: FORGE })
    expect(within(folderDialog()).queryByRole('alert')).toBeNull()
  })

  it('saves a new folder’s path, to be made when a project first goes in it', async () => {
    stubFolders()
    const command = provide(twoComputers())
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Change the default projects directory on forge' }))
    await within(folderDialog()).findByRole('button', { name: /^site/ })
    fireEvent.click(within(folderDialog()).getByRole('button', { name: 'New folder' }))
    fireEvent.change(within(folderDialog()).getByRole('textbox', { name: 'New folder name' }), { target: { value: 'clients' } })
    fireEvent.click(within(folderDialog()).getByRole('button', { name: 'Name folder' }))
    expect(within(folderDialog()).getByText('This folder is new. Sotto makes it on forge when a new project first goes in it.')).toBeInTheDocument()
    fireEvent.click(use())
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { projectsDirectory: '/home/zach/projects/clients' }, hostId: FORGE }))
  })

  it('keeps the browser open and says so when the folder can’t be saved', async () => {
    stubFolders()
    const command = provide(twoComputers(), current => ({ ...current, error: 'Settings could not be saved.' }))
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Change the default projects directory on forge' }))
    await within(folderDialog()).findByRole('button', { name: /^site/ })
    fireEvent.click(use())
    await waitFor(() => expect(command).toHaveBeenCalled())
    expect(await within(folderDialog()).findByRole('alert')).toHaveTextContent('Could not save the folder. Nothing was changed. Try again.')
  })

  it('says a save it never heard back about may have gone through, rather than that nothing changed', async () => {
    stubFolders()
    const command = vi.fn(async (): Promise<AgentState | null> => null)
    vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(twoComputers(), command))
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Change the default projects directory on forge' }))
    await within(folderDialog()).findByRole('button', { name: /^site/ })
    fireEvent.click(use())
    expect(await within(folderDialog()).findByRole('alert')).toHaveTextContent('Sotto could not confirm the folder was saved.')
  })

  it('keeps the keyboard on Choose while Clear saves', async () => {
    let answer: (state: AgentState) => void = () => {}
    const state = twoComputers()
    vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, vi.fn(() => new Promise<AgentState>(resolve => { answer = resolve }))))
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear the default projects directory on forge' }))
    const change = screen.getByRole('button', { name: 'Change the default projects directory on forge' })
    expect(change).toBeEnabled()
    expect(change).toHaveFocus()
    answer(state)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear the default projects directory on forge' })).toBeEnabled())
  })

  it('has one row, for this computer, when no host is paired', async () => {
    stubFolders()
    const command = provide(oneComputer('C:\\Users\\zache\\Projects'))
    render(<AgentSetupFields />)
    expect(within(projectsCard()).getByText('Default projects directory')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change the default projects directory on this computer' }))
    await waitFor(() => expect(use()).toBeEnabled())
    fireEvent.click(use())
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { projectsDirectory: 'C:\\Users\\zache\\Projects' } }))
  })
})
