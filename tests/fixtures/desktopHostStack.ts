import { startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { DesktopHosts } from '../../src/main/hosts/desktopHosts'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'

type HeadlessOptions = Parameters<typeof startHeadlessHost>[0]

/** Fresh providers per call. The surrounding fixture still owns listeners, storage and shutdown. */
export function startFixtureHeadlessHost(options: HeadlessOptions) {
  const { providers, ...settings } = options
  return startHeadlessHost({ reasoner: e2eAgentReasoner, ...settings,
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), ...providers } })
}

/** Borrow credentials and preserve the caller's launcher, local-host policy and start timing. */
export function desktopHostStack(options: Omit<ConstructorParameters<typeof DesktopHosts>[0], 'router'>) {
  const router = new DesktopHostRouter(emptyDesktopState)
  const manager = new DesktopHosts({ ...options, router })
  return { router, manager }
}
