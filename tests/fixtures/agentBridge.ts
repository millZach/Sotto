import { agentShell, type AgentBridge, type AgentWireBridge } from '../../src/shared/agents'
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
    onThreadDetail: listener => control.subscribeThreadDetail(listener),
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
 * reassembly (`wrapAgentBridge`) reads what main would send. Every broadcast is taken as delivered.
 */
export function agentWireBridge(bridge: AgentBridge, broadcaster = new AgentStateBroadcaster()): AgentWireBridge {
  return {
    ...bridge,
    command: async request => broadcaster.encodeReceipt(await bridge.command(request)),
    onState: listener => bridge.onState(state => { broadcaster.send(state, payload => { listener(payload); return true }) }),
  }
}
