import { join } from 'node:path'
import { AgentControl } from '../../src/main/agents/control'
import type { AgentHost } from '../../src/main/agents/host'
import { createAgentControl } from './agentControlFixture'
import { testCredentials } from './testCredentials'

/** A manual coordinator over the scripted host. The caller starts, connects and disposes it. */
export async function manualSendCoordinator(directory: string, host: AgentHost): Promise<AgentControl> {
  const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
  return createAgentControl({ directory, host, credentials,
    reasoner: {},
  })
}
