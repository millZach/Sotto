import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_AGENT_HOST, PROVIDER_LABELS, type AgentProviderStatus, type AgentState, type ProviderId } from '../../../../../src/shared/agents'
import type { HostsState } from '../../../../../src/shared/hosts'
import type { SottoE2EBridge } from '../../../../../src/shared/e2e'
import { AgentProvider } from '../../../../../src/renderer/src/agents/AgentContext'
import { writeShellCache } from '../../../../../src/renderer/src/agents/shellCache'
import { STARTING_SCREEN_DONE_KEY, StartingScreenGate } from '../../../../../src/renderer/src/features/starting/StartingScreen'
import { LATE_AFTER_MS, LEAVE_MS, REVEAL_AFTER_MS } from '../../../../../src/renderer/src/features/starting/startingView'
import { agentWireBridge } from '../../../../fixtures/agentBridge'
import { threadsStateFixture } from '../../../../fixtures/agentState'
import { hostStatus, hostsBridgeFixture, hostsState } from '../../../../fixtures/renderer/hostBridges'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const FORGE = '22222222-2222-4222-8222-222222222222'

function agent(providers: Partial<Record<ProviderId, AgentProviderStatus['connection']>>): AgentState {
  const statuses = Object.entries(providers).map(([id, connection]) => ({
    id: id as ProviderId, connection, name: PROVIDER_LABELS[id as ProviderId], version: '', capabilities: EMPTY_AGENT_HOST.capabilities,
  }))
  return threadsStateFixture({
    topLevel: { clientScoped: true, connections: [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }] },
    host: { clientHosts: [{ hostId: LOCAL, connected: true, models: [], capabilities: EMPTY_AGENT_HOST.capabilities, providers: statuses }] },
  })
}

/** The preload's agent and hosts bridges over states the test publishes. */
function bridges(initial: AgentState, hosts: HostsState = hostsState(), get?: () => Promise<AgentState>) {
  let current = initial
  const listeners = new Set<(state: AgentState) => void>()
  const agents = agentWireBridge({
    get: get ?? (async () => current), command: async () => current,
    onState: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  const hostsFixture = hostsBridgeFixture({ initial: hosts })
  Object.assign(window, { sotto: { agents, hosts: hostsFixture.bridge } })
  return {
    publish(next: AgentState): void { current = next; for (const listener of [...listeners]) listener(next) },
    hosts: hostsFixture,
  }
}

function Window({ settingsSettled = true, eligible = true }: { readonly settingsSettled?: boolean; readonly eligible?: boolean }): React.ReactNode {
  return (
    <AgentProvider settings={null}>
      <StartingScreenGate settingsSettled={settingsSettled} eligible={eligible} frame={starting => <main aria-label="Window">{starting}</main>}>
        <p>The app</p>
      </StartingScreenGate>
    </AgentProvider>
  )
}

/** Lets the bridges answer and React commit what they said. */
async function settle(ms = 0): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('the starting screen gate', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    delete (window as { sotto?: unknown }).sotto
    delete (window as { sottoE2E?: unknown }).sottoE2E
    delete document.documentElement.dataset.reducedMotion
  })

  it('covers launch while a provider connects, then fades into the app and remembers that this window opened it', async () => {
    const wire = bridges(agent({ codex: 'connected', devin: 'connecting' }))
    render(<Window />)
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Connecting Devin')
    expect(screen.getByRole('list', { name: 'Providers and hosts' })).toHaveTextContent('Codex, readyDevin, connecting')
    expect(screen.queryByText('The app')).not.toBeInTheDocument()
    // Nothing on the screen takes focus while it waits.
    expect(screen.queryAllByRole('button')).toEqual([])

    act(() => wire.publish(agent({ codex: 'connected', devin: 'connected' })))
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Ready')
    expect(screen.queryByText('The app')).not.toBeInTheDocument()
    await settle(LEAVE_MS)
    expect(screen.getByText('The app')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(sessionStorage.getItem(STARTING_SCREEN_DONE_KEY)).toBe('1')

    // Launch only: a provider dropping and reconnecting later never brings it back.
    act(() => wire.publish(agent({ codex: 'connected', devin: 'connecting' })))
    await settle(LATE_AFTER_MS)
    expect(screen.getByText('The app')).toBeVisible()
  })

  it('replaces the screen in one step with reduced motion', async () => {
    document.documentElement.dataset.reducedMotion = 'on'
    const wire = bridges(agent({ claude: 'connecting' }))
    render(<Window />)
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Connecting Claude Code')
    act(() => wire.publish(agent({ claude: 'connected' })))
    await settle()
    expect(screen.getByText('The app')).toBeVisible()
  })

  it('after ten seconds names what has not answered, focuses its button, and opens Sotto without it', async () => {
    const wire = bridges(agent({}), hostsState({ hosts: [hostStatus({ id: FORGE, name: 'forge', phase: 'connecting', reconnecting: true })] }))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<Window />)
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Connecting forge')
    expect(screen.queryAllByRole('button')).toEqual([])

    await settle(LATE_AFTER_MS)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for forge')
    expect(screen.getByRole('list', { name: 'Providers and hosts' })).toHaveTextContent('forge, not answering')
    const button = screen.getByRole('button', { name: 'Open Sotto without forge' })
    expect(button).toHaveFocus()
    expect(button).toHaveAccessibleDescription('forge has not answered in 10 seconds. Sotto keeps trying in the background.')

    await user.keyboard('{Enter}')
    await settle(LEAVE_MS)
    expect(screen.getByText('The app')).toBeVisible()
    // forge is still connecting; the app opened without waiting for it.
    expect(wire.hosts.state().hosts[0]!.phase).toBe('connecting')
  })

  it('says nothing and opens the app when there is nothing to connect', async () => {
    bridges(agent({ codex: 'disconnected' }))
    render(<Window />)
    expect(screen.getByRole('status')).toHaveTextContent('')
    await settle()
    expect(screen.getByText('The app')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('does not take the last run’s cached shell for an answer', async () => {
    writeShellCache(agent({ codex: 'connected' }))
    bridges(agent({ codex: 'connected' }), hostsState(), () => new Promise(() => undefined))
    render(<Window />)
    await settle(REVEAL_AFTER_MS)
    expect(screen.getByRole('status')).toHaveTextContent('Loading your threads')
    expect(screen.queryByText('The app')).not.toBeInTheDocument()
    // Main never answered: at ten seconds the screen stops waiting for it.
    await settle(LATE_AFTER_MS)
    await settle(LEAVE_MS)
    expect(screen.getByText('The app')).toBeVisible()
  })

  it('goes straight to the app on a reload of a window that already opened it', async () => {
    sessionStorage.setItem(STARTING_SCREEN_DONE_KEY, '1')
    bridges(agent({ devin: 'connecting' }))
    render(<Window />)
    expect(screen.getByText('The app')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('leaves first-run setup alone, and does not appear when setup finishes in the same window', async () => {
    bridges(agent({ devin: 'connecting' }))
    const view = render(<Window eligible={false} />)
    expect(screen.getByText('The app')).toBeVisible()
    await settle()
    expect(sessionStorage.getItem(STARTING_SCREEN_DONE_KEY)).toBe('1')
    view.rerender(<Window eligible />)
    await settle()
    expect(screen.getByText('The app')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('waits for settings before deciding, without painting the app first', async () => {
    bridges(agent({ devin: 'connecting' }))
    const view = render(<Window settingsSettled={false} />)
    // Until settings load, the window shows what it shows today (here, the app slot holds the loading view).
    expect(screen.getByText('The app')).toBeVisible()
    view.rerender(<Window settingsSettled />)
    expect(screen.queryByText('The app')).not.toBeInTheDocument()
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Connecting Devin')
  })

  it('shows in an end-to-end run only when the spec asks for it', async () => {
    bridges(agent({ devin: 'connecting' }))
    const e2e = { scenario: 'success', snapshot: vi.fn(), triggerShortcut: vi.fn() } satisfies SottoE2EBridge
    Object.assign(window, { sottoE2E: e2e })
    const plain = render(<Window />)
    expect(screen.getByText('The app')).toBeVisible()
    plain.unmount()
    sessionStorage.clear()
    Object.assign(window, { sottoE2E: { ...e2e, startingScreen: true } })
    render(<Window />)
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Connecting Devin')
  })

  it('needs main’s agent state to know what is connecting', () => {
    Object.assign(window, { sotto: {} })
    render(<Window />)
    expect(screen.getByText('The app')).toBeVisible()
  })
})
