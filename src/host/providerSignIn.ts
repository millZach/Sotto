import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { PROVIDER_LABELS, type ProviderId } from '../shared/agents'
import { PROVIDER_SIGN_IN_LIFETIME_MS, PROVIDER_SIGN_IN_SHAPES, SIGN_IN_MESSAGE_MAX, isProviderSignInPage, type HostSignIn, type ProviderSignInShape } from '../shared/hostProviders'
import { withCliPath } from '../main/agents/cliLookup'
import { findExecutable as findCodex, nativeEnvironment as codexEnvironment } from '../main/agents/subscriptionCodex'
import { claudeEnvironment, findClaudeExecutable } from '../main/agents/subscriptionClaude'
import { findGrokExecutable, grokEnvironment } from '../main/agents/grokRpc'

/**
 * A provider's own sign-in, run on this host for a paired client and finished by the user in that client's browser
 * (ADR-0037). The client is started as a child process with pipes, as the host has no terminal to give it: Codex's and
 * Grok Build's device-code sign-ins print a page and a code and finish by themselves once the code is entered there,
 * and Claude Code's subscription sign-in prints a page and waits for the code that page shows to be pasted back.
 *
 * What the client prints (the page's address, the code) and the code pasted back are held here in memory, for the
 * client that started the sign-in and for no one else, and only until it ends or its fifteen minutes run out. None of it
 * is logged or written to disk; the provider's own client writes its credential where it always does, once signed in.
 */

/** How the host starts one provider's sign-in. Tests stand fake clients in here. */
export interface SignInCommand { readonly executable: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv }
export interface ProviderSignInOptions {
  /** Each provider's sign-in command, or undefined when its client is not on this machine. */
  readonly command?: (provider: ProviderId) => Promise<SignInCommand | undefined>
  /** Connects the provider once its client says it signed in, for the client that asked; answers the provider's error when it did not connect. */
  readonly connect: (provider: ProviderId, clientId: string) => Promise<string | undefined>
  readonly lifetimeMs?: number
  /** How long a client has to print its page before the sign-in is given up. */
  readonly startTimeoutMs?: number
  /** How long an ended sign-in can still be read, so the client that started it learns how it ended. */
  readonly keepEndedMs?: number
}

/** A refusal whose sentence is the client's to show: the sign-in could not start, or a code was not taken. */
export class ProviderSignInRefusal extends Error {}

/** Only this much of what a client prints is read; a sign-in says what it needs in a few lines. */
const OUTPUT_LIMIT = 64 * 1024
const START_TIMEOUT_MS = 30_000
const KEEP_ENDED_MS = 2 * 60_000
/** Colour, cursor and hyperlink sequences a client prints even into a pipe. */
const TERMINAL_SEQUENCES = new RegExp(String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]`, 'gu')
const PAGE = /https:\/\/[^\s"'<>`]+/u
const DEVICE_CODE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/u
const EXPIRES = /expires in (\d{1,2}) minutes?/iu

/** The client's own sign-in, never an API key: Codex's and Grok Build's device codes, and Claude Code's subscription only. */
export const PROVIDER_SIGN_IN_ARGS: Readonly<Record<ProviderId, readonly string[] | null>> = {
  codex: ['login', '--device-auth'], grok: ['login', '--device-auth'], claude: ['auth', 'login', '--claudeai'], devin: null, muse: null, opencode: null,
}

/** Where each client is, found the way its adapter finds it (ADR-0036), with the environment its adapter gives it. */
async function defaultCommand(provider: ProviderId): Promise<SignInCommand | undefined> {
  const args = PROVIDER_SIGN_IN_ARGS[provider]
  if (!args) return undefined
  if (provider === 'codex') {
    const executable = await findCodex()
    return executable ? { executable, args, env: withCliPath({ ...codexEnvironment(), NO_COLOR: '1' }, executable) } : undefined
  }
  if (provider === 'grok') {
    const executable = await findGrokExecutable()
    return executable ? { executable, args, env: withCliPath({ ...grokEnvironment(), NO_COLOR: '1' }, executable) } : undefined
  }
  const executable = await findClaudeExecutable()
  return executable ? { executable, args, env: withCliPath(claudeEnvironment(), executable) } : undefined
}

interface Entry {
  view: HostSignIn
  readonly clientId: string
  readonly shape: ProviderSignInShape
  child?: ChildProcess | undefined
  output: string
  codeSent: boolean
  timers: NodeJS.Timeout[]
  /** Settles the start once the client has printed its page, or the sign-in ended first. */
  ready?: (() => void) | undefined
}

export class ProviderSignIns {
  private readonly entries = new Map<string, Entry>()
  private closed = false
  constructor(private readonly options: ProviderSignInOptions) {}

  /**
   * Starts a provider's sign-in for this client and answers once its client has printed the page (and, for a device
   * code, the code), or once it has ended without one. A sign-in already running for the same provider is stopped
   * first: the newest press wins, as a second terminal's would.
   */
  async start(provider: ProviderId, clientId: string): Promise<HostSignIn> {
    if (this.closed) throw new ProviderSignInRefusal('This host is stopping. Nothing was signed in. Connect again and try once more.')
    const shape = PROVIDER_SIGN_IN_SHAPES[provider]
    const name = PROVIDER_LABELS[provider]
    if (!shape) throw new ProviderSignInRefusal(`${name} signs in from a terminal on the host. Nothing was changed.`)
    for (const [id, entry] of this.entries) if (entry.view.provider === provider && !ended(entry.view)) this.end(id, 'ended')
    // The provider is this start's before the lookup below waits, so a start that overlaps it (another press, another
    // client) stops this one rather than running beside it, and a host that stops meanwhile spawns nothing.
    const id = randomUUID()
    const entry: Entry = { view: { id, provider, shape, stage: 'starting' }, clientId, shape, output: '', codeSent: false, timers: [] }
    this.entries.set(id, entry)
    let command: SignInCommand | undefined
    try { command = await (this.options.command ?? defaultCommand)(provider) } catch { command = undefined }
    if (this.closed || this.entries.get(id) !== entry || ended(entry.view)) return this.copy(entry)
    if (!command) {
      this.entries.delete(id)
      throw new ProviderSignInRefusal(`${name} is not installed on this host, so it cannot sign in. Nothing was changed.`)
    }
    const printed = new Promise<void>(resolve => { entry.ready = resolve })
    let child: ChildProcess
    try {
      child = spawn(command.executable, [...command.args], { cwd: homedir(), env: command.env, shell: false, windowsHide: true,
        stdio: [shape === 'paste-code' ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    } catch {
      this.end(id, 'failed', `${name} could not be started on this host. Nothing was changed.`)
      return this.copy(entry)
    }
    entry.child = child
    const read = (chunk: Buffer): void => {
      if (entry.child !== child || entry.output.length >= OUTPUT_LIMIT) return
      entry.output = (entry.output + chunk.toString('utf8')).slice(0, OUTPUT_LIMIT)
      this.parse(entry)
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.stdin?.on('error', () => undefined)
    child.on('error', () => { if (entry.child === child) this.end(id, 'failed', `${name} could not be started on this host. Nothing was changed.`) })
    child.on('close', exitCode => { if (entry.child === child) void this.exited(entry, exitCode) })
    entry.timers.push(setTimeout(() => { if (entry.view.stage === 'starting') this.end(id, 'failed', `${name} did not show a sign-in page. Nothing was changed.`) }, this.options.startTimeoutMs ?? START_TIMEOUT_MS))
    entry.timers.push(setTimeout(() => { if (!ended(entry.view)) this.end(id, 'ended', 'The sign-in ran out of time.') }, this.options.lifetimeMs ?? PROVIDER_SIGN_IN_LIFETIME_MS))
    for (const timer of entry.timers) timer.unref()
    await printed
    return this.copy(entry)
  }

  /** Where a sign-in stands, for the client that started it; null for any other client, or once it is gone. */
  read(id: string, clientId: string): HostSignIn | null {
    const entry = this.entries.get(id)
    return entry && entry.clientId === clientId ? this.copy(entry) : null
  }

  /**
   * Hands the client the code the user pasted from its sign-in page, as one line on its input, and keeps nothing: the
   * code is gone from here once written. A code that cannot be one is refused before the client sees it, and the
   * sign-in keeps waiting for the right one.
   */
  code(id: string, clientId: string, code: string): HostSignIn {
    const entry = this.entries.get(id)
    if (!entry || entry.clientId !== clientId || ended(entry.view)) throw new ProviderSignInRefusal('This sign-in has ended. Nothing was signed in. Start it again.')
    if (entry.shape !== 'paste-code' || entry.view.stage !== 'waiting' || !entry.child?.stdin) throw new ProviderSignInRefusal('This sign-in is not waiting for a code. Nothing was sent.')
    const text = code.trim()
    // One line, printable: a line break would hand the client two answers.
    if (!text || [...text].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new ProviderSignInRefusal('That code has characters a sign-in code does not. Copy it from the page again. Nothing was sent.')
    // Claude Code's code is the page's code and its state joined by `#`; without both it asks again and never finishes.
    if (entry.view.provider === 'claude' && !/^[^#\s]+#[^#\s]+$/u.test(text)) throw new ProviderSignInRefusal('That is not the whole code. Copy all of it from the page, then paste it again. Nothing was sent.')
    entry.child.stdin.write(text + '\n')
    entry.codeSent = true
    entry.view = { ...entry.view, stage: 'finishing' }
    return this.copy(entry)
  }

  /** Stops a sign-in for the client that started it. Nothing is signed in, and what it printed is dropped. */
  cancel(id: string, clientId: string): void {
    const entry = this.entries.get(id)
    if (entry && entry.clientId === clientId && !ended(entry.view)) this.end(id, 'ended')
  }

  /** The host is stopping: every client still signing in is stopped. */
  close(): void {
    this.closed = true
    for (const id of [...this.entries.keys()]) this.end(id, 'ended')
    for (const entry of this.entries.values()) for (const timer of entry.timers) clearTimeout(timer)
    this.entries.clear()
  }

  /** Reads the page and the code out of what the client printed, once both a sign-in of its shape needs are there. */
  private parse(entry: Entry): void {
    if (entry.view.stage !== 'starting') return
    const text = entry.output.replace(TERMINAL_SEQUENCES, '')
    const page = followed(text, PAGE.exec(text))?.[0]?.replace(/[.,;:)\]]+$/u, '')
    if (!page) return
    const name = PROVIDER_LABELS[entry.view.provider]
    if (!isProviderSignInPage(entry.view.provider, page)) {
      this.end(entry.view.id, 'failed', `${name} asked to sign in on a page Sotto does not open. Nothing was signed in. Sign in to ${name} on the host itself.`)
      return
    }
    const rest = text.replace(page, ''), printed = DEVICE_CODE.exec(rest)
    // A printed code still arriving is waited for; a code printed only in the page's address is taken from there.
    const code = entry.shape === 'device-code' ? (printed ? followed(rest, printed)?.[1] : DEVICE_CODE.exec(page)?.[1]) : undefined
    if (entry.shape === 'device-code' && !code) return
    const minutes = Number(EXPIRES.exec(text)?.[1])
    entry.view = { ...entry.view, stage: 'waiting', url: page, page: new URL(page).hostname, ...(code ? { code } : {}),
      ...(Number.isInteger(minutes) && minutes >= 1 && minutes <= 60 ? { expiresInMinutes: minutes } : {}) }
    // What it printed has given what it had to; nothing more of it is kept.
    entry.output = ''
    entry.ready?.(); entry.ready = undefined
  }

  /** The client ended. Signed in: connect the provider. Otherwise say how it ended: a pasted code refused, or a failure. */
  private async exited(entry: Entry, exitCode: number | null): Promise<void> {
    entry.child = undefined
    const id = entry.view.id, provider = entry.view.provider, name = PROVIDER_LABELS[provider]
    if (ended(entry.view)) return
    // A client that ends well has signed in, even one that found it already was and showed no page.
    if (exitCode !== 0) {
      if (entry.codeSent) this.end(id, 'refused')
      else this.end(id, 'failed', entry.view.stage === 'starting' ? `${name} stopped before it showed a sign-in page. Nothing was changed.` : undefined)
      return
    }
    entry.view = { id, provider, shape: entry.shape, stage: 'finishing' }
    let error: string | undefined
    try { error = await this.options.connect(provider, entry.clientId) } catch { error = `${name} signed in, but the host could not connect it. Press Connect on its tile to try again.` }
    if (this.entries.get(id) !== entry || ended(entry.view)) return
    this.end(id, error ? 'failed' : 'connected', error ? `${name} signed in, but did not connect: ${error}` : undefined)
  }

  /** Ends a sign-in: its client is stopped, what it printed is dropped, and only how it ended stays, for a little while. */
  private end(id: string, stage: 'connected' | 'refused' | 'failed' | 'ended', message?: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const child = entry.child
    entry.child = undefined
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    for (const timer of entry.timers) clearTimeout(timer)
    entry.output = ''; entry.codeSent = false
    // The provider's own error can make the sentence long; a message the client's schema refuses would leave it waiting.
    const said = message && message.length > SIGN_IN_MESSAGE_MAX ? message.slice(0, SIGN_IN_MESSAGE_MAX - 1).trimEnd() + '…' : message
    entry.view = { id, provider: entry.view.provider, shape: entry.shape, stage, ...(said ? { message: said } : {}) }
    entry.ready?.(); entry.ready = undefined
    const forget = setTimeout(() => { if (this.entries.get(id) === entry) this.entries.delete(id) }, this.options.keepEndedMs ?? KEEP_ENDED_MS)
    forget.unref()
    entry.timers = [forget]
  }

  private copy(entry: Entry): HostSignIn { return { ...entry.view } }
}

/**
 * The match, once something follows it in what was printed: a chunk can end partway through a page's address or a code,
 * and the part read so far would still match.
 */
function followed(text: string, match: RegExpExecArray | null): RegExpExecArray | null {
  return match && match.index + match[0].length < text.length ? match : null
}
function ended(view: HostSignIn): boolean { return view.stage === 'connected' || view.stage === 'refused' || view.stage === 'failed' || view.stage === 'ended' }
