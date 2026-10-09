// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, vi } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../src/main/agents/credentials'
import type { AgentHostCommand, AgentHostResult } from '../../src/main/agents/host'
import { ConfiguredAgentReasoner } from '../../src/main/agents/reasoning'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import { type AgentConfiguration } from '../../src/shared/agents'
import { immediatePublishScheduler } from './publishScheduler'

const roots: string[] = []
const controls: AgentControl[] = []
export const ROUTER_KEY = 'fixture-openrouter-key'

// OS encryption and native coding adapters are scripted; coordinator and stores are real.
export const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)),
  decryptString: value => Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8'),
}

export class UnacknowledgedCreationHost extends E2EAgentHost {
  readonly creationAttempts: AgentHostCommand[] = []
  private pending: AgentHostCommand | null = null
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type !== 'create-project' && command.type !== 'create-thread') return super.execute(command)
    this.creationAttempts.push(command)
    this.pending = command
    return { accepted: false, uncertain: true }
  }
  async revealOriginalCreation(): Promise<void> {
    if (!this.pending) throw new Error('No fixture creation is pending')
    await super.execute(this.pending)
    this.pending = null
  }
}

export async function fixture(host = new E2EAgentHost()) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-control-recovery-'))
  roots.push(root)
  const credentialsDirectory = join(root, 'vault')
  const credentials = new AgentCredentials(credentialsDirectory, encryption)
  await credentials.load()
  let control: AgentControl
  const reasoner = new ConfiguredAgentReasoner()
  const create = async (): Promise<void> => {
    control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner,
    })
    controls.push(control)
    await control.start()
    if (!control.get().host.connected) await control.command({ type: 'connect' })
  }
  await create()
  return {
    root, credentialsDirectory, credentials, host,
    get control() { return control },
    async restart() { control.dispose(); await create() },
    async account(provider: AgentConfiguration['reasoning'] = 'openrouter', key = ROUTER_KEY) {
      await control.command({ type: 'configure', patch: { reasoning: provider, reasoningModel: 'fixture-model' } })
      await control.command({ type: 'credential', slot: 'reasoning', value: key })
    },

  }
}

export function registerAgentControlRecoveryCleanup(): void {
  afterEach(async () => {
    for (const control of controls.splice(0)) {
      control.dispose()
      // Disposal stops new work; drain the serialized stores before deleting the
      // fixture directory while a final snapshot may still be writing.
      await Promise.allSettled([control.privacyChanged()]) // Some cases deliberately make agents.json unwritable.
    }
    vi.unstubAllGlobals()
    for (const root of roots.splice(0)) {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-control-recovery-')) throw new Error('Unexpected temporary test directory')
      await rm(root, { recursive: true, force: true })
    }
  })
}
