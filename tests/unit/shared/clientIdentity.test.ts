// @vitest-environment node
import { expect, it } from 'vitest'
import { clientAgentState, delegatingKey, hostEntityKey, mapHostReferences, projectClientAgentState, type DelegatingKeys } from '../../../src/shared/clientIdentity'
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

it('names a thread on another machine that delegated as the window names it, whichever machine started the child (#1316 part 3)', () => {
  const FORGE = '44444444-4444-4444-8444-444444444444', DESKTOP = '55555555-5555-4555-8555-555555555555', MAC = '66666666-6666-4666-8666-666666666666'
  const linkOf = (hostId: string, delegatedBy: string, across?: DelegatingKeys): string | undefined => {
    const state = threadsStateFixture()
    state.hostId = hostId
    state.host.threads[1]!.delegatedBy = delegatedBy
    return projectClientAgentState(state, undefined, across).output.host.threads[1]!.delegatedBy
  }
  const desktop = { desktopHostId: DESKTOP, clientId: 'client-1' }
  // A child the desktop relay started on This computer for a thread on forge names that thread by the window's key.
  expect(linkOf(DESKTOP, hostEntityKey(FORGE, 'parent'), desktop)).toBe(hostEntityKey(FORGE, 'parent'))
  // A child the desktop started on forge for one of its own threads names it through the caller's key there.
  expect(linkOf(FORGE, 'relay:client-1:parent', desktop)).toBe(hostEntityKey(DESKTOP, 'parent'))
  // A child on the Mac for a thread on forge, through the relay, names the forge thread.
  expect(linkOf(MAC, `relay:client-1:${hostEntityKey(FORGE, 'parent')}`, desktop)).toBe(hostEntityKey(FORGE, 'parent'))
  // Without the desktop's own ID, as on a phone, a desktop thread's caller key stays as its host names it.
  expect(linkOf(FORGE, 'relay:client-1:parent', { clientId: 'client-1' })).toBe(hostEntityKey(FORGE, 'relay:client-1:parent'))
  expect(delegatingKey(FORGE, 'parent', desktop)).toBe(hostEntityKey(FORGE, 'parent'))
})

it('keys a caller as this computer\'s thread only when the host names this computer as the desktop that asked (#1316 part 3)', () => {
  const FORGE = '44444444-4444-4444-8444-444444444444', DESKTOP = '55555555-5555-4555-8555-555555555555'
  // Two desktops paired with forge may each have a thread named "parent": only the one forge knows as client-1 is this one.
  expect(delegatingKey(FORGE, 'relay:client-1:parent', { desktopHostId: DESKTOP, clientId: 'client-1' })).toBe(hostEntityKey(DESKTOP, 'parent'))
  expect(delegatingKey(FORGE, 'relay:client-2:parent', { desktopHostId: DESKTOP, clientId: 'client-1' })).toBe(hostEntityKey(FORGE, 'relay:client-2:parent'))
  // A host this computer has no client ID for names none of its threads.
  expect(delegatingKey(FORGE, 'relay:client-1:parent', { desktopHostId: DESKTOP })).toBe(hostEntityKey(FORGE, 'relay:client-1:parent'))
})

it('keys every delegation link by its own host in Stable, saved Owl links included, as before #1316', () => {
  const FORGE = '44444444-4444-4444-8444-444444444444', DESKTOP = '55555555-5555-4555-8555-555555555555'
  const linkOf = (hostId: string, delegatedBy: string, across?: DelegatingKeys): string | undefined => {
    const state = threadsStateFixture()
    state.hostId = hostId
    state.host.threads[1]!.delegatedBy = delegatedBy
    return projectClientAgentState(state, undefined, across).output.host.threads[1]!.delegatedBy
  }
  // Neither link finds a thread, so the child keeps its own row in the sidebar, as a child whose parent is gone does.
  expect(linkOf(DESKTOP, hostEntityKey(FORGE, 'parent'))).toBe(hostEntityKey(DESKTOP, hostEntityKey(FORGE, 'parent')))
  expect(linkOf(FORGE, 'relay:client-1:parent')).toBe(hostEntityKey(FORGE, 'relay:client-1:parent'))
  expect(linkOf(FORGE, 'parent')).toBe(hostEntityKey(FORGE, 'parent'))
  // A projection keyed otherwise is not reused for the next one.
  const state = threadsStateFixture()
  state.hostId = FORGE
  state.host.threads[1]!.delegatedBy = 'relay:client-1:parent'
  const owl = projectClientAgentState(state, undefined, { desktopHostId: DESKTOP, clientId: 'client-1' })
  expect(owl.output.host.threads[1]!.delegatedBy).toBe(hostEntityKey(DESKTOP, 'parent'))
  expect(projectClientAgentState(state, owl).output.host.threads[1]!.delegatedBy).toBe(hostEntityKey(FORGE, 'relay:client-1:parent'))
})
