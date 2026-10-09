import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { HostDialog } from '../../../src/renderer/src/features/settings/HostDialog'
import { HostsSettings } from '../../../src/renderer/src/features/settings/HostsSettings'
import { HostQuestionDialog } from '../../../src/renderer/src/features/settings/HostQuestionDialog'
import type { HostSetupChoice, HostSetupState, HostsBridge, HostsCommand, HostsState, HostStatus } from '../../../src/shared/hosts'
import type { HostDevice } from '../../../src/shared/hostDevices'

// Have my agent set this up in Add host (ADR-0035, issue #431): the two choices, the setup view that follows the
// setup thread, Close and Stop setup, and Have my agent fix this under a failed step of Add it.
afterEach(cleanup)
const LOCAL = '11111111-1111-4111-8111-111111111111'
const CHOICE: HostSetupChoice = { models: [
  { id: 'claude:opus', name: 'Claude Opus 5.5', provider: 'Claude Code' },
  { id: 'codex:gpt', name: 'GPT-6', provider: 'Codex' },
], modelId: 'codex:gpt' }
/** The one device Add host lists: an alias from the SSH configuration. */
const DEVICES: HostDevice[] = [{ target: 'forge', name: 'forge', names: ['forge'], sshConfiguration: true }]
function fixture(choice: HostSetupChoice | undefined = CHOICE, answer?: (command: HostsCommand, state: HostsState) => HostsState) {
  let state: HostsState = { localHostEnabled: true, localHostRunning: true, localHostId: LOCAL, activeHostId: LOCAL, hosts: [], ...(choice ? { setupChoice: choice } : {}) }
  const listeners = new Set<(value: HostsState) => void>()
  const push = (next: Partial<HostsState>): void => { state = { ...state, ...next }; act(() => { for (const listener of listeners) listener(state) }) }
  // Main broadcasts every change it makes, as well as answering the command with it.
  const command = vi.fn<HostsBridge['command']>(async input => { if (answer) { state = answer(input, state); for (const listener of listeners) listener(state) } return state })
  const bridge: HostsBridge = { get: async () => state, command, onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) }, devices: async () => ({ tailscale: { state: 'missing' as const }, devices: DEVICES }), tailscale: async () => ({ state: 'missing' as const }),
    connectTailscale: async () => 'failed' as const, openTailscaleDownload: async () => undefined, providerAction: async () => ({}), updateClients: async () => ({}), signIn: async () => null }
  return { bridge, command, push }
}
const setupState = (patch: Partial<HostSetupState> = {}): HostSetupState => ({ id: 'setup', name: 'forge', target: 'zach@forge', threadId: `host:${LOCAL}:thread`, threadTitle: 'Set up forge',
  modelName: 'GPT-6', phase: 'running', byAgent: [], ...patch })
const attempt = (patch: Partial<HostStatus & { purpose: 'check' | 'add' }>): HostStatus & { purpose: 'check' | 'add' } => ({ id: '33333333-3333-4333-8333-333333333333', name: 'forge', target: 'zach@forge', identityFile: '', installPath: '~/.local/share/sotto-host',
  dataDirectory: '~/.sotto', enabled: true, phase: 'connecting', purpose: 'check', ...patch })
/** Switches Add host to typing a host, through the device list's last entry, and types it. */
async function typeAHost(user: ReturnType<typeof userEvent.setup>, value: string) {
  const dialog = screen.getByRole('dialog', { name: 'Add host' })
  const picker = await within(dialog).findByRole('combobox', { name: 'Device' })
  await waitFor(() => expect(within(dialog).queryByText('Looking for your devices…')).toBeNull())
  if (picker.getAttribute('aria-expanded') !== 'true') await user.click(picker)
  await user.click(await within(dialog).findByRole('option', { name: /^Another SSH host/ }))
  await user.type(within(dialog).getByRole('textbox', { name: 'SSH host' }), value)
}
const settings = (bridge: HostsBridge) => render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} />)

it('requires deliberate keyboard navigation before trusting a setup host key', async () => {
  const { bridge, command, push } = fixture(), user = userEvent.setup()
  const checking = attempt({ prompt: { id: 'trust-prompt', kind: 'host-key', text: 'Synthetic host key' } })
  push({ setup: setupState({ attempt: checking }) })
  render(<HostQuestionDialog bridge={bridge} />)
  const dialog = await screen.findByRole('dialog')
  expect(document.activeElement).toBe(within(dialog).getByRole('region', { name: 'SSH host key' }))
  await user.keyboard('{Enter}')
  expect(command).not.toHaveBeenCalled()
  await user.tab()
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Trust host' }))
  await user.keyboard('{Enter}')
  expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'ssh-answer', id: checking.id, promptId: 'trust-prompt', answer: 'yes' })
})

it.each(['passphrase', 'password'] as const)('submits a setup %s on Enter and reaches Continue before Not now', async kind => {
  const { bridge, command, push } = fixture(), user = userEvent.setup()
  const checking = attempt({ prompt: { id: 'enter-prompt', kind, text: 'Synthetic question' } })
  push({ setup: setupState({ attempt: checking }) })
  render(<HostQuestionDialog bridge={bridge} />)
  const dialog = await screen.findByRole('dialog')
  const field = within(dialog).getByLabelText(kind === 'password' ? 'SSH password' : 'Key passphrase')
  expect(document.activeElement).toBe(field)
  await user.tab()
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Continue' }))
  await user.tab()
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Not now' }))
  await user.type(field, 'synthetic{Enter}')
  await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'ssh-answer', id: checking.id, promptId: 'enter-prompt', answer: 'synthetic' }))
})

it('offers both ways to add, chooses the agent first on the model used most, and starts a setup for the typed device', async () => {
  const { bridge, command } = fixture(), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Add host' })
  const group = within(dialog).getByRole('radiogroup', { name: 'How to add the host' })
  const agent = within(group).getByRole('radio', { name: 'Have my agent set this up' })
  expect(agent).toHaveProperty('checked', true)
  expect(agent.getAttribute('aria-describedby')).toBeTruthy()
  expect(within(group).getByText(/you answer each command it wants to run/)).toBeTruthy()
  const model = within(dialog).getByRole('combobox', { name: 'Model' })
  expect((model as HTMLSelectElement).value).toBe('codex:gpt')
  expect(within(dialog).getByRole('button', { name: 'Start setup' })).toBeTruthy()
  await user.selectOptions(model, 'claude:opus')
  await typeAHost(user, 'forge')
  await user.type(within(dialog).getByLabelText(/Username/), 'zach')
  await user.click(within(dialog).getByRole('button', { name: 'Start setup' }))
  const sent = command.mock.calls.map(([value]) => value).find(value => value.type === 'start-setup')
  expect(sent).toMatchObject({ type: 'start-setup', modelId: 'claude:opus', host: { name: 'forge', target: 'zach@forge', installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto' } })
  expect(sent).not.toHaveProperty('after')
})

it('keeps Add it as the one choice when no agent can set up a host, and says why', async () => {
  const { bridge } = fixture({ models: [], unavailable: 'An agent sets a host up from a thread on this computer, which needs the local host.' }), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Add host' })
  expect(within(dialog).getByRole('radio', { name: 'Have my agent set this up' })).toHaveProperty('disabled', true)
  expect(within(dialog).getByRole('radio', { name: 'Add it' })).toHaveProperty('checked', true)
  expect(within(dialog).getByText(/needs the local host/)).toBeTruthy()
  expect(within(dialog).queryByRole('combobox', { name: 'Model' })).toBeNull()
  expect(within(dialog).getByRole('button', { name: 'Add host' })).toBeTruthy()
})

it('offers only Add it where Threads cannot be reached to answer a setup thread, as in first-run setup', async () => {
  const { bridge } = fixture()
  render(<HostDialog mode={{ kind: 'add' }} bridge={bridge} state={await bridge.get()} agentSetup={false} onClose={() => undefined} />)
  const dialog = await screen.findByRole('dialog', { name: 'Add host' })
  expect(within(dialog).queryByRole('radiogroup', { name: 'How to add the host' })).toBeNull()
  expect(within(dialog).queryByText('Have my agent set this up')).toBeNull()
  expect(within(dialog).queryByRole('button', { name: 'Start setup' })).toBeNull()
  expect(within(dialog).getByRole('button', { name: 'Add host' })).toBeTruthy()
})

it('follows the setup thread: the agent line, the checklist with the agent\'s steps, the card while the thread waits, and Stop setup', async () => {
  const { bridge, command, push } = fixture(CHOICE, (input, state) => input.type === 'start-setup' ? { ...state, setup: setupState({ id: input.id, phase: 'starting' }) } : state)
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'Add host' }))
  await typeAHost(user, 'zach@forge')
  await user.click(screen.getByRole('button', { name: 'Start setup' }))
  const id = (command.mock.calls.find(([value]) => value.type === 'start-setup')![0] as { id: string }).id
  const dialog = await screen.findByRole('dialog', { name: 'Setting up forge' })
  expect(within(dialog).getByText(/Starting the thread/)).toBeTruthy()
  // Running: a check stopped at the installation, which the agent is working on; the thread waits for a command.
  push({ setup: setupState({ id, attempt: attempt({ phase: 'error', step: 'install', reason: 'node-missing', error: 'Node was not found on the SSH host.' }), waiting: 'command' }) })
  expect(within(dialog).getByText(/GPT-6/).closest('p')!.textContent).toBe('GPT-6 is setting up forge in the thread Set up forge. You answer each command it wants to run.')
  const steps = within(dialog).getByRole('list', { name: 'Connection steps' })
  expect(within(steps).getByText('Reached forge')).toBeTruthy()
  expect(within(steps).getByText(/The last check stopped here\. Node was not found/)).toBeTruthy()
  const card = within(steps).getByText('The agent wants to run a command on forge. Answer it in the thread to carry on.')
  expect(card.closest('li')!.getAttribute('aria-current')).toBe('step')
  // The next check passes the installation: the agent did that step.
  push({ setup: setupState({ id, attempt: attempt({ phase: 'disconnected', step: 'pair', checked: true }), byAgent: ['install'], waiting: 'add' }) })
  expect(within(steps).getByText('Host installed').textContent).toBe('Host installed by the agent')
  expect(within(steps).getByText('Sotto is asking in the thread whether to add forge as a host. Answer it there to carry on.')).toBeTruthy()
  // Close hides the dialog; the setup carries on and the Hosts page offers it back.
  await user.click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(command.mock.calls.some(([value]) => value.type === 'dismiss-setup' || value.type === 'stop-setup')).toBe(false)
  await user.click(screen.getByRole('button', { name: 'Show setup of forge' }))
  const again = screen.getByRole('dialog', { name: 'Setting up forge' })
  await user.click(within(again).getByRole('button', { name: 'Stop setup' }))
  expect(command).toHaveBeenLastCalledWith({ type: 'stop-setup', id })
  push({ setup: setupState({ id, phase: 'stopped' }) })
  const stopped = screen.getByRole('dialog', { name: 'Setup of forge stopped' })
  expect(within(stopped).getByText(/Nothing was saved as a host\. Anything the agent installed on forge stays there/)).toBeTruthy()
  await user.click(within(stopped).getByRole('button', { name: 'Close' }))
  expect(command).toHaveBeenLastCalledWith({ type: 'dismiss-setup', id })
})

it('says the host is connected when the agent\'s add connects, and Done puts the setup away', async () => {
  const { bridge, command, push } = fixture(CHOICE, (input, state) => input.type === 'start-setup' ? { ...state, setup: setupState({ id: input.id }) } : state)
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'Add host' }))
  await typeAHost(user, 'zach@forge')
  await user.click(screen.getByRole('button', { name: 'Start setup' }))
  const id = (command.mock.calls.find(([value]) => value.type === 'start-setup')![0] as { id: string }).id
  push({ setup: setupState({ id, phase: 'connected', byAgent: ['install'], attempt: attempt({ phase: 'connected', purpose: 'add' }) }) })
  const dialog = await screen.findByRole('dialog', { name: 'forge is connected' })
  expect(within(dialog).getByText(/forge is added and connected\. GPT-6 set it up in/)).toBeTruthy()
  expect(within(dialog).queryByRole('button', { name: 'Stop setup' })).toBeNull()
  await user.click(within(dialog).getByRole('button', { name: 'Done' }))
  expect(command).toHaveBeenLastCalledWith({ type: 'dismiss-setup', id })
})

it('asks a running setup\'s SSH question and Tailscale approval over any page, with Not now, and says so on the Hosts page', async () => {
  const { bridge, command, push } = fixture(CHOICE), user = userEvent.setup()
  const checking = attempt({ step: 'sign-in', prompt: { id: 'prompt-1', kind: 'password', text: 'zach@forge password:' } })
  push({ setup: setupState({ attempt: checking, waiting: 'connection' }) })
  render(<><HostQuestionDialog bridge={bridge} /><HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} /></>)
  expect((await screen.findByText(/SSH is waiting for your answer before it connects to forge\. Show setup to answer it\./)).textContent).toContain('GPT-6 is setting up forge')
  const unlock = await screen.findByRole('dialog', { name: 'Unlock the SSH connection to forge' })
  expect(unlock.textContent).toContain('An agent is setting up forge, and SSH needs your password to sign in. Not now leaves it waiting')
  await user.type(within(unlock).getByLabelText('SSH password'), 'synthetic')
  await user.click(within(unlock).getByRole('button', { name: 'Continue' }))
  expect(command).toHaveBeenLastCalledWith({ type: 'ssh-answer', id: checking.id, promptId: 'prompt-1', answer: 'synthetic' })
  // Not now puts this question off; the next one asks again.
  await user.click(within(unlock).getByRole('button', { name: 'Not now' }))
  expect(screen.queryByRole('dialog', { name: 'Unlock the SSH connection to forge' })).toBeNull()
  expect(command.mock.calls.some(([value]) => value.type === 'stop-setup')).toBe(false)
  push({ setup: setupState({ attempt: attempt({ step: 'tailscale', tailscale: { waiting: true, url: 'https://login.tailscale.com/a/synthetic' } }), waiting: 'connection' }) })
  expect(screen.getByText(/Tailscale is waiting for you to approve the connection to forge\. Show setup to approve it\./)).toBeTruthy()
  const approve = screen.getByRole('dialog', { name: 'Approve the connection to forge in Tailscale' })
  expect(approve.textContent).not.toContain('login.tailscale.com')
  await user.click(within(approve).getByRole('button', { name: 'Open approval page' }))
  expect(command).toHaveBeenLastCalledWith({ type: 'open-approval', id: checking.id })
  expect(screen.queryByRole('dialog', { name: 'Approve the connection to forge in Tailscale' })).toBeNull()
  // A setup that has ended asks nothing.
  push({ setup: setupState({ phase: 'stopped', attempt: attempt({ step: 'sign-in', prompt: { id: 'prompt-2', kind: 'host-key', text: 'The authenticity of host forge cannot be established.' } }) }) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('offers Have my agent fix this under a failed step of Add it, naming the failed attempt', async () => {
  const { bridge, command, push } = fixture(CHOICE), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'Add host' }))
  await user.click(screen.getByRole('radio', { name: 'Add it' }))
  await typeAHost(user, 'forge')
  await user.click(within(screen.getByRole('dialog', { name: 'Add host' })).getByRole('button', { name: 'Add host' }))
  const added = command.mock.calls.find(([value]) => value.type === 'add')![0] as Extract<HostsCommand, { type: 'add' }>
  push({ adding: { ...added.host, enabled: true, phase: 'error', step: 'install', reason: 'node-too-new', error: 'The SSH host runs Node 26.1.0. Nothing was saved.' } })
  const dialog = await screen.findByRole('dialog', { name: 'forge could not be added' })
  const failed = within(dialog).getByRole('alert')
  expect(within(failed).getByText(/Or let an agent do it/)).toBeTruthy()
  await user.click(within(failed).getByRole('button', { name: 'Have my agent fix this' }))
  expect(command.mock.calls.map(([value]) => value).find(value => value.type === 'start-setup')).toMatchObject({ type: 'start-setup', after: added.host.id, modelId: 'codex:gpt', host: { target: 'forge' } })
})
