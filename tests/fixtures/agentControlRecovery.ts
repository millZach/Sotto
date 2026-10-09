import { createAgentControl } from './agentControlFixture'
import { testCredentials, xorCredentialEncryption } from './testCredentials'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, vi } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { type CredentialEncryption } from '../../src/main/agents/credentials'
import { ConfiguredAgentReasoner, type AgentDecision, type AgentIntent } from '../../src/main/agents/reasoning'
import type { AgentHostCommand, AgentHostResult } from '../../src/main/agents/host'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import { type AgentConfiguration } from '../../src/shared/agents'
import { immediatePublishScheduler } from './publishScheduler'

const roots: string[] = []

const controls: AgentControl[] = []

export const ROUTER_KEY = 'fixture-openrouter-key'

export const OPENAI_KEY = 'fixture-openai-key'

// Only external effects are replaced: OS encryption, native coding adapters, and provider HTTP.
// The controller, configured reasoner, and durable credential/state stores are real.
export const encryption: CredentialEncryption = xorCredentialEncryption()

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

type HostEvent = Parameters<E2EAgentHost['event']>[0]

export class DispatchEventHost extends E2EAgentHost {
  sendCalls = 0
  constructor(private readonly eventsAfterSend: readonly (readonly HostEvent[])[]) { super() }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    const result = await super.execute(command)
    if (command.type === 'send') {
      for (const event of this.eventsAfterSend[this.sendCalls++] ?? []) this.event(event)
    }
    return result
  }
}

export async function fixture(host = new E2EAgentHost(), options: { coordinatorEnabled?: () => boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-control-recovery-'))
  roots.push(root)
  const credentialsDirectory = join(root, 'vault')
  const credentials = await testCredentials(credentialsDirectory, { encryption: encryption })
  const service = { offline: false, intent: { type: 'select-project', projectId: 'project' } as AgentIntent,
    decision: { decision: 'followup', text: 'Fix the current failing test within the assigned scope.' } as AgentDecision,
    decisionGate: null as Promise<void> | null }
  const requests: { origin: string; authorization: string | null; utterance: string }[] = []
  const decisions: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
    const message = JSON.parse(body.messages[1]!.content) as { utterance?: string; messages?: { text: string }[] }
    if (message.utterance !== undefined) requests.push({ origin: new URL(String(input)).origin,
      authorization: new Headers(init?.headers).get('authorization'), utterance: message.utterance })
    else decisions.push(message.messages?.at(-1)?.text ?? '')
    if (service.offline) throw new TypeError('Fixture provider is offline')
    if (message.utterance === undefined) await service.decisionGate
    const result = message.utterance === undefined ? service.decision : service.intent
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
  })
  let control: AgentControl
  const reasoner = new ConfiguredAgentReasoner(() => control.get().configuration, credentials)
  const create = async (): Promise<void> => {
    control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner, ...options,
    })
    controls.push(control)
    await control.start()
    if (!control.get().host.connected) await control.command({ type: 'connect' })
  }
  await create()
  return {
    root, credentialsDirectory, credentials, host, requests, decisions, service,
    get control() { return control },
    async restart() { control.dispose(); await create() },
    async account(provider: AgentConfiguration['reasoning'] = 'openrouter', key = ROUTER_KEY) {
      await control.command({ type: 'configure', patch: { reasoning: provider, reasoningModel: 'fixture-model' } })
      await control.command({ type: 'credential', slot: 'reasoning', value: key })
    },
    async clarification() {
      await this.account()
      service.intent = { type: 'clarify', text: 'Which folder should contain the project?' }
      return control.command({ type: 'utterance', text: 'Create a project called Lantern.' })
    },
  }
}

export function registerAgentControlRecoveryCleanup(): void {
  afterEach(async () => {
    for (const control of controls.splice(0)) {
      control.dispose()
      // Disposal stops new work; drain the serialized stores before deleting the
      // fixture directory while a final supervision snapshot may still be writing.
      await Promise.allSettled([control.privacyChanged()]) // Some cases deliberately make agents.json unwritable.
    }
    vi.unstubAllGlobals()
    for (const root of roots.splice(0)) {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-control-recovery-')) throw new Error('Unexpected temporary test directory')
      await rm(root, { recursive: true, force: true })
    }
  })
}
