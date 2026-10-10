import { createAgentControl } from './agentControlFixture'
import { testCredentials } from './testCredentials'
import { deserialize, serialize } from 'node:v8'
import { vi } from 'vitest'
import { AgentControl, type PublishScheduler } from '../../src/main/agents/control'

import { LocalHostService } from '../../src/main/agents/hostService'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { registerAgentIpc } from '../../src/main/agents/ipc'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { ipcRegistry } from './ipcHarness'
import { createSottoBridge } from '../../src/preload'
import { wrapAgentBridge } from '../../src/renderer/src/agents/agentStateCatalogs'
import { AGENT_COMMAND, AGENT_STATE, type AgentBridge, type AgentHostSnapshot, type AgentModel, type AgentState, type AgentWireBridge } from '../../src/shared/agents'
import { syntheticModelCatalog } from './modelCatalog'

/*
 * The main window's side of a command receipt (issue #323), joined as `src/main/index.ts` joins it: the
 * `AGENT_COMMAND` handler with the broadcaster's receipt encoder, the desktop host router and the local
 * host service over the fixture coordinator, an IPC stand-in that copies every message the way a
 * structured clone would, the preload's bridge and the page's wrapped bridge that `AgentContext` reads.
 * The broadcast is sent by hand through the same broadcaster, so the window holds exactly what main
 * recorded as sent. A test file that uses it mocks `electron` first, as the preload imports it.
 */

export const RECEIPT_HOST_ID = '11111111-1111-4111-8111-111111111111'

/** The fixture host with a large catalog after its own model, which a test can change as a provider would. */
export class CatalogHost extends E2EAgentHost {
  catalog: AgentModel[] = syntheticModelCatalog()
  override async snapshot(): Promise<AgentHostSnapshot> {
    const snapshot = await super.snapshot()
    return { ...snapshot, models: [...snapshot.models, ...structuredClone(this.catalog)] }
  }
}

/** What a structured clone makes of `value`; `node:v8`'s `serialize` stands in for Electron's. */
export const clone = <T>(value: T): T => deserialize(serialize(value)) as T

export interface CommandReceiptWindow {
  readonly control: AgentControl
  readonly host: CatalogHost
  readonly router: DesktopHostRouter
  readonly broadcaster: AgentStateBroadcaster
  /** Main's handler for `channel`, called as the main window and answered without the copy. */
  handle(channel: string, ...args: unknown[]): Promise<unknown>
  /** The preload's own bridge over the IPC stand-in, and the page's wrapped one. */
  readonly preload: AgentWireBridge
  readonly page: AgentBridge
  /** Every message that crossed from main to the window, as it arrived there. */
  readonly wire: Array<{ channel: string; payload: unknown }>
  /** Every state the page's `onState` listener was given. */
  readonly seen: AgentState[]
  /** When set, the stand-in answers `AGENT_COMMAND` with this and never asks main. */
  held: { reply: unknown } | null
  /** Sends the router's shell through the broadcaster to the window. */
  broadcast(): void
  dispose(): void
}

export async function commandReceiptWindow(root: string, schedule: PublishScheduler): Promise<CommandReceiptWindow> {
  const host = new CatalogHost()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = createAgentControl({ schedule, directory: root, host, credentials, reasoner: e2eAgentReasoner,
  })
  await control.start(); await control.command({ type: 'connect' })

  const router = new DesktopHostRouter(() => emptyDesktopState(RECEIPT_HOST_ID))
  router.add({ hostId: RECEIPT_HOST_ID, name: 'This computer', kind: 'local', service: new LocalHostService({ control }),
    detail: threadId => control.threadDetail(threadId), preview: () => null })

  const registry = ipcRegistry({ mainUrl: 'file:///main.html' })
  const { ipc, main } = registry
  const broadcaster = new AgentStateBroadcaster()
  const unregister = registerAgentIpc(ipc, router, router, () => [main], 'win32', { status: vi.fn(), download: vi.fn() },
    { synthesize: vi.fn(), voices: vi.fn(), cancel: vi.fn() }, { synthesize: vi.fn(), cancel: vi.fn() }, { voiceCoordinatorEnabled: true, wakeControl: control, encodeReceipt: broadcaster.encodeReceipt })
  const handle = (channel: string, ...args: unknown[]): Promise<unknown> => registry.invoke(channel, args)

  const wire: Array<{ channel: string; payload: unknown }> = []
  const seen: AgentState[] = []
  let held: { reply: unknown } | null = null
  let listener: ((event: unknown, payload: unknown) => void) | null = null
  const renderer = {
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === AGENT_COMMAND && held !== null) return held.reply
      const payload = clone(await handle(channel, ...args))
      wire.push({ channel, payload })
      return payload
    },
    on: (channel: string, next: (event: unknown, payload: unknown) => void) => { if (channel === AGENT_STATE) listener = next },
    removeListener: () => undefined,
  }
  const preload = createSottoBridge(renderer, 'win32').agents!
  const page = wrapAgentBridge(preload)
  page.onState(state => seen.push(state))
  return {
    control, host, router, broadcaster, handle, preload, page, wire, seen,
    get held() { return held },
    set held(value) { held = value },
    broadcast: () => { broadcaster.send(router.shell(), 'main', payload => { listener!({}, clone(payload)); return true }) },
    dispose: () => { unregister(); router.dispose(); control.dispose() },
  }
}
