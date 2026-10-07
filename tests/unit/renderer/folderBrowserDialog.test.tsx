import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROJECT_FOLDER_MISSING, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import type { HostFoldersClientRequest, HostFoldersResult } from '../../../src/shared/hostFolders'
import { browsableHosts, FolderBrowserDialog } from '../../../src/renderer/src/agents/FolderBrowserDialog'
import { useAddProject } from '../../../src/renderer/src/agents/addProject'
import { projectForFolder, useProjectChooser, type ProjectChoice } from '../../../src/renderer/src/agents/ProjectChooser'
import { threadsStateFixture } from './liveAgentState'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const FORGE = '22222222-2222-4222-8222-222222222222'

/** This computer on Windows and forge on Linux, with forge-ml already a project on forge. */
function twoHosts(): AgentState {
  const state = threadsStateFixture()
  state.host.projects = [...state.host.projects.map(project => ({ ...project, hostId: LOCAL })),
    { id: 'forge-ml', hostId: FORGE, title: 'forge-ml', path: '/home/zach/code/forge-ml' }]
  state.connections = [{ hostId: FORGE, name: 'forge', kind: 'remote', connected: true }, { hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }]
  state.hostId = LOCAL
  return state
}

const forgeFolders: Record<string, HostFoldersResult> = {
  home: { status: 'listed', path: '/home/zach', home: '/home/zach', separator: '/', truncated: false,
    crumbs: [{ name: '/', path: '/' }, { name: 'home', path: '/home' }, { name: 'zach', path: '/home/zach' }],
    folders: [{ name: 'code', path: '/home/zach/code', git: false }, { name: 'datasets', path: '/home/zach/datasets', git: false }] },
  '/home/zach/code': { status: 'listed', path: '/home/zach/code', home: '/home/zach', separator: '/', truncated: false,
    crumbs: [{ name: '/', path: '/' }, { name: 'home', path: '/home' }, { name: 'zach', path: '/home/zach' }, { name: 'code', path: '/home/zach/code' }],
    folders: [{ name: 'forge-ml', path: '/home/zach/code/forge-ml', git: true }, { name: 'sotto', path: '/home/zach/code/sotto', git: true }] },
  '/home/zach/datasets': { status: 'unreadable', path: '/home/zach/datasets' },
}
/** Any other folder on forge: listed, with nothing inside. */
function emptyForgeFolder(path: string): HostFoldersResult {
  const parts = path.split('/').filter(Boolean)
  return { status: 'listed', path, home: '/home/zach', separator: '/', truncated: false, folders: [],
    crumbs: [{ name: '/', path: '/' }, ...parts.map((name, index) => ({ name, path: '/' + parts.slice(0, index + 1).join('/') }))] }
}
const localHome: HostFoldersResult = { status: 'listed', path: 'C:\\Users\\zache', home: 'C:\\Users\\zache', separator: '\\', truncated: false,
  crumbs: [{ name: 'Drives', path: null }, { name: 'C:', path: 'C:\\' }, { name: 'Users', path: 'C:\\Users' }, { name: 'zache', path: 'C:\\Users\\zache' }],
  folders: [{ name: 'source', path: 'C:\\Users\\zache\\source', git: false }] }

function stubBridge(extra: Record<string, unknown> = {}) {
  const hostFolders = vi.fn(async (request: HostFoldersClientRequest): Promise<HostFoldersResult> =>
    request.hostId === FORGE ? forgeFolders[request.path ?? 'home'] ?? emptyForgeFolder(request.path!) : localHome)
  const chooseProjectDirectory = vi.fn(async () => 'D:\\Talk to Text Application')
  const select = vi.fn(async () => ({ hosts: [], localHostEnabled: true, localHostRunning: true }))
  vi.stubGlobal('sotto', { agents: { hostFolders, chooseProjectDirectory }, hosts: { command: select }, ...extra })
  return { hostFolders, chooseProjectDirectory, select }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('browsableHosts', () => {
  it('counts this computer as a host and lists it first', () => {
    expect(browsableHosts(twoHosts()).map(host => host.name)).toEqual(['This computer', 'forge'])
    expect(browsableHosts({ hostId: LOCAL })).toEqual([{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }])
  })
})

describe('FolderBrowserDialog', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])('finishes composing a folder name before naming it: %j', async composition => {
    stubBridge()
    render(<FolderBrowserDialog state={twoHosts()} hostId={FORGE} heading="Choose a folder" onUse={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('button', { name: 'code' })
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const input = screen.getByRole('textbox', { name: 'New folder name' })
    fireEvent.change(input, { target: { value: 'new-project' } })
    fireEvent.keyDown(input, { key: 'Enter', ...composition })
    expect(input).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('textbox', { name: 'New folder name' })).toBeNull()
    expect(screen.getByText(/This folder is new/)).toBeInTheDocument()
  })
  it('asks for the computer first, with none chosen, then lists that computer\'s home folder', async () => {
    const { hostFolders } = stubBridge()
    const user = userEvent.setup()
    render(<FolderBrowserDialog state={twoHosts()} heading="Where should this project live?" onUse={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Where should this project live?' })).toBeVisible()
    const computers = screen.getByRole('group', { name: 'Computers' })
    expect(within(computers).getAllByRole('button').map(button => button.querySelector('strong')?.textContent)).toEqual(['This computer', 'forge'])
    expect(computers.querySelector('[data-highlighted]')).toBeNull()
    expect(hostFolders).not.toHaveBeenCalled()
    await user.click(within(computers).getByRole('button', { name: /forge/ }))
    await waitFor(() => expect(hostFolders).toHaveBeenCalledWith({ hostId: FORGE }))
    expect(await screen.findByRole('button', { name: 'code' })).toBeVisible()
    expect(within(screen.getByRole('navigation', { name: 'Folder on forge' })).getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'location')
    // This computer's own folder dialog cannot see forge's disks.
    expect(screen.queryByRole('button', { name: 'Browse with File Explorer' })).toBeNull()
  })

  it('opens folders, goes up with Backspace, and marks repositories and projects', async () => {
    const { hostFolders } = stubBridge()
    const user = userEvent.setup()
    render(<FolderBrowserDialog state={twoHosts()} hostId={FORGE} heading="Add" onUse={vi.fn()} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'code' }))
    await waitFor(() => expect(hostFolders).toHaveBeenLastCalledWith({ hostId: FORGE, path: '/home/zach/code' }))
    const forgeMl = await screen.findByRole('button', { name: /forge-ml/ })
    expect(forgeMl).toHaveTextContent('Git')
    expect(forgeMl).toHaveTextContent('Project')
    expect(screen.getByRole('button', { name: /^sotto/ })).not.toHaveTextContent('Project')
    await user.click(screen.getByRole('searchbox'))
    await user.keyboard('{Backspace}')
    await waitFor(() => expect(hostFolders).toHaveBeenLastCalledWith({ hostId: FORGE, path: '/home/zach' }))
  })

  it('says a folder it cannot read was left alone, and keeps the list it had', async () => {
    stubBridge()
    const user = userEvent.setup()
    render(<FolderBrowserDialog state={twoHosts()} hostId={FORGE} heading="Add" onUse={vi.fn()} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'datasets' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sotto can\'t read datasets on forge. It may belong to another account. Nothing was changed; choose another folder.')
    expect(screen.getByRole('button', { name: 'code' })).toBeVisible()
  })

  it('names a new folder in the host\'s own format, made only when the folder is used', async () => {
    stubBridge()
    const onUse = vi.fn()
    const user = userEvent.setup()
    render(<FolderBrowserDialog state={twoHosts()} hostId={FORGE} heading="Add" onUse={onUse} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'code' }))
    await screen.findByRole('button', { name: /forge-ml/ })
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'sotto{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('A folder named sotto is already here.')
    // Linux keeps case and allows a colon, so neither is refused on forge.
    await user.clear(screen.getByRole('textbox', { name: 'New folder name' }))
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'Sotto:old')
    await user.click(screen.getByRole('button', { name: 'Name folder' }))
    expect(screen.getByText(/This folder is new/)).toBeVisible()
    await user.click(within(screen.getByRole('navigation', { name: 'Folder on forge' })).getByRole('button', { name: 'code' }))
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await user.clear(screen.getByRole('textbox', { name: 'New folder name' }))
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'voice-lab{Enter}')
    expect(screen.getByText(/This folder is new/)).toBeVisible()
    expect(onUse).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(onUse).toHaveBeenCalledWith({ hostId: FORGE, path: '/home/zach/code/voice-lab', name: 'voice-lab', isNew: true })
  })

  it('offers Open project for a folder that is one, and uses the folder with Ctrl+Enter', async () => {
    stubBridge()
    const onUse = vi.fn()
    const user = userEvent.setup()
    render(<FolderBrowserDialog state={twoHosts()} hostId={FORGE} heading="Add" onUse={onUse} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'code' }))
    await user.click(await screen.findByRole('button', { name: /forge-ml/ }))
    expect(await screen.findByRole('button', { name: 'Open project' })).toBeVisible()
    await user.click(screen.getByRole('searchbox'))
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(onUse).toHaveBeenCalledWith({ hostId: FORGE, path: '/home/zach/code/forge-ml', name: 'forge-ml' })
  })

  it('offers this computer\'s own folder dialog beside its folders', async () => {
    const { chooseProjectDirectory } = stubBridge()
    const onUse = vi.fn()
    const user = userEvent.setup()
    render(<FolderBrowserDialog state={twoHosts()} hostId={LOCAL} heading="Add" onUse={onUse} onClose={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'source' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Browse with File Explorer' }))
    expect(chooseProjectDirectory).toHaveBeenCalledOnce()
    await waitFor(() => expect(onUse).toHaveBeenCalledWith({ hostId: LOCAL, path: 'D:\\Talk to Text Application', name: 'Talk to Text Application' }))
  })

  it('skips the computer step when this computer is the only one', async () => {
    const { hostFolders } = stubBridge()
    const state = twoHosts()
    state.connections = [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }]
    render(<FolderBrowserDialog state={state} heading="Where should this project live?" onUse={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'source' })).toBeVisible()
    expect(hostFolders).toHaveBeenCalledWith({ hostId: LOCAL })
    expect(screen.queryByRole('group', { name: 'Computers' })).toBeNull()
  })

  it('asks about a paired computer that is off, and says how to switch it on', async () => {
    const { hostFolders } = stubBridge({ hosts: { command: vi.fn(), onChanged: vi.fn(() => () => undefined),
      get: vi.fn(async () => ({ hosts: [{ id: '33333333-3333-4333-8333-333333333333', name: 'studio', target: 'studio', identityFile: '', installPath: '', dataDirectory: '', enabled: false, phase: 'disconnected' }], localHostEnabled: true, localHostRunning: true })) } })
    const state = twoHosts()
    state.connections = [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }]
    const user = userEvent.setup()
    render(<FolderBrowserDialog state={state} heading="Where should this project live?" onUse={vi.fn()} onClose={vi.fn()} />)
    const computers = await screen.findByRole('group', { name: 'Computers' })
    expect(within(computers).getByRole('button', { name: /studio/ })).toHaveTextContent('Off')
    await user.click(within(computers).getByRole('button', { name: /studio/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('studio is switched off, so its folders can\'t be listed. Nothing was changed. Switch it on in Settings > Hosts, then try again.')
    expect(hostFolders).not.toHaveBeenCalled()
  })

  it('does not offer the top of a machine as a project folder', async () => {
    stubBridge()
    const user = userEvent.setup()
    render(<FolderBrowserDialog state={twoHosts()} hostId={FORGE} heading="Add" onUse={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('button', { name: 'code' })
    await user.click(within(screen.getByRole('navigation', { name: 'Folder on forge' })).getByRole('button', { name: '/' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled())
  })

  it('says a disconnected computer cannot be browsed', async () => {
    const { hostFolders } = stubBridge()
    const state = twoHosts()
    state.connections = state.connections!.map(item => item.hostId === FORGE ? { ...item, connected: false } : item)
    const user = userEvent.setup()
    render(<FolderBrowserDialog state={state} heading="Add" onUse={vi.fn()} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /forge/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('forge is not connected, so its folders can\'t be listed. Nothing was changed.')
    expect(hostFolders).not.toHaveBeenCalled()
  })
})

describe('Add project', () => {
  function Harness({ state, command }: { readonly state: AgentState; readonly command: (request: AgentCommand) => Promise<AgentState | null> }) {
    const addProject = useAddProject(state, command)
    return <><button type="button" onClick={() => void addProject.add()}>Add project</button>{addProject.dialog}</>
  }

  it('selects the chosen computer, then adds the folder there as a project', async () => {
    const { select } = stubBridge()
    const state = twoHosts()
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state as AgentState | null)
    const user = userEvent.setup()
    render(<Harness state={state} command={command} />)
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.click(screen.getByRole('button', { name: /forge/ }))
    await user.click(await screen.findByRole('button', { name: 'code' }))
    await user.click(await screen.findByRole('button', { name: /^sotto/ }))
    await screen.findByText('No folders in here.')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-project', title: 'sotto', path: '/home/zach/code/sotto', useExisting: true })))
    expect(select).toHaveBeenCalledWith({ type: 'select', hostId: FORGE })
    expect(select.mock.invocationCallOrder[0]!).toBeLessThan(command.mock.invocationCallOrder[0]!)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull())
  })

  it('asks the host to make a folder named with New folder rather than attach it as existing', async () => {
    stubBridge()
    const state = twoHosts()
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state as AgentState | null)
    const user = userEvent.setup()
    render(<Harness state={state} command={command} />)
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.click(screen.getByRole('button', { name: /forge/ }))
    await user.click(await screen.findByRole('button', { name: 'code' }))
    await screen.findByRole('button', { name: /forge-ml/ })
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'voice-lab{Enter}')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-project', title: 'voice-lab', path: '/home/zach/code/voice-lab' })))
    expect(command.mock.calls.find(([request]) => request.type === 'create-project')![0]).not.toHaveProperty('useExisting')
  })

  it('attaches a new folder as existing when its first try went unanswered', async () => {
    stubBridge()
    const state = twoHosts()
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => null)
    const user = userEvent.setup()
    render(<Harness state={state} command={command} />)
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.click(screen.getByRole('button', { name: /forge/ }))
    await user.click(await screen.findByRole('button', { name: 'code' }))
    await screen.findByRole('button', { name: /forge-ml/ })
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'voice-lab{Enter}')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm the new project.')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(command.mock.calls.filter(([request]) => request.type === 'create-project')).toHaveLength(2))
    const [first, second] = command.mock.calls.filter(([request]) => request.type === 'create-project').map(([request]) => request)
    expect(first).not.toHaveProperty('useExisting')
    expect(second).toMatchObject({ path: '/home/zach/code/voice-lab', useExisting: true })
  })

  it('makes a new folder after all when the check finds its unanswered first try made nothing', async () => {
    stubBridge()
    const state = twoHosts()
    const answers: (AgentState | null)[] = [null, { ...state, error: PROJECT_FOLDER_MISSING }, state]
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async request => request.type === 'create-project' && answers.length ? answers.shift()! : state)
    const user = userEvent.setup()
    render(<Harness state={state} command={command} />)
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.click(screen.getByRole('button', { name: /forge/ }))
    await user.click(await screen.findByRole('button', { name: 'code' }))
    await screen.findByRole('button', { name: /forge-ml/ })
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'voice-lab{Enter}')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm the new project.')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull())
    const sent = command.mock.calls.map(([request]) => request).filter(request => request.type === 'create-project')
    expect(sent.map(request => 'useExisting' in request)).toEqual([false, true, false])
  })

  it('forgets an unanswered new folder when Add project is opened again', async () => {
    stubBridge()
    const state = twoHosts()
    const answers: (AgentState | null)[] = [null, state]
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async request => request.type === 'create-project' && answers.length ? answers.shift()! : state)
    const user = userEvent.setup()
    render(<Harness state={state} command={command} />)
    const nameVoiceLab = async (): Promise<void> => {
      await user.click(screen.getByRole('button', { name: 'Add project' }))
      await user.click(await screen.findByRole('button', { name: /forge/ }))
      await user.click(await screen.findByRole('button', { name: 'code' }))
      await screen.findByRole('button', { name: /forge-ml/ })
      await user.click(screen.getByRole('button', { name: 'New folder' }))
      await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'voice-lab{Enter}')
      await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    }
    await nameVoiceLab()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm the new project.')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull())
    await nameVoiceLab()
    await waitFor(() => expect(command.mock.calls.filter(([request]) => request.type === 'create-project')).toHaveLength(2))
    const sent = command.mock.calls.map(([request]) => request).filter(request => request.type === 'create-project')
    expect(sent.map(request => 'useExisting' in request)).toEqual([false, false])
  })

  it('opens the project a folder already is, on that computer', async () => {
    stubBridge()
    const state = twoHosts()
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state as AgentState | null)
    const user = userEvent.setup()
    render(<Harness state={state} command={command} />)
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.click(screen.getByRole('button', { name: /forge/ }))
    await user.click(await screen.findByRole('button', { name: 'code' }))
    await user.click(await screen.findByRole('button', { name: /forge-ml/ }))
    await user.click(await screen.findByRole('button', { name: 'Open project' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'select-project', projectId: 'forge-ml' }))
  })

  it('keeps the dialog open with the refusal when the host does not add the project', async () => {
    stubBridge()
    const state = twoHosts()
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => ({ ...state, error: 'Connect Codex before creating a project.' }) as AgentState | null)
    const user = userEvent.setup()
    render(<Harness state={state} command={command} />)
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.click(screen.getByRole('button', { name: /forge/ }))
    await user.click(await screen.findByRole('button', { name: 'code' }))
    await screen.findByRole('button', { name: /^sotto/ })
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connect Codex before creating a project.')
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeEnabled()
  })
})

describe('a folder chosen in New thread or New terminal', () => {
  function Chooser({ onChoose }: { readonly onChoose: (choice: ProjectChoice) => void }) {
    const chooser = useProjectChooser(twoHosts(), onChoose, { hostId: FORGE })
    return <>{chooser.choices}</>
  }

  it('carries New folder through the project chooser', async () => {
    stubBridge()
    const onChoose = vi.fn()
    const user = userEvent.setup()
    render(<Chooser onChoose={onChoose} />)
    await user.click(screen.getByRole('button', { name: /Folder on forge/ }))
    await user.click(await screen.findByRole('button', { name: 'code' }))
    // forge-ml is listed as a project too, so the folder list shows it a second time once code is open.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /forge-ml/ })).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'voice-lab{Enter}')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(onChoose).toHaveBeenCalledWith({ folder: '/home/zach/code/voice-lab', isNew: true })
  })

  it('is made when it was named with New folder, and otherwise attached only if it is still there', async () => {
    const state = twoHosts()
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state as AgentState | null)
    const common = { command, latest: () => state, providerId: undefined, hostId: FORGE }
    await projectForFolder({ ...common, folder: '/home/zach/code/voice-lab', isNew: true, attempted: new Set() })
    expect(command).toHaveBeenNthCalledWith(1, { type: 'create-project', title: 'voice-lab', path: '/home/zach/code/voice-lab' })
    await projectForFolder({ ...common, folder: '/home/zach/code/sotto', attempted: new Set() })
    expect(command).toHaveBeenCalledWith({ type: 'create-project', title: 'sotto', path: '/home/zach/code/sotto', useExisting: true })
  })
})
