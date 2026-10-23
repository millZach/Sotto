import { baseProps } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { useOptionalAgents } from '../../../../../src/renderer/src/agents/AgentContext'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { aimProviderSettings } from '../../../../../src/renderer/src/features/settings/settingsTarget'
import { defaultAgentConfiguration, PROVIDER_LABELS, providerIdSchema } from '../../../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'
import { agentContextFixture } from '../../../../fixtures/agentContext'
import { threadsStateFixture } from '../../../../fixtures/agentState'

/** Idle compaction's switch (ADR-0123): on Claude Code's page in Settings › Providers, saved as this computer's setting. */
const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
function provideAgents(): void {
  const state = threadsStateFixture({ configuration: { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'claude'] },
    host: { connected: true, name: 'Providers', version: '', capabilities: caps, projects: [], models: [], threads: [],
      providers: providerIdSchema.options.map(id => ({ id, name: PROVIDER_LABELS[id], version: '1.2.3', connection: 'connected', capabilities: caps })) } })
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, vi.fn(async () => state)))
}

it('opens Claude Code’s page with the switch in focus when a thread’s Turn off asks, and saves turning it off', async () => {
  provideAgents()
  const onUpdateSettings = vi.fn(async () => true)
  aimProviderSettings('claude')
  render(<SettingsView {...baseProps({ onUpdateSettings, openSection: { section: 'settings-providers', key: 1, settings: ['Compact idle threads'] } })} />)
  const toggle = await screen.findByRole('switch', { name: 'Compact idle threads' })
  await waitFor(() => expect(toggle).toHaveFocus())
  expect(toggle).toHaveAttribute('aria-checked', String(DEFAULT_SETTINGS.compactIdleThreads))
  await userEvent.click(toggle)
  expect(onUpdateSettings).toHaveBeenCalledWith({ compactIdleThreads: false })
})

it('Find a setting shows Claude Code’s page and puts focus on the switch, from whichever provider was showing', async () => {
  const user = userEvent.setup()
  provideAgents()
  render(<SettingsView {...baseProps()} />)
  await user.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'compact idle')
  const found = screen.getByRole('list', { name: 'Settings found' })
  await user.click(within(found).getByRole('button', { name: /Compact idle threads/u }))
  expect(screen.getByRole('switch', { name: 'Compact idle threads' })).toHaveFocus()
})
