// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { HostTailscale, mergeDevices, readTailscaleStatus } from '../../../src/main/hosts/tailscale'
import type { TailscaleInvoke, TailscaleRunOptions, TailscaleRunResult } from '../../../src/main/phones/tailscale'
import type { SshHostSuggestion } from '../../../src/shared/hosts'
import { TAILSCALE_NEEDS_LOGIN, TAILSCALE_NO_PEERS, TAILSCALE_NOT_ANSWERING, TAILSCALE_RUNNING, TAILSCALE_STOPPED } from '../../fixtures/tailscaleStatus'
import { deferred } from '../../fixtures/deferred'

const SSH: SshHostSuggestion[] = [
  { alias: 'forge', source: 'config', detail: 'zach@forge.tail5728ca.ts.net', hostname: 'forge.tail5728ca.ts.net' },
  { alias: 'pihole', source: 'config', detail: 'pi@100.64.0.5', hostname: '100.64.0.5' },
  { alias: 'spark', source: 'config', detail: 'zach@spark.lan', hostname: 'spark.lan' },
  { alias: 'buildbox.example.net', source: 'known-hosts', port: 2200, detail: 'buildbox.example.net:2200' },
  { alias: 'omarchy', source: 'known-hosts' },
]

describe('reading tailscale status --json', () => {
  it('lists the other devices on a running tailnet, leaving out this computer and Mullvad exit nodes', () => {
    const reading = readTailscaleStatus(TAILSCALE_RUNNING)
    expect(reading.summary).toEqual({ state: 'running', user: 'millZach', loginName: 'millZach@github', deviceCount: 5 })
    expect(reading.peers.map(peer => peer.dnsName).sort()).toEqual(['desktop-8npfsbm.tail5728ca.ts.net', 'forge.tail5728ca.ts.net', 'iphone-15-pro.tail5728ca.ts.net', 'omarchy.tail5728ca.ts.net', 'pihole.tail5728ca.ts.net'])
    expect(reading.peers.find(peer => peer.hostName === 'forge')).toEqual({ dnsName: 'forge.tail5728ca.ts.net', hostName: 'forge', os: 'linux', online: true, ssh: true, addresses: ['100.64.0.4', 'fd7a:115c:a1e0::4'] })
    // Tailscale writes the zero time for "never"; only a real time is kept.
    expect(reading.peers.find(peer => peer.hostName === 'omarchy')?.lastSeen).toBe('2026-09-19T04:52:53.100Z')
    expect(reading.peers.find(peer => peer.hostName === 'pihole')).toMatchObject({ ssh: false, online: true })
  })
  it('reads a tailnet with no other devices as running with none, knowing this computer’s tailnet name and addresses', () => {
    expect(readTailscaleStatus(TAILSCALE_NO_PEERS)).toEqual({
      summary: { state: 'running', user: 'millZach', loginName: 'millZach@github', deviceCount: 0 }, peers: [],
      self: ['laptop-russh2j5.tail5728ca.ts.net', '100.64.0.1', 'fd7a:115c:a1e0::1'],
    })
  })
  it('reads stopped, signed out and a service that is not answering as off, with no devices', () => {
    for (const output of [TAILSCALE_STOPPED, TAILSCALE_NEEDS_LOGIN, TAILSCALE_NOT_ANSWERING, '', 'null']) expect(readTailscaleStatus(output)).toEqual({ summary: { state: 'off' }, peers: [] })
  })
  it('keeps a name that could carry anything but a DNS name out of the target', () => {
    const odd = JSON.stringify({ BackendState: 'Running', Peer: { a: { DNSName: 'evil host/path.', HostName: 'evil', TailscaleIPs: ['100.64.0.9', 'not an address'], Online: true } } })
    expect(readTailscaleStatus(odd).peers).toEqual([{ dnsName: '', hostName: 'evil', os: '', online: true, ssh: false, addresses: ['100.64.0.9'] }])
    expect(mergeDevices(readTailscaleStatus(odd), [])[0]).toMatchObject({ target: '100.64.0.9', name: 'evil' })
  })
})

describe('merging Tailscale with the SSH setup', () => {
  it('shows a machine in both once, connects through its alias, and orders usable machines first', () => {
    const devices = mergeDevices(readTailscaleStatus(TAILSCALE_RUNNING), SSH)
    expect(devices.map(device => [device.name, device.target, device.unavailable ?? 'usable'])).toEqual([
      ['forge', 'forge', 'usable'],
      ['pihole', 'pihole', 'usable'],
      ['spark', 'spark', 'usable'],
      ['buildbox.example.net', 'buildbox.example.net', 'usable'],
      // Offline, most recently seen first; then phones.
      ['omarchy', 'omarchy.tail5728ca.ts.net', 'offline'],
      ['DESKTOP-8NPFSBM', 'desktop-8npfsbm.tail5728ca.ts.net', 'offline'],
      ['iphone-15-pro', 'iphone-15-pro.tail5728ca.ts.net', 'phone'],
    ])
    const [forge, pihole, spark, buildbox, omarchy] = devices
    expect(forge).toEqual({ target: 'forge', name: 'forge', os: 'Linux', tailscale: { online: true, ssh: true }, sshConfiguration: true,
      names: ['forge.tail5728ca.ts.net', 'forge', '100.64.0.4', 'fd7a:115c:a1e0::4'] })
    // Matched on the address the configuration's HostName gives.
    expect(pihole).toMatchObject({ target: 'pihole', sshConfiguration: true, tailscale: { online: true, ssh: false } })
    expect(spark).toEqual({ target: 'spark', name: 'spark', sshConfiguration: true, detail: 'zach@spark.lan', names: ['spark', 'spark.lan'] })
    expect(buildbox).toEqual({ target: 'buildbox.example.net', name: 'buildbox.example.net', knownHost: true, port: 2200, detail: 'buildbox.example.net:2200', names: ['buildbox.example.net'] })
    // A known host that is a tailnet device only adds its tag.
    expect(omarchy).toMatchObject({ knownHost: true, tailscale: { online: false, ssh: true, lastSeen: '2026-09-19T04:52:53.100Z' } })
  })
  it('matches an alias with no HostName by the alias itself, and a HostName in another case or with the root dot', () => {
    const reading = readTailscaleStatus(TAILSCALE_RUNNING)
    expect(mergeDevices(reading, [{ alias: 'forge', source: 'config' }])[0]).toMatchObject({ target: 'forge', sshConfiguration: true, tailscale: { online: true } })
    expect(mergeDevices(reading, [{ alias: 'box', source: 'config', hostname: 'Forge.Tail5728ca.ts.net.' }])[0]).toMatchObject({ target: 'box', name: 'box', sshConfiguration: true, os: 'Linux' })
  })
  it('folds a second alias for the same device into it, connecting through the first', () => {
    const devices = mergeDevices(readTailscaleStatus(TAILSCALE_RUNNING), [
      { alias: 'lab', source: 'config', hostname: 'omarchy.tail5728ca.ts.net' },
      { alias: 'lab-root', source: 'config', detail: 'root@omarchy', hostname: 'omarchy' },
    ])
    const omarchy = devices.filter(device => device.names.includes('omarchy'))
    expect(omarchy).toHaveLength(1)
    expect(omarchy[0]).toMatchObject({ target: 'lab', name: 'lab', sshConfiguration: true, unavailable: 'offline' })
    expect(omarchy[0]!.names).toEqual(expect.arrayContaining(['lab', 'lab-root']))
    expect(devices.some(device => device.name === 'lab-root')).toBe(false)
  })
  it('lists the SSH setup alone when Tailscale is off or missing', () => {
    const devices = mergeDevices(readTailscaleStatus(TAILSCALE_STOPPED), SSH)
    expect(devices.map(device => device.name)).toEqual(['forge', 'pihole', 'spark', 'buildbox.example.net', 'omarchy'])
    expect(devices.every(device => device.tailscale === undefined && device.unavailable === undefined)).toBe(true)
  })
})

/** A CLI that answers each command from a script, the way `tailscaleInvoker` would. */
function cli(answers: Record<string, (options: TailscaleRunOptions) => Promise<Awaited<ReturnType<TailscaleInvoke>>>>) {
  return vi.fn<TailscaleInvoke>(async (args, options) => {
    const answer = answers[args.join(' ')]
    if (!answer) throw new Error(`unexpected tailscale ${args.join(' ')}`)
    return answer(options)
  })
}
const done = (code: number, stdout = '', stderr = '') => async () => ({ code, stdout, stderr })

describe('what Add host cannot use: this computer and Git services', () => {
  it('greys out an SSH entry that goes to this computer: one of its addresses or its full tailnet name', () => {
    const devices = mergeDevices(readTailscaleStatus(TAILSCALE_RUNNING), [
      // This computer's tailnet address and full MagicDNS name, from the Self entry of the status.
      { alias: 'laptop', source: 'config', detail: 'zach@100.64.0.1', hostname: '100.64.0.1' },
      { alias: 'desk', source: 'config', hostname: 'Laptop-RUSSH2J5.tail5728ca.ts.net.' },
      // A known host that is one of this computer's own interface addresses.
      { alias: '192.168.1.180', source: 'known-hosts' },
      { alias: 'spark', source: 'config', detail: 'zach@spark.lan', hostname: 'spark.lan' },
    ], ['192.168.1.180'])
    expect(devices.filter(device => device.unavailable === 'this-computer').map(device => device.target)).toEqual(['laptop', 'desk', '192.168.1.180'])
    expect(devices.find(device => device.target === 'spark')?.unavailable).toBeUndefined()
  })
  it('never decides by a name only a lookup could place: an alias or known host that shares this computer’s host name stays usable', () => {
    // Two machines that kept a default host name such as pop-os: the alias is the user's label, and the
    // HostName is where SSH goes. Neither the host name nor Self's short names say which machine answers.
    const devices = mergeDevices(readTailscaleStatus(TAILSCALE_RUNNING), [
      { alias: 'laptop-russh2j5', source: 'config', detail: 'zach@192.168.1.11', hostname: '192.168.1.11' },
      { alias: 'pop-os', source: 'config' },
      { alias: 'LAPTOP-RUSSH2J5', source: 'known-hosts' },
    ], ['192.168.1.180'])
    const setup = devices.filter(device => ['laptop-russh2j5', 'pop-os', 'LAPTOP-RUSSH2J5'].includes(device.target))
    expect(setup.map(device => [device.target, device.unavailable])).toEqual([['laptop-russh2j5', undefined], ['pop-os', undefined], ['LAPTOP-RUSSH2J5', undefined]])
  })
  it('keeps an alias to a loopback address usable: a VM such as Colima is reached through a port forwarded there', () => {
    const devices = mergeDevices(readTailscaleStatus(TAILSCALE_STOPPED), [
      { alias: 'colima', source: 'config', hostname: '127.0.0.1' },
      { alias: 'lima-box', source: 'config', hostname: 'localhost' },
      { alias: '::1', source: 'known-hosts' },
    ], ['127.0.0.1', '::1', 'localhost'])
    expect(devices.map(device => device.unavailable)).toEqual([undefined, undefined, undefined])
  })
  it('keeps a jump to an address on this computer selectable, and still greys a direct alias to this computer', () => {
    const devices = mergeDevices(readTailscaleStatus(TAILSCALE_RUNNING), [
      // HostName is an address on this computer, but SSH connects to it from the bastion.
      { alias: 'through-bastion', source: 'config', hostname: '192.168.1.10', jump: true },
      { alias: 'this-box', source: 'config', hostname: '192.168.1.10' },
      // The full tailnet name still names this computer, whichever path SSH takes to it.
      { alias: 'named', source: 'config', hostname: 'laptop-russh2j5.tail5728ca.ts.net', jump: true },
    ], ['192.168.1.10'])
    const picked = ['through-bastion', 'this-box', 'named'].map(target => devices.find(device => device.target === target))
    expect(picked.map(device => [device?.target, device?.unavailable])).toEqual([
      ['through-bastion', undefined],
      ['this-box', 'this-computer'],
      ['named', 'this-computer'],
    ])
  })
  it('greys out an SSH entry that goes to a Git service, which is not a computer', () => {
    const devices = mergeDevices(readTailscaleStatus(TAILSCALE_STOPPED), [
      { alias: 'github-hermetic', source: 'config', detail: 'git@github.com', hostname: 'github.com' },
      { alias: 'gitlab.com', source: 'known-hosts' },
      { alias: 'forge', source: 'config', detail: 'zach@forge.tail5728ca.ts.net', hostname: 'forge.tail5728ca.ts.net' },
    ])
    expect(devices.map(device => [device.target, device.unavailable])).toEqual([['forge', undefined], ['github-hermetic', 'git-service'], ['gitlab.com', 'git-service']])
  })
  it('greys a Git service by the host SSH connects to, so an alias named github.com can still be a computer', () => {
    const devices = mergeDevices(readTailscaleStatus(TAILSCALE_STOPPED), [
      { alias: 'github.com', source: 'config', detail: 'zach@spark.lan', hostname: 'spark.lan' },
      { alias: 'github-personal', source: 'config', detail: 'git@github.com', hostname: 'github.com' },
      // No HostName: SSH connects to the alias itself, which is the service.
      { alias: 'gitlab.com', source: 'config' },
      { alias: 'gh-via-bastion', source: 'config', hostname: 'github.com', jump: true },
    ])
    expect(devices.map(device => [device.target, device.unavailable])).toEqual([
      ['github.com', undefined],
      ['github-personal', 'git-service'],
      ['gitlab.com', 'git-service'],
      ['gh-via-bastion', 'git-service'],
    ])
  })
  it('hands Add host the addresses this computer has', async () => {
    const tailscale = new HostTailscale({ invoke: async () => 'missing', suggestions: async () => [{ alias: 'sun', source: 'config', hostname: '10.10.100.235' }], openExternal: vi.fn(), thisComputer: () => ['10.10.100.235'] })
    expect((await tailscale.devices()).devices).toEqual([expect.objectContaining({ target: 'sun', unavailable: 'this-computer' })])
  })
  it('still lists the devices when this computer cannot say its addresses', async () => {
    const tailscale = new HostTailscale({ invoke: async () => 'missing', suggestions: async () => [{ alias: 'sun', source: 'config', hostname: '10.10.100.235' }], openExternal: vi.fn(), thisComputer: () => { throw new Error('uv_interface_addresses') } })
    const devices = (await tailscale.devices()).devices
    expect(devices.map(device => [device.target, device.unavailable])).toEqual([['sun', undefined]])
  })
})

describe('Tailscale on this computer', () => {
  it('reads the status and the SSH setup together for Add host', async () => {
    const invoke = cli({ 'status --json': done(0, TAILSCALE_RUNNING) })
    const tailscale = new HostTailscale({ invoke, suggestions: async () => SSH, openExternal: vi.fn() })
    const list = await tailscale.devices()
    expect(list.tailscale).toEqual({ state: 'running', user: 'millZach', loginName: 'millZach@github', deviceCount: 5 })
    expect(list.devices).toHaveLength(7)
    expect(invoke).toHaveBeenCalledWith(['status', '--json'], { timeoutMs: 10_000 })
  })
  it('still lists the SSH setup when Tailscale is not installed or the SSH files cannot be read', async () => {
    const missing = new HostTailscale({ invoke: async () => 'missing', suggestions: async () => SSH, openExternal: vi.fn() })
    expect(await missing.devices()).toMatchObject({ tailscale: { state: 'missing' }, devices: expect.arrayContaining([expect.objectContaining({ name: 'forge', sshConfiguration: true })]) })
    const unreadable = new HostTailscale({ invoke: cli({ 'status --json': done(1, TAILSCALE_NEEDS_LOGIN) }), suggestions: async () => { throw new Error('EACCES') }, openExternal: vi.fn() })
    expect(await unreadable.devices()).toEqual({ tailscale: { state: 'off' }, devices: [] })
    const broken = new HostTailscale({ invoke: async () => { throw new Error('EPERM') }, suggestions: async () => [], openExternal: vi.fn() })
    expect(await broken.status()).toEqual({ state: 'off' })
  })

  it('opens the sign-in page tailscale up prints, once the whole URL is printed, and answers while the sign-in goes on', async () => {
    let finish: (() => void) | undefined
    const openExternal = vi.fn(async () => undefined)
    const invoke = cli({ up: options => {
      const pending = deferred<TailscaleRunResult>()
      options.watch?.('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/1a2')
      options.watch?.('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/1a2b3c\n\n')
      finish = () => pending.resolve({ code: 0, stdout: 'Success.\n', stderr: '' })
      return pending.promise
    } })
    const tailscale = new HostTailscale({ invoke, suggestions: async () => [], openExternal })
    expect(await tailscale.connect()).toBe('sign-in-opened')
    expect(openExternal.mock.calls).toEqual([['https://login.tailscale.com/a/1a2b3c']])
    expect(invoke.mock.calls[0]![0]).toEqual(['up'])
    expect(invoke.mock.calls[0]![1].timeoutMs).toBe(600_000)
    finish!()
  })
  it('does not open a sign-in page on another control server, and says the sign-in is needed', async () => {
    const openExternal = vi.fn(async () => undefined)
    const invoke = cli({ up: done(1, '\nTo authenticate, visit:\n\n\thttps://headscale.example.net/register/abc\n\n') })
    expect(await new HostTailscale({ invoke, suggestions: async () => [], openExternal }).connect()).toBe('sign-in-needed')
    expect(openExternal).not.toHaveBeenCalled()
  })
  it('answers connected, failed or missing from how tailscale up ends, and answers two presses at once from one run', async () => {
    const make = (answer: Parameters<typeof cli>[0]['up']) => new HostTailscale({ invoke: cli({ up: answer! }), suggestions: async () => [], openExternal: vi.fn() })
    expect(await make(done(0)).connect()).toBe('connected')
    expect(await make(done(1, '', 'backend error: access denied')).connect()).toBe('failed')
    expect(await make(async () => { throw new Error('EPERM') }).connect()).toBe('failed')
    expect(await new HostTailscale({ invoke: async () => 'missing', suggestions: async () => [], openExternal: vi.fn() }).connect()).toBe('missing')
    const invoke = cli({ up: done(0) })
    const tailscale = new HostTailscale({ invoke, suggestions: async () => [], openExternal: vi.fn() })
    expect(await Promise.all([tailscale.connect(), tailscale.connect()])).toEqual(['connected', 'connected'])
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('keeps one tailscale up while the sign-in goes on: a second press opens the same page again', async () => {
    let finish: (() => void) | undefined
    const openExternal = vi.fn(async () => undefined)
    const invoke = cli({ up: options => {
      const pending = deferred<TailscaleRunResult>()
      options.watch?.('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/first\n\n')
      finish = () => pending.resolve({ code: 0, stdout: 'Success.\n', stderr: '' })
      return pending.promise
    } })
    const tailscale = new HostTailscale({ invoke, suggestions: async () => [], openExternal })
    expect(await tailscale.connect()).toBe('sign-in-opened')
    expect(await tailscale.connect()).toBe('sign-in-opened')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(openExternal.mock.calls).toEqual([['https://login.tailscale.com/a/first'], ['https://login.tailscale.com/a/first']])
    // Once the sign-in finishes and the program ends, the next press starts a new tailscale up.
    finish!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await tailscale.connect()).toBe('sign-in-opened')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('stops a tailscale up still waiting for the sign-in when Sotto closes, and starts no other', async () => {
    let signal: AbortSignal | undefined
    const invoke = cli({ up: options => new Promise(resolve => {
      signal = options.signal
      options.watch?.('To authenticate, visit:\n\thttps://login.tailscale.com/a/xyz\n')
      options.signal?.addEventListener('abort', () => resolve({ code: null, stdout: '', stderr: '' }))
    }) })
    const tailscale = new HostTailscale({ invoke, suggestions: async () => [], openExternal: vi.fn(async () => undefined) })
    expect(await tailscale.connect()).toBe('sign-in-opened')
    expect(signal?.aborted).toBe(false)
    tailscale.dispose()
    expect(signal?.aborted).toBe(true)
    expect(await tailscale.connect()).toBe('failed')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('says the sign-in is needed when the browser does not open', async () => {
    const invoke = cli({ up: options => { options.watch?.('To authenticate, visit:\n\thttps://login.tailscale.com/a/xyz\n'); return new Promise(() => undefined) } })
    expect(await new HostTailscale({ invoke, suggestions: async () => [], openExternal: async () => { throw new Error('no browser') } }).connect()).toBe('sign-in-needed')
  })
  it('opens Tailscale’s download page for Get Tailscale', async () => {
    const openExternal = vi.fn(async () => undefined)
    await new HostTailscale({ invoke: async () => 'missing', suggestions: async () => [], openExternal }).openDownload()
    expect(openExternal).toHaveBeenCalledWith('https://tailscale.com/download')
  })
})
