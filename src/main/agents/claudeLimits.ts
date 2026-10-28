import { randomUUID } from 'node:crypto'
import type { UsageQuotaRead } from '../../shared/usageDashboard'
import { withCliPath } from './cliLookup'
import { launchInteractiveProcess, type InteractiveProcess } from './gitLauncher'
import { dropExpiredQuotaWindows, mergeClaudeQuota, parseClaudeQuota, parseClaudeUsage, unavailableProviderQuota } from './providerQuota'
import { claudeEnvironment } from './subscriptionClaude'

/**
 * Claude limits read on demand through Claude Code's own `get_usage` control request (stream-json). No prompt is
 * sent, no session is saved, and Sotto reads no credential: the user's Claude Code asks its own provider with its
 * own sign-in. Only the documented window figures are kept (`parseClaudeUsage`); nothing here logs or stores the
 * answer. The request is marked experimental by Claude Code, so a client that refuses it or never answers gives an
 * unavailable read and the passive `rate_limit_event` path stays the fallback.
 *
 * The probe starts on the Git launcher's worker thread (`launchInteractiveProcess`), not on the thread that asks: on
 * Windows a start holds the thread that asks, and the first start in a while of Claude Code's binary held it for over
 * half a second while Windows checked the file (ADR-0083). Only the start moved; the exchange stays here.
 */

/** A live Claude runtime's control channel: sends one control request and resolves with the success body. */
export type ClaudeControl = (request: Record<string, unknown>) => Promise<Record<string, unknown>>

export interface ClaudeLimitsOptions {
  /** A live thread runtime's control channel, tried first. */
  control?: ClaudeControl
  /** Claude Code itself, for a short probe when no runtime is live (or the live one could not answer). */
  executable?: string
  /** Arguments placed before the probe's own flags (tests run a Node script as the client). */
  prefixArgs?: readonly string[]
  /** The probe's environment. Defaults to `claudeEnvironment()`: the same allow-list every Claude Code process gets. */
  environment?: NodeJS.ProcessEnv
  /** An existing absolute folder for the probe to start in. */
  workingDirectory?: string
  signal?: AbortSignal
  /** Overall deadline for one read, 15 s by default. */
  timeoutMs?: number
  /** The clock used for `observedAt`. */
  now?: () => Date
}

export const CLAUDE_LIMITS_TIMEOUT_MS = 15_000
const PROBE_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024
const PROBE_EXIT_GRACE_MS = 3_000
/** The flags `ClaudeSubscriptionClient.models()` uses: no tools, no customisations, no permission prompts, no session file. */
const PROBE_FLAGS = [
  '--print', '--safe-mode', '--tools', '', '--permission-prompts', 'none', '--no-session-persistence',
  '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
]
const GET_USAGE = { subtype: 'get_usage', skip_behaviors: true } as const

/** How one read ended. `unsupported` means Claude Code answered with an error: it heard and will not. */
type Answer = { kind: 'usage'; body: unknown } | { kind: 'unsupported' } | { kind: 'none' }

class Deadline extends Error {}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const abortError = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('The read was stopped.', 'AbortError')

/** `work`, unless the deadline (when given) passes or `signal` aborts first. */
function within<T>(work: Promise<T>, timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return }
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish(() => reject(new Deadline())), timeoutMs)
    const stop = (): void => finish(() => reject(abortError(signal!)))
    const finish = (settle: () => void): void => { clearTimeout(timer); signal?.removeEventListener('abort', stop); settle() }
    signal?.addEventListener('abort', stop, { once: true })
    work.then(value => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)))
  })
}

/**
 * `lost`: the runtime went away or refused. A refusal there is not taken as the client's answer, because a runtime
 * can run an older client than the one installed now, or not have finished starting; a probe of the installed
 * client decides.
 */
async function askRuntime(control: ClaudeControl, timeoutMs: number, signal: AbortSignal): Promise<Answer | 'lost'> {
  const asked = control({ ...GET_USAGE })
  // A late answer or failure after the deadline is not wanted and must not surface as an unhandled rejection.
  asked.catch(() => undefined)
  try { return { kind: 'usage', body: await within(asked, timeoutMs, signal) } }
  catch (error) {
    if (signal.aborted) throw abortError(signal)
    // No answer in time: the deadline is spent. Otherwise a fresh probe may still answer.
    return error instanceof Deadline ? { kind: 'none' } : 'lost'
  }
}

function probe(options: ClaudeLimitsOptions & { executable: string; workingDirectory: string }, timeoutMs: number, signal: AbortSignal): Promise<Answer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError(signal)); return }
    const environment = options.environment ?? claudeEnvironment()
    let child: InteractiveProcess
    try {
      child = launchInteractiveProcess(options.executable, [...(options.prefixArgs ?? []), ...PROBE_FLAGS], {
        cwd: options.workingDirectory, env: withCliPath(environment, options.executable),
      })
    } catch { resolve({ kind: 'none' }); return }
    const initialize = randomUUID()
    const usage = randomUUID()
    let settled = false
    let bytes = 0
    let pending = ''
    const kill = (): void => { try { child.kill('SIGKILL') } catch { /* Already gone. */ } }
    const settle = (answer: Answer | { error: unknown }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      if ('error' in answer || answer.kind === 'none') kill()
      else {
        // EOF lets the client exit on its own; a client that lingers is stopped so no probe outlives its read.
        try { child.stdin.end() } catch { /* Exiting already. */ }
        const grace = setTimeout(kill, PROBE_EXIT_GRACE_MS)
        grace.unref()
        child.once('close', () => clearTimeout(grace))
      }
      if ('error' in answer) reject(answer.error)
      else resolve(answer)
    }
    const timer = setTimeout(() => settle({ kind: 'none' }), timeoutMs)
    const stop = (): void => settle({ error: abortError(signal) })
    signal.addEventListener('abort', stop, { once: true })
    const send = (requestId: string, request: Record<string, unknown>): void => {
      try { child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`) }
      catch { settle({ kind: 'none' }) }
    }
    const line = (text: string): void => {
      let frame: unknown
      try { frame = JSON.parse(text) } catch { return }
      const envelope = object(frame)
      if (envelope?.type !== 'control_response') return
      const response = object(envelope.response)
      if (response?.request_id === initialize) {
        if (response.subtype === 'success') send(usage, { ...GET_USAGE })
        else settle({ kind: 'none' })
      } else if (response?.request_id === usage) {
        settle(response.subtype === 'success' ? { kind: 'usage', body: response.response } : { kind: 'unsupported' })
      }
    }
    child.stdout.setEncoding('utf8')
    // Once settled, what the client still prints is read and dropped.
    child.stdout.on('data', chunk => {
      if (settled) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > PROBE_OUTPUT_LIMIT_BYTES) { settle({ kind: 'none' }); return }
      pending += chunk
      let newline: number
      while (!settled && (newline = pending.indexOf('\n')) >= 0) {
        const text = pending.slice(0, newline); pending = pending.slice(newline + 1)
        if (text.trim()) line(text)
      }
    })
    // Claude Code's diagnostics are never kept; reading them only stops a full pipe from stalling the client.
    child.stderr.on('data', () => undefined)
    child.on('error', () => settle({ kind: 'none' }))
    child.stdin.on('error', () => settle({ kind: 'none' }))
    child.on('close', () => settle({ kind: 'none' }))
    send(initialize, { subtype: 'initialize', hooks: {}, sdkMcpServers: [], promptSuggestions: false })
  })
}

async function readOnce(options: ClaudeLimitsOptions, signal: AbortSignal): Promise<UsageQuotaRead> {
  const timeoutMs = options.timeoutMs ?? CLAUDE_LIMITS_TIMEOUT_MS
  const started = Date.now()
  const at = (): string => (options.now?.() ?? new Date()).toISOString()
  let answer: Answer | 'lost' = 'lost'
  if (options.control) answer = await askRuntime(options.control, timeoutMs, signal)
  if (answer === 'lost' && options.executable && options.workingDirectory) {
    answer = await probe({ ...options, executable: options.executable, workingDirectory: options.workingDirectory },
      Math.max(1, timeoutMs - (Date.now() - started)), signal)
  }
  if (answer === 'lost' || answer.kind === 'none') return unavailableProviderQuota('claude', 'refresh-unavailable', true, at())
  if (answer.kind === 'unsupported') return unavailableProviderQuota('claude', 'refresh-unavailable', false, at())
  return parseClaudeUsage(answer.body, at())
}

interface Flight { promise: Promise<UsageQuotaRead>; controller: AbortController; waiters: number }
const flights = new Map<unknown, Flight>()
/** Reads through the same live runtime, or the same client in the same folder, share one request. */
function flightKey(options: ClaudeLimitsOptions): unknown {
  return options.control ?? JSON.stringify([options.executable ?? '', options.prefixArgs ?? [], options.workingDirectory ?? ''])
}

/**
 * Claude's account limits now, `refreshable: true`. Concurrent reads through the same runtime or client share one
 * request; a caller that stops waiting leaves the others theirs, and the shared request stops only when nobody
 * waits. An explicit refusal from Claude Code comes back with `refreshable: false`, so the caller can stop asking
 * that client. Rejects only when `signal` aborts.
 */
export function readClaudeLimits(options: ClaudeLimitsOptions): Promise<UsageQuotaRead> {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal))
  if (!options.control && !(options.executable && options.workingDirectory)) {
    return Promise.resolve(unavailableProviderQuota('claude', 'refresh-unavailable', true, (options.now?.() ?? new Date()).toISOString()))
  }
  const key = flightKey(options)
  let flight = flights.get(key)
  if (!flight) {
    const controller = new AbortController()
    const created: Flight = { controller, waiters: 0, promise: readOnce(options, controller.signal) }
    created.promise.then(() => undefined, () => undefined).finally(() => { if (flights.get(key) === created) flights.delete(key) })
    flights.set(key, created)
    flight = created
  }
  const shared = flight
  shared.waiters++
  const signal = options.signal
  if (!signal) return shared.promise.finally(() => { shared.waiters-- })
  return new Promise<UsageQuotaRead>((resolve, reject) => {
    let done = false
    const leave = (): void => {
      if (done) return
      done = true
      signal.removeEventListener('abort', stop)
      shared.waiters--
    }
    const stop = (): void => {
      leave()
      // Nobody waits: stop it, and let the next read start afresh rather than join a stopped one.
      if (shared.waiters <= 0) {
        if (flights.get(key) === shared) flights.delete(key)
        shared.controller.abort(abortError(signal))
      }
      reject(abortError(signal))
    }
    signal.addEventListener('abort', stop, { once: true })
    shared.promise.then(value => { if (!done) { leave(); resolve(value) } }, (error: unknown) => { if (!done) { leave(); reject(error) } })
  })
}

/** What the adapter needs to read Claude limits at a given moment: a live runtime's control channel, and the client. */
export interface ClaudeLimitsSource {
  control?: ClaudeControl
  executable?: string
  prefixArgs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  workingDirectory?: string
}

/**
 * The adapter's Claude limits: passive events and `get_usage` answers merged into one reading, which
 * `readProviderQuota` returns. `clear()` on every connect; stale answers from before it are discarded.
 * Whether Claude can be read on demand is decided by the client's own answers, never by a passive event.
 */
export class ClaudeLimits {
  private quota: UsageQuotaRead | undefined
  private refusing = false
  private generation = 0
  private pending: { generation: number; promise: Promise<void> } | undefined
  constructor(private readonly options: { timeoutMs?: number; now?: () => Date } = {}) {}

  /** A `rate_limit_event` frame from a thread's own session. Anything else is ignored. */
  observe(frame: unknown): void {
    if (object(frame)?.type !== 'rate_limit_event') return
    this.quota = mergeClaudeQuota(this.quota, parseClaudeQuota(frame, this.now()))
  }

  /** Forget the reading and whether the client refused, as on connect or a client update. */
  clear(): void {
    this.quota = undefined
    this.refusing = false
    this.generation++
  }

  /** A different Claude Code (an update, or another install) may answer `get_usage`, so ask it again. */
  clientChanged(): void { this.refusing = false }

  /**
   * The current reading; with `refresh`, ask Claude Code first. Concurrent refreshes share one request even when
   * each brings its own control function. Rejects only when `signal` aborts.
   */
  async read(refresh: boolean, source: ClaudeLimitsSource, signal?: AbortSignal): Promise<UsageQuotaRead> {
    if (refresh && !this.refusing) {
      if (this.pending?.generation !== this.generation) {
        const generation = this.generation
        const asked = readClaudeLimits({ ...source,
          ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
          ...(this.options.now ? { now: this.options.now } : {}) }).then(answer => {
          // A refusal says nothing about the limits, so the passive reading stands as it was.
          if (generation !== this.generation) return
          if (!answer.refreshable) this.refusing = true
          else this.quota = mergeClaudeQuota(this.quota, answer)
        }).finally(() => { if (this.pending?.promise === asked) this.pending = undefined })
        this.pending = { generation, promise: asked }
      }
      // The shared request runs to its own deadline; a caller that stops waiting only stops waiting.
      await within(this.pending.promise, undefined, signal)
    }
    const current = this.quota ?? unavailableProviderQuota('claude', this.refusing ? 'refresh-unavailable' : 'not-read', !this.refusing)
    return { ...dropExpiredQuotaWindows(current, this.now()), refreshable: !this.refusing }
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString() }
}
