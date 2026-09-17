import { agentShell, type AgentBridge } from '../../src/shared/agents'
import type { AgentControl } from '../../src/main/agents/control'

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
    ...overrides,
  }
}
