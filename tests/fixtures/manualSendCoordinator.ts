import { join } from 'node:path'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import type { AgentHost } from '../../src/main/agents/host'
import type { AgentReasoner } from '../../src/main/agents/reasoning'
import { immediatePublishScheduler } from './publishScheduler'

/**
 * A coordinator over `host` with a plain credential store under `directory`, a reasoner that decides nothing
 * unless given `decide`, enough for a manual send, and for a supervision follow-up when
 * `decide` answers one. The caller starts, connects and disposes it.
 */
export async function manualSendCoordinator(directory: string, host: AgentHost,
  decide: AgentReasoner['decide'] = async () => ({ decision: 'human', text: 'Review' })): Promise<AgentControl> {
  const credentials = new AgentCredentials(join(directory, 'vault'), { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  return new AgentControl({ schedule: immediatePublishScheduler, directory, host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide },
  })
}
