/**
 * The devices Add host lists, and Tailscale on this computer as the Hosts page shows it. Main reads both
 * (`tailscale status --json` and the SSH setup) and hands the window only these shapes; nothing here is
 * sent anywhere else or logged.
 */

export const HOSTS_DEVICES = 'hosts:devices'
export const HOSTS_TAILSCALE = 'hosts:tailscale'
export const HOSTS_TAILSCALE_CONNECT = 'hosts:tailscale-connect'
export const HOSTS_TAILSCALE_DOWNLOAD = 'hosts:tailscale-download'

/** Where Get Tailscale sends the browser. */
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

/**
 * Tailscale on this computer. `off` covers stopped, signed out and a Tailscale service that is not
 * answering: each is put right by Connect to Tailscale or by the Tailscale app.
 */
export type TailscaleSummary =
  | { readonly state: 'missing' }
  | { readonly state: 'off' }
  | {
      readonly state: 'running'
      /** The tailnet user's display name, such as `millZach`. */
      readonly user: string
      /** The account another device signs in with, such as `millZach@github`. */
      readonly loginName: string
      /** The other devices on the tailnet, this computer not counted. */
      readonly deviceCount: number
    }

/** What pressing Connect to Tailscale did. */
export type TailscaleConnectOutcome =
  /** Tailscale is up. */
  | 'connected'
  /** Tailscale asked for a sign-in, and its page opened in the default browser. */
  | 'sign-in-opened'
  /** Tailscale asked for a sign-in Sotto cannot open, such as one on another control server. */
  | 'sign-in-needed'
  | 'failed'
  | 'missing'

/**
 * Why a device is listed under "Can't use now". "Already added" is decided in the window, which knows the saved hosts.
 * `this-computer` is an SSH entry that goes to the computer Sotto runs on, whose host is the local one. A jump to an
 * address that matches one here is not: SSH connects to that address from the jump host. `git-service` is an SSH
 * entry whose destination is a Git host such as github.com, an account on a service rather than a machine.
 */
export type HostDeviceUnavailable = 'offline' | 'phone' | 'this-computer' | 'git-service'

/**
 * A machine Add host offers: a device on this computer's tailnet, an entry in the SSH configuration or
 * known hosts, or one device in more than one of them.
 */
export interface HostDevice {
  /** The SSH target Add host saves: the SSH alias when the configuration has one, so its user and key apply; else the device's MagicDNS name; else the known host. */
  readonly target: string
  /** What the list and the new host's row call it. */
  readonly name: string
  /** A known host recorded on a port other than 22. */
  readonly port?: number
  /** Where an SSH configuration alias goes, such as `zach@forge.example.net`, for an entry Tailscale does not describe. */
  readonly detail?: string
  /** The operating system in words (Linux, Windows, macOS, iOS, Android), from Tailscale. */
  readonly os?: string
  /** What this computer's Tailscale says about the device, when it is on the tailnet. */
  readonly tailscale?: {
    readonly online: boolean
    /** Tailscale SSH is on: the device published SSH host keys. */
    readonly ssh: boolean
    /** When an offline device was last seen, as an ISO time. */
    readonly lastSeen?: string
  }
  readonly sshConfiguration?: boolean
  readonly knownHost?: boolean
  readonly unavailable?: HostDeviceUnavailable
  /** Every name the device answers to (alias, MagicDNS name and label, host name, tailnet addresses), so the window can tell one is already a saved host. */
  readonly names: readonly string[]
}

export interface HostDeviceList {
  readonly tailscale: TailscaleSummary
  readonly devices: readonly HostDevice[]
}
