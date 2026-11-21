import { startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { DesktopHosts } from '../../src/main/hosts/desktopHosts'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'

type HeadlessOptions = Parameters<typeof startHeadlessHost>[0]

/**
 * Fresh providers per call. The surrounding fixture still owns listeners, storage and shutdown. Muse, OpenCode, Hermes and Cursor get
 * fakes too: a host runs them now they are sent to stable (Cursor on November 17, 2026), and one real adapter that sends events would make the host
 * read every thread's history from events, which these fakes do not send. A provider passed as `undefined` keeps its real
 * adapter, for a test that needs a host reading history from events.
 */
type HostProviders = NonNullable<HeadlessOptions['providers']>
export function startFixtureHeadlessHost(options: Omit<HeadlessOptions, 'providers'> & { providers?: { [K in keyof HostProviders]?: HostProviders[K] | undefined } }) {
  const { providers, ...settings } = options
  const chosen = { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(),
    muse: new E2EAgentHost(), opencode: new E2EAgentHost(), hermes: new E2EAgentHost(), cursor: new E2EAgentHost(), antigravity: new E2EAgentHost(), ...providers }
  return startHeadlessHost({ reasoner: e2eAgentReasoner, ...settings,
    providers: Object.fromEntries(Object.entries(chosen).filter(([, host]) => host !== undefined)) as HostProviders })
}

/** Borrow credentials and preserve the caller's launcher, local-host policy and start timing. */
export function desktopHostStack(options: Omit<ConstructorParameters<typeof DesktopHosts>[0], 'router'>) {
  const router = new DesktopHostRouter(emptyDesktopState)
  const manager = new DesktopHosts({ ...options, router })
  return { router, manager }
}
