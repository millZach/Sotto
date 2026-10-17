// Stands in for an installed host/index.js in tests/integration/hostSelfUpdate.test.ts: the real headless host, with
// scripted providers in place of real ones and no Tailscale, built into a host installation the test lays out the way a
// release does. It runs from that installation, so it updates itself when a paired desktop asks over its socket (ADR-0088),
// from the stand-in releases page SOTTO_TEST_HOST_RELEASES_URL names, which only this test entry reads.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseHostArguments, runHeadlessCommandLine, startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { e2eTailscale } from '../../src/main/e2e/tailscale'

const ADMIN = new Set(['--pairing-code', '--allow-answers', '--deny-answers', '--revoke-client'])
/** The version of the install this runs from, the way a release says it: the package.json beside its `host` folder. */
function installedVersion(): string {
  return (JSON.parse(readFileSync(join(dirname(process.argv[1]!), '..', 'package.json'), 'utf8')) as { version: string }).version
}
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.some(argument => ADMIN.has(argument))) { await runHeadlessCommandLine(); return }
  const options = parseHostArguments(args)
  delete process.env.SOTTO_HOST_STARTED_BY
  const releasesUrl = process.env.SOTTO_TEST_HOST_RELEASES_URL
  const host = await startHeadlessHost({ ...options, sottoVersion: installedVersion(), entryPath: process.argv[1]!, ...(releasesUrl ? { releasesUrl } : {}),
    // This machine's Tailscale is never touched: the host reads it as not installed.
    tailscale: e2eTailscale(options.dataDirectory),
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  const keepAlive = setInterval(() => undefined, 60_000)
  const stop = (): void => { clearInterval(keepAlive); void host.close().finally(() => process.exit(0)) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
void main().catch(() => { process.exitCode = 1 })
