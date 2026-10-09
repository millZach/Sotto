import { deferred } from '../deferred'
import { hostStatus, hostsBridgeFixture, hostsState } from './hostBridges'
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, vi } from 'vitest'
import { HostsSettings } from '../../../src/renderer/src/features/settings/HostsSettings'
import type { HostsBridge, HostsCommand, HostsState, HostStatus } from '../../../src/shared/hosts'
import type { HostDevice, TailscaleConnectOutcome, TailscaleSummary } from '../../../src/shared/hostDevices'

afterEach(cleanup)

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
  return hostStatus(patch)
}

/** A bridge whose state the test moves on, the way main's broadcasts do. */
function fixture(hosts: HostStatus[] = [host()], answer?: (command: HostsCommand, state: HostsState) => HostsState | Promise<HostsState>,
  options: { tailscale?: TailscaleSummary; connect?: () => Promise<TailscaleConnectOutcome> } = {}) {
  let tailscale = options.tailscale ?? RUNNING
  const devices = vi.fn(async () => ({ tailscale, devices: tailscale.state === 'running' ? DEVICES : sshOnly(DEVICES) }))
  const connectTailscale = vi.fn(options.connect ?? (async (): Promise<TailscaleConnectOutcome> => 'connected'))
  const openTailscaleDownload = vi.fn(async () => undefined)
  const made = hostsBridgeFixture({ initial: hostsState({ localHostId: LOCAL, activeHostId: LOCAL, hosts }), ...(answer ? { answer } : {}),
    commands: { devices, tailscale: vi.fn(async () => tailscale), connectTailscale, openTailscaleDownload } })
  const push = (next: Partial<HostsState>): void => { act(() => made.publish(next)) }
  return { bridge: made.bridge, command: made.command, push, state: made.state, devices, connectTailscale, openTailscaleDownload,
    setTailscale: (next: TailscaleSummary) => { tailscale = next } }
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

/** A saved host this computer has never paired with: it has no host ID yet. */
const neverPaired = (status: HostStatus): HostStatus => { const copy = { ...status }; delete copy.hostId; return copy }

/** A row's line saying how the host is connected and how it is, read whole: the connection is its own span. */
const rowMeta = (row: HTMLElement): string | null | undefined => row.querySelector('.hosts-row__meta')?.textContent

const settings = (bridge: HostsBridge) => render(<HostsSettings localHostEnabled onLocalHostChange={async () => true} bridge={bridge} />)

/** Adds forge from the form, and hands back the dialog, the add's ID and the press that ends the add. */
async function addForge(user: ReturnType<typeof userEvent.setup>, answer?: (command: HostsCommand, state: HostsState) => HostsState | Promise<HostsState>) {
  let resolveAdd: ((state: HostsState) => void) | undefined
  const made = fixture([], (input, current) => input.type === 'add' ? (() => { const pending = deferred<HostsState>(); resolveAdd = pending.resolve; return pending.promise })() : answer ? answer(input, current) : current)
  settings(made.bridge)
  const { dialog } = await openAddHost(user)
  await user.click(within(dialog).getByRole('option', { name: /^forge/ }))
  await user.click(within(dialog).getByRole('button', { name: 'Add host' }))
  const id = (made.command.mock.calls[0]![0] as Extract<HostsCommand, { type: 'add' }>).host.id
  const forge = (patch: Partial<HostStatus>) => host({ id, name: 'forge', target: 'forge', phase: 'connected', step: 'pair', ...patch })
  const steps = (): string[] => within(within(dialog).getByRole('list', { name: 'Connection steps' })).getAllByRole('listitem')
    .map(item => `${item.querySelector('[role="img"]')?.getAttribute('aria-label')}: ${item.querySelector('.host-setup__title')?.textContent}`)
  const finish = (): void => { delete made.state().adding; resolveAdd!(made.state()) }
  return { ...made, dialog, id, forge, steps, finish }
}

export { LOCAL, REMOTE, DAY, DEVICES, RUNNING, sshOnly, host, fixture, openAddHost, typeAHost, neverPaired, rowMeta, settings, addForge }
