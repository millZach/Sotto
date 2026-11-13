import type { GitHubSignIn, PluginHostSignIn } from '../../shared/plugins'

/** A connected host as GitHub's sign-in is read from it: its identity, and the read where it lists `plugin-github-sign-in`. */
export interface SignInTarget {
  readonly hostId: string
  readonly kind: 'local' | 'remote'
  readonly service: {
    readonly supportsPluginGitHubSignIn?: boolean | undefined
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
 * A host that is away cannot be asked, and one whose Sotto runs no plugin tools has nothing to say: its threads do
 * not use GitHub through Sotto. A host that does not answer is `unknown`, the same as a `gh` that would not say.
 * Only a name comes back, never a token.
 */
export async function readHostGitHubSignIns(computers: readonly SignInComputer[], connections: Iterable<SignInTarget>): Promise<PluginHostSignIn[]> {
  const connected = [...connections].filter(target => target.kind === 'remote')
  return Promise.all(computers.map(async (computer): Promise<PluginHostSignIn> => {
    const about = { computerId: computer.id, name: computer.name }
    const target = computer.connected && computer.hostId ? connected.find(entry => entry.hostId === computer.hostId) : undefined
    if (!target) return { ...about, state: 'away' }
    const { service } = target
    if (service.supportsPluginGitHubSignIn !== true || !service.pluginGitHubSignIn) return { ...about, state: 'no-plugins' }
    try {
      const signIn = await service.pluginGitHubSignIn()
      return signIn.state === 'signed-in' ? { ...about, state: 'signed-in', login: signIn.login } : { ...about, state: signIn.state }
    } catch {
      return { ...about, state: 'unknown' }
    }
  }))
}
