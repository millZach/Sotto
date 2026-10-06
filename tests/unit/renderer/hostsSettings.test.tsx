import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { HostsSettings } from '../../../src/renderer/src/features/settings/HostsSettings'
import { HostQuestionDialog } from '../../../src/renderer/src/features/settings/HostQuestionDialog'
import { ThreadWorkingCopy } from '../../../src/renderer/src/agents/ThreadWorkingCopy'
import type { HostsBridge, HostsCommand, HostsState, HostStatus } from '../../../src/shared/hosts'
import type { HostDevice, TailscaleConnectOutcome, TailscaleSummary } from '../../../src/shared/hostDevices'
import { hostVersionMismatch } from '../../../src/shared/hostProtocol'

afterEach(cleanup)

it('shows a failed local host save beside the switch and clears it on retry', async () => {
  const change = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const user = userEvent.setup()
  const { container } = render(<HostsSettings localHostEnabled onLocalHostChange={change} bridge={fixture().bridge} />)
  const toggle = screen.getByRole('switch', { name: 'Run the local host' })
  await user.click(toggle)
  expect(await within(container.querySelector('.hosts-local')!).findByRole('alert')).toHaveTextContent('The local host setting could not be saved. Nothing was changed. Try again.')
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  await user.click(toggle)
  await waitFor(() => expect(within(container.querySelector('.hosts-local')!).queryByRole('alert')).toBeNull())
})
const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const DAY = 24 * 60 * 60_000
/** What main's merge gives for the recorded tailnet and SSH setup (see tests/unit/main/hostTailscale.test.ts). */
const DEVICES: HostDevice[] = [
  { target: 'forge', name: 'forge', os: 'Linux', tailscale: { online: true, ssh: true }, sshConfiguration: true, names: ['forge.tail5728ca.ts.net', 'forge', '100.64.0.4'] },
  { target: 'pihole.tail5728ca.ts.net', name: 'pihole', os: 'Linux', tailscale: { online: true, ssh: false }, names: ['pihole.tail5728ca.ts.net', 'pihole', '100.64.0.5'] },
  { target: 'spark', name: 'spark', sshConfiguration: true, detail: 'zach@spark.lan', names: ['spark', 'spark.lan'] },
  { target: 'buildbox.example.net', name: 'buildbox.example.net', knownHost: true, port: 2200, detail: 'buildbox.example.net:2200', names: ['buildbox.example.net'] },
  { target: 'omarchy.tail5728ca.ts.net', name: 'omarchy', os: 'Linux', tailscale: { online: false, ssh: true, lastSeen: new Date(Date.now() - 8 * DAY - 60_000).toISOString() }, unavailable: 'offline', names: ['omarchy.tail5728ca.ts.net', 'omarchy'] },
  { target: 'iphone-15-pro.tail5728ca.ts.net', name: 'iphone-15-pro', os: 'iOS', tailscale: { online: true, ssh: false }, unavailable: 'phone', names: ['iphone-15-pro.tail5728ca.ts.net', 'iphone-15-pro', 'localhost'] },
]
const RUNNING: TailscaleSummary = { state: 'running', user: 'millZach', loginName: 'millZach@github', deviceCount: 5 }
/** The SSH setup alone, as main lists it while Tailscale is off or missing. */
const sshOnly = (devices: HostDevice[]): HostDevice[] => devices.filter(item => item.sshConfiguration || item.knownHost)
  .map(({ target, name, names, detail, port, sshConfiguration, knownHost }) => ({ target, name, names, ...(detail ? { detail } : {}), ...(port ? { port } : {}), ...(sshConfiguration ? { sshConfiguration } : {}), ...(knownHost ? { knownHost } : {}) }))
function host(patch: Partial<HostStatus> = {}): HostStatus {
  return { id: REMOTE, hostId: REMOTE, name: 'Build box', target: 'build', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase: 'connected', enabled: true, ...patch }
}
/** A bridge whose state the test moves on, the way main's broadcasts do. */
function fixture(hosts: HostStatus[] = [host()], answer?: (command: HostsCommand, state: HostsState) => HostsState | Promise<HostsState>,
  options: { tailscale?: TailscaleSummary; connect?: () => Promise<TailscaleConnectOutcome> } = {}) {
  let state: HostsState = { localHostEnabled: true, localHostRunning: true, localHostId: LOCAL, activeHostId: LOCAL, hosts }
  let tailscale = options.tailscale ?? RUNNING
  const listeners = new Set<(value: HostsState) => void>()
  const push = (next: Partial<HostsState>): void => { state = { ...state, ...next }; act(() => { for (const listener of listeners) listener(state) }) }
  const command = vi.fn<HostsBridge['command']>(async input => { if (answer) state = await answer(input, state); return state })
  const devices = vi.fn(async () => ({ tailscale, devices: tailscale.state === 'running' ? DEVICES : sshOnly(DEVICES) }))
  const connectTailscale = vi.fn(options.connect ?? (async (): Promise<TailscaleConnectOutcome> => 'connected'))
  const openTailscaleDownload = vi.fn(async () => undefined)
  const bridge: HostsBridge = { get: async () => state, command, onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    devices, tailscale: vi.fn(async () => tailscale), connectTailscale, openTailscaleDownload, providerAction: vi.fn(async () => ({})), updateClients: vi.fn(async () => ({})), signIn: vi.fn(async () => null) }
  return { bridge, command, push, state: () => state, devices, connectTailscale, openTailscaleDownload, setTailscale: (next: TailscaleSummary) => { tailscale = next } }
}
/** Opens Add host and waits for its device list. */
async function openAddHost(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Add host' })
  const picker = within(dialog).getByRole('combobox', { name: 'Device' })
  await waitFor(() => expect(within(dialog).queryByText('Looking for your devices…')).toBeNull())
  return { dialog, picker }
}
/** Switches Add host to typing a host, through the list's last entry. */
async function typeAHost(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  const picker = within(dialog).getByRole('combobox', { name: 'Device' })
  if (picker.getAttribute('aria-expanded') !== 'true') await user.click(picker)
  await user.click(within(dialog).getByRole('option', { name: /^Another SSH host/ }))
  return within(dialog).getByRole('textbox', { name: 'SSH host' })
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

it('says Forget signs in to a host it is not connected to, to revoke this computer there', async () => {
  const { bridge } = fixture([host({ phase: 'disconnected', enabled: false })]), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Forget Build box…' }))
  expect(within(screen.getByRole('dialog', { name: 'Forget Build box?' })).getByText("Sotto signs in to Build box over SSH to revoke this computer's access there, stops the host if Sotto started it, and removes the saved connection. "
    + "If Build box can't be reached, it is still removed here, and Sotto shows the command that revokes this computer there. Threads stay on the host.")).toBeTruthy()
})

it('shows Tailscale’s approval inside Forget while its sign-in waits for it, and opens the page on a press', async () => {
  const url = 'https://login.tailscale.com/a/l1a2b3c4'
  let release!: () => void
  const { bridge, command, push } = fixture([host({ phase: 'disconnected', enabled: false })], async (input, current) => {
    if (input.type === 'forget') await new Promise<void>(resolve => { release = resolve })
    return input.type === 'forget' ? { ...current, hosts: [] } : current
  })
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Forget Build box…' }))
  const dialog = screen.getByRole('dialog', { name: 'Forget Build box?' })
  await user.click(within(dialog).getByRole('button', { name: 'Forget host' }))
  push({ hosts: [host({ phase: 'disconnected', enabled: false, adminSignIn: true, tailscale: { waiting: true, url } })] })
  expect(within(dialog).getByRole('status').textContent).toContain('Waiting for your approval in Tailscale.')
  await user.click(within(dialog).getByRole('button', { name: 'Open the Tailscale approval page for Build box' }))
  expect(command).toHaveBeenCalledWith({ type: 'open-approval', id: REMOTE })
  release()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('says a forgotten host still trusts this computer, offers the command that removes it there, and puts it away on Dismiss', async () => {
  const command = 'I="$HOME/.local/share/sotto-host"; E="$I/host/index.js"; node "$E" --data "$HOME/.sotto" --revoke-client "client"'
  const { bridge, command: sent, push } = fixture([], (input, current) => input.type === 'dismiss-forgotten' ? { ...current, forgotten: (current.forgotten ?? []).filter(item => item.id !== input.id) } : current)
  const user = userEvent.setup()
  // After setup, which puts its own clipboard in place.
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  settings(bridge)
  await screen.findByText('No remote hosts yet.')
  push({ forgotten: [{ id: REMOTE, name: 'forge', cause: 'unreachable', command }] })
  const notice = await screen.findByRole('status', { name: 'forge still trusts this computer' })
  expect(notice.textContent).toContain('SSH could not reach forge, so Sotto removed it from this computer without revoking this computer’s access there. forge still trusts this computer until it is removed there. To remove it, run this on forge while its host is running:')
  expect(within(notice).getByRole('region', { name: 'Command to run on forge' }).textContent).toBe(command)
  await user.click(within(notice).getByRole('button', { name: 'Copy the command to run on forge' }))
  expect(clipboard).toHaveBeenCalledWith(command)
  expect(within(notice).getByRole('button', { name: 'Copy the command to run on forge' }).textContent).toBe('Copied')
  // The label goes back, as every other copy button's does.
  await waitFor(() => expect(within(notice).getByRole('button', { name: 'Copy the command to run on forge' }).textContent).toBe('Copy command'), { timeout: 5_000 })
  await user.click(within(notice).getByRole('button', { name: 'Dismiss what Sotto said about forge' }))
  expect(sent).toHaveBeenCalledWith({ type: 'dismiss-forgotten', id: REMOTE })
  await waitFor(() => expect(screen.queryByRole('status', { name: 'forge still trusts this computer' })).toBeNull())
  // Its button went with it, so focus goes to the control above the list rather than to the page.
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add host' }))
})

it('says why each forgotten host was not revoked, one notice for each', async () => {
  const { bridge, push } = fixture([])
  settings(bridge)
  await screen.findByText('No remote hosts yet.')
  push({ forgotten: [
    { id: REMOTE, name: 'forge', cause: 'refused', command: 'revoke forge' },
    { id: LOCAL, name: 'spark', cause: 'not-running', command: 'revoke spark' },
  ] })
  expect(screen.getByRole('status', { name: 'forge still trusts this computer' }).textContent).toContain('The host on forge did not revoke this computer’s access, so Sotto removed forge from this computer and left its host running. forge still trusts this computer until it is removed there. To remove it, run this on forge:')
  expect(screen.getByRole('status', { name: 'spark still trusts this computer' }).textContent).toContain('The host on spark was not running, so Sotto removed spark from this computer without revoking this computer’s access there. spark still trusts this computer until it is removed there. To remove it, start the host on spark, then run this there:')
})

it('selects the command from the keyboard when it cannot be copied, so the copy shortcut takes it', async () => {
  const { bridge, push } = fixture([])
  const user = userEvent.setup()
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
  settings(bridge)
  await screen.findByText('No remote hosts yet.')
  push({ forgotten: [{ id: REMOTE, name: 'forge', cause: 'unreachable', command: 'revoke forge' }] })
  const notice = screen.getByRole('status', { name: 'forge still trusts this computer' })
  await user.click(within(notice).getByRole('button', { name: 'Copy the command to run on forge' }))
  expect(within(notice).getByRole('alert').textContent).toBe('The command could not be copied. It is selected above: copy it with your keyboard’s copy shortcut.')
  const code = within(notice).getByRole('region', { name: 'Command to run on forge' })
  expect(document.activeElement).toBe(code)
  expect(window.getSelection()?.toString()).toBe('revoke forge')
})

it('lets Keep host stop Forget’s sign-in while it waits, and says SSH’s question is waiting with Answer', async () => {
  const prompt = { id: 'prompt-9', kind: 'password' as const, text: 'Password:' }
  let release!: () => void
  const { bridge, command, push } = fixture([host({ phase: 'disconnected', enabled: false })], async (input, current) => {
    if (input.type === 'forget') await new Promise<void>(resolve => { release = resolve })
    if (input.type === 'stop-admin-sign-in') release()
    return current
  })
  const user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Forget Build box…' }))
  const dialog = screen.getByRole('dialog', { name: 'Forget Build box?' })
  await user.click(within(dialog).getByRole('button', { name: 'Forget host' }))
  // Before the sign-in says it is under way, Keep host waits.
  expect(within(dialog).getByRole('button', { name: 'Keep host' })).toBeDisabled()
  push({ hosts: [host({ phase: 'disconnected', enabled: false, adminSignIn: true, prompt })] })
  expect(within(dialog).getByRole('status').textContent).toContain('SSH is waiting for your answer.')
  expect(within(dialog).getByRole('button', { name: "Answer SSH's question for Build box" })).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: 'Keep host' }))
  expect(command).toHaveBeenCalledWith({ type: 'stop-admin-sign-in', id: REMOTE })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('region', { name: 'Build box' })).toBeTruthy()
})

it('asks an admin connection’s SSH question for a change the user asked for, and Stop signing in leaves the switch alone', async () => {
  const forgetting = host({ name: 'forge', phase: 'disconnected', enabled: false, adminSignIn: true, prompt: { id: 'prompt-4', kind: 'password', text: 'Password:' } })
  const { bridge, command } = fixture([forgetting]), user = userEvent.setup()
  render(<HostQuestionDialog bridge={bridge} />)
  const dialog = await screen.findByRole('dialog', { name: 'Unlock the SSH connection to forge' })
  expect(dialog.textContent).toContain('Sotto is signing in to forge for a change you asked for there, and SSH needs your password to sign in.')
  await user.click(within(dialog).getByRole('button', { name: 'Stop signing in' }))
  expect(command).toHaveBeenCalledWith({ type: 'stop-admin-sign-in', id: REMOTE })
  expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set-enabled' }))
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
  expect(within(dialog).getByRole('textbox', { name: 'SSH host' })).toHaveProperty('value', 'forge')
  expect(within(dialog).queryByRole('combobox')).toBeNull()
  expect(within(dialog).getByRole('textbox', { name: 'Username (optional)' })).toHaveProperty('value', 'zach')
  expect(within(dialog).getByRole('textbox', { name: 'Port (optional)' })).toHaveProperty('value', '2222')
  expect(within(dialog).getByText('client-1')).toBeTruthy()
  await user.clear(within(dialog).getByRole('textbox', { name: 'Port (optional)' }))
  await user.click(within(dialog).getByRole('button', { name: 'Save connection' }))
  expect(command).toHaveBeenCalledWith({ type: 'save', host: { id: REMOTE, name: 'Build box', target: 'zach@forge', installPath: '/opt/sotto', dataDirectory: '/data', identityFile: '' } })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('lists the devices Sotto can see, in groups, with greyed ones read out with their reason', async () => {
  const { bridge } = fixture([host({ target: 'zach@spark', name: 'Spark box' })]), user = userEvent.setup()
  settings(bridge)
  const { dialog, picker } = await openAddHost(user)
  // The list opens with the dialog, on the Device field.
  expect(document.activeElement).toBe(picker)
  expect(picker.getAttribute('aria-expanded')).toBe('true')
  const groups = within(within(dialog).getByRole('listbox', { name: 'Device' })).getAllByRole('group')
  expect(groups.map(group => group.getAttribute('aria-label'))).toEqual(['Can connect', "Can't use now"])
  expect(within(groups[0]!).getAllByRole('option').map(option => option.textContent)).toEqual([
    'forgeLinux · Tailscale SSH · SSH configuration',
    'piholeLinux · Tailscale, SSH server not checked',
    'buildbox.example.netbuildbox.example.net:2200 · Known hosts',
  ])
  const greyed = within(groups[1]!).getAllByRole('option')
  expect(greyed.map(option => [option.textContent, option.getAttribute('aria-disabled')])).toEqual([
    // spark is already a saved host, so it is not offered again.
    ['sparkzach@spark.lan · SSH configuration · Already added as Spark box', 'true'],
    ['omarchyLinux · Tailscale SSH · Offline, last seen 8 days ago', 'true'],
    ['iphone-15-proiOS · Tailscale · A phone cannot run the host', 'true'],
  ])
  const options = within(dialog).getAllByRole('option')
  expect(options.at(-1)!.textContent).toBe('Another SSH host…Type a host name or user@server')
  expect(within(dialog).getByText("Don't see your machine? Install Tailscale on it and sign in as millZach@github.")).toBeTruthy()
  // Arrow keys reach the greyed entries too, so their reason is heard; Enter leaves them be.
  expect(picker.getAttribute('aria-activedescendant')).toBe(options[0]!.id)
  await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}')
  expect(picker.getAttribute('aria-activedescendant')).toBe(greyed[1]!.id)
  await user.keyboard('{Enter}')
  expect(picker.getAttribute('aria-expanded')).toBe('true')
  // Typing jumps to a name; Enter picks it and closes the list.
  await user.keyboard('b')
  expect(picker.getAttribute('aria-activedescendant')).toBe(options[2]!.id)
  await user.keyboard('{Enter}')
  expect(picker.getAttribute('aria-expanded')).toBe('false')
  expect(picker.textContent).toBe('buildbox.example.netbuildbox.example.net:2200 · Known hosts')
  expect(document.activeElement).toBe(picker)
  // The list opens again on the chosen device, and Escape closes it before the dialog.
  await user.keyboard('{ArrowDown}')
  expect(picker.getAttribute('aria-expanded')).toBe('true')
  expect(picker.getAttribute('aria-activedescendant')).toBe(options[2]!.id)
  await user.keyboard('{Escape}')
  expect(picker.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('dialog', { name: 'Add host' })).toBeTruthy()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add host' })))
})

it('adds a picked device by its SSH alias or tailnet name, named as the list names it', async () => {
  const { bridge, command } = fixture([]), user = userEvent.setup()
  settings(bridge)
  const { dialog, picker } = await openAddHost(user)
  await user.keyboard('{ArrowDown}{Enter}')
  expect(picker.textContent).toContain('pihole')
  // Username and Port come from the SSH setup; they are fields only for a host typed by hand.
  expect(within(dialog).queryByRole('textbox', { name: 'Username (optional)' })).toBeNull()
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  expect(command).toHaveBeenCalledWith({ type: 'add', host: { id: expect.any(String), name: 'pihole', target: 'pihole.tail5728ca.ts.net', installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', identityFile: '' } })
  cleanup()
  const second = fixture([])
  settings(second.bridge)
  const again = await openAddHost(user)
  await user.click(within(again.dialog).getByRole('option', { name: /^buildbox/ }))
  await user.click(within(again.dialog).getByRole('button', { name: 'Add host' }))
  expect(second.command).toHaveBeenCalledWith({ type: 'add', host: expect.objectContaining({ name: 'buildbox.example.net', target: 'buildbox.example.net', sshPort: 2200 }) })
})

it('says so when the devices or Tailscale cannot be read, and still offers Another SSH host', async () => {
  const user = userEvent.setup()
  const { bridge } = fixture([])
  const broken: HostsBridge = { ...bridge, devices: async () => { throw new Error('IPC failed') }, tailscale: async () => { throw new Error('IPC failed') } }
  settings(broken)
  const row = await screen.findByRole('region', { name: 'Tailscale' })
  expect((await within(row).findByRole('status')).textContent).toBe('Sotto could not check Tailscale on this computer. Nothing was changed. Come back to this window to check again.')
  await user.click(screen.getByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Add host' })
  expect((await within(dialog).findByText(/could not read the devices/)).textContent).toBe('Sotto could not read the devices on this computer. Nothing was changed. Choose Another SSH host to type one.')
  expect(within(dialog).getAllByRole('option').map(option => option.querySelector('b')?.textContent)).toEqual(['Another SSH host…'])
})

it('opens and closes the list on a click with no key before it, the way a screen reader activates it', async () => {
  const { bridge } = fixture([]), user = userEvent.setup()
  settings(bridge)
  const { picker } = await openAddHost(user)
  expect(picker.getAttribute('aria-expanded')).toBe('true')
  act(() => { picker.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })) })
  expect(picker.getAttribute('aria-expanded')).toBe('false')
  act(() => { picker.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })) })
  expect(picker.getAttribute('aria-expanded')).toBe('true')
  // Enter opens once: the click a browser adds after it does not close the list again.
  await user.keyboard('{Escape}{Enter}')
  expect(picker.getAttribute('aria-expanded')).toBe('true')
})

it('types a host through Another SSH host, and Choose from your devices goes back to the list', async () => {
  const { bridge, command } = fixture([]), user = userEvent.setup()
  settings(bridge)
  const { dialog } = await openAddHost(user)
  await user.keyboard('{End}{Enter}')
  const field = within(dialog).getByRole('textbox', { name: 'SSH host' })
  expect(document.activeElement).toBe(field)
  expect(within(dialog).queryByRole('combobox')).toBeNull()
  await user.type(field, 'zach@10.0.0.42')
  await user.type(within(dialog).getByRole('textbox', { name: 'Port (optional)' }), '2222')
  await user.click(within(dialog).getByRole('button', { name: 'Choose from your devices' }))
  const picker = within(dialog).getByRole('combobox', { name: 'Device' })
  expect(document.activeElement).toBe(picker)
  expect(picker.getAttribute('aria-expanded')).toBe('true')
  // What was typed gives way to the list: nothing is chosen, so nothing is added.
  await user.keyboard('{Escape}')
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  expect(within(dialog).getByRole('alert').textContent).toBe('Choose a device, or choose Another SSH host… to type one.')
  expect(command).not.toHaveBeenCalled()
  // A device chosen first starts the typed host, and comes back with its own route after an edit.
  await user.click(picker)
  await user.click(within(dialog).getByRole('option', { name: /^forge/ }))
  const typed = await typeAHost(user, dialog)
  expect(typed).toHaveProperty('value', 'forge')
  await user.type(typed, '-lab')
  await user.click(within(dialog).getByRole('button', { name: 'Choose from your devices' }))
  expect(within(dialog).getByRole('combobox', { name: 'Device' }).textContent).toContain('forge')
  await user.keyboard('{Escape}')
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  expect(command).toHaveBeenCalledWith({ type: 'add', host: expect.objectContaining({ name: 'forge', target: 'forge' }) })
})

it('shows Tailscale under This computer, and connects it from Add host', async () => {
  const user = userEvent.setup()
  const running = fixture([])
  settings(running.bridge)
  const row = await screen.findByRole('region', { name: 'Tailscale' })
  await waitFor(() => expect(row.textContent).toContain('Connected as millZach · 5 devices on your tailnet'))
  expect(within(row).queryByRole('button')).toBeNull()
  cleanup()

  let finish: ((outcome: TailscaleConnectOutcome) => void) | undefined
  const off = fixture([], undefined, { tailscale: { state: 'off' }, connect: () => new Promise(resolve => { finish = resolve }) })
  settings(off.bridge)
  const offRow = await screen.findByRole('region', { name: 'Tailscale' })
  await waitFor(() => expect(offRow.textContent).toContain('Off on this computer. Connect to reach your other machines.'))
  expect(within(offRow).getByRole('button', { name: 'Connect to Tailscale' })).toBeTruthy()
  const { dialog, picker } = await openAddHost(user)
  // The dialog asks too, above the Device list, which still has focus; the list holds the SSH setup alone meanwhile.
  expect(document.activeElement).toBe(picker)
  expect(within(dialog).getByText(/Tailscale is off on this computer\./)).toBeTruthy()
  expect(within(dialog).getAllByRole('option').map(option => option.querySelector('b')?.textContent)).toEqual(['forge', 'spark', 'buildbox.example.net', 'Another SSH host…'])
  expect(within(dialog).getByText('Connect to Tailscale to see the machines on your tailnet here.')).toBeTruthy()
  // Inside Add host, Connect to Tailscale is the primary action, as the prototype drew it; on the Hosts page it is not.
  expect(within(dialog).getByRole('button', { name: 'Connect to Tailscale' }).className).toContain('tt-button--primary')
  expect(within(offRow).getByRole('button', { name: 'Connect to Tailscale' }).className).toContain('tt-button--secondary')
  await user.click(within(dialog).getByRole('button', { name: 'Connect to Tailscale' }))
  expect(off.connectTailscale).toHaveBeenCalledTimes(1)
  expect(within(dialog).getByRole('button', { name: 'Connecting…' })).toHaveProperty('disabled', true)
  off.setTailscale(RUNNING)
  await act(async () => { finish!('connected') })
  // Once Tailscale is up, the prompt goes and the tailnet's devices fill in.
  await waitFor(() => expect(within(dialog).queryByText(/Tailscale is off/)).toBeNull())
  expect(document.activeElement).toBe(within(dialog).getByRole('combobox', { name: 'Device' }))
  await user.keyboard('{ArrowDown}')
  await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(DEVICES.length + 1))
  expect(off.devices).toHaveBeenCalledTimes(2)
  expect(offRow.textContent).toContain('Connected as millZach')
})

it('says to finish signing in when Tailscale opens its page, and fills in once it is signed in', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const off = fixture([], undefined, { tailscale: { state: 'off' }, connect: async () => 'sign-in-opened' })
    settings(off.bridge)
    const row = await screen.findByRole('region', { name: 'Tailscale' })
    await user.click(await within(row).findByRole('button', { name: 'Connect to Tailscale' }))
    expect((await within(row).findByRole('status')).textContent).toBe('Sign in to Tailscale in your browser. Sotto lists your devices once you have.')
    // While the sign-in goes on, the button opens the same page again rather than starting another connect.
    await user.click(within(row).getByRole('button', { name: 'Open sign-in page' }))
    expect(off.connectTailscale).toHaveBeenCalledTimes(2)
    expect(within(row).getByRole('button', { name: 'Open sign-in page' })).toBeTruthy()
    expect(within(row).getByRole('status').textContent).toBe('Sign in to Tailscale in your browser. Sotto lists your devices once you have.')
    off.setTailscale(RUNNING)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    await waitFor(() => expect(row.textContent).toContain('Connected as millZach'))
    expect(within(row).queryByRole('status')).toBeNull()
  } finally { vi.useRealTimers() }
})

it('reads the devices again when Tailscale stops while Add host is open, so the list and the prompt agree', async () => {
  const user = userEvent.setup()
  const running = fixture([])
  settings(running.bridge)
  const { dialog } = await openAddHost(user)
  expect(within(dialog).getAllByRole('option')).toHaveLength(DEVICES.length + 1)
  // Disconnect from the tray, then back to the window.
  running.setTailscale({ state: 'off' })
  act(() => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => expect(within(dialog).getByText(/Tailscale is off on this computer\./)).toBeTruthy())
  await waitFor(() => expect(within(dialog).getAllByRole('option').map(option => option.querySelector('b')?.textContent)).toEqual(['forge', 'spark', 'buildbox.example.net', 'Another SSH host…']))
  expect(running.devices).toHaveBeenCalledTimes(2)
  expect(within(dialog).getByText('Connect to Tailscale to see the machines on your tailnet here.')).toBeTruthy()
  expect(within(dialog).queryByText(/Don't see your machine\?/)).toBeNull()
})

it('says in words when Tailscale does not connect, and offers Get Tailscale when it is not installed', async () => {
  const user = userEvent.setup()
  const failing = fixture([], undefined, { tailscale: { state: 'off' }, connect: async () => 'failed' })
  settings(failing.bridge)
  const row = await screen.findByRole('region', { name: 'Tailscale' })
  await user.click(await within(row).findByRole('button', { name: 'Connect to Tailscale' }))
  expect((await within(row).findByRole('status')).textContent).toBe('Tailscale did not connect. Open the Tailscale app on this computer and connect from there.')
  cleanup()
  const missing = fixture([], undefined, { tailscale: { state: 'missing' } })
  settings(missing.bridge)
  const missingRow = await screen.findByRole('region', { name: 'Tailscale' })
  await waitFor(() => expect(missingRow.textContent).toContain('Not installed. Any machine you reach over SSH works without it.'))
  await user.click(within(missingRow).getByRole('button', { name: 'Get Tailscale' }))
  expect(missing.openTailscaleDownload).toHaveBeenCalledTimes(1)
  const { dialog } = await openAddHost(user)
  expect(within(dialog).getByText(/Tailscale is not installed\./)).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: 'Get Tailscale' })).toBeTruthy()
  // SSH configuration entries still list.
  expect(within(dialog).getByRole('option', { name: /^forge/ }).textContent).toBe('forgeSSH configuration')
  expect(within(dialog).getByText('Get Tailscale to see the machines on your tailnet here.')).toBeTruthy()
})

it('turns Add host into the setup checklist once pressed, asks SSH questions on their step, and says when the host is connected', async () => {
  let resolveAdd: ((state: HostsState) => void) | undefined
  const { bridge, command, push, state } = fixture([], (input, current) => input.type === 'add' ? new Promise<HostsState>(resolve => { resolveAdd = resolve }) : current)
  const user = userEvent.setup()
  settings(bridge)
  const { dialog } = await openAddHost(user)
  await user.type(await typeAHost(user, dialog), 'forge')
  await user.type(within(dialog).getByRole('textbox', { name: 'Username (optional)' }), 'zach')
  await user.type(within(dialog).getByRole('textbox', { name: 'Port (optional)' }), '2222')
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  const sent = command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>
  expect(sent).toEqual({ type: 'add', host: { id: expect.any(String), name: 'forge', target: 'zach@forge', sshPort: 2222, installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', identityFile: '' } })
  // The form gives way to a line saying what is being added, and the steps.
  expect(dialog.getAttribute('aria-labelledby') && document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Connecting to forge')
  expect(within(dialog).queryByRole('combobox')).toBeNull()
  expect(within(dialog).getByText('forge').parentElement?.textContent).toBe('forge · as zach, port 2222')
  const adding = host({ id: sent.host.id, name: 'forge', target: 'zach@forge', phase: 'connecting', step: 'reach' })
  push({ adding })
  const steps = (): string[] => within(within(dialog).getByRole('list', { name: 'Connection steps' })).getAllByRole('listitem').map(item => `${item.querySelector('[role="img"]')?.getAttribute('aria-label')}: ${item.querySelector('.host-setup__title')?.textContent}`)
  expect(steps()).toEqual(['In progress: Reaching forge…', 'Not started: Sign in', 'Not started: Check the host installation', 'Not started: Start the host', 'Not started: Pair this computer'])
  // A screen reader hears the connect move on, step by step.
  const progress = () => within(dialog).getAllByRole('status')[0]!.textContent
  expect(progress()).toBe('Reaching forge…')
  expect(within(dialog).getByRole('button', { name: 'Connecting…' })).toHaveProperty('disabled', true)
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
  // SSH's question is asked on the step that asked it, since there is no row for the host yet.
  push({ adding: { ...adding, step: 'sign-in', prompt: { id: 'prompt-1', kind: 'passphrase', text: 'Enter passphrase for key' } } })
  const signIn = within(dialog).getAllByRole('listitem')[1]!
  expect(signIn.getAttribute('aria-current')).toBe('step')
  const passphrase = within(signIn).getByLabelText('Key passphrase')
  expect(document.activeElement).toBe(passphrase)
  await user.type(passphrase, 'synthetic')
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    fireEvent.keyDown(passphrase, { key: 'Enter', ...composition })
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ssh-answer' }))
  }
  await user.keyboard('{Enter}')
  expect(command).toHaveBeenCalledWith({ type: 'ssh-answer', id: sent.host.id, promptId: 'prompt-1', answer: 'synthetic' })
  push({ adding: { ...adding, step: 'start' } })
  expect(steps().slice(0, 4)).toEqual(['Done: Reached forge', 'Done: Signed in', 'Done: Host installed', 'In progress: Starting the host…'])
  expect(progress()).toBe('Starting the host…')
  // Saved and connected: the dialog says so, and Done closes it.
  delete state().adding
  push({ hosts: [{ ...adding, phase: 'connected', step: 'pair' }] })
  resolveAdd!(state())
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'forge is connected' })).toBeTruthy())
  expect(steps()).toEqual(['Done: Reached forge', 'Done: Signed in', 'Done: Host installed', 'Done: Host started', 'Done: Paired'])
  expect(within(dialog).getAllByRole('status').map(item => item.textContent)).toEqual(['', expect.stringContaining('forge is added and connected.')])
  expect(within(dialog).queryByRole('button', { name: /^Change/ })).toBeNull()
  const done = within(dialog).getByRole('button', { name: 'Done' })
  expect(document.activeElement).toBe(done)
  await user.click(done)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('region', { name: 'forge' })).toBeTruthy()
  expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cancel-add' }))
})

it('shows Tailscale approval as its own step, opens the approval page only on a press, and goes on when approved', async () => {
  const { bridge, command, push } = fixture([])
  const openExternalLink = vi.fn(async () => ({ ok: true as const }))
  const previous = window.sotto
  Object.assign(window, { sotto: { ...previous, openExternalLink } })
  try {
    const user = userEvent.setup()
    settings(bridge)
    const { dialog: form } = await openAddHost(user)
    await user.click(within(form).getByRole('option', { name: /^forge/ }))
    await user.click(within(form).getByRole('button', { name: 'Add host' }))
    const dialog = screen.getByRole('dialog', { name: 'Connecting to forge' })
    const id = (command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>).host.id
    const waiting = host({ id, name: 'forge', target: 'forge', phase: 'connecting', step: 'tailscale', tailscale: { waiting: true, url: 'https://login.tailscale.com/a/l1ab2c3' } })
    push({ adding: waiting })
    const step = within(dialog).getAllByRole('listitem')[1]!
    expect(step.getAttribute('aria-current')).toBe('step')
    expect(within(step).getByRole('img').getAttribute('aria-label')).toBe('Waiting for you')
    expect(within(step).getByText('Waiting for your approval in Tailscale')).toBeTruthy()
    expect(within(step).getByRole('status').textContent).toBe('forge uses Tailscale SSH, which asks you to approve new connections in your browser. Sotto waits up to 5 minutes and carries on when you approve.Open approval pageWhy Tailscale asks')
    // Focus moves to the one thing to do; nothing opens until it is pressed, and main opens the page.
    const open = within(step).getByRole('button', { name: 'Open approval page' })
    expect(document.activeElement).toBe(open)
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'open-approval' }))
    await user.click(open)
    expect(command).toHaveBeenCalledWith({ type: 'open-approval', id })
    await user.click(within(step).getByRole('button', { name: 'Why Tailscale asks' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://github.com/millZach/Sotto/blob/main/docs/guide.md#hosts-over-tailscale-ssh')
    // Approved in the browser: the step is done and the checklist carries on without another press.
    push({ adding: { ...waiting, step: 'install', tailscale: { waiting: false } } })
    expect(within(dialog).getAllByRole('listitem').map(item => item.querySelector('.host-setup__title')?.textContent).slice(0, 4))
      .toEqual(['Reached forge', 'Approved in Tailscale', 'Signed in', 'Checking the host installation…'])
    expect(within(dialog).queryByRole('button', { name: 'Open approval page' })).toBeNull()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(command).toHaveBeenLastCalledWith({ type: 'cancel-add', id })
  } finally { Object.assign(window, { sotto: previous }) }
})

it('shows an approval Tailscale asks of the port forward on the Tailscale step, with the 30 seconds it has', async () => {
  const { bridge, command, push } = fixture([])
  const user = userEvent.setup()
  settings(bridge)
  const { dialog: form } = await openAddHost(user)
  await user.click(within(form).getByRole('option', { name: /^forge/ }))
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Connecting to forge' })
  const id = (command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>).host.id
  push({ adding: host({ id, name: 'forge', target: 'forge', phase: 'connecting', step: 'start', tailscale: { waiting: true, url: 'https://login.tailscale.com/a/l1ab2c3' } }) })
  const items = within(dialog).getAllByRole('listitem')
  expect(items.map(item => `${item.getAttribute('data-state')}: ${item.querySelector('.host-setup__title')?.textContent}`))
    .toEqual(['done: Reached forge', 'waiting: Waiting for your approval in Tailscale', 'done: Signed in', 'done: Host installed', 'active: Starting the host…', 'todo: Pair this computer'])
  // Where the user is: the approval, not the step the connect is on.
  expect(items.map(item => item.getAttribute('aria-current'))).toEqual([null, 'step', null, null, null, null])
  expect(within(items[1]!).getByRole('status').textContent).toContain('forge uses Tailscale SSH, which asks you to approve the port forward as well. Approve it in your browser within 30 seconds and Sotto carries on.')
  expect(document.activeElement).toBe(within(items[1]!).getByRole('button', { name: 'Open approval page' }))
})

it("keeps a failed Open approval page on the Tailscale card, and shows main's own failure on the failed step", async () => {
  const stale = 'Tailscale is no longer waiting for this approval. Nothing was opened.'
  const { bridge, command, push } = fixture([], (input, current) => { if (input.type === 'open-approval') throw new Error(stale); return current })
  const user = userEvent.setup()
  settings(bridge)
  const { dialog: form } = await openAddHost(user)
  await user.click(within(form).getByRole('option', { name: /^forge/ }))
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  const dialog = screen.getByRole('dialog', { name: 'Connecting to forge' })
  const id = (command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>).host.id
  const waiting = host({ id, name: 'forge', target: 'forge', phase: 'connecting', step: 'tailscale', tailscale: { waiting: true, url: 'https://login.tailscale.com/a/l1ab2c3' } })
  push({ adding: waiting })
  await user.click(within(dialog).getByRole('button', { name: 'Open approval page' }))
  // Said on the card it belongs to; the connect itself has not failed.
  const card = within(within(dialog).getAllByRole('listitem')[1]!).getByRole('status')
  expect(within(card).getByRole('alert').textContent).toBe(stale)
  expect(dialog.getAttribute('aria-labelledby') && document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Connecting to forge')
  // Tailscale stops waiting: the sentence goes with it.
  push({ adding: { ...waiting, step: 'install', tailscale: { waiting: false } } })
  expect(within(dialog).queryByText(stale)).toBeNull()
  // A later failure shows main's sentence on its step.
  const message = 'The host was not ready in time. Nothing was saved. Check that it starts on the SSH host, then add the host again.'
  push({ adding: { ...waiting, phase: 'error', step: 'start', tailscale: { waiting: false }, error: message } })
  const failed = within(screen.getByRole('dialog', { name: 'forge could not be added' })).getAllByRole('listitem')[4]!
  expect(within(failed).getByRole('alert').textContent).toBe(message)
  expect(within(screen.getByRole('dialog')).queryByText(stale)).toBeNull()
})

it('shows a failure on its own step with its fix to copy, and Try again and Change start over', async () => {
  const { bridge, command, push } = fixture([])
  const user = userEvent.setup()
  // After setup, which puts its own clipboard in place.
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  settings(bridge)
  const { dialog: form } = await openAddHost(user)
  // A form that cannot be sent says so in the form.
  await user.keyboard('{Escape}')
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  expect(within(form).getByRole('alert').textContent).toBe('Choose a device, or choose Another SSH host… to type one.')
  const typed = await typeAHost(user, form)
  await user.type(within(form).getByRole('textbox', { name: 'Port (optional)' }), '99999')
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  expect(within(form).getByRole('alert').textContent).toBe('Enter an SSH host or alias, such as forge or user@server.')
  await user.type(typed, 'forge')
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  expect(within(form).getByRole('alert').textContent).toBe('Enter a port between 1 and 65535, or leave Port empty to use your SSH configuration.')
  await user.clear(within(form).getByRole('textbox', { name: 'Port (optional)' }))
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  const id = (command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>).host.id
  const message = 'The SSH host key changed. Nothing was saved. Verify the host identity and update your SSH known hosts before adding the host again.'
  push({ adding: host({ id, name: 'forge', target: 'forge', phase: 'error', step: 'sign-in', error: message,
    fix: { text: "Once you know the new key is the host's own, remove the old one from your known hosts on this computer:", command: 'ssh-keygen -R forge.example.net' } }) })
  const dialog = screen.getByRole('dialog', { name: 'forge could not be added' })
  const failed = within(dialog).getAllByRole('listitem')[1]!
  expect(within(failed).getByRole('img').getAttribute('aria-label')).toBe('Failed')
  expect(within(failed).getByText('Could not sign in')).toBeTruthy()
  const alert = within(failed).getByRole('alert')
  expect(alert.textContent).toContain(message)
  expect(within(alert).getByText('ssh-keygen -R forge.example.net').tagName).toBe('CODE')
  await user.click(within(alert).getByRole('button', { name: 'Copy the command' }))
  expect(writeText).toHaveBeenCalledWith('ssh-keygen -R forge.example.net')
  expect(within(alert).getByRole('button', { name: 'Copy the command' }).textContent).toBe('Copied')
  expect(within(alert).getByRole('status').textContent).toBe('Copied the command')
  // The steps after the failure never started.
  expect(within(dialog).getAllByRole('listitem').slice(2).map(item => item.getAttribute('data-state'))).toEqual(['todo', 'todo', 'todo'])
  expect(screen.getByText('No remote hosts yet.')).toBeTruthy()
  // Try again adds it again as a new attempt.
  await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
  const retried = (command.mock.calls.at(-1)![0] as Extract<HostsCommand, { type: 'add' }>)
  expect(retried).toMatchObject({ type: 'add', host: { target: 'forge' } })
  expect(retried.host.id).not.toBe(id)
  push({ adding: host({ id: retried.host.id, name: 'forge', target: 'forge', phase: 'error', step: 'reach', error: 'SSH could not reach the host. Nothing was saved. Check the host name and your network, then add the host again.' }) })
  // Change drops the attempt and gives the form back with what was typed, focused.
  await user.click(within(dialog).getByRole('button', { name: /^Change/ }))
  expect(command).toHaveBeenLastCalledWith({ type: 'cancel-add', id: retried.host.id })
  const field = within(screen.getByRole('dialog', { name: 'Add host' })).getByRole('textbox', { name: 'SSH host' })
  expect(field).toHaveProperty('value', 'forge')
  await waitFor(() => expect(document.activeElement).toBe(field))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('goes back to the form when main refuses the add before connecting', async () => {
  const { bridge } = fixture([], input => { if (input.type === 'add') throw new Error('forge is already saved as Forge. Nothing was saved. Switch it on in the list instead.'); throw new Error('unexpected') })
  const user = userEvent.setup()
  settings(bridge)
  const { dialog: form } = await openAddHost(user)
  await user.click(within(form).getByRole('option', { name: /^forge/ }))
  await user.click(within(form).getByRole('button', { name: 'Add host' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add host' })
  expect(within(dialog).getByRole('alert').textContent).toBe('forge is already saved as Forge. Nothing was saved. Switch it on in the list instead.')
  expect(within(dialog).getByRole('combobox', { name: 'Device' }).textContent).toContain('forge')
})

it("says on a saved host's row that Tailscale is waiting for approval, and opens the page on a press", async () => {
  const { bridge, command } = fixture([host({ name: 'forge', target: 'forge', phase: 'connecting', reconnecting: true, step: 'tailscale', tailscale: { waiting: true, url: 'https://login.tailscale.com/a/l1ab2c3' } })])
  const user = userEvent.setup()
  settings(bridge)
  const row = await screen.findByRole('region', { name: 'forge' })
  expect(within(row).getByText(/SSH forge ·/).textContent).toBe('SSH forge · Waiting for your approval in Tailscale')
  await user.click(within(row).getByRole('button', { name: 'Open the Tailscale approval page for forge' }))
  expect(command).toHaveBeenCalledWith({ type: 'open-approval', id: REMOTE })
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
  await user.click(within(trust).getByRole('button', { name: 'Switch it off' }))
  expect(command).toHaveBeenLastCalledWith({ type: 'set-enabled', id: REMOTE, enabled: false })
  push({ hosts: [{ ...reconnecting, phase: 'disconnected', enabled: false }] })
  expect(trust.isConnected).toBe(false)
})

it.each(['passphrase', 'host-key'] as const)('dismisses a saved host %s question on Escape without switching it off', async kind => {
  const prompt = { id: 'dismissed-prompt', kind, text: 'Synthetic SSH question' }
  const connecting = host({ phase: 'connecting', prompt })
  const { bridge, command, push, state } = fixture([connecting]), user = userEvent.setup()
  render(<HostQuestionDialog bridge={bridge} />)
  await screen.findByRole('dialog')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(command).not.toHaveBeenCalled()
  expect(state().hosts[0]?.enabled).toBe(true)
  push({ hosts: [{ ...connecting }] })
  expect(screen.queryByRole('dialog')).toBeNull()
  push({ hosts: [{ ...connecting, prompt: { ...prompt, id: 'next-prompt' } }] })
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('lets each saved host ask without reopening another host question already dismissed', async () => {
  const first = host({ name: 'forge', phase: 'connecting', prompt: { id: 'forge-prompt', kind: 'passphrase', text: 'First question' } })
  const second = host({ id: '33333333-3333-4333-8333-333333333333', name: 'spark', phase: 'connecting', prompt: { id: 'spark-prompt', kind: 'host-key', text: 'Second question' } })
  const { bridge, command, push } = fixture([first, second]), user = userEvent.setup()
  const fallback = React.createRef<HTMLButtonElement>()
  render(<><button ref={fallback}>Page control</button><HostQuestionDialog bridge={bridge} /></>)
  fallback.current!.focus()
  await screen.findByRole('dialog', { name: 'Unlock the SSH connection to forge' })
  await user.keyboard('{Escape}')
  expect(screen.getByRole('dialog', { name: 'Trust the SSH host spark?' })).toBeTruthy()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(fallback.current))
  push({ hosts: [first, second] })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(command).not.toHaveBeenCalled()
})

it.each(['passphrase', 'password', 'host-key'] as const)('opens a saved host %s question with focus on its answer', async kind => {
  const { bridge } = fixture([host({ phase: 'connecting', prompt: { id: 'focus-prompt', kind, text: 'Synthetic question' } })])
  render(<HostQuestionDialog bridge={bridge} />)
  const dialog = await screen.findByRole('dialog')
  const target = kind === 'host-key' ? within(dialog).getByRole('region', { name: 'SSH host key' }) : within(dialog).getByLabelText(kind === 'password' ? 'SSH password' : 'Key passphrase')
  await waitFor(() => expect(document.activeElement).toBe(target))
})

it('requires deliberate keyboard navigation before trusting a saved host key', async () => {
  const { bridge, command } = fixture([host({ phase: 'connecting', prompt: { id: 'trust-prompt', kind: 'host-key', text: 'Synthetic host key' } })]), user = userEvent.setup()
  render(<HostQuestionDialog bridge={bridge} />)
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('region', { name: 'SSH host key' })))
  await user.keyboard('{Enter}')
  expect(command).not.toHaveBeenCalled()
  await user.tab()
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Trust host' }))
  await user.keyboard('{Enter}')
  expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'ssh-answer', id: REMOTE, promptId: 'trust-prompt', answer: 'yes' })
})

it.each(['passphrase', 'password'] as const)('submits a saved host %s on Enter and reaches Continue before Switch it off', async kind => {
  const { bridge, command } = fixture([host({ phase: 'connecting', prompt: { id: 'enter-prompt', kind, text: 'Synthetic question' } })]), user = userEvent.setup()
  render(<HostQuestionDialog bridge={bridge} />)
  const dialog = await screen.findByRole('dialog')
  const field = within(dialog).getByLabelText(kind === 'password' ? 'SSH password' : 'Key passphrase')
  await waitFor(() => expect(document.activeElement).toBe(field))
  await user.tab()
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Continue' }))
  await user.tab()
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Switch it off' }))
  await user.type(field, 'synthetic{Enter}')
  await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'ssh-answer', id: REMOTE, promptId: 'enter-prompt', answer: 'synthetic' }))
})

it('returns to a dismissed question from its host row and sends the answer', async () => {
  const connecting = host({ phase: 'connecting', prompt: { id: 'row-prompt', kind: 'password', text: 'Synthetic question' } })
  const { bridge, command, push } = fixture([connecting]), user = userEvent.setup()
  render(<><HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} /><HostQuestionDialog bridge={bridge} /></>)
  await screen.findByRole('dialog')
  const row = await screen.findByRole('region', { name: 'Build box' })
  expect(within(row).queryByRole('button', { name: 'Answer Build box' })).toBeNull()
  expect(within(row).queryByText('Waiting for your answer')).toBeNull()
  await user.keyboard('{Escape}')
  const answerButton = within(row).getByRole('button', { name: 'Answer Build box' })
  expect(within(row).getByText('Waiting for your answer')).toBeTruthy()
  await waitFor(() => expect(document.activeElement).toBe(answerButton))
  expect(command).not.toHaveBeenCalled()
  await user.click(answerButton)
  const field = within(screen.getByRole('dialog')).getByLabelText('SSH password')
  expect(document.activeElement).toBe(field)
  expect(within(row).queryByRole('button', { name: 'Answer Build box' })).toBeNull()
  await user.type(field, 'synthetic')
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  expect(command).toHaveBeenCalledWith({ type: 'ssh-answer', id: REMOTE, promptId: 'row-prompt', answer: 'synthetic' })
  await user.keyboard('{Escape}')
  push({ hosts: [host({ phase: 'connected' })] })
  expect(within(row).queryByRole('button', { name: 'Answer Build box' })).toBeNull()
  expect(within(row).queryByText('Waiting for your answer')).toBeNull()
})

it('leaves focus and scrolling on the current page when Hosts is mounted but hidden', async () => {
  const { bridge } = fixture([host({ phase: 'connecting', prompt: { id: 'hidden-prompt', kind: 'password', text: 'Synthetic question' } })]), user = userEvent.setup()
  render(<><button>Current page</button><div hidden><HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} /></div><HostQuestionDialog bridge={bridge} /></>)
  const previous = screen.getByRole('button', { name: 'Current page' })
  previous.focus()
  await screen.findByRole('dialog')
  const row = screen.getByRole('region', { name: 'Build box', hidden: true })
  const scroll = vi.fn()
  row.scrollIntoView = scroll
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(previous))
  expect(scroll).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Answer Build box' })).toBeNull()
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

it('names a host with a long name within the limit, and says in words when the host and username are too long', async () => {
  const { bridge, command } = fixture([]), user = userEvent.setup()
  settings(bridge)
  const { dialog } = await openAddHost(user)
  const long = `${'build-'.repeat(20)}box.example.net`
  await user.click(await typeAHost(user, dialog))
  await user.paste(long)
  await user.click(within(dialog).getByRole('textbox', { name: 'Username (optional)' }))
  await user.paste('z')
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  const sent = command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>
  expect(sent.host.target).toBe(`z@${long}`)
  expect(sent.host.name).toBe(long.slice(0, 80))
  cleanup()
  const second = fixture([])
  settings(second.bridge)
  const { dialog: again } = await openAddHost(user)
  await user.click(await typeAHost(user, again))
  await user.paste(`${'a'.repeat(250)}.net`)
  await user.click(within(again).getByRole('textbox', { name: 'Username (optional)' }))
  await user.paste('zach')
  await user.click(within(again).getByRole('button', { name: 'Add host' }))
  expect(second.command).not.toHaveBeenCalled()
  expect(within(again).getByRole('alert').textContent).toBe('This SSH host and username are too long together. Nothing was saved. Use a shorter alias from your SSH configuration.')
})

it.each([{ isComposing: true }, { keyCode: 229 }])('leaves a host rename for Enter after composition (%j)', async composition => {
  const { bridge, command } = fixture(), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
  const field = screen.getByRole('textbox', { name: 'Host name' })
  fireEvent.change(field, { target: { value: 'Forge' } })
  fireEvent.keyDown(field, { key: 'Enter', ...composition })
  expect(command).not.toHaveBeenCalled()
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(command).toHaveBeenCalledWith({ type: 'rename', id: REMOTE, name: 'Forge' })
})

it.each([{ isComposing: true }, { keyCode: 229 }])('leaves a connection save for Enter after composition (%j)', async composition => {
  const { bridge, command } = fixture(), user = userEvent.setup()
  settings(bridge)
  await user.click(await screen.findByRole('button', { name: 'More for Build box' }))
  await user.click(screen.getByRole('menuitem', { name: 'Edit connection' }))
  const field = screen.getByRole('textbox', { name: 'SSH host' })
  fireEvent.change(field, { target: { value: 'forge' } })
  fireEvent.keyDown(field, { key: 'Enter', ...composition })
  expect(command).not.toHaveBeenCalled()
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(command).toHaveBeenCalledWith({ type: 'save', host: expect.objectContaining({ target: 'forge' }) })
})
