import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AgentControl } from '../../src/main/agents/control'
import type { AgentCredentials } from '../../src/main/agents/credentials'
import type { AgentHost } from '../../src/main/agents/host'
import type { AgentReasoner } from '../../src/main/agents/reasoning'
import { immediatePublishScheduler } from './publishScheduler'
import { testCredentials, type TestCredentialOptions } from './testCredentials'

export type AgentControlOptions = ConstructorParameters<typeof AgentControl>[0]
export type TestControlOptions = Omit<AgentControlOptions, 'directory' | 'host' | 'credentials' | 'reasoner'>

export function stubAgentReasoner(overrides: Partial<AgentReasoner> = {}): AgentReasoner {
  return { ...overrides }
}

/** Unstarted control; also usable for restart tests with already loaded credentials. */
export function createAgentControl(options: Pick<AgentControlOptions, 'directory' | 'host' | 'credentials'> &
  TestControlOptions & { reasoner?: AgentReasoner }): AgentControl {
  return new AgentControl({ schedule: immediatePublishScheduler, reasoner: stubAgentReasoner(), ...options })
}

export type AgentControlFixtureOptions<H extends AgentHost> = {
  host: H
  /** Supplied storage is borrowed and is never removed by this fixture. */
  directory?: string
  credentialsDirectory?: string
  reasoner?: AgentReasoner
  control?: TestControlOptions
} & ({ credentials: AgentCredentials; credentialOptions?: never } |
  { credentials?: never; credentialOptions: TestCredentialOptions })

/** Owns storage only when it creates it. Start/connect timing and host disposal belong to the caller. */
export async function agentControlFixture<H extends AgentHost>(options: AgentControlFixtureOptions<H>) {
  const owned = options.directory === undefined
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'sotto-control-fixture-'))
  const controls: AgentControl[] = []
  const remove = async () => {
    if (!owned) return
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-control-fixture-')) throw new Error('Unexpected fixture directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  try {
    const credentialsDirectory = options.credentialsDirectory ?? join(directory, 'vault')
    const credentials = options.credentials ?? await testCredentials(credentialsDirectory, options.credentialOptions!)
    const reasoner = options.reasoner ?? stubAgentReasoner()
    let disposing: Promise<void> | undefined
    const create = (patch: TestControlOptions = {}) => {
      if (disposing) throw new Error('Fixture is disposed')
      const control = createAgentControl({ directory, host: options.host, credentials, reasoner, ...options.control, ...patch })
      controls.push(control)
      return control
    }
    const control = create()
    return { directory, root: directory, credentialsDirectory, credentials, host: options.host, reasoner, control, create,
      dispose: () => disposing ??= (async () => {
        for (const item of controls) item.dispose()
        const drained = await Promise.allSettled(controls.map(item => item.privacyChanged()))
        await remove()
        const failed = drained.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })(),
    }
  } catch (error) { await remove(); throw error }
}
