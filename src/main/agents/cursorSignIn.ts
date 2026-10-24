import { execFile } from 'node:child_process'
import { ProviderSignIns, ProviderSignInRefusal, type SignInCommand } from '../../host/providerSignIn'
import { isProviderSignInPage } from '../../shared/hostProviders'
import { CURSOR_SIGN_IN_WORDS, cursorSignInViewSchema, type CursorSignInDone, type CursorSignInStart, type CursorSignInView } from '../../shared/cursorSignIn'
import { withCliPath } from './cliLookup'
import { cursorEnvironment, findCursorProgram, type CursorProgram } from './cursorRpc'

/** The one client a desktop's own sign-in is for: this computer's window. */
const DESKTOP = 'desktop'

export interface CursorSignInOptions {
  /** Sotto's own Cursor folder, which `agent login` and `agent logout` run with (ADR-0128). */
  readonly configDirectory: string
  /** Cursor's program; found the way the adapter finds it by default. A test stands a fake client in here. */
  readonly program?: () => Promise<CursorProgram | undefined>
  readonly environment?: NodeJS.ProcessEnv
  /** Connects Cursor once its client says it signed in; answers Cursor's error when it did not connect. */
  readonly connect: () => Promise<string | undefined>
  /** Disconnects Cursor once it has signed out. */
  readonly signedOut?: () => Promise<void>
  /** Opens a page in this computer's browser. Only a checked `https://cursor.com` page ever reaches it. */
  readonly openExternal: (url: string) => Promise<void>
  readonly lifetimeMs?: number
  readonly startTimeoutMs?: number
}

/**
 * Cursor's sign-in from its tile on this computer (ADR-0128, variant A): Cursor's own `agent login`, which prints a
 * cursor.com page and finishes by itself once the user has signed in there. Main opens that page, checked, in the
 * browser; the window is told where the sign-in stands and never the page's address. Nothing here is logged.
 */
export class CursorSignIn {
  private readonly signIns: ProviderSignIns
  constructor(private readonly options: CursorSignInOptions) {
    this.signIns = new ProviderSignIns({
      command: async provider => provider === 'cursor' ? this.command(['login']) : undefined,
      connect: async () => options.connect(),
      ...(options.lifetimeMs !== undefined ? { lifetimeMs: options.lifetimeMs } : {}),
      ...(options.startTimeoutMs !== undefined ? { startTimeoutMs: options.startTimeoutMs } : {}),
    })
  }
  private async command(args: readonly string[]): Promise<SignInCommand | undefined> {
    const program = await (this.options.program ?? (() => findCursorProgram(this.options.environment)))()
    if (!program) return undefined
    return { executable: program.executable, args: [...program.args, ...args], env: withCliPath(cursorEnvironment(this.options.configDirectory, this.options.environment), program.executable) }
  }
  private view(id: string): CursorSignInView | null {
    const read = this.signIns.read(id, DESKTOP)
    if (!read) return null
    // The page's address stays in main: the window is told where the sign-in stands, never where it points.
    return cursorSignInViewSchema.parse(Object.fromEntries(Object.entries(read).filter(([key]) => key !== 'url')))
  }
  /** Start signing in, and open Cursor's page once the client prints it. */
  async start(): Promise<CursorSignInStart> {
    let started
    try { started = await this.signIns.start('cursor', DESKTOP) }
    catch (error) { return { message: error instanceof ProviderSignInRefusal ? error.message : CURSOR_SIGN_IN_WORDS.notRunning } }
    if (started.url) {
      if (isProviderSignInPage('cursor', started.url)) await this.options.openExternal(started.url).catch(() => undefined)
      else { this.signIns.cancel(started.id, DESKTOP); return { message: CURSOR_SIGN_IN_WORDS.pageRefused } }
    }
    const view = this.view(started.id)
    return view ? { view } : { message: CURSOR_SIGN_IN_WORDS.notRunning }
  }
  async read(id: string): Promise<CursorSignInView | null> { return this.view(id) }
  /** Open the page again, for a user who closed it. */
  async reopen(id: string): Promise<CursorSignInDone> {
    const url = this.signIns.read(id, DESKTOP)?.url
    if (!url || !isProviderSignInPage('cursor', url)) return { ok: false, message: 'This sign-in has ended. Nothing was signed in. Start it again.' }
    await this.options.openExternal(url)
    return { ok: true }
  }
  async cancel(id: string): Promise<CursorSignInDone> { this.signIns.cancel(id, DESKTOP); return { ok: true } }
  /** `agent logout`, which ends the sign-in every Cursor on this computer shares, and then Cursor's connection. */
  async signOut(): Promise<CursorSignInDone> {
    const command = await this.command(['logout'])
    if (!command) return { ok: false, message: 'Cursor’s CLI is not installed on this computer, so there is nothing to sign out of.' }
    const ok = await new Promise<boolean>(resolve => {
      execFile(command.executable, [...command.args], { env: command.env, windowsHide: true, shell: false, timeout: 60_000, maxBuffer: 64 * 1024 }, error => resolve(!error))
    })
    if (!ok) return { ok: false, message: CURSOR_SIGN_IN_WORDS.signOutFailed }
    await this.options.signedOut?.().catch(() => undefined)
    return { ok: true, message: CURSOR_SIGN_IN_WORDS.signedOut }
  }
  close(): void { this.signIns.close() }
}
