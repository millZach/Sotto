// Stands in for an installed host/index.js in tests/integration/hostSelfUpdate.test.ts and desktopHostSelfUpdate.test.ts:
// the real headless host, with scripted providers in place of real ones and no Tailscale, built into a host installation
// the test lays out the way a release does. It runs from that installation, so it updates itself when a paired desktop
// asks over its socket (ADR-0088), from the stand-in releases page SOTTO_TEST_HOST_RELEASES_URL names, which only this test
// entry reads. Its Tailscale is the end-to-end stand-in, which reads `e2e-tailscale.json` in the data folder; while Serve
// carries the tailnet listener, the listener's loopback port is in `serve-stand-in.json` there, for a test's Serve stand-in.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseHostArguments, runHeadlessCommandLine, startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { e2eTailscale } from '../../src/main/e2e/tailscale'

const ADMIN = new Set(['--pairing-code', '--allow-answers', '--deny-answers', '--revoke-client'])
/** The version of the install this runs from, the way a release says it: the package.json beside its `host` folder. */
function installedVersion(): string {
  return (JSON.parse(readFileSync(join(dirname(process.argv[1]!), '..', 'package.json'), 'utf8')) as { version: string }).version
}
/** The end-to-end Tailscale, which also says where Serve would carry the tailnet listener, for the test's Serve stand-in. */
function standInServe(dataDirectory: string): ReturnType<typeof e2eTailscale> {
  const tailscale = e2eTailscale(dataDirectory), file = join(dataDirectory, 'serve-stand-in.json')
  return { ...tailscale,
    serve: async (port, loopback) => {
      const result = await tailscale.serve(port, loopback)
      if (result.ok) writeFileSync(file, JSON.stringify({ port: loopback }))
      return result
    },
    unserve: async port => { rmSync(file, { force: true }); return tailscale.unserve(port) } }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.some(argument => ADMIN.has(argument))) { await runHeadlessCommandLine(); return }
  const options = parseHostArguments(args)
  delete process.env.SOTTO_HOST_STARTED_BY
  const releasesUrl = process.env.SOTTO_TEST_HOST_RELEASES_URL
  const host = await startHeadlessHost({ ...options, sottoVersion: installedVersion(), entryPath: process.argv[1]!, ...(releasesUrl ? { releasesUrl } : {}),
    // This machine's Tailscale is never touched: the host reads it as not installed unless the test's file says otherwise.
    tailscale: standInServe(options.dataDirectory),
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  const keepAlive = setInterval(() => undefined, 60_000)
  const stop = (): void => { clearInterval(keepAlive); void host.close().finally(() => process.exit(0)) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
void main().catch(() => { process.exitCode = 1 })
