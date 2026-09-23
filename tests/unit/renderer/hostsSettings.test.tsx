import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { HostsSettings } from '../../../src/renderer/src/features/settings/HostsSettings'
import { HostQuestionDialog } from '../../../src/renderer/src/features/settings/HostQuestionDialog'
import { ThreadWorkingCopy } from '../../../src/renderer/src/agents/ThreadWorkingCopy'
import type { HostsBridge, HostsCommand, HostsState, HostStatus, SshHostSuggestion } from '../../../src/shared/hosts'
import { hostVersionMismatch } from '../../../src/shared/hostProtocol'

afterEach(cleanup)
const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const SUGGESTIONS: SshHostSuggestion[] = [
  { alias: 'forge', detail: 'zach@forge.tail5728ca.ts.net', source: 'config' },
  { alias: 'pihole', detail: 'pi@100.77.163.67', source: 'config' },
  { alias: 'buildbox.example.net', port: 2200, detail: 'buildbox.example.net:2200', source: 'known-hosts' },
]
function host(patch: Partial<HostStatus> = {}): HostStatus {
  return { id: REMOTE, hostId: REMOTE, name: 'Build box', target: 'build', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase: 'connected', enabled: true, ...patch }
}
/** A bridge whose state the test moves on, the way main's broadcasts do. */
function fixture(hosts: HostStatus[] = [host()], answer?: (command: HostsCommand, state: HostsState) => HostsState | Promise<HostsState>) {
  let state: HostsState = { localHostEnabled: true, localHostRunning: true, localHostId: LOCAL, activeHostId: LOCAL, hosts }
  const listeners = new Set<(value: HostsState) => void>()
  const push = (next: Partial<HostsState>): void => { state = { ...state, ...next }; act(() => { for (const listener of listeners) listener(state) }) }
  const command = vi.fn<HostsBridge['command']>(async input => { if (answer) state = await answer(input, state); return state })
  const bridge: HostsBridge = { get: async () => state, command, onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) }, sshSuggestions: vi.fn(async () => SUGGESTIONS) }
  return { bridge, command, push, state: () => state }
}
const settings = (bridge: HostsBridge) => render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} />)

it('keeps the local host switch, and no longer offers Save, Connect, Disconnect or Use this host', async () => {
  const { bridge } = fixture(), change = vi.fn(async () => true), user = userEvent.setup()
  render(<HostsSettings localHostEnabled onLocalHostChange={change} bridge={bridge} />)
  await screen.findByRole('region', { name: 'Build box' })
  for (const name of ['Use this host', 'Use this computer', 'Connect', 'Disconnect', 'Save host']) expect(screen.queryByRole('button', { name })).toBeNull()
  await user.click(screen.getByRole('switch', { name: 'Run the local host' }))
  expect(change).toHaveBeenCalledWith(false)
})

it('reads a row the way the prototype does and switches a host off and on', async () => {
  const { bridge, command, push } = fixture([host({ target: 'forge', name: 'forge' })]), user = userEvent.setup()
  settings(bridge)
  const row = await screen.findByRole('region', { name: 'forge' })
  expect(within(row).getByText(/SSH forge ·/).textContent).toBe('SSH forge · Connected')
  const toggle = within(row).getByRole('switch', { name: 'Keep forge connected, now and when Sotto starts' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(within(row).getByText('On')).toBeTruthy()
  await user.click(toggle)
  expect(command).toHaveBeenCalledWith({ type: 'set-enabled', id: REMOTE, enabled: false })
  push({ hosts: [host({ target: 'forge', name: 'forge', phase: 'disconnected', enabled: false })] })
  expect(within(row).getByText(/SSH forge ·/).textContent).toBe('SSH forge · Switched off')
  expect(within(row).getByRole('switch').getAttribute('aria-checked')).toBe('false')
  await user.click(within(row).getByRole('switch'))
  expect(command).toHaveBeenLastCalledWith({ type: 'set-enabled', id: REMOTE, enabled: true })
  push({ hosts: [host({ target: 'forge', name: 'forge', phase: 'connecting', reconnecting: true, sshPort: 2222 })] })
  expect(within(row).getByText(/SSH forge/).textContent).toBe('SSH forge, port 2222 · Reconnecting…')
})

it('opens the row menu from the keyboard, moves with the arrows and gives focus back on Escape', async () => {
  const { bridge } = fixture([host({ owned: true })]), user = userEvent.setup()
  settings(bridge)
  const more = await screen.findByRole('button', { name: 'More for Build box' })
  more.focus()
  await user.keyboard('{Enter}')
  const menu = screen.getByRole('menu', { name: 'Build box actions' })
  expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Stop host', 'Rename', 'Edit connection', 'Forget Build box…'])
  expect(document.activeElement?.textContent).toBe('Stop host')
  await user.keyboard('{ArrowDown}')
  expect(document.activeElement?.textContent).toBe('Rename')
  await user.keyboard('{ArrowUp}{ArrowUp}')
  expect(document.activeElement?.textContent).toBe('Forget Build box…')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(more)
})

it('offers Stop host only for a host Sotto started, confirms it, and says the host is switched off', async () => {
  const { bridge, command } = fixture([host({ owned: true })]), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Stop host' }))
  const dialog = screen.getByRole('dialog', { name: 'Stop the host on Build box?' })
  expect(within(dialog).getByText(/and switches it off/)).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: 'Stop host' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'stop-host', id: REMOTE }))
  cleanup()
  const discovered = fixture([host({ owned: false })])
  settings(discovered.bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  expect(screen.queryByRole('menuitem', { name: 'Stop host' })).toBeNull()
})

it('keeps Stop host beside the sentence that asks for it, and offers Connect again for a host that needs attention', async () => {
  const mismatch = hostVersionMismatch('0.1.16', '0.1.15', true)
  const { bridge, command } = fixture([host({ phase: 'error', owned: true, error: mismatch })]), user = userEvent.setup()
  settings(bridge)
  expect((await screen.findByRole('alert')).textContent).toBe(mismatch)
  expect(screen.getByText(/SSH build ·/).textContent).toBe('SSH build · Needs attention')
  await user.click(screen.getByRole('button', { name: 'Stop host' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop host' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'stop-host', id: REMOTE }))
  // Forget still reaches that host, so it says it revokes and stops rather than leaving access behind.
  await user.click(screen.getByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Forget Build box…' }))
  expect(within(screen.getByRole('dialog')).getByText("This revokes this computer's access on the host and removes the saved connection. It also stops the host Sotto started there. Threads stay on the host.")).toBeTruthy()
  cleanup()
  const failed = fixture([host({ phase: 'error', error: 'The SSH host refused your sign-in. Check the user name, password or identity file, then reconnect.' })])
  settings(failed.bridge)
  await user.click(await screen.findByRole('button', { name: 'Connect again' }))
  expect(failed.command).toHaveBeenCalledWith({ type: 'set-enabled', id: REMOTE, enabled: true })
  expect(screen.queryByRole('button', { name: 'Stop host' })).toBeNull()
})

it('says what Forget does to a host it cannot reach', async () => {
  const { bridge } = fixture([host({ phase: 'disconnected', enabled: false })]), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Forget Build box…' }))
  expect(screen.getByText(/access on Build box stays until you connect again or revoke it there/)).toBeTruthy()
  expect(screen.queryByText(/stops the host/)).toBeNull()
})

it('renames a host from its menu', async () => {
  const { bridge, command } = fixture(), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
  const field = screen.getByRole('textbox', { name: 'Host name' })
  expect(document.activeElement).toBe(field)
  await user.clear(field)
  await user.type(field, 'Forge{Enter}')
  expect(command).toHaveBeenCalledWith({ type: 'rename', id: REMOTE, name: 'Forge' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('edits a connection with its username, port and folders split out, and saves it whole', async () => {
  const { bridge, command } = fixture([host({ target: 'zach@forge', sshPort: 2222, clientId: 'client-1' })]), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  const dialog = screen.getByRole('dialog', { name: 'Edit connection to Build box' })
  expect(within(dialog).getByRole('combobox', { name: 'SSH host or alias' })).toHaveProperty('value', 'forge')
  expect(within(dialog).getByRole('textbox', { name: 'Username (optional)' })).toHaveProperty('value', 'zach')
  expect(within(dialog).getByRole('textbox', { name: 'Port (optional)' })).toHaveProperty('value', '2222')
  expect(within(dialog).getByText('client-1')).toBeTruthy()
  await user.clear(within(dialog).getByRole('textbox', { name: 'Port (optional)' }))
  await user.click(within(dialog).getByRole('button', { name: 'Save connection' }))
  expect(command).toHaveBeenCalledWith({ type: 'save', host: { id: REMOTE, name: 'Build box', target: 'zach@forge', installPath: '/opt/sotto', dataDirectory: '/data', identityFile: '' } })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('suggests hosts from the SSH setup in a combobox, and Escape closes the list before the dialog', async () => {
  const { bridge, command } = fixture([host({ target: 'forge', name: 'forge' })]), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Add host' })
  const field = within(dialog).getByRole('combobox', { name: 'SSH host or alias' })
  expect(document.activeElement).toBe(field)
  // forge is already saved, so it is not offered again.
  await waitFor(() => expect(within(dialog).getAllByRole('option').map(option => option.querySelector('b')?.textContent)).toEqual(['pihole', 'buildbox.example.net']))
  expect(field.getAttribute('aria-expanded')).toBe('true')
  await user.type(field, 'build')
  expect(within(dialog).getAllByRole('option')).toHaveLength(1)
  await user.keyboard('{ArrowDown}')
  expect(field.getAttribute('aria-activedescendant')).toBe(within(dialog).getByRole('option').id)
  await user.keyboard('{Enter}')
  expect(field).toHaveProperty('value', 'buildbox.example.net')
  expect(within(dialog).getByRole('textbox', { name: 'Port (optional)' })).toHaveProperty('value', '2200')
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Add host' }))
  await user.click(field)
  expect(field.getAttribute('aria-expanded')).toBe('true')
  await user.keyboard('{Escape}')
  expect(field.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('dialog', { name: 'Add host' })).toBeTruthy()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(command).not.toHaveBeenCalled()
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add host' })))
})

it('connects from inside Add host, asks SSH questions there, and closes once the host is saved', async () => {
  let resolveAdd: ((state: HostsState) => void) | undefined
  const { bridge, command, push, state } = fixture([], (input, current) => input.type === 'add' ? new Promise<HostsState>(resolve => { resolveAdd = resolve }) : current)
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Add host' })
  await user.type(within(dialog).getByRole('combobox', { name: 'SSH host or alias' }), 'forge')
  await user.type(within(dialog).getByRole('textbox', { name: 'Username (optional)' }), 'zach')
  await user.type(within(dialog).getByRole('textbox', { name: 'Port (optional)' }), '2222')
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  const sent = command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>
  expect(sent).toEqual({ type: 'add', host: { id: expect.any(String), name: 'forge', target: 'zach@forge', sshPort: 2222, installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', identityFile: '' } })
  const adding = host({ id: sent.host.id, name: 'forge', target: 'zach@forge', phase: 'connecting' })
  push({ adding })
  expect(within(dialog).getByRole('status').textContent).toContain('Connecting to forge. Sotto signs in over SSH')
  expect(within(dialog).getByRole('button', { name: 'Connecting…' })).toHaveProperty('disabled', true)
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
  // SSH's question is asked in the dialog, since there is no row for it yet.
  push({ adding: { ...adding, prompt: { id: 'prompt-1', kind: 'passphrase', text: 'Enter passphrase for key' } } })
  const passphrase = within(dialog).getByLabelText('Key passphrase')
  expect(document.activeElement).toBe(passphrase)
  await user.type(passphrase, 'synthetic{Enter}')
  expect(command).toHaveBeenCalledWith({ type: 'ssh-answer', id: sent.host.id, promptId: 'prompt-1', answer: 'synthetic' })
  push({ adding: undefined, hosts: [{ ...adding, phase: 'connected' }] })
  resolveAdd!(state())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('region', { name: 'forge' })).toBeTruthy()
  expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cancel-add' }))
})

it('says what went wrong and that nothing was saved, and Cancel drops the failed attempt', async () => {
  const { bridge, command, push } = fixture([])
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Add host' })
  await user.type(within(dialog).getByRole('textbox', { name: 'Port (optional)' }), '99999')
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  expect(within(dialog).getByRole('alert').textContent).toBe('Enter an SSH host or alias, such as forge or user@server.')
  await user.type(within(dialog).getByRole('combobox', { name: 'SSH host or alias' }), 'nowhere{Escape}')
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  expect(within(dialog).getByRole('alert').textContent).toBe('Enter a port between 1 and 65535, or leave Port empty to use your SSH configuration.')
  await user.clear(within(dialog).getByRole('textbox', { name: 'Port (optional)' }))
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  const id = (command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>).host.id
  push({ adding: host({ id, name: 'nowhere', target: 'nowhere', phase: 'error', error: 'SSH could not reach the host. Nothing was saved. Check the host name and your network, then add the host again.' }) })
  expect(within(dialog).getByRole('alert').textContent).toContain('Nothing was saved.')
  expect(within(dialog).getByRole('button', { name: 'Add host' })).toHaveProperty('disabled', false)
  expect(screen.getByText('No remote hosts yet.')).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(command).toHaveBeenLastCalledWith({ type: 'cancel-add', id })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps the remote Open folder control visible and explains where it acts', async () => {
  const command = vi.fn(), user = userEvent.setup()
  render(<ThreadWorkingCopy thread={{ id: 'remote', remoteHost: true, workingDirectory: '/repo' }} project={{ path: '/repo' }} command={command} />)
  await user.click(screen.getByRole('button', { name: 'Working copy: Project folder' }))
  expect(screen.getByText('This folder is on the host machine. Open it there.')).toBeTruthy()
  const button = screen.getByRole('button', { name: 'Open folder' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  await user.click(button)
  expect(command).not.toHaveBeenCalled()
})

it("asks a saved host's SSH question on any page, sends the answer, and Switch it off switches the host off", async () => {
  const reconnecting = host({ name: 'forge', phase: 'connecting', reconnecting: true })
  const { bridge, command, push } = fixture([reconnecting]), user = userEvent.setup()
  // Rendered on its own, the way the app shell renders it over whichever page is open.
  render(<HostQuestionDialog bridge={bridge} />)
  await waitFor(() => expect(command).not.toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).toBeNull()
  push({ hosts: [{ ...reconnecting, prompt: { id: 'prompt-2', kind: 'passphrase', text: 'Enter passphrase for key' } }] })
  const dialog = screen.getByRole('dialog', { name: 'Unlock the SSH connection to forge' })
  expect(dialog.textContent).toContain('Sotto is connecting to forge, and SSH needs your key passphrase to sign in.')
  await user.type(within(dialog).getByLabelText('Key passphrase'), 'synthetic')
  await user.click(within(dialog).getByRole('button', { name: 'Continue' }))
  expect(command).toHaveBeenCalledWith({ type: 'ssh-answer', id: REMOTE, promptId: 'prompt-2', answer: 'synthetic' })
  push({ hosts: [{ ...reconnecting, prompt: { id: 'prompt-3', kind: 'host-key', text: 'The authenticity of host forge cannot be established.' } }] })
  const trust = screen.getByRole('dialog', { name: 'Trust the SSH host forge?' })
  await user.keyboard('{Escape}')
  expect(command).toHaveBeenLastCalledWith({ type: 'set-enabled', id: REMOTE, enabled: false })
  push({ hosts: [{ ...reconnecting, phase: 'disconnected', enabled: false }] })
  expect(trust.isConnected).toBe(false)
})

it("waits with a saved host's SSH question while a Hosts dialog is open", async () => {
  const reconnecting = host({ name: 'forge', phase: 'connecting', reconnecting: true })
  const { bridge, push } = fixture([reconnecting]), user = userEvent.setup()
  render(<><HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} /><HostQuestionDialog bridge={bridge} /></>)
  await user.click(await screen.findByRole('button', { name: 'More for forge' }))
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
  push({ hosts: [{ ...reconnecting, prompt: { id: 'prompt-4', kind: 'password', text: 'zach@forge password:' } }] })
  // Rename keeps the screen; the question does not stack on it.
  expect(screen.getAllByRole('dialog')).toEqual([screen.getByRole('dialog', { name: 'Rename forge' })])
  await user.keyboard('{Escape}')
  const question = await screen.findByRole('dialog', { name: 'Unlock the SSH connection to forge' })
  expect(within(question).getByLabelText('SSH password')).toBeTruthy()
})
