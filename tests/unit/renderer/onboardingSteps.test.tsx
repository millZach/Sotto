import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentCapabilities, type AgentProject, type AgentProviderStatus, type AgentState } from '../../../src/shared/agents'
import { PROVIDER_INSTALL_GUIDES } from '../../../src/shared/hostProviders'
import type { HostsBridge, HostsState, HostStatus } from '../../../src/shared/hosts'
import { IPHONE_BETA_URL, type PhonesBridge, type PhonesCommand, type PhonesState } from '../../../src/shared/phones'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { Onboarding } from '../../../src/renderer/src/features/onboarding/Onboarding'
import { AgentsStep } from '../../../src/renderer/src/features/onboarding/AgentsStep'
import { ComputersStep } from '../../../src/renderer/src/features/onboarding/ComputersStep'
import { LookStep } from '../../../src/renderer/src/features/onboarding/LookStep'
import { PhoneStep } from '../../../src/renderer/src/features/onboarding/PhoneStep'
import { ProjectStep } from '../../../src/renderer/src/features/onboarding/ProjectStep'
import { appearancePreview } from '../../../src/renderer/src/state/appearance'
import { agentContextFixture } from '../../fixtures/agentContext'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/features/settings/HostDialog', () => ({ HostDialog: ({ onClose }: { readonly onClose: () => void }) => <div role="dialog" aria-label="Add a computer (stub)"><button onClick={onClose}>Close stub dialog</button></div> }))

afterEach(() => { cleanup(); vi.clearAllMocks(); appearancePreview.reset() })

const CAPS: AgentCapabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }

function agentState(providers: readonly AgentProviderStatus[], projects: readonly AgentProject[] = [], options: { stale?: boolean } = {}): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected',
    host: { connected: true, name: 'Test', version: '1.0', capabilities: CAPS, projects: [...projects], providers: [...providers], models: [], threads: [] },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
    ...(options.stale ? { stale: true } : {}),
  }
}

function provide(state: AgentState | null, command = vi.fn(async () => state)): void {
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
}

function appearanceSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

describe('LookStep', () => {
  it('says when a look could not be saved, and clears that once a choice saves', async () => {
    const onUpdateSettings = vi.fn(async () => false)
    const user = userEvent.setup()
    render(<LookStep settings={appearanceSettings({ appearance: 'dark' })} platform="win32" onUpdateSettings={onUpdateSettings} heading={<div />} />)
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That look could not be saved. Your previous look is still on.')
    onUpdateSettings.mockResolvedValue(true)
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('sends an appearance patch and shows the saved mode as checked', async () => {
    const onUpdateSettings = vi.fn(async () => true)
    const user = userEvent.setup()
    render(<LookStep settings={appearanceSettings({ appearance: 'dark' })} platform="win32" onUpdateSettings={onUpdateSettings} heading={<div />} />)
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(onUpdateSettings).toHaveBeenCalledWith({ appearance: 'light' })
  })

  it('names the system option after the platform', () => {
    render(<LookStep settings={appearanceSettings()} platform="darwin" onUpdateSettings={vi.fn(async () => true)} heading={<div />} />)
    expect(screen.getByRole('radio', { name: 'Match macOS' })).toBeVisible()
  })

  it('sends a theme patch for both halves and shows the saved theme as checked', async () => {
    const onUpdateSettings = vi.fn(async () => true)
    const user = userEvent.setup()
    render(<LookStep settings={appearanceSettings({ lightTheme: 't3-code', darkTheme: 't3-code' })} platform="win32" onUpdateSettings={onUpdateSettings} heading={<div />} />)
    expect(screen.getByRole('radio', { name: 'Sotto' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: 'Hush' }))
    expect(onUpdateSettings).toHaveBeenCalledWith({ lightTheme: 'hush', darkTheme: 'hush' })
  })

  it('moves and chooses with arrow keys inside a radiogroup', async () => {
    const onUpdateSettings = vi.fn(async () => true)
    const user = userEvent.setup()
    render(<LookStep settings={appearanceSettings({ appearance: 'light' })} platform="win32" onUpdateSettings={onUpdateSettings} heading={<div />} />)
    screen.getByRole('radio', { name: 'Light' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Match Windows' })).toHaveFocus()
    expect(onUpdateSettings).toHaveBeenCalledWith({ appearance: 'system' })
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus()
    expect(onUpdateSettings).toHaveBeenCalledWith({ appearance: 'light' })
  })
})

describe('AgentsStep', () => {
  it('sends connect exactly once when a live state first arrives, never for a stale one', async () => {
    const command = vi.fn(async () => agentState([]))
    provide(agentState([], [], { stale: true }), command)
    const { rerender } = render(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)
    expect(command).not.toHaveBeenCalled()

    provide(agentState([{ id: 'codex', connection: 'disconnected', name: 'Codex', version: '', capabilities: CAPS }]), command)
    rerender(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)
    await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'connect' }))

    rerender(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('never auto-connects when a provider is already connected, and Check again retries only the clients with a problem', async () => {
    const providers: AgentProviderStatus[] = [
      { id: 'codex', connection: 'connected', name: 'Codex', version: '1.2.3', capabilities: CAPS },
      { id: 'grok', connection: 'error', name: 'Grok Build', version: '', capabilities: CAPS, problem: 'signed-out' },
    ]
    const command = vi.fn(async () => agentState(providers))
    provide(agentState(providers), command)
    const user = userEvent.setup()
    render(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)
    expect(command).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'refresh', provider: 'grok' }))
  })

  it('runs Connect providers again on Check again while no client is connected', async () => {
    const providers: AgentProviderStatus[] = [{ id: 'claude', connection: 'error', name: 'Claude Code', version: '', capabilities: CAPS, problem: 'signed-out' }]
    const command = vi.fn(async () => agentState(providers))
    provide(agentState(providers), command)
    const user = userEvent.setup()
    render(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'connect' }))
    command.mockClear()
    await user.click(await screen.findByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'connect' }))
    expect(command).toHaveBeenCalledWith({ type: 'refresh', provider: 'claude' })
  })

  it('says Not connected, never Not installed, for a client main has not tried, and connects it on Connect', async () => {
    const providers: AgentProviderStatus[] = [
      { id: 'codex', connection: 'connected', name: 'Codex', version: '1.2.3', capabilities: CAPS },
      { id: 'claude', connection: 'disconnected', name: 'Claude Code', version: '', capabilities: CAPS },
    ]
    const command = vi.fn(async () => agentState(providers))
    provide(agentState(providers), command)
    const user = userEvent.setup()
    render(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)
    const claudeRow = screen.getByText('Claude Code').closest('li')!
    expect(claudeRow).toHaveTextContent('Not connected')
    expect(claudeRow).not.toHaveTextContent('Not installed')
    expect(screen.queryByRole('button', { name: 'Open the Claude Code install guide' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Connect Claude Code' }))
    await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'connect', provider: 'claude' }))
  })

  it('maps each provider problem to its row label and detail', () => {
    const providers: AgentProviderStatus[] = [
      { id: 'codex', connection: 'connected', name: 'Codex', version: '1.2.3', capabilities: CAPS, account: 'zach' },
      { id: 'claude', connection: 'connecting', name: 'Claude Code', version: '', capabilities: CAPS },
      { id: 'grok', connection: 'error', name: 'Grok Build', version: '', capabilities: CAPS, problem: 'not-installed', error: 'Not found on this computer.' },
      { id: 'devin', connection: 'error', name: 'Devin', version: '', capabilities: CAPS, problem: 'signed-out', error: 'Sign in to Devin.' },
    ]
    provide(agentState(providers))
    render(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)

    const codexRow = screen.getByText('Codex').closest('li')!
    expect(codexRow).toHaveTextContent('Ready')
    const claudeRow = screen.getByText('Claude Code').closest('li')!
    expect(claudeRow).toHaveTextContent('Checking…')
    const grokRow = screen.getByText('Grok Build').closest('li')!
    expect(grokRow).toHaveTextContent('Not installed')
    expect(grokRow).toHaveTextContent('Not found on this computer.')
    expect(screen.getByRole('button', { name: 'Open the Grok Build install guide' })).toBeVisible()
    const devinRow = screen.getByText('Devin').closest('li')!
    expect(devinRow).toHaveTextContent('Not signed in')
    expect(devinRow).toHaveTextContent('Sign in to Devin.')
    expect(screen.queryByRole('button', { name: 'Open the Devin install guide' })).toBeNull()
  })

  it('maps too-old and cannot-start problems', () => {
    const providers: AgentProviderStatus[] = [
      { id: 'codex', connection: 'error', name: 'Codex', version: '', capabilities: CAPS, problem: 'too-old', error: 'Update it.' },
      { id: 'claude', connection: 'error', name: 'Claude Code', version: '', capabilities: CAPS, problem: 'cannot-start', error: 'Sotto could not start it.' },
    ]
    provide(agentState(providers))
    render(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)
    const codexRow = screen.getByText('Codex').closest('li')!
    expect(codexRow).toHaveTextContent('Too old to use')
    expect(codexRow).toHaveTextContent('Update it.')
    expect(screen.getByRole('button', { name: 'Open the Codex install guide' })).toBeVisible()
    const claudeRow = screen.getByText('Claude Code').closest('li')!
    expect(claudeRow).toHaveTextContent("Can't be started")
    expect(claudeRow).toHaveTextContent('Sotto could not start it.')
  })

  it('opens the install guide and reports success', async () => {
    const providers: AgentProviderStatus[] = [{ id: 'codex', connection: 'error', name: 'Codex', version: '', capabilities: CAPS, problem: 'not-installed' }]
    provide(agentState(providers))
    const user = userEvent.setup()
    const onOpenLink = vi.fn(async () => true)
    render(<AgentsStep heading={<div />} onOpenLink={onOpenLink} />)
    await user.click(screen.getByRole('button', { name: 'Open the Codex install guide' }))
    expect(onOpenLink).toHaveBeenCalledWith(PROVIDER_INSTALL_GUIDES.codex)
    expect(screen.queryByText(/Your browser did not open/)).toBeNull()
  })

  it('shows a failure sentence when the install guide link does not open', async () => {
    const providers: AgentProviderStatus[] = [{ id: 'codex', connection: 'error', name: 'Codex', version: '', capabilities: CAPS, problem: 'not-installed' }]
    provide(agentState(providers))
    const user = userEvent.setup()
    const onOpenLink = vi.fn(async () => false)
    render(<AgentsStep heading={<div />} onOpenLink={onOpenLink} />)
    await user.click(screen.getByRole('button', { name: 'Open the Codex install guide' }))
    expect(await screen.findByText(/Your browser did not open/)).toBeVisible()
  })
})

describe('AgentsStep on a desktop with another computer', () => {
  const LOCAL = '11111111-1111-4111-8111-111111111111'
  const REMOTE = '22222222-2222-4222-8222-222222222222'
  const local = { hostId: LOCAL, name: 'This computer', kind: 'local' as const, connected: true }
  const remote = { hostId: REMOTE, name: 'forge', kind: 'remote' as const, connected: true }
  const withHosts = (selected: string, connections: AgentState['connections']): AgentState => ({ ...agentState([]), hostId: selected, connections })
  const sotto = (selectedAfter: string) => {
    const hosts = { command: vi.fn(async () => ({})) }
    const agents = { get: vi.fn(async () => ({ hostId: selectedAfter })) }
    Object.assign(window, { sotto: { hosts, agents } })
    return { hosts, agents }
  }
  afterEach(() => { Reflect.deleteProperty(window, 'sotto') })

  it('checks nothing and says why when this computer runs no local host', async () => {
    sotto(REMOTE)
    const command = vi.fn(async () => agentState([]))
    provide(withHosts(REMOTE, [remote]), command)
    render(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('This computer’s local host is off')
    expect(command).not.toHaveBeenCalled()
  })

  it('checks nothing when it cannot switch to this computer', async () => {
    const { hosts } = sotto(REMOTE)
    const command = vi.fn(async () => agentState([]))
    provide(withHosts(REMOTE, [local, remote]), command)
    render(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Sotto could not switch to this computer, so it checked nothing.')
    expect(hosts.command).toHaveBeenCalledWith({ type: 'select', hostId: LOCAL })
    expect(command).not.toHaveBeenCalled()
  })

  it('switches to this computer to check it, and gives the selection back when the step closes', async () => {
    const { hosts } = sotto(LOCAL)
    const command = vi.fn(async () => agentState([]))
    provide(withHosts(REMOTE, [local, remote]), command)
    const { unmount } = render(<AgentsStep heading={<div />} onOpenLink={vi.fn(async () => true)} />)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'connect' }))
    expect(hosts.command).toHaveBeenCalledWith({ type: 'select', hostId: LOCAL })
    unmount()
    expect(hosts.command).toHaveBeenLastCalledWith({ type: 'select', hostId: REMOTE })
  })
})

describe('ProjectStep', () => {
  it('shows the needs-agent sentence when no local provider is connected', () => {
    provide(agentState([]))
    render(<ProjectStep heading={<div />} />)
    expect(screen.getByText(/Connect a coding agent first/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Choose a folder' })).toBeNull()
  })

  it('offers Choose a folder once a provider is connected', () => {
    provide(agentState([{ id: 'codex', connection: 'connected', name: 'Codex', version: '1.0.0', capabilities: CAPS }]))
    render(<ProjectStep heading={<div />} />)
    expect(screen.getByRole('button', { name: 'Choose a folder' })).toBeVisible()
    expect(screen.queryByText(/Connect a coding agent first/)).toBeNull()
  })

  it('offers Add another folder, not Choose a folder, once a project already exists', () => {
    provide(agentState(
      [{ id: 'codex', connection: 'connected', name: 'Codex', version: '1.0.0', capabilities: CAPS }],
      [{ id: 'project', title: 'workshop', path: '/home/zach/workshop' }],
    ))
    render(<ProjectStep heading={<div />} />)
    expect(screen.getByRole('button', { name: 'Add another folder' })).toBeVisible()
    expect(screen.getByText('workshop')).toBeVisible()
  })
})

function hostsFixture(hosts: HostStatus[] = []): { readonly bridge: HostsBridge } {
  const state: HostsState = { hosts, localHostEnabled: true, localHostRunning: true }
  const bridge: HostsBridge = {
    get: async () => state,
    command: vi.fn(async () => state),
    onChanged: () => () => undefined,
    devices: vi.fn(async () => ({ tailscale: { state: 'running' as const, user: 'zach', loginName: 'zach@github', deviceCount: 1 }, devices: [] })),
    tailscale: vi.fn(async () => ({ state: 'running' as const, user: 'zach', loginName: 'zach@github', deviceCount: 1 })),
    connectTailscale: vi.fn(async () => 'connected' as const),
    openTailscaleDownload: vi.fn(async () => undefined),
    providerAction: vi.fn(async () => ({})) as HostsBridge['providerAction'],
    updateClients: vi.fn(async () => ({})) as HostsBridge['updateClients'],
    signIn: vi.fn(async () => null),
  }
  return { bridge }
}

describe('ComputersStep', () => {
  function host(patch: Partial<HostStatus> = {}): HostStatus {
    return { id: 'host-1', name: 'Build box', target: 'zach@build', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase: 'connected', enabled: true, ...patch }
  }

  it('lists hosts from the bridge and reports their count', async () => {
    const { bridge } = hostsFixture([host()])
    const onHostsChange = vi.fn()
    render(<ComputersStep heading={<div />} bridge={bridge} onHostsChange={onHostsChange} />)
    expect(await screen.findByText('Build box')).toBeVisible()
    // The count is reported from an effect after the render that shows the host.
    await waitFor(() => expect(onHostsChange).toHaveBeenCalledWith(1))
  })

  it('reports zero hosts when none are saved', async () => {
    const { bridge } = hostsFixture([])
    const onHostsChange = vi.fn()
    render(<ComputersStep heading={<div />} bridge={bridge} onHostsChange={onHostsChange} />)
    await screen.findByRole('button', { name: 'Add a computer' })
    await waitFor(() => expect(onHostsChange).toHaveBeenCalledWith(0))
  })

  it('opens the Add a computer dialog on press', async () => {
    const { bridge } = hostsFixture([])
    const user = userEvent.setup()
    render(<ComputersStep heading={<div />} bridge={bridge} />)
    await user.click(await screen.findByRole('button', { name: 'Add a computer' }))
    expect(screen.getByRole('dialog', { name: 'Add a computer (stub)' })).toBeVisible()
  })
})

function phonesFixture(initial: Partial<PhonesState> = {}): { readonly bridge: PhonesBridge; readonly command: ReturnType<typeof vi.fn> } {
  let state: PhonesState = {
    enabled: false, localHostRunning: true, phase: 'off',
    tailscale: { status: 'waiting' }, serve: { status: 'waiting' },
    address: null, computerName: 'This computer', defaultName: 'This computer',
    code: null, phones: [], answersAvailable: true, ...initial,
  }
  const command = vi.fn(async (request: PhonesCommand) => {
    if (request.type === 'show-code') state = { ...state, code: { code: '12345678', expiresAt: new Date(Date.now() + 300_000).toISOString() } }
    if (request.type === 'cancel-code') state = { ...state, code: null }
    return state
  })
  const bridge: PhonesBridge = { get: async () => state, command, onChanged: () => () => undefined }
  return { bridge, command }
}

describe('PhoneStep', () => {
  it('reports success when the beta link opens', async () => {
    const { bridge } = phonesFixture()
    const user = userEvent.setup()
    const onOpenLink = vi.fn(async () => true)
    render(<PhoneStep heading={<div />} phoneAccess={false} onUpdateSettings={vi.fn(async () => true)} onOpenLink={onOpenLink} bridge={bridge} />)
    await user.click(screen.getByRole('button', { name: 'Get the iPhone beta' }))
    expect(onOpenLink).toHaveBeenCalledOnce()
    expect(onOpenLink).toHaveBeenCalledWith(IPHONE_BETA_URL)
    expect(await screen.findByText('Opened in your browser')).toBeVisible()
  })

  it('reports failure when the beta link does not open', async () => {
    const { bridge } = phonesFixture()
    const user = userEvent.setup()
    const onOpenLink = vi.fn(async () => false)
    render(<PhoneStep heading={<div />} phoneAccess={false} onUpdateSettings={vi.fn(async () => true)} onOpenLink={onOpenLink} bridge={bridge} />)
    await user.click(screen.getByRole('button', { name: 'Get the iPhone beta' }))
    expect(await screen.findByText(/Your browser did not open/)).toBeVisible()
  })

  it('patches phoneAccess from the toggle', async () => {
    const { bridge } = phonesFixture()
    const onUpdateSettings = vi.fn(async () => true)
    const user = userEvent.setup()
    render(<PhoneStep heading={<div />} phoneAccess={false} onUpdateSettings={onUpdateSettings} onOpenLink={vi.fn(async () => true)} bridge={bridge} />)
    await user.click(await screen.findByRole('switch', { name: 'Let phones connect' }))
    expect(onUpdateSettings).toHaveBeenCalledWith({ phoneAccess: true })
  })

  it('shows a pairing code after Show a pairing code', async () => {
    const { bridge, command } = phonesFixture({ phase: 'on', enabled: true })
    const user = userEvent.setup()
    render(<PhoneStep heading={<div />} phoneAccess onUpdateSettings={vi.fn(async () => true)} onOpenLink={vi.fn(async () => true)} bridge={bridge} />)
    await user.click(await screen.findByRole('button', { name: 'Show a pairing code' }))
    expect(command).toHaveBeenCalledWith({ type: 'show-code' })
    expect(await screen.findByRole('group', { name: 'Pairing code' })).toBeVisible()
  })

  it('moves focus to the code, names this computer as the app asks for it, and gives focus back when Escape cancels the code', async () => {
    const { bridge, command } = phonesFixture({ phase: 'on', enabled: true, tailscale: { status: 'ok', hostName: 'forge', dnsName: 'forge.tail1234.ts.net' } })
    const user = userEvent.setup()
    render(<PhoneStep heading={<div />} phoneAccess onUpdateSettings={vi.fn(async () => true)} onOpenLink={vi.fn(async () => true)} bridge={bridge} />)
    await user.click(await screen.findByRole('button', { name: 'Show a pairing code' }))
    const code = await screen.findByRole('group', { name: 'Pairing code' })
    await waitFor(() => expect(code).toHaveFocus())
    expect(code).toHaveTextContent('In the app, tap Add computer, enter forge, then this code.')
    await user.keyboard('{Escape}')
    expect(command).toHaveBeenCalledWith({ type: 'cancel-code' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show a pairing code' })).toHaveFocus())
  })
})

describe('Onboarding forward button labels', () => {
  const base = { settings: DEFAULT_SETTINGS, onUpdateSettings: vi.fn(async () => true), onCheckTranscriptionKey: vi.fn(async () => ({ ok: true as const })), shortcut: 'Ctrl+Shift+Space', platform: 'win32' as const, onRequestMicrophone: vi.fn(), onComplete: vi.fn() }

  it('reads Continue on steps that are always done', async () => {
    const user = userEvent.setup()
    render(<Onboarding {...base} microphoneState="ready" />)
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    expect(screen.getByRole('heading', { name: 'Choose how Sotto looks' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull()
  })

  it('reads Skip for now on a step whose task is not done, and Continue once it is', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Onboarding {...base} microphoneState="idle" />)
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('heading', { name: 'Check your microphone' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeVisible()

    rerender(<Onboarding {...base} microphoneState="ready" />)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeVisible()
  })

  it('reads Skip for now on the key step while the key is empty', async () => {
    const user = userEvent.setup()
    render(<Onboarding {...base} microphoneState="ready" />)
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('heading', { name: 'Connect your OpenRouter key' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(screen.getByRole('heading', { name: 'One shortcut from speech to text' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeVisible()
  })
})
