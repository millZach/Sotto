import type { GitHubSignIn, PluginHostSignIn } from '../../shared/plugins'

/** A connected host as GitHub's sign-in is read from it: its identity, and the read where it lists `plugin-github-sign-in`. */
export interface SignInTarget {
  readonly hostId: string
  readonly kind: 'local' | 'remote'
  readonly service: {
    readonly supportsPluginGitHubSignIn?: boolean | undefined
    /** Whether the host keeps account copies, which a host that runs plugin tools has done since before it had this read. */
    readonly supportsPluginAccountCopies?: boolean | undefined
    pluginGitHubSignIn?(): Promise<GitHubSignIn>
  }
}
/** A computer the user paired as a host, as this computer saved it. */
export interface SignInComputer { readonly id: string; readonly name: string; readonly hostId?: string | undefined; readonly connected: boolean }

/**
 * Who `gh` is signed in to GitHub as on each of the user's other computers (ADR-0205). GitHub's account is `gh`'s own
 * sign-in on each computer, so a thread on a paired host acts as that host's account, which need not be this
 * computer's. Each connected host that runs plugin tools is asked, all at once, for Settings › Plugins.
 *
 * A host that is away cannot be asked. One whose Sotto runs no plugin tools has nothing to say: its threads do not
 * use GitHub through Sotto. One that runs them on a Sotto from before this read is `too-old`: its threads use its own
 * `gh` all the same, and it is told apart by the account copies it keeps, which such a host has always listed. A host
 * that does not answer is `unknown`, the same as a `gh` that would not say. Only a name comes back, never a token.
 *
 * The connections are read in place, and again when a read fails: a host that moves from SSH to its tailnet closes the
 * connection a read was on, and the read is asked once more of the connection that took its place.
 */
export async function readHostGitHubSignIns(computers: readonly SignInComputer[], connections: () => Iterable<SignInTarget>): Promise<PluginHostSignIn[]> {
  const connectionOf = (hostId: string): SignInTarget | undefined => [...connections()].find(entry => entry.kind === 'remote' && entry.hostId === hostId)
  return Promise.all(computers.map(async (computer): Promise<PluginHostSignIn> => {
    const about = { computerId: computer.id, name: computer.name }
    const { hostId } = computer
    const target = computer.connected && hostId ? connectionOf(hostId) : undefined
    if (!target || !hostId) return { ...about, state: 'away' }
    const ask = async (service: SignInTarget['service']): Promise<PluginHostSignIn> => {
      if (service.supportsPluginGitHubSignIn !== true || !service.pluginGitHubSignIn) return { ...about, state: service.supportsPluginAccountCopies === true ? 'too-old' : 'no-plugins' }
      const signIn = await service.pluginGitHubSignIn()
      return signIn.state === 'signed-in' ? { ...about, state: 'signed-in', login: signIn.login } : { ...about, state: signIn.state }
    }
    try { return await ask(target.service) } catch {
      // The connection the read was on may have been replaced while it waited, as a move to the tailnet does.
      const now = connectionOf(hostId)
      if (now && now.service !== target.service) { try { return await ask(now.service) } catch { /* It did not answer there either. */ } }
      return { ...about, state: 'unknown' }
    }
  }))
}
