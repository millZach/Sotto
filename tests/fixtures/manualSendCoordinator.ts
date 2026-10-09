import { join } from 'node:path'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import type { AgentHost } from '../../src/main/agents/host'
import { immediatePublishScheduler } from './publishScheduler'

/** A manual coordinator over the scripted host. The caller starts, connects and disposes it. */
export async function manualSendCoordinator(directory: string, host: AgentHost): Promise<AgentControl> {
  const credentials = new AgentCredentials(join(directory, 'vault'), { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  return new AgentControl({ schedule: immediatePublishScheduler, directory, host, credentials,
    reasoner: {},
  })
}
