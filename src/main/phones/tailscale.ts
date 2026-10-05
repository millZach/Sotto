import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

/**
 * The Tailscale CLI, as phone access uses it (ADR-0033): read the node's state, read and change the
 * Serve setting on one HTTPS port, and nothing else. Sotto never runs Funnel. The CLI talks to the
 * local Tailscale service only, so none of this contacts a host of Sotto's own.
 *
 * Every call goes through `execFile` with an argument array and a timeout: no shell, no string that a
 * name or a port could break out of. Output is parsed here and never logged.
 */

export interface TailscaleRunResult {
  /** The exit code, or null when the run was stopped early or timed out. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}
export interface TailscaleRunOptions {
  readonly timeoutMs: number
  /** Stops the run as soon as its output matches, such as the CLI waiting on a consent page. */
  readonly stopOn?: RegExp
  /** Hears everything printed so far, each time more arrives, while the run goes on. */
  readonly watch?: (output: string) => void
  /** Stops the run when aborted, such as a `tailscale up` still waiting for a sign-in when Sotto quits. */
  readonly signal?: AbortSignal
}
/** Runs one CLI command. Rejects with an `ENOENT` error when the executable is not there. */
export type TailscaleRun = (executable: string, args: readonly string[], options: TailscaleRunOptions) => Promise<TailscaleRunResult>

/** Where the CLI lives when it is not on the PATH: the Windows installer's folder and the macOS app bundle. */
export function tailscaleCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const found = ['tailscale']
  if (platform === 'win32') found.push(win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'))
  if (platform === 'darwin') found.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  return found
}

export const runTailscale: TailscaleRun = (executable, args, options) => new Promise((resolve, reject) => {
  let stopped = false
  const child = execFile(executable, [...args], { timeout: options.timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', ...(options.signal ? { signal: options.signal } : {}) }, (error, stdout, stderr) => {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') { reject(error); return }
    const exit = error === null ? 0 : stopped || typeof (error as { code?: unknown }).code !== 'number' ? null : (error as unknown as { code: number }).code
    resolve({ code: exit, stdout: String(stdout), stderr: String(stderr) })
  })
  if (options.stopOn || options.watch) {
    let seen = ''
    const watch = (chunk: unknown): void => {
      seen += String(chunk)
      options.watch?.(seen)
      if (!stopped && options.stopOn?.test(seen)) { stopped = true; child.kill() }
    }
    child.stdout?.on('data', watch)
    child.stderr?.on('data', watch)
  }
})

export type TailscaleStatus =
  | { readonly state: 'missing' }
  | { readonly state: 'not-running' }
  | { readonly state: 'running'; readonly dnsName: string; readonly hostName: string }

/** Reads `tailscale status --json`: running only when the backend says so and the node has a MagicDNS name. */
export function parseTailscaleStatus(output: string): TailscaleStatus {
  let value: unknown
  try { value = JSON.parse(output) } catch { return { state: 'not-running' } }
  if (typeof value !== 'object' || value === null) return { state: 'not-running' }
  const status = value as { BackendState?: unknown; Self?: { DNSName?: unknown; HostName?: unknown } }
  const dnsName = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/u, '') : ''
  const hostName = typeof status.Self?.HostName === 'string' ? status.Self.HostName : ''
  if (status.BackendState !== 'Running' || !/^[A-Za-z0-9.-]{1,253}$/u.test(dnsName)) return { state: 'not-running' }
  return { state: 'running', dnsName, hostName: hostName.trim() || dnsName.split('.')[0]! }
}

/** The parts of `tailscale serve status --json` phone access reads. Anything else in it is left alone. */
export interface ServeConfig {
  readonly TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string; TerminateTLS?: string } | undefined>
  readonly Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string } | undefined> } | undefined>
  readonly AllowFunnel?: Record<string, boolean | undefined>
}

/** An empty answer is a node with no Serve setting at all. Unreadable output throws: Sotto changes nothing it cannot read. */
export function parseServeStatus(output: string): ServeConfig {
  const text = output.trim()
  if (!text) return {}
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Tailscale Serve status was not an object.')
  return value as ServeConfig
}

/** What Sotto's own setting on the port looks like: HTTPS, one handler at `/`, proxying to this loopback port. */
export function serveTarget(loopbackPort: number): string { return `http://127.0.0.1:${loopbackPort}` }

/**
 * Who holds the Serve port. `free` when nothing is on it; `ours` when the only thing on it is an HTTPS
 * proxy at `/` to one of Sotto's loopback ports and Funnel is not on for it; `taken` for anything else,
 * which Sotto never overwrites or removes.
 */
export function servePortOwner(config: ServeConfig, port: number, ourLoopbackPorts: readonly number[]): 'free' | 'ours' | 'taken' {
  const key = String(port)
  const suffix = `:${key}`
  const tcp = config.TCP?.[key]
  const webKeys = Object.keys(config.Web ?? {}).filter(name => name.endsWith(suffix))
  const funnel = Object.entries(config.AllowFunnel ?? {}).some(([name, on]) => on === true && name.endsWith(suffix))
  if (!tcp && webKeys.length === 0 && !funnel) return 'free'
  if (funnel || !tcp || tcp.HTTPS !== true || tcp.TCPForward !== undefined || webKeys.length !== 1) return 'taken'
  const handlers = Object.entries(config.Web?.[webKeys[0]!]?.Handlers ?? {})
  if (handlers.length !== 1) return 'taken'
  const [path, handler] = handlers[0]!
  if (path !== '/' || handler?.Proxy === undefined) return 'taken'
  const target = handler.Proxy.replace(/\/$/u, '')
  return ourLoopbackPorts.some(ours => target === serveTarget(ours)) ? 'ours' : 'taken'
}

/** The consent page the CLI prints when the tailnet has not turned Serve or HTTPS on. */
const CONSENT_URL = /https:\/\/login\.tailscale\.com\/[A-Za-z0-9/?=&%._~-]+/u

/**
 * What the CLI prints when the local Tailscale service will not let this account change it: on Linux, until the
 * account is its operator (`tailscale set --operator=<user>`), which a host's account usually is not.
 */
const ACCESS_DENIED = /\baccess denied\b/iu

/** Serve's setting could not be read because Tailscale refused this account. */
export class TailscaleAccessDenied extends Error {}

export type ServeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-enabled'; readonly enableUrl?: string }
  | { readonly ok: false; readonly reason: 'denied' | 'failed' }

/** Runs a command on the first executable that exists, or answers `missing` when none does. */
export type TailscaleInvoke = (args: readonly string[], options: TailscaleRunOptions) => Promise<TailscaleRunResult | 'missing'>

/** Finds the CLI on first use and remembers the executable that ran, until it stops being there. */
export function tailscaleInvoker(run: TailscaleRun = runTailscale, candidates: readonly string[] = tailscaleCandidates()): TailscaleInvoke {
  let executable: string | undefined
  return async (args, options) => {
    const order = executable ? [executable] : candidates
    for (const candidate of order) {
      try {
        const result = await run(candidate, args, options)
        executable = candidate
        return result
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    executable = undefined
    return 'missing'
  }
}

/** The CLI, found once and remembered. Each method answers in terms the Phones page can say plainly. */
export class TailscaleCli {
  private readonly invoke: TailscaleInvoke
  constructor(run: TailscaleRun = runTailscale, candidates: readonly string[] = tailscaleCandidates()) { this.invoke = tailscaleInvoker(run, candidates) }

  async status(): Promise<TailscaleStatus> {
    const result = await this.invoke(['status', '--json'], { timeoutMs: 10_000 })
    if (result === 'missing') return { state: 'missing' }
    // A stopped or signed-out node still prints its status, with exit 1; a daemon that is not there prints nothing readable.
    return parseTailscaleStatus(result.stdout)
  }

  /** The node's Serve setting. Throws when it cannot be read, so the caller changes nothing. */
  async serveStatus(): Promise<ServeConfig> {
    const result = await this.invoke(['serve', 'status', '--json'], { timeoutMs: 10_000 })
    if (result === 'missing') throw new Error('Tailscale is not installed.')
    if (result.code !== 0) {
      if (ACCESS_DENIED.test(result.stdout + result.stderr)) throw new TailscaleAccessDenied('Tailscale refused to show Serve to this account.')
      throw new Error('Tailscale Serve status could not be read.')
    }
    return parseServeStatus(result.stdout)
  }

  /** `tailscale serve --bg --https=<port> http://127.0.0.1:<loopback>`: tailnet only, never Funnel. */
  async serve(port: number, loopbackPort: number): Promise<ServeResult> {
    const result = await this.invoke(['serve', '--bg', `--https=${port}`, serveTarget(loopbackPort)], { timeoutMs: 20_000, stopOn: CONSENT_URL })
    if (result === 'missing') return { ok: false, reason: 'failed' }
    const url = CONSENT_URL.exec(result.stdout + '\n' + result.stderr)?.[0]
    if (url) return { ok: false, reason: 'not-enabled', enableUrl: url }
    if (result.code === 0) return { ok: true }
    const output = result.stdout + result.stderr
    if (ACCESS_DENIED.test(output)) return { ok: false, reason: 'denied' }
    return /\b(?:is not|isn't|not) enabled\b/iu.test(output) ? { ok: false, reason: 'not-enabled' } : { ok: false, reason: 'failed' }
  }

  /** `tailscale serve --https=<port> off`. Call only for a setting `servePortOwner` said is Sotto's. */
  async unserve(port: number): Promise<boolean> {
    const result = await this.invoke(['serve', `--https=${port}`, 'off'], { timeoutMs: 10_000 })
    return result !== 'missing' && result.code === 0
  }
}
