import type { HostService } from '../main/agents/hostService'
import type { PairedClients } from '../main/agents/pairing'
import type { SecureSettings } from '../main/agents/secureSettings'
import { PhoneAccess, type PhoneAccessEvent, type PhoneAccessPolicy, type PhoneAccessTailscale } from '../main/phones/phoneAccess'
import { TailscaleCli } from '../main/phones/tailscale'
import type { AppSettings } from '../shared/settings'
import type { HostPhonesCommand } from '../shared/phones'
import type { HostPhonesAdministration, HostPhonesAnswer } from './socketServer'

/**
 * A headless host's phone access (ADR-0050): the desktop's own phone access, run here over this host's service and
 * its one pairing store, so the iPhone reaches this host's threads through Tailscale Serve on this machine. The
 * `phoneAccess` setting lives in this host's settings, so the host puts Serve back each time it starts, on the
 * loopback port it remembers, and takes it away when it stops.
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
  readonly startup: Pick<AppSettings, 'phoneAccess' | 'phoneAccessName'>
  /** Tests and end-to-end runs stand in for this machine's Tailscale. */
  readonly tailscale?: PhoneAccessTailscale | undefined
  readonly log?: ((event: PhoneAccessEvent | 'phone-access-setting-failed') => void) | undefined
}

export interface HostPhoneAccess {
  readonly administration: HostPhonesAdministration
  close(): Promise<void>
}

const NO_PAGE = 'Tailscale did not give a page to open. Open the Tailscale admin console to turn on Serve.'
const NOT_SAVED = 'Phone access could not be saved on this host. Nothing was changed. Try again.'

export function startHostPhoneAccess(options: HostPhoneAccessOptions): HostPhoneAccess {
  let current = { phoneAccess: options.startup.phoneAccess, phoneAccessName: options.startup.phoneAccessName }
  const access = new PhoneAccess({
    directory: options.directory, service: options.service, pairing: options.pairing,
    tailscale: options.tailscale ?? new TailscaleCli(),
    settings: () => current, policy: options.policy,
    // A host has no browser. The desktop asks for the page with `open-serve-setup` and opens it itself.
    openExternal: async () => { throw new Error(NO_PAGE) },
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
  return {
    administration: { get: () => access.get(), command },
    close: async () => { await started; await access.close() },
  }
}
