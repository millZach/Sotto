import { hostsBridgeFixture, hostsState, hostStatus } from '../../fixtures/renderer/hostBridges'
import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { HostProviders } from '../../../src/renderer/src/features/settings/HostProviders'
import type { AgentProviderStatus, ProviderId } from '../../../src/shared/agents'
import type { HostSetupChoice, HostsBridge, HostStatus } from '../../../src/shared/hosts'
import type { HostProviderJobState } from '../../../src/shared/hostProviders'

// Have my agent install it, update it or fix it on a host's provider tiles (ADR-0035, issue #461): the button for each
// case beside Check again, the dialog with its Model picker and Start, and the working tile with Show thread and Stop.
afterEach(cleanup)
const HOST = '22222222-2222-4222-8222-222222222222'
const forge: HostStatus = hostStatus({ id: HOST, hostId: HOST, name: 'forge', target: 'forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase: 'connected', enabled: true })
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
const status = (id: ProviderId, patch: Partial<AgentProviderStatus>): AgentProviderStatus => ({ id, name: id, version: '', connection: 'error', capabilities, ...patch })
const CHOICE: HostSetupChoice = { models: [
  { id: 'claude:opus', name: 'Claude Opus 5.5', provider: 'Claude Code' },
  { id: 'codex:gpt', name: 'GPT-6', provider: 'Codex' },
], modelId: 'codex:gpt' }
const PROVIDERS = [
  status('claude', { problem: 'cannot-start', version: '2.1.281' }),
  status('codex', { connection: 'connected', account: 'ChatGPT', version: '0.155.1' }),
  status('grok', { problem: 'too-old', version: '0.9.12', requiredVersion: '1.0.5' }),
  status('devin', { problem: 'not-installed' }),
]
const job = (patch: Partial<HostProviderJobState> = {}): HostProviderJobState => ({ id: '44444444-4444-4444-8444-444444444444', hostId: HOST, host: 'forge', provider: 'devin', case: 'install',
  threadId: 'host:local:thread', threadTitle: 'Install Devin on forge', modelName: 'GPT-6', phase: 'running', ...patch })
function hosts(command: HostsBridge['command'] = async () => hostsState()) {
  const mock = vi.fn(command)
  const { bridge } = hostsBridgeFixture({ commands: { command: mock } })
  return { bridge, command: mock }
}
const tile = (name: string) => screen.getAllByRole('listitem').find(item => within(item).queryByRole('heading', { name }))!

it('offers the agent that fits why the host cannot use each provider, with Check again beside it', async () => {
  const user = userEvent.setup()
  render(<div className="hosts-settings"><HostProviders host={forge} providers={PROVIDERS} bridge={hosts().bridge} choice={CHOICE} /></div>)
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  expect(within(tile('Devin')).getByRole('button', { name: 'Have my agent install Devin on forge' })).toHaveTextContent('Have my agent install it')
  expect(within(tile('Grok Build')).getByText('0.9.12 on forge. Sotto needs 1.0.5 or later.')).toBeInTheDocument()
  expect(within(tile('Grok Build')).getByRole('button', { name: 'Have my agent update Grok Build on forge' })).toHaveTextContent('Have my agent update it')
  expect(within(tile('Claude Code')).getByText("Installed, but forge's host could not find or start it.")).toBeInTheDocument()
  expect(within(tile('Claude Code')).getByRole('button', { name: 'Have my agent fix Claude Code on forge' })).toHaveTextContent('Have my agent fix it')
  for (const name of ['Devin', 'Grok Build', 'Claude Code']) expect(within(tile(name)).getByRole('button', { name: `Check forge for ${name} again` })).toBeInTheDocument()
  expect(within(tile('Codex')).queryByRole('button', { name: /Have my agent/u })).toBeNull()
})

it('offers Check again and Have my agent fix it for an error the adapter could not name', async () => {
  const user = userEvent.setup()
  const providers = PROVIDERS.map(item => item.id === 'codex' ? status('codex', { version: '0.155.1', error: 'Codex did not confirm the connection.' }) : item)
  render(<div className="hosts-settings"><HostProviders host={forge} providers={providers} bridge={hosts().bridge} choice={CHOICE} /></div>)
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  expect(tile('Codex')).toHaveTextContent("Can't be started")
  expect(within(tile('Codex')).getByRole('button', { name: 'Have my agent fix Codex on forge' })).toHaveTextContent('Have my agent fix it')
  expect(within(tile('Codex')).getByRole('button', { name: 'Check forge for Codex again' })).toBeInTheDocument()
})

it('starts a provider job from the dialog on the model used most, and Escape closes it without starting', async () => {
  const user = userEvent.setup()
  const { bridge, command } = hosts()
  render(<div className="hosts-settings"><HostProviders host={forge} providers={PROVIDERS} bridge={bridge} choice={CHOICE} /></div>)
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  await user.click(within(tile('Devin')).getByRole('button', { name: 'Have my agent install Devin on forge' }))
  let dialog = screen.getByRole('dialog', { name: 'Install Devin on forge' })
  expect(dialog).toHaveTextContent("An agent installs Devin on forge from this computer, in a thread you can watch. It reaches forge through this computer's SSH, and its tool works only on forge. It stops once forge's host finds Devin; you then sign in.")
  expect(dialog).toHaveTextContent('The thread Install Devin on forge goes in the Host setup project.')
  const model = within(dialog).getByRole('combobox', { name: 'Model' })
  expect(model).toHaveValue('codex:gpt')
  expect(model).toHaveAccessibleDescription(/Its provider receives the brief and what the agent's commands print on forge\./u)
  // Focus starts on the main button; Escape closes, and nothing was started.
  expect(within(dialog).getByRole('button', { name: 'Start install' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(command).not.toHaveBeenCalled()

  await user.click(within(tile('Grok Build')).getByRole('button', { name: 'Have my agent update Grok Build on forge' }))
  dialog = screen.getByRole('dialog', { name: 'Update Grok Build on forge' })
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Model' }), 'claude:opus')
  await user.click(within(dialog).getByRole('button', { name: 'Start update' }))
  expect(command).toHaveBeenCalledWith({ type: 'start-provider-job', id: expect.any(String), hostId: HOST, provider: 'grok', modelId: 'claude:opus' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('keeps the dialog open with main\'s reason when the job cannot start, and says why when no model can run it', async () => {
  const user = userEvent.setup()
  const { bridge } = hosts(async () => { throw new Error("Error invoking remote method 'hosts:command': Error: An agent is setting up lab now. Stop that setup first. Nothing was started.") })
  const { rerender } = render(<div className="hosts-settings"><HostProviders host={forge} providers={PROVIDERS} bridge={bridge} choice={CHOICE} /></div>)
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  await user.click(within(tile('Claude Code')).getByRole('button', { name: 'Have my agent fix Claude Code on forge' }))
  const dialog = screen.getByRole('dialog', { name: 'Fix Claude Code on forge' })
  await user.click(within(dialog).getByRole('button', { name: 'Start fix' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('An agent is setting up lab now. Stop that setup first. Nothing was started.')
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  rerender(<div className="hosts-settings"><HostProviders host={forge} providers={PROVIDERS} bridge={bridge}
    choice={{ unavailable: 'An agent sets a host up from a thread on this computer, which needs the local host.', models: [] }} /></div>)
  await user.click(within(tile('Claude Code')).getByRole('button', { name: 'Have my agent fix Claude Code on forge' }))
  const off = screen.getByRole('dialog', { name: 'Fix Claude Code on forge' })
  expect(within(off).getByText('An agent sets a host up from a thread on this computer, which needs the local host.')).toBeInTheDocument()
  expect(within(off).queryByRole('combobox', { name: 'Model' })).toBeNull()
  expect(within(off).getByRole('button', { name: 'Start fix' })).toBeDisabled()
})

it('follows the job on its tile, with Show thread and Stop, and says how it ended', async () => {
  const user = userEvent.setup()
  const { bridge, command } = hosts()
  const view = (value: HostProviderJobState, providers = PROVIDERS) => <div className="hosts-settings"><HostProviders host={forge} providers={providers} bridge={bridge} choice={CHOICE} job={value} /></div>
  const { rerender } = render(view(job()))
  await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  const devin = tile('Devin')
  expect(devin).toHaveTextContent('Agent is installing it')
  expect(devin).toHaveTextContent('In the thread Install Devin on forge on this computer.')
  expect(within(devin).getByRole('button', { name: 'Show thread Install Devin on forge' })).toHaveTextContent('Show thread')
  expect(within(devin).queryByRole('button', { name: /Have my agent/u })).toBeNull()
  // A job on another host, or another provider, leaves this tile alone.
  rerender(view(job({ hostId: '55555555-5555-4555-8555-555555555555' })))
  expect(tile('Devin')).toHaveTextContent('Not installed')
  rerender(view(job()))
  await user.click(within(tile('Devin')).getByRole('button', { name: 'Stop the agent working on Devin on forge' }))
  expect(command).toHaveBeenCalledWith({ type: 'stop-provider-job', id: job().id })
  // Stopped: the tile offers the agent again, says what stays, and focus lands on its first action.
  rerender(view(job({ phase: 'stopped' })))
  expect(tile('Devin')).toHaveTextContent('Stopped. Anything the agent installed on forge stays there, and the thread Install Devin on forge stays in your Threads list.')
  await waitFor(() => expect(within(tile('Devin')).getByRole('button', { name: 'Have my agent install Devin on forge' })).toHaveFocus())
  // A tile changing while focus is elsewhere leaves focus where it is: only the tile whose pressed control went takes it.
  const toggle = screen.getByRole('button', { name: 'Hide providers on forge' })
  toggle.focus()
  rerender(view(job({ phase: 'stopped' }), PROVIDERS.map(item => item.id === 'claude' ? status('claude', { connection: 'connected', version: '2.1.281' }) : item)))
  expect(toggle).toHaveFocus()
  ;(document.activeElement as HTMLElement).blur()
  rerender(view(job({ phase: 'stopped' }), PROVIDERS.map(item => item.id === 'claude' ? status('claude', { problem: 'signed-out', version: '2.1.281' }) : item)))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(document.body).toHaveFocus()
  // Found: the host sees Devin, which waits for the user to sign in.
  rerender(view(job({ phase: 'found' }), PROVIDERS.map(item => item.id === 'devin' ? { ...item, problem: 'signed-out' as const, version: '2026.9.1' } : item)))
  expect(tile('Devin')).toHaveTextContent('Not signed in')
  expect(tile('Devin')).toHaveTextContent("forge's host found it. GPT-6 worked in the thread Install Devin on forge.")
})
