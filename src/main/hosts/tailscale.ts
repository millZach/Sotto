import { networkInterfaces } from 'node:os'
import { tailscaleInvoker, type TailscaleInvoke } from '../phones/tailscale'
import type { SshHostSuggestion } from '../../shared/hosts'
import { TAILSCALE_DOWNLOAD_URL, type HostDevice, type HostDeviceList, type TailscaleConnectOutcome, type TailscaleSummary } from '../../shared/hostDevices'

/**
 * Tailscale on this computer, as Add host and the Hosts page use it: `tailscale status --json` for the
 * devices on the tailnet, and `tailscale up` when the user presses Connect to Tailscale. The CLI talks to
 * the local Tailscale service only, so none of this contacts a host of Sotto's own. The status, the
 * device names and any sign-in URL are parsed here, handed to the window or the browser, and never logged.
 */

/** A device on this computer's tailnet, as `tailscale status --json` describes it. */
export interface TailscalePeer {
  /** The MagicDNS name without its trailing dot, or '' when MagicDNS gives none. */
  readonly dnsName: string
  /** The name the device reports for itself, which an iPhone gives as `localhost`. */
  readonly hostName: string
  readonly os: string
  readonly online: boolean
  /** Tailscale SSH is on: the device publishes SSH host keys. */
  readonly ssh: boolean
  readonly lastSeen?: string
  readonly addresses: readonly string[]
}
/** `self` is this computer's full MagicDNS name and tailnet addresses, when it is running: the names that can only be this computer. */
export interface TailscaleReading { readonly summary: TailscaleSummary; readonly peers: readonly TailscalePeer[]; readonly self?: readonly string[] }

const OFF: TailscaleReading = { summary: { state: 'off' }, peers: [] }
const DNS_NAME = /^[A-Za-z0-9.-]{1,253}$/u
const ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})$/iu
/** An exit node Tailscale offers through Mullvad is on the tailnet but is nobody's machine. */
const MULLVAD = /\.mullvad\.ts\.net$/iu
/** Operating systems that cannot run the host. */
const PHONES = new Set(['ios', 'android'])
/** Loopback names and addresses: they reach this computer, or a VM through a port forwarded to it. */
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/u
/** Git hosting services people reach over SSH for repositories; an alias to one is an account there, not a machine that can run the host. */
const GIT_SERVICES = new Set(['github.com', 'ssh.github.com', 'gitlab.com', 'altssh.gitlab.com', 'bitbucket.org', 'altssh.bitbucket.org', 'ssh.dev.azure.com', 'vs-ssh.visualstudio.com', 'codeberg.org', 'git.sr.ht'])
const OS_WORDS: Record<string, string> = { linux: 'Linux', windows: 'Windows', macos: 'macOS', ios: 'iOS', android: 'Android', freebsd: 'FreeBSD', openbsd: 'OpenBSD', illumos: 'illumos', tvos: 'tvOS' }

const text = (value: unknown, limit = 253): string => typeof value === 'string' ? value.trim().slice(0, limit) : ''
/** A time Tailscale really recorded; it writes the zero time for a device it has never seen go offline. */
const seenAt = (value: unknown): string | undefined => {
  const at = text(value, 64)
  const time = Date.parse(at)
  return Number.isFinite(time) && new Date(time).getUTCFullYear() > 1970 ? new Date(time).toISOString() : undefined
}

function peer(value: unknown): TailscalePeer | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  const dns = text(item.DNSName).replace(/\.$/u, '')
  const dnsName = DNS_NAME.test(dns) ? dns : ''
  if (MULLVAD.test(dnsName)) return null
  const addresses = Array.isArray(item.TailscaleIPs) ? item.TailscaleIPs.map(address => text(address, 64)).filter(address => ADDRESS.test(address)) : []
  if (!dnsName && !addresses.length) return null
  const lastSeen = seenAt(item.LastSeen)
  return {
    dnsName, hostName: text(item.HostName, 63), os: text(item.OS, 32), online: item.Online === true,
    ssh: Array.isArray(item.sshHostKeys) && item.sshHostKeys.length > 0, addresses, ...(lastSeen ? { lastSeen } : {}),
  }
}

/**
 * Reads `tailscale status --json`. Only a node whose backend says Running lists devices; a stopped or
 * signed-out node, and output that is not a status at all (the service not answering), read as off.
 */
export function readTailscaleStatus(output: string): TailscaleReading {
  let value: unknown
  try { value = JSON.parse(output) } catch { return OFF }
  if (typeof value !== 'object' || value === null) return OFF
  const status = value as { BackendState?: unknown; Self?: { UserID?: unknown }; User?: Record<string, { LoginName?: unknown; DisplayName?: unknown } | undefined>; Peer?: Record<string, unknown> }
  if (status.BackendState !== 'Running') return OFF
  const peers = Object.values(status.Peer ?? {}).map(peer).filter((item): item is TailscalePeer => item !== null)
  const self = status.User?.[String(status.Self?.UserID)]
  const loginName = text(self?.LoginName, 128)
  const user = text(self?.DisplayName, 128) || loginName.split('@')[0]!
  const thisComputer = peer(status.Self)
  const own = thisComputer ? [...new Set([thisComputer.dnsName, ...thisComputer.addresses].filter(Boolean).map(lower))] : []
  return { summary: { state: 'running', user, loginName, deviceCount: peers.length }, peers, ...(own.length ? { self: own } : {}) }
}

const lower = (value: string): string => value.toLowerCase().replace(/\.$/u, '')
const label = (peer: TailscalePeer): string => peer.dnsName.split('.')[0] ?? ''
/** Every name a peer answers to, lower case: its MagicDNS name and label, its own host name and its addresses. */
const peerNames = (peer: TailscalePeer): string[] => [...new Set([peer.dnsName, label(peer), peer.hostName, ...peer.addresses].filter(Boolean).map(lower))]
/** The name the list shows: the device's own, unless it is not its tailnet name (an iPhone calls itself `localhost`). */
const peerName = (peer: TailscalePeer): string => !peer.hostName || (label(peer) && lower(peer.hostName) !== lower(label(peer))) ? label(peer) || peer.addresses[0]! : peer.hostName
const osWords = (os: string): string | undefined => os ? OS_WORDS[os.toLowerCase()] ?? os : undefined

type Draft = { -readonly [Key in keyof HostDevice]: HostDevice[Key] }

function peerDevice(item: TailscalePeer): Draft {
  const os = osWords(item.os)
  return {
    target: item.dnsName || item.addresses[0]!, name: peerName(item), names: peerNames(item), ...(os ? { os } : {}),
    tailscale: { online: item.online, ssh: item.ssh, ...(item.lastSeen && !item.online ? { lastSeen: item.lastSeen } : {}) },
    ...(PHONES.has(item.os.toLowerCase()) ? { unavailable: 'phone' as const } : item.online ? {} : { unavailable: 'offline' as const }),
  }
}

/**
 * One list from Tailscale's devices and the SSH setup. A configuration alias whose `HostName` (the alias
 * itself when it has none) is one of a device's names is the same machine: it shows once, with both tags,
 * and Sotto connects through the first such alias so the user's user and key settings apply. A known host that is
 * one of a device's names only adds its tag. Usable devices come first (online tailnet devices by name,
 * then the configuration in the order it is written, then known hosts); then the offline devices, most
 * recently seen first, and phones.
 */
export function mergeDevices(reading: TailscaleReading, suggestions: readonly SshHostSuggestion[], thisComputer: readonly string[] = []): HostDevice[] {
  const peers = reading.peers.map(item => ({ device: peerDevice(item), aliased: false }))
  // An SSH entry is this computer when where it goes is one of this computer's addresses or its full tailnet name.
  // A bare host name never counts, the alias least of all: two machines that kept a default name such as pop-os
  // share it, and only a lookup could say which one answers. Loopback never counts either: a VM such as Colima,
  // Lima or WSL is reached through a port forwarded to it, and is a machine of its own.
  // A jump is the other exception for an address. `ProxyJump bastion` with `HostName 192.168.1.10` connects to
  // that address from the bastion, which can be a different machine. Any `ProxyCommand` counts the same way, because
  // the command decides where the connection goes. The full tailnet name still names this computer, jump or not.
  // A Git service is that destination, not the alias: an entry named github.com can go to an ordinary computer.
  const own = new Set([...(reading.self ?? []), ...thisComputer].map(lower).filter(name => !LOOPBACK.test(name)))
  const unusable = (goesTo: string, jump = false): HostDevice['unavailable'] =>
    own.has(goesTo) && !(jump && ADDRESS.test(goesTo)) ? 'this-computer' : GIT_SERVICES.has(goesTo) ? 'git-service' : undefined
  const configured: HostDevice[] = []
  const known: HostDevice[] = []
  for (const suggestion of suggestions) {
    if (suggestion.source === 'config') {
      const goesTo = lower(suggestion.hostname ?? suggestion.alias)
      const match = peers.find(item => item.device.names.includes(goesTo))
      if (match) {
        // The first alias written for a device is the one Sotto connects through; a later one only adds a name
        // the device answers to, so the device still shows once.
        if (!match.aliased) Object.assign(match.device, { target: suggestion.alias, name: suggestion.alias, sshConfiguration: true })
        match.aliased = true
        match.device.names = [...new Set([...match.device.names, lower(suggestion.alias)])]
        continue
      }
      const names = [...new Set([suggestion.alias, suggestion.hostname ?? ''].filter(Boolean).map(lower))]
      const unavailable = unusable(goesTo, suggestion.jump === true)
      configured.push({ target: suggestion.alias, name: suggestion.alias, sshConfiguration: true, names, ...(suggestion.detail ? { detail: suggestion.detail } : {}), ...(unavailable ? { unavailable } : {}) })
      continue
    }
    const match = peers.find(item => item.device.names.includes(lower(suggestion.alias)))
    if (match) {
      match.device.knownHost = true
      // A port recorded for the tailnet name applies only while Sotto connects by that name, not through an alias.
      if (suggestion.port && !match.aliased) match.device.port = suggestion.port
      continue
    }
    const unavailable = unusable(lower(suggestion.alias))
    known.push({ target: suggestion.alias, name: suggestion.alias, knownHost: true, names: [lower(suggestion.alias)], ...(suggestion.port ? { port: suggestion.port } : {}), ...(suggestion.detail ? { detail: suggestion.detail } : {}), ...(unavailable ? { unavailable } : {}) })
  }
  const byName = (left: HostDevice, right: HostDevice): number => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  const devices: HostDevice[] = peers.map(item => item.device)
  const online = devices.filter(item => !item.unavailable).sort(byName)
  const offline = devices.filter(item => item.unavailable === 'offline').sort((left, right) => (right.tailscale?.lastSeen ?? '').localeCompare(left.tailscale?.lastSeen ?? '') || byName(left, right))
  const phones = devices.filter(item => item.unavailable === 'phone').sort(byName)
  const setup = [...configured, ...known]
  return [...online, ...setup.filter(item => !item.unavailable), ...offline, ...phones, ...setup.filter(item => item.unavailable)]
}

/** The sign-in page `tailscale up` prints, taken only once whitespace ends it so a half-printed URL is never opened. */
const SIGN_IN_URL = /(https:\/\/login\.tailscale\.com\/[A-Za-z0-9/?=&%._~-]+)\s/u
/** A sign-in on a control server other than Tailscale's own, which Sotto does not open. */
const OTHER_SIGN_IN = /To authenticate, visit:\s*https?:\/\/\S+\s/iu
/** How long `tailscale up` may wait for the sign-in to finish in the browser before it is stopped. */
const UP_LIMIT_MS = 10 * 60_000

export interface HostTailscaleOptions {
  readonly invoke?: TailscaleInvoke
  /** The SSH configuration and known hosts, read on each request so an alias added a moment ago is listed. */
  readonly suggestions: () => Promise<SshHostSuggestion[]>
  readonly openExternal: (url: string) => Promise<void>
  /** This computer's own addresses off the tailnet, read when Add host asks. */
  readonly thisComputer?: () => readonly string[]
}

/** The addresses of this computer's network interfaces. */
function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).map(entry => entry.address)).filter(Boolean)
}

/** One `tailscale up`, from the press that started it until the program ends. */
interface UpRun {
  /** The first answer: what the press that started the run is told. */
  readonly answer: Promise<TailscaleConnectOutcome>
  readonly stop: AbortController
  /** The sign-in page it printed, once that page has been opened or tried. */
  signInUrl?: string
  answered: boolean
}

/** Answers the Hosts page and Add host about Tailscale on this computer, and connects it when asked. */
export class HostTailscale {
  private readonly invoke: TailscaleInvoke
  private running: UpRun | null = null
  private disposed = false
  constructor(private readonly options: HostTailscaleOptions) { this.invoke = options.invoke ?? tailscaleInvoker() }

  async read(): Promise<TailscaleReading> {
    try {
      const result = await this.invoke(['status', '--json'], { timeoutMs: 10_000 })
      // A stopped or signed-out node still prints its status, with exit 1.
      return result === 'missing' ? { summary: { state: 'missing' }, peers: [] } : readTailscaleStatus(result.stdout)
    } catch { return OFF }
  }

  async status(): Promise<TailscaleSummary> { return (await this.read()).summary }

  async devices(): Promise<HostDeviceList> {
    const [reading, suggestions] = await Promise.all([this.read(), this.options.suggestions().catch(() => [])])
    return { tailscale: reading.summary, devices: mergeDevices(reading, suggestions, (this.options.thisComputer ?? localAddresses)()) }
  }

  /**
   * `tailscale up`, with no flags so the node keeps its own settings. When Tailscale answers with its
   * sign-in page, the page opens in the default browser, because the press asked for it, and the command
   * keeps running so the sign-in finishes; the answer comes back as soon as the page is open.
   *
   * Only one `tailscale up` runs at a time, for as long as the program runs, not just until it first
   * answers. A press while it waits for the sign-in opens the same page again rather than starting another,
   * which would open a second page and could replace the first sign-in.
   */
  connect(): Promise<TailscaleConnectOutcome> {
    if (this.disposed) return Promise.resolve('failed')
    const running = this.running
    if (!running) return this.up()
    return running.answered && running.signInUrl ? this.openSignIn(running.signInUrl) : running.answer
  }

  /** Stops a `tailscale up` that is still waiting for a sign-in, so none is left running once Sotto quits. */
  dispose(): void {
    this.disposed = true
    this.running?.stop.abort()
    this.running = null
  }

  private openSignIn(url: string): Promise<TailscaleConnectOutcome> {
    return this.options.openExternal(url).then(() => 'sign-in-opened' as const, () => 'sign-in-needed' as const)
  }

  private up(): Promise<TailscaleConnectOutcome> {
    const stop = new AbortController()
    let resolveAnswer!: (outcome: TailscaleConnectOutcome) => void
    const run: UpRun = { answer: new Promise(resolve => { resolveAnswer = resolve }), stop, answered: false }
    let decided = false
    const answer = (outcome: TailscaleConnectOutcome): void => {
      if (decided) return
      decided = true
      run.answered = true
      resolveAnswer(outcome)
    }
    const signIn = (url: string): void => {
      if (decided) return
      decided = true
      run.signInUrl = url
      void this.openSignIn(url).then(outcome => { run.answered = true; resolveAnswer(outcome) })
    }
    const watch = (output: string): void => {
      const url = SIGN_IN_URL.exec(output)?.[1]
      if (url) signIn(url)
      else if (OTHER_SIGN_IN.test(output)) answer('sign-in-needed')
    }
    this.running = run
    const ended = (): void => { if (this.running === run) this.running = null }
    this.invoke(['up'], { timeoutMs: UP_LIMIT_MS, watch, signal: stop.signal }).then(result => {
      ended()
      if (result === 'missing') return answer('missing')
      watch(`${result.stdout}\n${result.stderr}\n`)
      answer(result.code === 0 ? 'connected' : 'failed')
    }, () => { ended(); answer('failed') })
    return run.answer
  }

  /** Get Tailscale: Tailscale's download page, and no other. */
  async openDownload(): Promise<void> { await this.options.openExternal(TAILSCALE_DOWNLOAD_URL) }
}
