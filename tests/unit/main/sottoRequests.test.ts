// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { SottoThreadRequests } from '../../../src/main/agents/sottoRequests'
import { withSottoRequests } from '../../../src/main/agents/sottoRequests'
import type { AgentRequest } from '../../../src/shared/agents'
import { manualSendCoordinator } from '../../fixtures/manualSendCoordinator'

// A request Sotto owns (ADR-0035): merged into its thread beside the provider's, answered in place, and never sent
// to the provider. Only a client that may grant answers it, as for every other request (ADR-0004).
const ADD: AgentRequest = { id: 'sotto:host-setup:one', kind: 'permission', text: 'Add forge as a host?', options: [],
  permissionChoices: [{ id: 'add', label: 'Add forge', kind: 'allow-once' }, { id: 'decline', label: 'Don’t add', kind: 'deny' }] }

function source() {
  let pending = new Map<string, readonly AgentRequest[]>()
  const listeners = new Set<() => void>()
  const answer = vi.fn((threadId: string, requestId: string) => {
    if (!pending.get(threadId)?.some(request => request.id === requestId)) throw new Error('This request is no longer pending. Refresh the thread.')
    pending = new Map(); for (const listener of listeners) listener()
  })
  const requests: SottoThreadRequests = { requests: () => pending, answer, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
  const set = (value: Map<string, readonly AgentRequest[]>): void => { pending = value; for (const listener of listeners) listener() }
  return { requests, answer, set }
}

it('merges Sotto\'s request beside the provider\'s own and leaves other threads as they are', () => {
  const provider: AgentRequest = { id: 'provider-1', kind: 'question', text: 'Which branch?', options: [] }
  const snapshot = { connected: true, name: 'Fixture', version: '1', capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
    models: [], projects: [], threads: [
      { id: 'setup', title: 'Set up forge', projectId: 'p', modelId: 'm', status: 'idle' as const, messages: [], requests: [provider, { ...ADD, id: 'sotto:host-setup:old' }] },
      { id: 'other', title: 'Other', projectId: 'p', modelId: 'm', status: 'idle' as const, messages: [], requests: [] },
    ] }
  const merged = withSottoRequests(snapshot, new Map([['setup', [ADD]]]))
  expect(merged.threads[0]!.requests.map(request => request.id)).toEqual(['provider-1', 'sotto:host-setup:one'])
  expect(merged.threads[1]).toBe(snapshot.threads[1])
  expect(withSottoRequests(merged, new Map()).threads[0]!.requests.map(request => request.id)).toEqual(['provider-1'])
})

it('keeps the request on the thread until it is answered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-sotto-requests-'))
  const control = await manualSendCoordinator(directory, new E2EAgentHost())
  try {
    await control.start(); await control.command({ type: 'connect' })
    const { requests, set } = source()
    control.useSottoRequests(requests)
    set(new Map([['workshop', [ADD]]]))
    const queued = () => control.get().host.threads.find(t => t.id === 'workshop')!.requests.filter(item => item.id === ADD.id)
    expect(queued()).toEqual([expect.objectContaining({ id: ADD.id, kind: 'permission' })])
    // A refresh from the provider, which knows nothing of the request, keeps it queued.
    await control.command({ type: 'refresh' })
    expect(queued()).toHaveLength(1)
    await control.command({ type: 'answer', threadId: 'workshop', requestId: ADD.id, answer: 'Add forge', approved: true, permissionChoice: 'add' })
    expect(queued()).toEqual([])
  } finally { control.dispose(); await control.privacyChanged(); await rm(directory, { recursive: true, force: true }) }
})

it('shows the request in its thread, takes the local window\'s answer without the provider, and refuses a client with no grant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-sotto-requests-'))
  const host = new E2EAgentHost()
  const execute = vi.spyOn(host, 'execute')
  const control = await manualSendCoordinator(directory, host)
  try {
    await control.start(); await control.command({ type: 'connect' })
    const { requests, answer, set } = source()
    control.useSottoRequests(requests)
    set(new Map([['workshop', [ADD]]]))
    expect(control.shell().host.threads.find(thread => thread.id === 'workshop')!.requests).toEqual([ADD])
    // A refresh from the provider keeps it: the provider's snapshot knows nothing of Sotto's request.
    await control.command({ type: 'refresh' })
    expect(control.shell().host.threads.find(thread => thread.id === 'workshop')!.requests.map(request => request.id)).toEqual([ADD.id])
    const phone = { clientId: 'phone', user: 'zach', transport: 'socket' as const }
    const refused = await control.command({ type: 'answer', threadId: 'workshop', requestId: ADD.id, answer: 'Add forge', approved: true, permissionChoice: 'add' }, phone)
    expect(refused.error).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()
    expect(control.shell().host.threads.find(thread => thread.id === 'workshop')!.requests).toEqual([ADD])
    const commands = execute.mock.calls.length
    await control.command({ type: 'answer', threadId: 'workshop', requestId: ADD.id, answer: 'Add forge', approved: true, permissionChoice: 'add' })
    expect(answer).toHaveBeenCalledWith('workshop', ADD.id, true)
    expect(execute.mock.calls.slice(commands).some(([command]) => command.type === 'answer')).toBe(false)
    expect(control.shell().host.threads.find(thread => thread.id === 'workshop')!.requests).toEqual([])
  } finally { control.dispose(); await control.privacyChanged(); await rm(directory, { recursive: true, force: true }) }
})
