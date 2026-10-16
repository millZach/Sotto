// @vitest-environment node
import { expect, it } from 'vitest'
import { clientAgentState, hostEntityKey, mapHostReferences } from '../../../src/shared/clientIdentity'
import type { AgentState } from '../../../src/shared/agents'
import { threadsStateFixture } from '../../fixtures/agentState'
import { syntheticModelCatalog } from '../../fixtures/modelCatalog'

const HOST = '33333333-3333-4333-8333-333333333333'

/** What `clientAgentState` did before #917: it walked the whole state, the catalog and threads included. */
function walkedEverything(state: AgentState): AgentState {
  const hostId = state.hostId ?? state.host.hostId!
  const mapped = mapHostReferences(state, id => hostEntityKey(hostId, id))
  return { ...mapped, hostId,
    host: { ...mapped.host,
      projects: mapped.host.projects.map(project => ({ ...project, id: hostEntityKey(project.hostId ?? hostId, project.id) })),
      threads: state.host.threads.map(thread => ({ ...thread, id: hostEntityKey(thread.hostId ?? hostId, thread.id), projectId: hostEntityKey(thread.hostId ?? hostId, thread.projectId) })) } }
}

it('keys a host state as walking all of it did, keeping its catalog and walking no thread (#917)', () => {
  const state = threadsStateFixture()
  state.hostId = HOST
  state.host.models = syntheticModelCatalog(12)
  const thread = state.host.threads[0]!
  state.threadDrafts = [{ threadId: thread.id, text: 'Draft', attachments: [], revision: 1 }] as unknown as AgentState['threadDrafts']
  state.busyThreadIds = [thread.id]
  state.draftThreadId = thread.id
  const projected = clientAgentState(state)
  expect(projected).toEqual(walkedEverything(state))
  expect(projected.host.models).toBe(state.host.models)
  expect(projected.activeThreadId).toBe(hostEntityKey(HOST, state.activeThreadId!))
  expect(projected.busyThreadIds).toEqual([hostEntityKey(HOST, thread.id)])
  expect(projected.host.threads[0]!.id).toBe(hostEntityKey(HOST, thread.id))
})

it('names the thread that delegated to a thread as the window names threads, so its link finds it (ADR-0081)', () => {
  const state = threadsStateFixture()
  state.hostId = HOST
  const [parent, child] = state.host.threads
  child!.delegatedBy = parent!.id
  const projected = clientAgentState(state)
  const keyed = projected.host.threads.find(thread => thread.id === hostEntityKey(HOST, child!.id))!
  expect(keyed.delegatedBy).toBe(hostEntityKey(HOST, parent!.id))
  expect(projected.host.threads.some(thread => thread.id === keyed.delegatedBy)).toBe(true)
  // A thread no other thread started gains no link.
  expect(projected.host.threads.find(thread => thread.id === hostEntityKey(HOST, parent!.id))).not.toHaveProperty('delegatedBy')
})
