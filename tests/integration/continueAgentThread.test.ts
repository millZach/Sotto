// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentThread } from '../../src/shared/agents'
import { AGENT_FORK_GONE, AGENT_STILL_WORKING, START_HANDOVER_CLOSE } from '../../src/shared/threadStarts'
import type { AgentHostCommand, ThreadForkRequest } from '../../src/main/agents/host'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

/**
 * Continuing one of a thread's agents as its own thread (#1028), through the coordinator and the workspace over fake
 * providers: Codex forks it natively and the new thread is bound when it is made; Claude Code starts the new thread from
 * a thin handover that goes ahead of its first message. Refusals make nothing, and stable starts none of it.
 */
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

const TASK = 'Confirm that saved task text is removed from threads.sqlite when history is turned off.'
const RESULT = 'Confirmed. Turning history off removes saved task text and leaves drafts alone.'

async function fixture(options: { readonly threadStarts?: boolean } = {}) {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  if (options.threadStarts !== false) workspace.host.allowThreadStarts()
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { threadStartsEnabled: options.threadStarts !== false } })
  cleanups.push(async () => { await f.dispose(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' }); await f.control.commandShell({ type: 'connect', provider: 'claude' })
  const sotto = (provider: 'codex' | 'claude', session = 'session-workshop') => workspace.registry.bySession(provider, session)!.threadId
  const native = (provider: 'codex' | 'claude', session = 'session-workshop') => workspace.adapters[provider].state.threads.find(thread => thread.id === session)!
  const thread = (id: string): AgentThread | undefined => f.control.shell().host.threads.find(item => item.id === id)
  const model = (provider: 'codex' | 'claude') => f.control.shell().host.models.find(item => item.providerId === provider)!.id
  /** The parent's agent as its provider reports it: finished with a result, or still working. */
  const agent = async (provider: 'codex' | 'claude', status: 'completed' | 'running' = 'completed', id = `${provider}-agent-1`) => {
    const parent = native(provider)
    const activity: AgentActivity = { id: `${provider}-activity-${id}`, turnId: 'turn-1', sequence: 0, kind: 'subagent', title: 'Subagent', status,
      agents: [{ id, status, title: 'Verify history-off cleanup', prompt: TASK, ...(status === 'completed' ? { message: RESULT } : {}), model: 'sonnet', observedAt: new Date().toISOString() }] }
    parent.activities = [...(parent.activities ?? []).filter(record => record.id !== activity.id), activity]
    workspace.adapters[provider].emit()
    await f.control.commandShell({ type: 'refresh', provider })
    await expect.poll(async () => (await workspace.host.subagentPage({ threadId: sotto(provider) })).rows.find(row => row.id === id)?.status)
      .toBe(status === 'running' ? 'running' : 'completed')
    return id
  }
  const sends = (provider: 'codex' | 'claude') => workspace.adapters[provider].commands.filter((command): command is Extract<AgentHostCommand, { type: 'send' }> => command.type === 'send')
  return { ...f, workspace, sotto, native, thread, model, agent, sends }
}

describe('continuing a Claude Code agent as its own thread', () => {
  it('makes an unstarted thread whose first message carries a thin handover of the agent’s task and result', async () => {
    const f = await fixture()
    const agentId = await f.agent('claude')
    const newThreadId = randomUUID()
    const answer = await f.control.commandShell({ type: 'continue-agent', threadId: f.sotto('claude'), agentId, newThreadId, modelId: f.model('claude') })
    expect(answer.error).toBeNull()
    expect(f.control.shell().activeThreadId).toBe(newThreadId)
    const made = f.thread(newThreadId)!
    expect(made).toMatchObject({ title: 'Verify history-off cleanup', providerId: 'claude', nativeSessionStarted: false,
      startedFrom: { threadId: f.sotto('claude'), from: 'agent', route: 'handover', agentTitle: 'Verify history-off cleanup', handover: { thin: true, counts: { total: 2, carried: 2, answered: true } } } })
    // Nothing reached the provider: the handover waits for the first message.
    expect(f.workspace.adapters.claude.commands.filter(command => command.type === 'create-thread')).toHaveLength(0)
    const read = f.workspace.host.startHandover(newThreadId)!
    expect(read.text).toContain('This handover is thin.')
    expect(read.text).toContain(TASK); expect(read.text).toContain(RESULT)
    expect(read.text).toContain('context, not a new request')

    expect((await f.control.commandShell({ type: 'manual-send', threadId: newThreadId, draftId: randomUUID(), text: 'Add a test for the drafts.' })).error).toBeNull()
    const [send] = f.sends('claude')
    // One message: the handover, the line that closes it, then the user's words.
    expect(send!.text.startsWith('This is a handover from an agent of another Sotto thread.')).toBe(true)
    expect(send!.text).toContain(`${START_HANDOVER_CLOSE}\n\nAdd a test for the drafts.`)
    await f.control.commandShell({ type: 'observe-threads', threadIds: [newThreadId] })
    await expect.poll(() => f.control.threadDetail(newThreadId)?.messages.find(message => message.role === 'user')?.text).toBe('Add a test for the drafts.')
    const shown = f.control.threadDetail(newThreadId)!.messages.find(message => message.role === 'user')!
    expect(shown.handover).toMatchObject({ provider: 'claude', counts: { carried: 2 } })
    expect(shown.handover!.text).toContain(RESULT)
    expect(f.thread(newThreadId)!.startedFrom?.handover?.sent).toMatchObject({ messageId: shown.id })
    // Only the first message carries it.
    expect(f.workspace.host.startHandover(newThreadId)).toBeUndefined()
  })

  it('refuses an agent that is still working, and makes nothing', async () => {
    const f = await fixture()
    const agentId = await f.agent('claude', 'running')
    const before = f.control.shell().host.threads.length
    const answer = await f.control.commandShell({ type: 'continue-agent', threadId: f.sotto('claude'), agentId, newThreadId: randomUUID(), modelId: f.model('claude') })
    expect(answer.error).toBe(AGENT_STILL_WORKING)
    expect(f.control.shell().host.threads).toHaveLength(before)
  })

  it('makes nothing on stable, where continuing agents is an Owl feature', async () => {
    const f = await fixture({ threadStarts: false })
    const agentId = await f.agent('claude')
    const before = f.control.shell().host.threads.length
    const answer = await f.control.commandShell({ type: 'continue-agent', threadId: f.sotto('claude'), agentId, newThreadId: randomUUID(), modelId: f.model('claude') })
    expect(answer.error).toMatch(/available in Sotto Owl/u)
    expect(f.control.shell().host.threads).toHaveLength(before)
    await expect(f.workspace.host.continueAgent({ threadId: randomUUID(), sourceThreadId: f.sotto('claude'), agentId, modelId: f.model('claude') })).rejects.toThrow('Sotto Owl')
  })
})

describe('continuing a Codex agent as its own thread', () => {
  it('binds the new thread to Codex’s copy when it is made, and keeps it through a restart', async () => {
    const f = await fixture()
    const agentId = await f.agent('codex')
    const forks: ThreadForkRequest[] = []
    f.workspace.adapters.codex.forkThread = async request => {
      forks.push(request)
      f.workspace.adapters.codex.state.threads.push({ id: request.threadId, projectId: 'project', title: request.title, modelId: request.modelId, status: 'idle', requests: [],
        messages: [{ id: randomUUID(), role: 'assistant', text: 'The player waits on a 64 KB buffer before it starts.', createdAt: new Date().toISOString() }] })
      f.workspace.adapters.codex.emit()
      return { accepted: true }
    }
    const newThreadId = randomUUID()
    expect((await f.control.commandShell({ type: 'continue-agent', threadId: f.sotto('codex'), agentId, newThreadId, modelId: f.model('codex') })).error).toBeNull()
    expect(forks).toHaveLength(1)
    expect(forks[0]).toMatchObject({ source: { threadId: 'session-workshop', agentId } })
    // The copy is bound to the new Sotto thread, never under the provider's own identifier.
    expect(f.workspace.registry.byThread(newThreadId)).toMatchObject({ provider: 'codex', sessionId: forks[0]!.threadId })
    expect(f.thread(newThreadId)).toMatchObject({ nativeSessionStarted: true, startedFrom: { threadId: f.sotto('codex'), from: 'agent', route: 'fork', agentTitle: 'Verify history-off cleanup' } })
    expect(f.thread(newThreadId)!.startedFrom).not.toHaveProperty('handover')
    expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'create-thread')).toHaveLength(0)
    // The record is the workspace's own and is saved with it.
    await f.dispose(); await f.workspace.stop()
    const reloaded = new WorkspaceHost(f.workspace.native, f.workspace.root, () => true)
    await reloaded.initialize()
    expect(reloaded.workspaceSnapshot().threads.find(thread => thread.id === newThreadId)?.startedFrom).toMatchObject({ route: 'fork', from: 'agent' })
    reloaded.dispose()
  })

  it('leaves nothing behind when Codex no longer has the agent, and offers a thin handover instead', async () => {
    const f = await fixture()
    const agentId = await f.agent('codex')
    f.workspace.adapters.codex.forkThread = async () => { throw new Error(AGENT_FORK_GONE) }
    const before = f.control.shell().host.threads.map(thread => thread.id)
    const gone = await f.control.commandShell({ type: 'continue-agent', threadId: f.sotto('codex'), agentId, newThreadId: randomUUID(), modelId: f.model('codex') })
    expect(gone.error).toBe(AGENT_FORK_GONE)
    expect(f.control.shell().host.threads.map(thread => thread.id)).toEqual(before)
    const newThreadId = randomUUID()
    expect((await f.control.commandShell({ type: 'continue-agent', threadId: f.sotto('codex'), agentId, newThreadId, modelId: f.model('codex'), handover: true })).error).toBeNull()
    expect(f.thread(newThreadId)).toMatchObject({ providerId: 'codex', nativeSessionStarted: false, startedFrom: { route: 'handover', handover: { thin: true } } })
  })
})
