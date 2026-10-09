import { DEVICES, RUNNING, host, fixture, openAddHost, typeAHost, settings } from '../../../../fixtures/renderer/hostsSettingsHarness'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { HostsBridge } from '../../../../../src/shared/hosts'
import type { TailscaleConnectOutcome } from '../../../../../src/shared/hostDevices'

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
  await waitFor(() => expect(missingRow.textContent).toContain('Not installed. Any machine you reach over SSH works without it, and Sotto connects to it over SSH each time.'))
  await user.click(within(missingRow).getByRole('button', { name: 'Get Tailscale' }))
  expect(missing.openTailscaleDownload).toHaveBeenCalledTimes(1)
  const { dialog } = await openAddHost(user)
  expect(within(dialog).getByText(/Tailscale is not installed\./)).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: 'Get Tailscale' })).toBeTruthy()
  // SSH configuration entries still list.
  expect(within(dialog).getByRole('option', { name: /^forge/ }).textContent).toBe('forgeSSH configuration')
  expect(within(dialog).getByText('Get Tailscale to see the machines on your tailnet here.')).toBeTruthy()
})
