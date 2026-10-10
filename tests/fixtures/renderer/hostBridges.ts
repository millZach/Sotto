import { vi } from 'vitest'
import type { HostsBridge, HostsCommand, HostsState, HostStatus } from '../../../src/shared/hosts'
import type { PhonesBridge, PhonesCommand, PhonesState } from '../../../src/shared/phones'
import { publishedState } from './bridgePublication'

export function hostStatus(patch: Partial<HostStatus> = {}): HostStatus {
  return structuredClone({ id: '22222222-2222-4222-8222-222222222222', hostId: '22222222-2222-4222-8222-222222222222',
    name: 'Build box', target: 'build', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase: 'connected', enabled: true, ...patch })
}

export function hostsState(patch: Partial<HostsState> = {}): HostsState {
  return structuredClone({ localHostEnabled: true, localHostRunning: true, hosts: [], ...patch })
}

export function phonesState(patch: Partial<PhonesState> = {}): PhonesState {
  return structuredClone({ enabled: false, localHostRunning: true, phase: 'off', tailscale: { status: 'waiting' }, serve: { status: 'waiting' },
    servePort: null, address: null, computerName: 'LAPTOP-RUSSH2J5', defaultName: 'LAPTOP-RUSSH2J5', code: null, phones: [], answersAvailable: true, ...patch })
}

export function hostsBridgeFixture(options: { initial?: HostsState;
  answer?: (command: HostsCommand, state: HostsState) => HostsState | Promise<HostsState>;
  commands?: Partial<Omit<HostsBridge, 'onChanged'>> } = {}) {
  const publication = publishedState(options.initial ?? hostsState())
  const command = vi.fn<HostsBridge['command']>(async request => options.answer ? publication.set(await options.answer(request, publication.state())) : publication.state())
  const bridge: HostsBridge = {
    get: vi.fn<HostsBridge['get']>(async () => publication.state()), command, onChanged: publication.subscribe,
    devices: vi.fn<HostsBridge['devices']>(async () => ({ tailscale: { state: 'missing' }, devices: [] })), tailscale: vi.fn<HostsBridge['tailscale']>(async () => ({ state: 'missing' })),
    connectTailscale: vi.fn<HostsBridge['connectTailscale']>(), openTailscaleDownload: vi.fn<HostsBridge['openTailscaleDownload']>(), providerAction: vi.fn<HostsBridge['providerAction']>(async () => ({})),
    updateClients: vi.fn<HostsBridge['updateClients']>(async () => ({})), signIn: vi.fn<HostsBridge['signIn']>(async () => null), ...options.commands,
  }
  return { ...publication, bridge, command }
}

/** Local phone access and remote Hosts commands intentionally have separate bridges. */
export function phonesBridgeFixture(options: { initial?: PhonesState;
  answer?: (command: PhonesCommand, state: PhonesState) => PhonesState | Promise<PhonesState>;
  commands?: Partial<Omit<PhonesBridge, 'onChanged'>> } = {}) {
  const publication = publishedState(options.initial ?? phonesState())
  const command = vi.fn<PhonesBridge['command']>(async request => options.answer ? publication.set(await options.answer(request, publication.state())) : publication.state())
  const bridge: PhonesBridge = { get: vi.fn<PhonesBridge['get']>(async () => publication.state()), command, onChanged: publication.subscribe, ...options.commands }
  return { ...publication, bridge, command }
}
