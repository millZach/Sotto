import type { HostService } from '../main/agents/hostService'
import type { PairedClients } from '../main/agents/pairing'
import type { SecureSettings } from '../main/agents/secureSettings'
import { PhoneAccess, type PhoneAccessEvent, type PhoneAccessOptions, type PhoneAccessPolicy, type PhoneAccessTailscale } from '../main/phones/phoneAccess'
import { TailscaleCli } from '../main/phones/tailscale'
import type { AppSettings } from '../shared/settings'
import type { HostPhoneAccessSummary } from '../shared/hostProtocol'
import type { HostPhonesCommand, PhonesState } from '../shared/phones'
import type { DesktopClients } from './desktopClients'
import type { HostPhonesAdministration, HostPhonesAnswer, HostTailnetAnswer } from './socketServer'

/**
 * A headless host's phone access (ADR-0050): the desktop's own phone access, run here over this host's service and
 * its one pairing store, so the iPhone reaches this host's threads through Tailscale Serve on this machine. The
 * `phoneAccess` setting lives in this host's settings, so the host puts Serve back each time it starts, on the
 * loopback port it remembers, and takes it away when it stops.
 *
 * Its listener is the host's tailnet listener, which carries paired desktops' tailnet connections too (ADR-0053). The
 * host's own `tailnetConnections` setting keeps it, and Serve, up for them with phone access off. The launch script
 * records which clients are desktops; the host turns the setting off itself once the last of them is revoked, so Forget
 * leaves no Serve setting behind for desktops.
 *
 * Nothing here has a page. The desktop that reaches this host over SSH reads and changes it on the administrative
 * routes, and opens Tailscale's consent page, when there is one, on its own computer.
 */
export interface HostPhoneAccessOptions {
  readonly directory: string
  readonly service: HostService
  readonly pairing: PairedClients
  readonly policy?: PhoneAccessPolicy | undefined
  readonly settings: Pick<SecureSettings, 'update'>
  readonly startup: Pick<AppSettings, 'phoneAccess' | 'phoneAccessName' | 'tailnetConnections'>
  /** The clients the launch script recorded as desktops. */
  readonly desktops: DesktopClients
  /** What the tailnet listener takes for desktops besides: provider sign-in, client updates, the shared receipts, and what health says. */
  readonly listener?: Omit<NonNullable<PhoneAccessOptions['listener']>, 'desktops' | 'phoneAccess' | 'onRevoked'> | undefined
  /** Tests and end-to-end runs stand in for this machine's Tailscale. */
  readonly tailscale?: PhoneAccessTailscale | undefined
  readonly log?: ((event: PhoneAccessEvent | 'phone-access-setting-failed' | 'tailnet-connections-setting-failed' | 'tailnet-connections-off-failed') => void) | undefined
}

export interface HostPhoneAccess {
  readonly administration: HostPhonesAdministration
  /** The tailnet address, `https://<MagicDNS name>:<port>`, while Serve carries the tailnet listener, and nothing otherwise. */
  address(): string | undefined
  /** Phone access in the words the desktop's row uses, for a desktop's hello. */
  summary(): HostPhoneAccessSummary
  /** How many paired clients hold an open socket on the tailnet listener. */
  peers(): number
  /** Told the tailnet address whenever phone access or the listener changed, so the host can record a new one. */
  subscribe(listener: (address: string | undefined) => void): () => void
  /** Told after a client was revoked on either listener: a desktop leaves the record, and the last one turns `tailnetConnections` off. */
  revoked(clientId: string): void
  close(): Promise<void>
}

const NO_PAGE = 'Tailscale did not give a page to open. Open the Tailscale admin console to turn on Serve.'
const NOT_SAVED = 'Phone access could not be saved on this host. Nothing was changed. Try again.'
const TAILNET_NOT_SAVED = 'Tailnet connections could not be saved on this host. Nothing was changed. Try again.'

/** The tailnet address in a phone access state: there only while Serve carries the listener. */
const tailnetAddress = (state: Pick<PhonesState, 'phase' | 'address'>): string | undefined => state.phase === 'on' && state.address ? state.address : undefined

/** A phone access state in the row's words: off, starting, on with its paired phones, or that it needs the owner. */
export function phoneAccessSummary(state: Pick<PhonesState, 'enabled' | 'phase'> & { readonly phones: number }): HostPhoneAccessSummary {
  const { phones } = state
  if (!state.enabled) return { status: 'off', phones }
  if (state.phase === 'failed' || state.phase === 'cleanup-failed') return { status: 'needs-you', phones }
  if (state.phase === 'starting') return { status: 'starting', phones }
  return { status: state.phase === 'on' ? 'on' : 'off', phones }
}

export function startHostPhoneAccess(options: HostPhoneAccessOptions): HostPhoneAccess {
  let current = { phoneAccess: options.startup.phoneAccess, phoneAccessName: options.startup.phoneAccessName, tailnetConnections: options.startup.tailnetConnections }
  let revoking: Promise<void> = Promise.resolve()
  const revoked = (clientId: string): void => {
    revoking = revoking.then(async () => {
      const left = await options.desktops.remove(clientId)
      // Only a desktop's revocation counts, and a record that cannot be read says nothing about who is left: either way
      // the setting stays as the owner set it.
      if (!left || !current.tailnetConnections) return
      if (options.pairing.list().some(client => left.has(client.clientId))) return
      if ((await setTailnet(false)).error) options.log?.('tailnet-connections-off-failed')
    }).catch(() => options.log?.('tailnet-connections-off-failed'))
  }
  const access: PhoneAccess = new PhoneAccess({
    directory: options.directory, service: options.service, pairing: options.pairing,
    tailscale: options.tailscale ?? new TailscaleCli(),
    settings: () => current, policy: options.policy,
    // A host has no browser. The desktop asks for the page with `open-serve-setup` and opens it itself.
    openExternal: async () => { throw new Error(NO_PAGE) },
    listener: { ...options.listener, desktops: options.desktops, phoneAccess: (): HostPhoneAccessSummary => phoneAccessSummary(access.brief()), onRevoked: revoked },
    ...(options.log ? { log: options.log } : {}),
  })
  // Tailscale's checks take seconds, so they run beside the host's start rather than in front of it.
  const started = access.start().catch(() => options.log?.('phone-access-start-failed'))
  const command = async (request: HostPhonesCommand): Promise<HostPhonesAnswer> => {
    await started
    if (request.type === 'set-enabled') {
      try { await options.settings.update({ phoneAccess: request.enabled }) }
      catch { options.log?.('phone-access-setting-failed'); return { state: access.get(), error: NOT_SAVED } }
      current = { ...current, phoneAccess: request.enabled }
      access.settingsChanged()
      return { state: access.get() }
    }
    if (request.type === 'open-serve-setup') {
      const url = access.serveSetupUrl()
      return url ? { state: access.get(), url } : { state: access.get(), error: NO_PAGE }
    }
    // Each refusal is a sentence written for the owner: that a phone is gone, that a code needs phone access on.
    try { return { state: await access.command(request) } }
    catch (error) { return { state: access.get(), error: error instanceof Error ? error.message : 'Phone access could not be changed. Nothing was changed. Try again.' } }
  }
  /** Turns tailnet connections on or off and waits for Serve to follow, so the answer says how it came out. */
  async function setTailnet(enabled: boolean): Promise<HostTailnetAnswer> {
    await started
    if (current.tailnetConnections !== enabled) {
      try { await options.settings.update({ tailnetConnections: enabled }) }
      catch { options.log?.('tailnet-connections-setting-failed'); return { enabled: current.tailnetConnections, state: access.get(), error: TAILNET_NOT_SAVED } }
      current = { ...current, tailnetConnections: enabled }
      access.settingsChanged()
    }
    await access.settled()
    return { enabled: current.tailnetConnections, state: access.get() }
  }
  const tailnet = async (request: { readonly enabled?: boolean | undefined }): Promise<HostTailnetAnswer> => {
    if (request.enabled !== undefined) return setTailnet(request.enabled)
    // A revocation still deciding whether it was the last desktop's is part of what the setting is now.
    await started; await revoking
    return { enabled: current.tailnetConnections, state: access.get() }
  }
  return {
    administration: { get: () => access.get(), command, tailnet },
    // Health reads these on every request, unmetered, so they skip the per-phone policy lookups `get()` makes.
    address: () => tailnetAddress(access.brief()),
    summary: () => phoneAccessSummary(access.brief()),
    peers: () => access.peers(),
    subscribe: listener => access.subscribe(state => listener(tailnetAddress(state))),
    revoked,
    close: async () => { await started; await revoking; await access.close() },
  }
}
