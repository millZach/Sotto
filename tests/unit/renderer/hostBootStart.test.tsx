import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostsSettings } from '../../../src/renderer/src/features/settings/HostsSettings'
import { HostBootOffer } from '../../../src/renderer/src/features/settings/HostBootStart'
import { HostUpdateControl } from '../../../src/renderer/src/agents/HostUpdates'
import type { HostsBridge, HostsCommand, HostsState, HostStatus } from '../../../src/shared/hosts'
import type { BootStatus, HostBootState } from '../../../src/shared/bootStart'

afterEach(cleanup)
const LOCAL = '11111111-1111-4111-8111-111111111111'
const FORGE = '22222222-2222-4222-8222-222222222222'
const off: BootStatus = { supported: true, installed: false, enabled: false, active: false, linger: true, nodeDrift: false }
const on: BootStatus = { supported: true, installed: true, enabled: true, active: true, linger: true, nodeDrift: false }
const lingerOff: BootStatus = { ...off, linger: false, fix: 'sudo loginctl enable-linger zach' }
function forge(patch: Partial<HostStatus> = {}): HostStatus {
  return { id: FORGE, hostId: FORGE, name: 'forge', target: 'zach@forge', identityFile: '', installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', phase: 'connected', enabled: true, owned: true, bootStart: off, ...patch }
}
const change = (patch: Partial<HostBootState> = {}): HostBootState => ({ id: FORGE, name: 'forge', change: 'install', phase: 'changing', working: 0, restarts: true, ...patch })
/** A bridge holding what main publishes; `answer` decides what each press changes. */
function fixture(hosts: HostStatus[], answer?: (command: HostsCommand, state: HostsState) => Partial<HostsState>) {
  let state: HostsState = { localHostEnabled: true, localHostRunning: true, localHostId: LOCAL, activeHostId: LOCAL, hosts }
  const listeners = new Set<(value: HostsState) => void>()
  const push = (next: Partial<HostsState>): void => { state = { ...state, ...next }; act(() => { for (const listener of listeners) listener(state) }) }
  const command = vi.fn<HostsBridge['command']>(async input => { if (answer) state = { ...state, ...answer(input, state) }; return state })
  const bridge = { get: async () => state, command, onChanged: (listener: (value: HostsState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    devices: vi.fn(async () => ({ tailscale: null, devices: [] })), tailscale: vi.fn(async () => ({ state: 'stopped' })), connectTailscale: vi.fn(), openTailscaleDownload: vi.fn(),
    providerAction: vi.fn(async () => ({})), updateClients: vi.fn(async () => ({})), signIn: vi.fn(async () => null) } as unknown as HostsBridge
  return { bridge, command, push }
}
const boots = (command: ReturnType<typeof fixture>['command']) => command.mock.calls.map(([value]) => value).filter(value => value.type === 'host-boot')
const settings = (bridge: HostsBridge) => render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} />)
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'More for forge' }))
  return screen.getByRole('menu', { name: 'forge actions' })
}

describe('the More menu (ADR-0054)', () => {
  it('offers Start at boot… first, above a line, and Stop starting at boot… once the host starts at boot', async () => {
    const user = userEvent.setup()
    const { bridge, push } = fixture([forge()])
    settings(bridge)
    const menu = await openMenu(user)
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Start at boot…', 'Stop host', 'Rename', 'Edit connection', 'Forget forge…'])
    // One line under start at boot, and one above Forget, as the prototype draws them.
    expect([...menu.children].map(item => item.getAttribute('role'))).toEqual(['menuitem', 'separator', 'menuitem', 'menuitem', 'menuitem', 'separator', 'menuitem'])
    expect(document.activeElement?.textContent).toBe('Start at boot…')
    await user.keyboard('{Escape}')
    push({ hosts: [forge({ bootStart: on })] })
    expect(within(await openMenu(user)).getAllByRole('menuitem')[0]).toHaveTextContent('Stop starting at boot…')
  })

  it('offers nothing for a host that cannot start at boot, one whose launch did not say, or one not connected', async () => {
    const user = userEvent.setup()
    for (const host of [forge({ bootStart: { ...off, supported: false, reason: 'macos' } }), forge({ bootStart: undefined }), forge({ phase: 'connecting' })]) {
      const { bridge } = fixture([host])
      settings(bridge)
      const menu = await openMenu(user)
      expect(within(menu).queryByRole('menuitem', { name: /at boot/u })).toBeNull()
      // Only the line above Forget.
      expect(within(menu).getAllByRole('separator')).toHaveLength(1)
      cleanup()
    }
  })
})

describe('Start at boot’s modal', () => {
  it('says what Sotto found and what changes, with the linger command to copy, and sends nothing until the press', async () => {
    const user = userEvent.setup()
    const { bridge, command } = fixture([forge({ bootStart: lingerOff })], () => ({ boot: [change()] }))
    settings(bridge)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Start at boot…' }))
    const dialog = screen.getByRole('dialog', { name: 'Start forge’s host at boot?' })
    const found = within(dialog).getByRole('list', { name: 'What Sotto found on forge' })
    expect(found).toHaveTextContent('Linger, first · Off. Sotto turns it on for zach before anything else')
    expect(found).toHaveTextContent('Sotto never runs sudo.')
    expect(within(found).getByText('sudo loginctl enable-linger zach')).toBeInTheDocument()
    expect(within(found).getByRole('button', { name: 'Copy the command' })).toBeInTheDocument()
    const changes = within(dialog).getByRole('list', { name: 'What changes on forge' })
    expect(changes).toHaveTextContent('A unit · sotto-host.service in zach’s systemd folder, and a small script beside the host.')
    expect(changes).toHaveTextContent('One restart, now · The host Sotto started restarts under the unit.')
    expect(boots(command)).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Start at boot' }))
    expect(boots(command)).toEqual([{ type: 'host-boot', id: FORGE, action: 'install' }])
    expect(await screen.findByRole('dialog', { name: 'Starting forge’s host at boot…' })).toHaveTextContent('Turning on linger, then installing the unit on forge. The host restarts once under it, and this computer connects again.')
  })

  it('tells the owner of a host Sotto did not start that it keeps running, and the unit takes over at the next boot', async () => {
    const user = userEvent.setup()
    const { bridge } = fixture([forge({ owned: false })])
    settings(bridge)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Start at boot…' }))
    const changes = screen.getByRole('list', { name: 'What changes on forge' })
    expect(changes).toHaveTextContent('No restart · Sotto did not start the host running on forge, so it keeps running as it is. The unit takes over the next time forge starts.')
    expect(screen.getByRole('list', { name: 'What Sotto found on forge' })).toHaveTextContent('Linger · On for zach')
  })

  it('answers Escape with nothing sent, and gives focus back to the menu button', async () => {
    const user = userEvent.setup()
    const { bridge, command } = fixture([forge()])
    settings(bridge)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Start at boot…' }))
    expect(screen.getByRole('dialog', { name: 'Start forge’s host at boot?' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(boots(command)).toEqual([])
    await waitFor(() => expect(screen.getByRole('button', { name: 'More for forge' })).toHaveFocus())
  })

  it('asks the busy-host question, and sends each answer', async () => {
    const user = userEvent.setup()
    const { bridge, command, push } = fixture([forge()], input => input.type === 'host-boot' && input.action === 'install' ? { boot: [change({ phase: 'confirm', working: 2 })] } : {})
    settings(bridge)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Start at boot…' }))
    await user.click(screen.getByRole('button', { name: 'Start at boot' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start forge’s host at boot?' })
    await waitFor(() => expect(dialog).toHaveTextContent('2 threads on forge are working. Starting at boot restarts forge’s host, which stops them.'))
    expect(dialog).toHaveTextContent('Only the work in progress on those turns is lost. Drafts and history stay.')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Wait until they finish, then start at boot on forge' })).toHaveFocus())
    await user.click(within(dialog).getByRole('button', { name: 'Wait until they finish, then start at boot on forge' }))
    push({ boot: [change({ phase: 'waiting', working: 2 })] })
    const waiting = screen.getByRole('dialog', { name: 'Waiting for forge’s threads' })
    expect(waiting).toHaveTextContent('forge’s host starts at boot once its threads finish. 2 still working.')
    await user.click(within(waiting).getByRole('button', { name: 'Stop 2 threads now, then start at boot on forge' }))
    expect(boots(command).map(item => item.type === 'host-boot' && item.action)).toEqual(['install', 'when-idle', 'stop-threads'])
    // Closed while it waits, the change carries on, and the row says so.
    await user.click(within(waiting).getByRole('button', { name: 'Close. Sotto still waits for forge’s threads' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('region', { name: 'forge' })).toHaveTextContent('Starts at boot when its threads finish')
    expect(boots(command)).toHaveLength(3)
  })

  it('says linger needs an administrator, with the command, and offers Start at boot again', async () => {
    const user = userEvent.setup()
    const failed = change({ phase: 'failed', failure: { kind: 'linger', message: 'forge would not turn on linger without an administrator. Without it, a unit would stop forge’s host whenever its account signs out, so Sotto installed nothing.',
      fix: { text: 'Run this on forge, then press Start at boot again. Sotto never runs sudo.', command: 'sudo loginctl enable-linger zach' } } })
    const { bridge, command } = fixture([forge({ bootStart: lingerOff })], input => input.type === 'host-boot' && input.action === 'install' ? { boot: [failed] } : { boot: [] })
    settings(bridge)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Start at boot…' }))
    await user.click(screen.getByRole('button', { name: 'Start at boot' }))
    const dialog = await screen.findByRole('dialog', { name: 'forge’s host does not start at boot yet' })
    expect(dialog).toHaveTextContent('Nothing changed on forge. Its host is still running as before, and this computer is still connected.')
    const checks = within(dialog).getByRole('list', { name: 'Start at boot on forge' })
    expect(within(checks).getAllByRole('listitem').map(item => item.textContent?.split(' · ')[0])).toEqual(['Linger', 'Unit', 'Restart'])
    expect(within(checks).getByText('sudo loginctl enable-linger zach')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Start at boot' }))
    expect(boots(command).map(item => item.type === 'host-boot' && item.action)).toEqual(['install', 'install'])
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    // A result is put away with the modal that shows it.
    await waitFor(() => expect(boots(command).at(-1)).toEqual({ type: 'host-boot', id: FORGE, action: 'dismiss' }))
  })

  it('puts away a result left from an earlier press, rather than showing it as this modal’s', async () => {
    const user = userEvent.setup()
    const { bridge, command, push } = fixture([forge({ bootStart: on })], () => ({ boot: [] }))
    settings(bridge)
    // Started at boot from Add host's card, and its result never put away.
    await screen.findByRole('region', { name: 'forge' })
    push({ boot: [change({ phase: 'done', restarted: true })] })
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Stop starting at boot…' }))
    expect(screen.getByRole('dialog', { name: 'Stop starting forge’s host at boot?' })).toBeInTheDocument()
    await waitFor(() => expect(boots(command)).toEqual([{ type: 'host-boot', id: FORGE, action: 'dismiss' }]))
  })

  it('opens on a failure nobody has read yet, rather than putting it away unseen', async () => {
    const user = userEvent.setup()
    const failed = change({ phase: 'failed', failure: { kind: 'failed', message: 'forge’s systemd would not take the unit, so Sotto took it away again.' } })
    const { bridge, command, push } = fixture([forge()], () => ({ boot: [] }))
    settings(bridge)
    await screen.findByRole('region', { name: 'forge' })
    push({ boot: [failed] })
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Start at boot…' }))
    const dialog = screen.getByRole('dialog', { name: 'forge’s host does not start at boot' })
    expect(dialog).toHaveTextContent('forge’s systemd would not take the unit, so Sotto took it away again.')
    expect(boots(command)).toEqual([])
    // The row leaves it to the modal while the modal shows it.
    expect(screen.queryByRole('status', { name: 'What Sotto said about start at boot on forge' })).toBeNull()
  })

  it('shows on the row a change that failed after its modal was closed, until Dismiss', async () => {
    const user = userEvent.setup()
    const { bridge, command, push } = fixture([forge({ bootStart: on })], input => input.type === 'host-boot' && input.action === 'remove' ? { boot: [change({ change: 'remove' })] } : input.type === 'host-boot' && input.action === 'dismiss' ? { boot: [] } : {})
    settings(bridge)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Stop starting at boot…' }))
    await user.click(screen.getByRole('button', { name: 'Stop starting at boot' }))
    const running = await screen.findByRole('dialog', { name: 'Stopping forge’s host starting at boot…' })
    await user.click(within(running).getByRole('button', { name: 'Close. Stop starting at boot carries on' }))
    expect(screen.getByRole('region', { name: 'forge' })).toHaveTextContent('Stopping start at boot…')
    const message = 'Sotto turned off start at boot on forge but could not remove the unit’s files there. Nothing was lost, and this computer starts the host again when it connects.'
    push({ boot: [change({ change: 'remove', phase: 'failed', failure: { kind: 'failed', message, fix: { text: 'To remove them, run this on forge:', command: 'B="$HOME/.local/share/sotto-host"/boot-start.sh' } } })] })
    const notice = screen.getByRole('status', { name: 'What Sotto said about start at boot on forge' })
    expect(notice).toHaveTextContent(message)
    expect(within(notice).getByText('B="$HOME/.local/share/sotto-host"/boot-start.sh')).toBeInTheDocument()
    // Nothing was put away while nobody had read it.
    expect(boots(command).map(item => item.type === 'host-boot' && item.action)).toEqual(['remove'])
    await user.click(within(notice).getByRole('button', { name: 'Dismiss what Sotto said about start at boot on forge' }))
    expect(boots(command).at(-1)).toEqual({ type: 'host-boot', id: FORGE, action: 'dismiss' })
    await waitFor(() => expect(screen.queryByRole('status', { name: 'What Sotto said about start at boot on forge' })).toBeNull())
    expect(screen.getByRole('button', { name: 'More for forge' })).toHaveFocus()
  })
})

describe('Stop starting at boot’s modal', () => {
  it('says the unit goes and the host restarts once outside it, and sends the change on the press', async () => {
    const user = userEvent.setup()
    const { bridge, command } = fixture([forge({ bootStart: on })], () => ({ boot: [change({ change: 'remove', phase: 'done', restarted: true })] }))
    settings(bridge)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Stop starting at boot…' }))
    const dialog = screen.getByRole('dialog', { name: 'Stop starting forge’s host at boot?' })
    expect(dialog).toHaveTextContent('Sotto removes sotto-host.service and its script from forge, and, while forge is switched on, restarts the host once outside the unit, so it keeps running.')
    expect(dialog).toHaveTextContent('After forge restarts, its host starts again only when this computer connects over SSH.')
    await user.click(within(dialog).getByRole('button', { name: 'Stop starting at boot' }))
    expect(boots(command)).toEqual([{ type: 'host-boot', id: FORGE, action: 'remove' }])
    const done = await screen.findByRole('dialog', { name: 'forge’s host no longer starts at boot' })
    expect(done).toHaveTextContent('It restarted once outside the unit and is connected again.')
    await user.click(within(done).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(boots(command).at(-1)).toEqual({ type: 'host-boot', id: FORGE, action: 'dismiss' }))
  })

  it('offers Keep starting at boot, which changes nothing', async () => {
    const user = userEvent.setup()
    const { bridge, command } = fixture([forge({ bootStart: on })])
    settings(bridge)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Stop starting at boot…' }))
    await user.click(screen.getByRole('button', { name: 'Keep starting at boot' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(boots(command)).toEqual([])
  })
})

describe('Stop host and Forget for a host that starts at boot', () => {
  it('says the host starts again when its machine restarts, and that Forget removes the unit', async () => {
    const user = userEvent.setup()
    const { bridge } = fixture([forge({ bootStart: on })])
    settings(bridge)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Stop host' }))
    expect(screen.getByRole('dialog', { name: 'Stop the host on forge?' })).toHaveTextContent('forge’s host stops now and starts again when forge restarts or when you switch it on.')
    await user.click(screen.getByRole('button', { name: 'Keep it running' }))
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Forget forge…' }))
    expect(screen.getByRole('dialog', { name: 'Forget forge?' })).toHaveTextContent('It removes start at boot from forge, so its host does not start again when forge restarts.')
  })

  it('says Forget removes start at boot from a host that is not connected too, since the row cannot know', async () => {
    const user = userEvent.setup()
    const { bridge } = fixture([forge({ phase: 'disconnected', enabled: false, owned: undefined, bootStart: undefined })])
    settings(bridge)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Forget forge…' }))
    expect(screen.getByRole('dialog', { name: 'Forget forge?' })).toHaveTextContent('If its host starts at boot, Sotto removes that too, so it does not start again when forge restarts.')
  })

  it('says Forget left the unit behind, with the command that removes it, beside the revoke’s own when both are needed', async () => {
    const bootCommand = 'B="$HOME/.local/share/sotto-host"/boot-start.sh; U="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/sotto-host.service"; grep -qxF "ExecStart=/bin/sh \\"$B\\"" "$U" && { systemctl --user disable --now sotto-host; }'
    const { bridge } = fixture([], () => ({}))
    const state: Partial<HostsState> = { forgotten: [{ id: FORGE, name: 'forge', bootCommand }] }
    const withNotice = { ...bridge, get: async () => ({ ...(await bridge.get()), ...state }) } as HostsBridge
    settings(withNotice)
    const notice = await screen.findByRole('status', { name: 'forge still starts at boot' })
    expect(notice).toHaveTextContent('Sotto removed forge from this computer but could not remove its start at boot unit there, so its host still starts when forge restarts. To remove the unit, run this on forge:')
    expect(within(notice).getByRole('region', { name: 'Command that removes start at boot on forge' })).toHaveTextContent(bootCommand)
    expect(within(notice).getByRole('button', { name: 'Dismiss what Sotto said about forge' })).toBeInTheDocument()
    cleanup()
    const both = { ...bridge, get: async () => ({ ...(await bridge.get()), forgotten: [{ id: FORGE, name: 'forge', revoke: { cause: 'refused' as const, command: 'node … --revoke-client "x"' }, bootCommand }] }) } as HostsBridge
    settings(both)
    const trusts = await screen.findByRole('status', { name: 'forge still trusts this computer' })
    expect(trusts).toHaveTextContent('forge’s host also still starts when forge restarts, since Sotto could not remove its start at boot unit there.')
    expect(within(trusts).getByRole('region', { name: 'Command to run on forge' })).toBeInTheDocument()
    expect(within(trusts).getByRole('region', { name: 'Command that removes start at boot on forge' })).toBeInTheDocument()
    expect(within(trusts).getAllByRole('button', { name: 'Dismiss what Sotto said about forge' })).toHaveLength(1)
  })
})

describe('Add host’s connected card', () => {
  it('offers one consented press that says what changes, then says it is done', async () => {
    const user = userEvent.setup()
    const { bridge, command } = fixture([])
    const { rerender } = render(<div className="hosts-settings"><HostBootOffer host={forge({ bootStart: lingerOff })} view={undefined} bridge={bridge} /></div>)
    expect(screen.getByText('Start forge’s host at boot', { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByText(/Sotto adds a systemd user unit for zach on forge and turns on linger for that account; the host restarts once now/u)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start forge’s host at boot' }))
    expect(boots(command)).toEqual([{ type: 'host-boot', id: FORGE, action: 'install' }])
    rerender(<div className="hosts-settings"><HostBootOffer host={forge()} view={change()} bridge={bridge} /></div>)
    expect(screen.getByRole('status')).toHaveTextContent('Installing the unit on forge. The host restarts once under it, and this computer connects again.')
    rerender(<div className="hosts-settings"><HostBootOffer host={forge({ bootStart: on })} view={change({ phase: 'done', restarted: true })} bridge={bridge} /></div>)
    expect(screen.getByRole('status')).toHaveTextContent('forge’s host starts at boot. It restarted once under its systemd unit and is connected again.')
  })

  it('keeps drawing the change while the restart it caused reconnects, when the row knows nothing of start at boot', () => {
    const { bridge } = fixture([])
    // A restart drops the connection, and with it what the row knew of start at boot, until the host connects again.
    const away = forge({ phase: 'connecting', reconnecting: true, bootStart: undefined })
    const { rerender } = render(<div className="hosts-settings"><HostBootOffer host={away} view={change()} bridge={bridge} /></div>)
    expect(screen.getByRole('status')).toHaveTextContent('Installing the unit on forge. The host restarts once under it, and this computer connects again.')
    rerender(<div className="hosts-settings"><HostBootOffer host={away} view={change({ phase: 'done', restarted: true })} bridge={bridge} /></div>)
    expect(screen.getByRole('status')).toHaveTextContent('forge’s host starts at boot. It restarted once under its systemd unit and Sotto is connecting to it again.')
    rerender(<div className="hosts-settings"><HostBootOffer host={away} view={change({ phase: 'failed', failure: { kind: 'failed', message: 'The unit did not bring forge’s host back, so Sotto took the unit away again.', fix: { text: 'To see why the unit failed, run this on forge:', command: 'journalctl --user -u sotto-host -n 50 --no-pager' } } })} bridge={bridge} /></div>)
    expect(screen.getByRole('alert')).toHaveTextContent('The unit did not bring forge’s host back, so Sotto took the unit away again.')
    expect(screen.getByText('journalctl --user -u sotto-host -n 50 --no-pager')).toBeInTheDocument()
  })

  it('says linger needs an administrator on the card, with the command, and offers the press again', async () => {
    const user = userEvent.setup()
    const { bridge, command } = fixture([])
    const failed = change({ phase: 'failed', failure: { kind: 'linger', message: 'forge would not turn on linger without an administrator.', fix: { text: 'Run this on forge, then press Start at boot again. Sotto never runs sudo.', command: 'sudo loginctl enable-linger zach' } } })
    render(<div className="hosts-settings"><HostBootOffer host={forge({ bootStart: lingerOff })} view={failed} bridge={bridge} /></div>)
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing changed on forge, and its host is still running as before. forge would not turn on linger without an administrator.')
    expect(screen.getByText('sudo loginctl enable-linger zach')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start forge’s host at boot' }))
    expect(boots(command)).toEqual([{ type: 'host-boot', id: FORGE, action: 'install' }])
  })

  it('says why a host cannot start at boot, and offers nothing for a host whose launch did not say', () => {
    const { bridge } = fixture([])
    const { container, rerender } = render(<HostBootOffer host={forge({ bootStart: { ...off, supported: false, reason: 'macos' } })} view={undefined} bridge={bridge} />)
    expect(container).toHaveTextContent('This host runs macOS')
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<HostBootOffer host={forge({ bootStart: undefined })} view={undefined} bridge={bridge} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the update panel for a host that starts at boot', () => {
  it('says its systemd unit restarts it, and that it still starts at boot', async () => {
    const user = userEvent.setup()
    const updates = [{ id: FORGE, name: 'forge', from: '0.1.22', to: '0.1.24', phase: 'needs' as const, owned: true, working: 0, commands: '# On forge:', boot: true }]
    const bridge = { get: async () => ({ hosts: [], localHostEnabled: true, localHostRunning: true, updates }), command: vi.fn(), onChanged: () => () => undefined } as unknown as HostsBridge
    render(<HostUpdateControl bridge={bridge} />)
    await user.click(await screen.findByRole('button', { name: 'Update for forge. Show host updates' }))
    expect(screen.getByRole('dialog', { name: 'Host updates' })).toHaveTextContent('Updating restarts its host through its systemd unit, so they are unavailable for a few seconds. It still starts at boot after.')
  })
})
