import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentState } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { agentWireBridge } from '../../fixtures/agentBridge'
import { createBridge, renderApp } from '../../fixtures/renderer/appHarness'
import { hostStatus, hostsBridgeFixture, hostsState } from '../../fixtures/renderer/hostBridges'
import { FORGE_HOST_ID, providerStatuses, startingAgentState } from '../../fixtures/renderer/startingScreenState'

/** The app at launch over a preload whose agent state the test publishes, with forge asking for its SSH password. */
function launch(initial: AgentState) {
  const bridge = createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })) })
  let current = initial
  const listeners = new Set<(state: AgentState) => void>()
  const hosts = hostsBridgeFixture({ initial: hostsState({ hosts: [hostStatus({
    id: FORGE_HOST_ID, name: 'forge', phase: 'connecting', prompt: { id: 'password', kind: 'password', text: 'zach@forge’s password:' },
  })] }) })
  window.sotto = {
    ...bridge,
    agents: agentWireBridge({
      get: async () => current, command: async () => current,
      onState: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }),
    hosts: hosts.bridge,
  }
  renderApp(bridge)
  return { publish(next: AgentState): void { current = next; for (const listener of [...listeners]) listener(next) } }
}

describe('the starting screen in the app', () => {
  afterEach(() => { delete (window as { sotto?: unknown }).sotto })

  it('keeps one SSH question across the starting screen and the app, so a half-typed password survives the app opening', async () => {
    document.documentElement.dataset.reducedMotion = 'on'
    const user = userEvent.setup()
    const wire = launch(startingAgentState(providerStatuses({ devin: 'connecting' })))
    expect(await screen.findByText('Connecting Devin')).toBeVisible()
    const field = await screen.findByLabelText('SSH password')
    expect(field).toHaveFocus()
    await user.keyboard('hunt')

    // Devin connects while the question is still open: the app takes the window under the same dialog.
    act(() => wire.publish(startingAgentState(providerStatuses({ devin: 'connected' }))))
    expect(await screen.findByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
    expect(screen.queryByText('Connecting Devin')).not.toBeInTheDocument()
    expect(screen.getAllByRole('dialog', { name: 'Unlock the SSH connection to forge' })).toHaveLength(1)
    expect(screen.getByLabelText('SSH password')).toBe(field)
    expect(field).toHaveValue('hunt')
    expect(field).toHaveFocus()
  })
})
