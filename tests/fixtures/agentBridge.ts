import { agentShell, type AgentBridge, type AgentStateBroadcast, type AgentWireBridge } from '../../src/shared/agents'
import type { AgentControl } from '../../src/main/agents/control'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'

/**
 * A bridge over a real `AgentControl`, carrying what the preload carries: the shell on the state
 * channel, and each thread's history on the detail channel or by request. Tests that mount the window
 * over a live coordinator use this so the split main actually publishes is the split they exercise.
 */
export function agentBridgeFor(control: AgentControl, overrides: Partial<AgentBridge> = {}): AgentBridge {
  return {
    get: async () => control.shell(),
    command: request => control.command(request).then(agentShell),
    onState: listener => control.subscribe(listener),
    onThreadDetail: listener => control.subscribeThreadDetail(listener, { appends: true }),
    threadDetail: async threadId => control.threadDetail(threadId),
    stageAttachment: ({ name, mimeType, bytes }) => control.stageAttachment({ name, mimeType, bytes }),
    attachmentContent: request => control.attachmentContent(request.digest),
    ...overrides,
  }
}

/**
 * `bridge` as the preload hands it to the page (ADR-0028): every broadcast encoded for the main window and
 * every command reply encoded as a command receipt by a real `AgentStateBroadcaster`. A test that installs a
 * bridge as `window.sotto.agents` wraps it in this, so the page's own catalog
 * and thread reassembly (`wrapAgentBridge`) reads what main would send. Every broadcast is taken as delivered.
 *
 * Main encodes each publish once for the window, however many listeners the page has, so every listener here is
 * handed the same broadcast: one per listener would advance the thread base once per listener, and each would be
 * measured from a broadcast only another listener was sent.
 */
export function agentWireBridge(bridge: AgentBridge, broadcaster = new AgentStateBroadcaster()): AgentWireBridge {
  const listeners = new Set<(payload: AgentStateBroadcast) => void>()
  let unsubscribe: (() => void) | null = null
  return {
    ...bridge,
    // A read of the whole state tells the broadcaster, as `AGENT_GET` does, so the next broadcast lists every thread.
    get: () => { broadcaster.windowRead(); return bridge.get() },
    command: async request => broadcaster.encodeReceipt(await bridge.command(request)),
    onState: listener => {
      const entry = (payload: AgentStateBroadcast): void => { listener(payload) }
      listeners.add(entry)
      unsubscribe ??= bridge.onState(state => {
        broadcaster.send(state, payload => { for (const each of [...listeners]) each(payload); return true })
      })
      return () => {
        listeners.delete(entry)
        if (listeners.size === 0) { unsubscribe?.(); unsubscribe = null }
      }
    },
  }
}
