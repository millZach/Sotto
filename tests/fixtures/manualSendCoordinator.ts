import { join } from 'node:path'
import { AgentControl } from '../../src/main/agents/control'
import type { AgentHost } from '../../src/main/agents/host'
import type { AgentReasoner } from '../../src/main/agents/reasoning'
import { createAgentControl } from './agentControlFixture'
import { testCredentials } from './testCredentials'

/**
 * A coordinator over `host` with unavailable credential encryption under `directory`, a reasoner that decides nothing
 * unless given `decide`, enough for a manual send, and for a supervision follow-up when
 * `decide` answers one. The caller starts, connects and disposes it.
 */
export async function manualSendCoordinator(directory: string, host: AgentHost,
  decide: AgentReasoner['decide'] = async () => ({ decision: 'human', text: 'Review' })): Promise<AgentControl> {
  const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
  return createAgentControl({ directory, host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide },
  })
}
