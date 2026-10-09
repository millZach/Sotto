import { z } from 'zod'

export const PHONES_GET = 'phones:get'
export const PHONES_COMMAND = 'phones:command'
export const PHONES_CHANGED = 'phones:changed'

/**
 * The Tailscale Serve ports phone access may use: 8443, or 10000 when another app already holds 8443. Setup
 * tries the port it last used first, so phones keep their address. 443 is left to other apps (ADR-0033). Serve offers HTTPS on these three only.
 */
export const PHONE_ACCESS_SERVE_PORTS = [8443, 10000] as const
export type PhoneAccessServePort = (typeof PHONE_ACCESS_SERVE_PORTS)[number]

/** The first row of the Phones checklist: whether Tailscale is up on this computer. */
export type TailscaleCheck =
  | { readonly status: 'waiting' }
  | { readonly status: 'ok'; readonly hostName: string; readonly dnsName: string }
  | { readonly status: 'failed'; readonly reason: 'missing' | 'not-running' }

/** The second row: whether Sotto's Tailscale Serve setting, on 8443 or 10000, is in place. */
export type ServeCheck =
  | { readonly status: 'waiting' }
  | { readonly status: 'ok' }
  | {
      readonly status: 'failed'
      /**
       * `port-taken`: ports 8443 and 10000 both carry another app's Serve setting, which Sotto leaves alone.
       * `not-enabled`: the tailnet has not turned Serve on; `canOpenSetup` says whether Sotto has the page that turns it on.
       * `cleanup`: phones cannot connect while Sotto finishes removing its Serve setting.
       * `cleanup-record`: cleanup cannot identify an occupied setting because its saved record is unreadable.
       * `record`: setup stopped because Sotto could not save its cleanup record.
       * `denied`: Tailscale refused to let this account change Serve, as Linux does until the account is its operator.
       * `listener`: Sotto could not open its own loopback listener. `failed`: the serve command failed some other way.
       */
      readonly reason: 'port-taken' | 'not-enabled' | 'denied' | 'listener' | 'failed' | 'cleanup' | 'cleanup-record' | 'record'
      readonly canOpenSetup?: boolean | undefined
    }

export interface PairedPhone {
  readonly clientId: string
  /** As the phone sent it when it paired. */
  readonly name: string
  readonly pairedAt: string
  /** Holds an open socket now. */
  readonly connected: boolean
  /** A policy record lets this phone's answers count (ADR-0004). */
  readonly canAnswer: boolean
}

export interface PhonesState {
  /** The `phoneAccess` setting. */
  readonly enabled: boolean
  /** Phone access serves the local host's threads, so it needs the local host running. */
  readonly localHostRunning: boolean
  /**
   * `starting` checks setup; `on` means the listener is up and Serve carries it, admitting phones only while `enabled` (a
   * headless host keeps it up for desktops with phone access off, ADR-0053); `failed` stops setup; `cleanup-failed` denies
   * connections while cleanup retries.
   */
  readonly phase: 'off' | 'starting' | 'on' | 'failed' | 'cleanup-failed'
  readonly tailscale: TailscaleCheck
  readonly serve: ServeCheck
  /**
   * The Serve port phones use: 8443, or 10000 when another app held 8443 when Sotto chose. Null until Sotto has chosen; absent from
   * a host from before the 10000 fallback, which only ever uses 8443.
   */
  readonly servePort?: PhoneAccessServePort | null | undefined
  /** `https://<name>.<tailnet>.ts.net:8443` (or `:10000`), once Serve is in place. */
  readonly address: string | null
  /** The name phones show for this computer: the setting, or `defaultName` when it is empty. */
  readonly computerName: string
  readonly defaultName: string
  /** The one live pairing code, if any. It lives in memory only and is never logged. */
  readonly code: { readonly code: string; readonly expiresAt: string } | null
  readonly phones: readonly PairedPhone[]
  /** False when this computer's permission policies cannot be read, so Can answer cannot be turned on. */
  readonly answersAvailable: boolean
}

export const phonesCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('retry') }).strict(),
  z.object({ type: z.literal('show-code') }).strict(),
  z.object({ type: z.literal('cancel-code') }).strict(),
  z.object({ type: z.literal('set-can-answer'), clientId: z.string().min(1).max(512), allowed: z.boolean() }).strict(),
  z.object({ type: z.literal('remove'), clientId: z.string().min(1).max(512) }).strict(),
  z.object({ type: z.literal('open-serve-setup') }).strict(),
])
export type PhonesCommand = z.infer<typeof phonesCommandSchema>

/**
 * The iPhone app's public TestFlight link, which first-run setup's Get the iPhone beta opens in the browser. The app
 * is still in internal testing, so this is a placeholder until external testing has a public link: set it before a
 * release (docs/release/releasing.md).
 */
export const IPHONE_BETA_URL = 'https://testflight.apple.com/join/PLACEHOLDER'

export interface PhonesBridge {
  get(): Promise<PhonesState>
  command(command: PhonesCommand): Promise<PhonesState>
  onChanged(listener: (state: PhonesState) => void): () => void
}

/**
 * A remote host's phone access (ADR-0050): the host runs it the way the desktop runs its own, and the desktop reads and
 * changes it through the host's administrative routes, over the SSH connection it already has. Turning it on or off is
 * the host's own setting, so it carries `set-enabled` beside the Phones page's commands.
 */
export const hostPhonesCommandSchema = z.discriminatedUnion('type', [
  ...phonesCommandSchema.options,
  z.object({ type: z.literal('set-enabled'), enabled: z.boolean() }).strict(),
])
export type HostPhonesCommand = z.infer<typeof hostPhonesCommandSchema>

/** What a host's administrative route answers with, checked before the desktop shows any of it. */
export const phonesStateSchema = z.object({
  enabled: z.boolean(), localHostRunning: z.boolean(),
  phase: z.enum(['off', 'starting', 'on', 'failed', 'cleanup-failed']),
  tailscale: z.union([
    z.object({ status: z.literal('waiting') }),
    z.object({ status: z.literal('ok'), hostName: z.string().max(256), dnsName: z.string().max(256) }),
    z.object({ status: z.literal('failed'), reason: z.enum(['missing', 'not-running']) }),
  ]),
  serve: z.union([
    z.object({ status: z.literal('waiting') }),
    z.object({ status: z.literal('ok') }),
    z.object({ status: z.literal('failed'), reason: z.enum(['port-taken', 'not-enabled', 'denied', 'listener', 'failed', 'cleanup', 'cleanup-record', 'record']), canOpenSetup: z.boolean().optional() }),
  ]),
  servePort: z.union([z.literal(8443), z.literal(10000)]).nullable().optional(),
  address: z.string().max(512).nullable(),
  computerName: z.string().max(256), defaultName: z.string().max(256),
  code: z.object({ code: z.string().min(1).max(32), expiresAt: z.iso.datetime() }).nullable(),
  phones: z.array(z.object({ clientId: z.string().min(1).max(512), name: z.string().max(256), pairedAt: z.string().max(64), connected: z.boolean(), canAnswer: z.boolean() })).max(200),
  answersAvailable: z.boolean(),
}) satisfies z.ZodType<PhonesState>
