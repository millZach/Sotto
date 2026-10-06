// Stands in for an installed host/index.js in the Add host journey (tests/e2e/host-setup.spec.ts): the real
// headless host and its administration flags, with scripted providers in place of real ones. The spec builds
// it into a fake host installation, where the real launch script, run by the fake ssh, starts it.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseHostArguments, runHeadlessCommandLine, startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { e2eTailscale } from '../../src/main/e2e/tailscale'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import { fakeSignInCommand, signInProviders } from './signInProviders'
import { clientUpdateHost } from './clientUpdateProviders'
import { homedir } from 'node:os'

/** A provider installed on the host but not signed in there: its connect fails, as Claude Code's did on forge (#459). */
class SignedOut extends E2EAgentHost {
  override async connect(): Promise<AgentHostSnapshot> { throw new Error('Sign in to this provider on the host machine, then connect it again.') }
}

const ADMIN = new Set(['--pairing-code', '--allow-answers', '--deny-answers', '--revoke-client'])
/**
 * The version of the install this runs from, the way a release says it: the package.json beside its `host` folder. The
 * host update journey (tests/e2e/host-update.spec.ts) installs one as an older release and updates it to this build.
 */
function installedVersion(): { sottoVersion?: string } {
  try {
    const version: unknown = (JSON.parse(readFileSync(join(dirname(process.argv[1]!), '..', 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' ? { sottoVersion: version } : {}
  } catch { return {} }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.some(argument => ADMIN.has(argument))) { await runHeadlessCommandLine(); return }
  const options = parseHostArguments(args)
  delete process.env.SOTTO_HOST_STARTED_BY
  // The host's phone access reads e2e-tailscale.json in SOTTO_E2E_HOST_TAILSCALE_DIR in place of this machine's Tailscale
  // (src/main/e2e/tailscale.ts), so a spec can turn phones on for forge and see each failure (ADR-0050). Without it, the host
  // reads Tailscale as not installed: Add host turns on its tailnet connections (ADR-0053), and a spec must never change
  // the Serve settings of the machine it runs on.
  options.tailscale = e2eTailscale(process.env.SOTTO_E2E_HOST_TAILSCALE_DIR ?? options.dataDirectory)
  // With SOTTO_E2E_SIGN_IN_DIR, each provider is signed out until its fake client's sign-in (tests/fixtures/fakeSignInCli.mjs,
  // at SOTTO_E2E_SIGN_IN_SCRIPT) writes its mark there, and the host runs that fake client for Sign in (#460).
  const signInDirectory = process.env.SOTTO_E2E_SIGN_IN_DIR, signInScript = process.env.SOTTO_E2E_SIGN_IN_SCRIPT
  if (signInDirectory && signInScript) {
    const host = await startHeadlessHost({ ...options, ...installedVersion(), providers: signInProviders(signInDirectory), reasoner: e2eAgentReasoner, signInCommand: fakeSignInCommand(signInDirectory, signInScript) })
    keepRunning(() => host.close())
    return
  }
  // With SOTTO_E2E_CLIENT_UPDATES_DIR, forge's mise-installed clients on September 29, all behind (#480).
  const updates = process.env.SOTTO_E2E_CLIENT_UPDATES_DIR
  if (updates) {
    const { clients, locateClient, providers } = clientUpdateHost(updates, homedir())
    const host = await startHeadlessHost({ ...options, ...installedVersion(), providers, clients, locateClient, reasoner: e2eAgentReasoner })
    keepRunning(() => host.close())
    return
  }
  // While the file SOTTO_E2E_HOST_SIGNED_OUT names exists, this host starts with every provider signed out.
  const signedOut = Boolean(process.env.SOTTO_E2E_HOST_SIGNED_OUT && existsSync(process.env.SOTTO_E2E_HOST_SIGNED_OUT))
  const provider = (): E2EAgentHost => signedOut ? new SignedOut() : new E2EAgentHost()
  const host = await startHeadlessHost({ ...options, ...installedVersion(), providers: { codex: provider(), claude: provider(), grok: provider(), devin: provider() }, reasoner: e2eAgentReasoner })
  keepRunning(() => host.close())
}
function keepRunning(close: () => Promise<void>): void {
  const keepAlive = setInterval(() => undefined, 60_000)
  const stop = (): void => { clearInterval(keepAlive); void close().finally(() => process.exit(0)) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
void main().catch(() => { process.exitCode = 1 })
