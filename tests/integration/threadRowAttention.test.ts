// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { describeThreads } from '../../src/renderer/src/agents/threadFacts'
import { agentShell, type AgentState } from '../../src/shared/agents'
import { claudeFixture } from '../fixtures/claudeFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

/**
 * A thread you started yourself has no assignment, so the coordinator never puts its requests in the
 * attention queue; the composer answers them from `thread.requests` all the same. The sidebar row is
 * read from the shell stream, as the window reads it, and has to say the same thing the composer does.
 */
for (const kind of ['question', 'permission'] as const) it(`says a Claude thread needs you while its ${kind} is pending, and stops once it is answered`, async () => {
  const f = await claudeFixture()
  const threadId = randomUUID()
  const credentials = new AgentCredentials(join(f.root, 'vault'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
  const row = (state: AgentState) => describeThreads(agentShell(state), Date.now()).find(entry => entry.thread.id === threadId)!
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Asks first', modelId: f.modelId })
    await control.start(); await control.command({ type: 'connect' })
    // Opened, so Claude's process is running for it, as it is for a thread you just prompted.
    await control.command({ type: 'select-thread', threadId })
    await (kind === 'question' ? f.driver.raiseQuestion(threadId, 'Which colour?') : f.driver.raisePermission(threadId, 'Build?'))
    await expect.poll(() => control.get().host.threads.find(thread => thread.id === threadId)?.requests.map(request => request.kind),
      { message: `the ${kind} never reached thread.requests, so the composer has nothing to show` }).toEqual([kind])
    const state = control.get()
    expect(state.assignments.some(assignment => assignment.threadId === threadId), 'the thread is one you started, not one Sotto manages').toBe(false)
    // The coordinator's queue is not where the row learns this: it stays empty for a thread Sotto does not manage.
    expect(state.queue.filter(item => item.threadId === threadId)).toEqual([])
    expect(row(state), `thread.requests holds the ${kind} and the composer answers it, but the sidebar row does not say so`).toMatchObject(kind === 'question'
      ? { state: 'needs', waitingFor: 'question', stateLabel: 'Needs your answer', request: { kind, threadId } }
      : { state: 'needs', waitingFor: 'approval', stateLabel: 'Needs your approval', request: { kind, threadId } })

    const request = state.host.threads.find(thread => thread.id === threadId)!.requests[0]!
    const choice = request.permissionChoices?.find(entry => entry.kind === 'allow-once')
    await control.command(kind === 'question'
      ? { type: 'answer', threadId, requestId: request.id, answer: '', questionAnswers: { '0': { optionIds: [], text: 'Blue' } } }
      : { type: 'answer', threadId, requestId: request.id, answer: '', approved: true, ...(choice ? { permissionChoice: choice.id } : {}) })
    await expect.poll(() => control.get().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(0)
    expect(row(control.get())).toMatchObject({ waitingFor: null, request: undefined })
    expect(row(control.get()).state).not.toBe('needs')
  } finally { control.dispose(); await control.privacyChanged(); await f.cleanup() }
})
