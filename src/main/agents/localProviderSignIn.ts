import { existsSync } from 'node:fs'
import { t } from '@lingui/core/macro'
import { defaultSignInCommand, ProviderSignInRefusal, ProviderSignIns, type SignInCommand } from '../../host/providerSignIn'
import { isProviderSignInPage, type HostSignIn, type ProviderSignInView } from '../../shared/hostProviders'
import type { LocalSignInProvider, LocalSignInRequest } from '../../shared/localProviderSignIn'

/** The one client this computer's own sign-ins are for: its window. */
const DESKTOP = 'desktop'

export interface LocalProviderSignInOptions {
  /** Connects the provider once its client says it signed in; answers the provider's error when it did not connect. */
  readonly connect: (provider: LocalSignInProvider) => Promise<string | undefined>
  /** Opens a page in this computer's browser. Only a checked page of the provider's own ever reaches it. */
  readonly openExternal: (url: string) => Promise<void>
  /** Each provider's sign-in command; found the way its adapter finds it by default. A test stands fake clients in here. */
  readonly command?: (provider: LocalSignInProvider) => Promise<SignInCommand | undefined>
  readonly lifetimeMs?: number
  readonly startTimeoutMs?: number
}

/**
 * Claude Code opens its sign-in page in a browser by itself as its sign-in starts (ADR-0037), which on this computer
 * would be before the user presses Open sign-in page. It runs `BROWSER` instead where that is set, so on Linux and
 * macOS its sign-in is given a program that does nothing, and the page opens only from main, checked, on the press.
 * Measured on Linux with Claude Code 2.1.322; Windows is left as it is until it is measured there.
 */
export function withoutOwnBrowser(provider: LocalSignInProvider, command: SignInCommand | undefined, platform: NodeJS.Platform = process.platform): SignInCommand | undefined {
  if (!command || provider !== 'claude' || platform === 'win32') return command
  return { ...command, env: { ...command.env, BROWSER: existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true' } }
}

/**
 * Signing Codex, Claude Code or Grok Build in on this computer from its row in Settings › Providers (ADR-0200). It is
 * the sign-in a paired host runs for its tiles (ADR-0037), on this computer's own client: the client is started over
 * pipes, what it printed is held here in memory, and the window is told where the sign-in stands and the code to show,
 * never the page's address. Main opens that page, checked, on a press. Nothing here is logged or written to disk; the
 * client writes its own credential where it always does.
 */
export class LocalProviderSignIn {
  private readonly signIns: ProviderSignIns
  constructor(private readonly options: LocalProviderSignInOptions) {
    this.signIns = new ProviderSignIns({
      place: 'computer',
      command: async provider => withoutOwnBrowser(provider as LocalSignInProvider, await (options.command ? options.command(provider as LocalSignInProvider) : defaultSignInCommand(provider))),
      connect: async provider => options.connect(provider as LocalSignInProvider),
      ...(options.lifetimeMs !== undefined ? { lifetimeMs: options.lifetimeMs } : {}),
      ...(options.startTimeoutMs !== undefined ? { startTimeoutMs: options.startTimeoutMs } : {}),
    })
  }

  /** One step of a sign-in, answered as a host answers its own: the view without the page's address, or null once it is gone. */
  async request(request: LocalSignInRequest): Promise<ProviderSignInView | null> {
    let view: HostSignIn | null
    if (request.type === 'start') view = await this.signIns.start(request.provider, DESKTOP)
    else if (request.type === 'read') view = this.signIns.read(request.signInId, DESKTOP)
    else if (request.type === 'code') view = this.signIns.code(request.signInId, DESKTOP, request.code)
    else if (request.type === 'cancel') { this.signIns.cancel(request.signInId, DESKTOP); return null }
    else {
      view = this.signIns.read(request.signInId, DESKTOP)
      if (!view || view.stage !== 'waiting' || !view.url || !isProviderSignInPage(view.provider, view.url)) throw new ProviderSignInRefusal(t`This sign-in is no longer waiting for you. Nothing was opened. Start it again.`)
      try { await this.options.openExternal(view.url) }
      catch { throw new ProviderSignInRefusal(t`The sign-in page could not open in your browser. Nothing was changed. Try Open sign-in page again.`) }
    }
    if (!view) return null
    const shown: HostSignIn = { ...view }
    delete shown.url
    return shown
  }

  close(): void { this.signIns.close() }
}
