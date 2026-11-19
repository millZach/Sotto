// The TypeScript headless host as the referee harness starts it (`tests/referee/`, docs/plans/2026-11-14-rust-native-port.md,
// Stage 0 item 3): the real host, `startHeadlessHost`, with one provider's adapter pointed at that provider's fake program in
// `tests/fixtures`. It is started by a plain command line and spoken to only over its socket, as a host in another language
// will be, so it takes nothing a foreign host could not: `--data <folder> --provider <id>`, and the same ready line on
// stdout and SIGTERM handling as `out/host/index.js`.
//
// Main's own code runs here, so English is active first, as it is in main (tests/fixtures/desktopMainBundle.ts).
import '../../src/main/interfaceLanguage'
import { startHeadlessHost } from '../../src/host'
import { HeldProviderHost } from '../../src/main/agents/heldProviderGate'
import { ProviderClients } from '../../src/main/agents/providerClients'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { providerIdSchema, type ProviderId } from '../../src/shared/agents'
import { claudeFixture } from './claudeFixture'
import { codexFixture } from './codexFixture'
import { devinFixture } from './devinFixture'
import { grokFixture } from './fakeGrokThreadFixture'
import { museFixture } from './museFixture'
import { opencodeFixture } from './fakeOpenCodeFixture'
import { cursorFixture } from './fakeCursorFixture'
import { REFEREE_OWL_VERSION } from '../referee/providers'

/**
 * Each provider's adapter over its fake, made by its own fixture with the fixture's own deadlines, which cover a loaded
 * runner (Devin's 15 seconds among them). The fake takes the host's data folder as its own, where the referee's driver
 * finds its control file.
 */
const factories: Partial<Record<ProviderId, (root: string) => Promise<{ host: unknown }>>> = {
  codex: root => codexFixture(root, false), claude: root => claudeFixture(root), grok: root => grokFixture(root),
  devin: root => devinFixture(root), muse: root => museFixture(root), opencode: root => opencodeFixture(root),
  cursor: root => cursorFixture(root),
}

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`The referee host needs ${name}.`)
  return value
}

async function main(): Promise<void> {
  const root = argument('--data'), provider = argument('--provider') as ProviderId
  const factory = factories[provider]
  if (!factory) throw new Error(`The referee host has no fake for ${provider}.`)
  const native = await factory(root)
  // Every other provider is held, so the host starts nothing for it and its state names none of it: a recording holds
  // only the provider it is about, and no real client on this machine is looked for. The reasoner is the end-to-end
  // stand-in, so nothing reaches a network.
  const providers = Object.fromEntries(providerIdSchema.options.map(id => [id, id === provider ? native.host : new HeldProviderHost(id)]))
  // One Owl version for every provider, so every recording is made with the same features on and OpenCode and Cursor,
  // Owl providers (ADR-0087, ADR-0128), are hosted at all.
  // The client update check (ADR-0042) asks the providers' registries what each client publishes, npm and mise what is
  // installed, and this machine's PATH where each real client is. Here it reaches none of them: a recording must not depend
  // on the network, nor on which provider clients the machine that made it has installed, nor say which those are.
  const offline = async (): Promise<never> => { throw new Error('The referee host reaches no registry and runs no installer.') }
  const clients = new ProviderClients({ fetchImpl: offline, run: offline, npmPath: async () => undefined, misePath: async () => undefined, miseReleaseAgeFlag: async () => false })
  const host = await startHeadlessHost({ dataDirectory: root, port: 0, sottoVersion: REFEREE_OWL_VERSION, reasoner: e2eAgentReasoner, clients, locateClient: async () => undefined,
    providers: providers as Parameters<typeof startHeadlessHost>[0]['providers'] })
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void host.close().then(() => process.exit(0), () => { console.error('referee-host-shutdown-failed'); process.exit(1) })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.stdout.write(JSON.stringify({ ...host.descriptor, event: 'ready' }) + '\n')
}

void main().catch(error => { console.error('referee-host-start-failed', error instanceof Error ? error.message : ''); process.exit(1) })
