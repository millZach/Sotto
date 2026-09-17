// Shared controller/store boundary for draft handoff regressions. All storage/provider effects are synthetic.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { BindRequestDraftDecision } from '../../src/main/agents/requestDrafts'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import type { AgentHostCommand } from '../../src/main/agents/host'
import { agentCommandSchema, type AgentCommand, type AgentState } from '../../src/shared/agents'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'
import { immediatePublishScheduler } from './publishScheduler'

export async function draftHandoffFixture(bindRequestDraftDecision?: BindRequestDraftDecision) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-draft-handoff-'))
  const host = new E2EAgentHost()
  const attempts: AgentHostCommand[] = []
  const execute = host.execute.bind(host)
  host.execute = command => { attempts.push(command); return execute(command) }
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: text => text.toString() })
  await credentials.load()
  let history = true
  const create = () => new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, ...(bindRequestDraftDecision ? { bindRequestDraftDecision } : {}), historyEnabled: () => history,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
  let control = create(); await control.start(); await control.command({ type: 'connect' })
  const stores: ThreadDraftStore[] = []; const off: (() => void)[] = []; const pending = new Map<Promise<unknown>, AgentCommand>()
  const command = (request: AgentCommand) => control.command(agentCommandSchema.parse(request))
  return { root, host, attempts, command, get control() { return control },
    disk: async () => JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')),
    setHistory: (enabled: boolean) => { history = enabled },
    store(send: (request: AgentCommand) => Promise<AgentState | null> = command) {
      const store = new ThreadDraftStore(request => {
        const task = send(request); pending.set(task, request)
        void task.finally(() => pending.delete(task)).catch(() => undefined)
        return task
      }, 60000, randomUUID)
      stores.push(store); store.receive(control.get()); off.push(control.subscribe(state => store.receive(state)))
      return store
    },
    async flush(store: ThreadDraftStore, threadId: string, retry = false) {
      store.flush(threadId, retry)
      await Promise.allSettled([...pending].filter(([, request]) => request.type === 'save-thread-draft' && request.threadId === threadId).map(([task]) => task))
    },
    async restart() {
      for (const unsubscribe of off.splice(0)) unsubscribe()
      control.dispose(); await control.privacyChanged(); control = create(); await control.start(); await control.command({ type: 'connect' })
    },
    async close() {
      for (const store of stores) store.flushAll()
      await Promise.allSettled([...pending.keys()])
      for (const unsubscribe of off) unsubscribe()
      control.dispose(); await control.privacyChanged()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-draft-handoff-')) throw new Error('Unexpected fixture path')
      await rm(root, { recursive: true, force: true })
    },
  }
}
