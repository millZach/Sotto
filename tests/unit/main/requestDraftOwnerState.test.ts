// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { requestDraftOwnerState } from '../../../src/main/agents/requestDraftOwners'
import { RequestDraftService } from '../../../src/main/agents/requestDrafts'
import type { RequestAnswerRecovery } from '../../../src/main/agents/hostService'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { RequestDraftTarget } from '../../../src/shared/requestDrafts'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { testCredentials } from '../../fixtures/testCredentials'

const REMOTE = '22222222-2222-4222-8222-222222222222'
const questions = [{ id: 'question', question: 'Where?', multiSelect: false, allowFreeText: true, options: [] }]

function remoteHost(): DesktopHostConnection {
  const state = emptyDesktopState(REMOTE)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.threads = [{ id: 'thread', projectId: 'project', title: 'Task', modelId: '', status: 'idle', messages: [],
    requests: [{ id: 'request', kind: 'question', text: 'Question', options: [], questions }] }]
  const recovery: RequestAnswerRecovery = { uncertainRequestIds: [], completed: [] }
  return { hostId: REMOTE, name: 'Forge', kind: 'remote', detail: async () => null, preview: () => null, refreshRequestAnswer: async () => {},
    service: { shell: () => state, subscribe: () => () => {}, command: async () => state, requestAnswerRecovery: () => recovery } }
}

describe('a saved answer looking up its thread', () => {
  const roots: string[] = []
  const controls: AgentControl[] = []
  afterEach(async () => {
    for (const control of controls.splice(0)) control.dispose()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  // Recovery reconciles held answers on every published state, dozens of times a second while a provider
  // streams. `get()` copies every loaded thread's history: on a desktop with 195 threads each copy blocked
  // main for 200 to 430 ms, so clicks and typing lagged by seconds while one remote answer stayed held.
  it('reconciles a held answer on another host without copying this computer\'s histories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-draft-owner-'))
    roots.push(root)
    const control = createAgentControl({ directory: root, host: new E2EAgentHost(), credentials: await testCredentials(root, { mode: 'unavailable' }) })
    controls.push(control)
    await control.start()
    const router = new DesktopHostRouter(emptyDesktopState)
    router.add(remoteHost())
    const drafts = new RequestDraftService(root, owner => requestDraftOwnerState(owner, control, router), async () => {}, { write: async () => {} })
    const target: RequestDraftTarget = { kind: 'thread', ownerId: hostEntityKey(REMOTE, 'thread'), providerId: 'codex', requestId: 'request', questions }
    await drafts.save({ target, revision: 1, held: true, selections: { question: { optionIds: [], other: false, text: 'Saved answer' } } })
    await drafts.bindDecision(target, 'decision', { question: { optionIds: [], text: 'Saved answer' } })
    const copies = vi.spyOn(control, 'get')
    try {
      await router.reconcileRequestDrafts(drafts)
      await drafts.reconcile()
      expect((await drafts.get(target))?.held).toBe(true)
      expect(copies).not.toHaveBeenCalled()
    } finally { router.dispose() }
  })
})
