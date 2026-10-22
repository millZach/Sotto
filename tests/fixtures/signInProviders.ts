import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ProviderId, AgentHostSnapshot } from '../../src/shared/agents'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import { ProviderUnavailable } from '../../src/main/agents/providerProblem'
import { PROVIDER_SIGN_IN_ARGS, type SignInCommand } from '../../src/host/providerSignIn'

/**
 * A scripted provider that is installed on the host and signed out there until its fake client's sign-in writes
 * `<provider>.signed-in` in `directory` (tests/fixtures/fakeSignInCli.mjs), as a real client's credential appears once it
 * signs in. Devin is not installed, as on forge, until `devin.installed` appears there, as an agent's install would put
 * it where the host looks (#461).
 */
export class SignedOutUntilSignIn extends E2EAgentHost {
  constructor(private readonly provider: ProviderId, private readonly directory: string) { super() }
  override async connect(): Promise<AgentHostSnapshot> {
    if (this.provider === 'devin' && !existsSync(join(this.directory, 'devin.installed'))) throw new ProviderUnavailable('not-installed', 'Install Devin CLI and run devin auth login, then connect again. Your threads and drafts are kept.')
    if (!existsSync(join(this.directory, `${this.provider}.signed-in`))) throw new ProviderUnavailable('signed-out', 'Sign in to this provider on the host machine, then connect it again.', '1.0.0')
    return super.connect()
  }
}
export function signInProviders(directory: string): Record<ProviderId, SignedOutUntilSignIn> {
  return { codex: new SignedOutUntilSignIn('codex', directory), claude: new SignedOutUntilSignIn('claude', directory),
    grok: new SignedOutUntilSignIn('grok', directory), devin: new SignedOutUntilSignIn('devin', directory), muse: new SignedOutUntilSignIn('muse', directory), opencode: new SignedOutUntilSignIn('opencode', directory) }
}
/** Each provider's sign-in, run as the fake client under this Node, with only what it needs in its environment. */
export function fakeSignInCommand(directory: string, script = resolve('tests/fixtures/fakeSignInCli.mjs'), page?: string, split?: string) {
  return async (provider: ProviderId): Promise<SignInCommand | undefined> => PROVIDER_SIGN_IN_ARGS[provider] === null ? undefined : {
    executable: process.execPath,
    args: [script, provider, ...PROVIDER_SIGN_IN_ARGS[provider] ?? []],
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', FAKE_SIGN_IN_DIR: directory, ...(page ? { FAKE_SIGN_IN_PAGE: page } : {}), ...(split ? { FAKE_SIGN_IN_SPLIT: split } : {}) },
  }
}
