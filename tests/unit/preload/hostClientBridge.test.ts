// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { hostClientBridge } from '../../../src/preload/hostClientBridge'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { agentCommandSchema, EMPTY_AGENT_HOST, defaultAgentConfiguration, type AgentState, type AgentCommand, type AgentThreadDetail } from '../../../src/shared/agents'
function threadsStateFixture(): AgentState {
  return { configuration: defaultAgentConfiguration(), connection: 'connected',
    host: { ...EMPTY_AGENT_HOST, threads: [{ id: 'visual-gate', projectId: 'project', title: 'Task', modelId: 'model', status: 'idle', messages: [], requests: [] }] },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null,
    composing: false, pendingRequest: '', globalLaneBusy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: false }, reasoningAccounts: [], membership: { status: 'free', label: 'Free', expiresAt: null } }
}

const HOST = '11111111-1111-4111-8111-111111111111'
function setup() {
  const state = threadsStateFixture(); state.hostId = HOST; state.host.hostId = HOST
  let detailListener: ((detail: AgentThreadDetail) => void) | undefined
  const raw = { agents: {
    get: vi.fn(async () => state), command: vi.fn(async (command: AgentCommand) => { agentCommandSchema.parse(command); return state }),
    threadDetail: vi.fn(async (threadId: string) => ({ threadId, revision: 1, messages: [] })),
    onThreadDetail: (listener: (detail: AgentThreadDetail) => void) => { detailListener = listener; return () => { detailListener = undefined } },
    attachmentPreview: vi.fn(async (_request: { threadId: string; messageId: string; attachmentId: string }) => { void _request; return null }),
    workingCopyOptions: vi.fn(async (_projectId: string) => { void _projectId; return { isGit: false } }) },
    files: { list: vi.fn(async (request: { threadId: string }) => ({ ok: true, value: { ...request } })) },
    requestDrafts: { list: vi.fn(async (owner: { kind: string; ownerId: string }) => [owner]) } }
  return { state, raw, bridge: hostClientBridge(raw), push: (detail: AgentThreadDetail) => detailListener?.(detail) }
}
it('decodes thread/project command IDs before wire validation and projects every returned state', async () => {
  const { bridge, raw } = setup(); const state = await bridge.agents.get()
  expect(state.host.threads[0]!.id).toBe(hostEntityKey(HOST, 'visual-gate'))
  const id = 'x'.repeat(512)
  const commands: AgentCommand[] = [
    { type: 'manual-send', threadId: hostEntityKey(HOST, id), text: 'Keep host: IDs in user text' },
    { type: 'select-project', projectId: hostEntityKey(HOST, 'p:a|b') },
    { type: 'observe-threads', threadIds: [hostEntityKey(HOST, id), hostEntityKey(HOST, 'other')] },
    { type: 'create-thread', threadId: hostEntityKey(HOST, HOST), projectId: hostEntityKey(HOST, 'p'), title: 'Task', modelId: 'model' },
    { type: 'select-attention', itemId: hostEntityKey(HOST, 'queue') },
  ]
  for (const command of commands) expect((await bridge.agents.command(command)).hostId).toBe(HOST)
  expect(raw.agents.command.mock.calls.map(call => call[0])).toEqual([
    { type: 'manual-send', threadId: id, text: 'Keep host: IDs in user text' },
    { type: 'select-project', projectId: 'p:a|b' },
    { type: 'observe-threads', threadIds: [id, 'other'] },
    { type: 'create-thread', threadId: HOST, projectId: 'p', title: 'Task', modelId: 'model' },
    { type: 'select-attention', itemId: 'queue' },
  ])
})
it('scopes detail push/read and decodes attachment, project, files and request-draft lookups', async () => {
  const { bridge, raw, push } = setup(); await bridge.agents.get()
  const key = hostEntityKey(HOST, 'thread')
  expect((await bridge.agents.threadDetail(key))!.threadId).toBe(key)
  expect(raw.agents.threadDetail).toHaveBeenCalledWith('thread')
  const listener = vi.fn(); const stop = bridge.agents.onThreadDetail(listener)
  push({ threadId: 'thread', revision: 2, messages: [] })
  expect(listener).toHaveBeenCalledWith({ threadId: key, revision: 2, messages: [] }); stop()
  await bridge.agents.attachmentPreview({ threadId: key, messageId: 'message', attachmentId: 'image' })
  expect(raw.agents.attachmentPreview).toHaveBeenCalledWith({ threadId: 'thread', messageId: 'message', attachmentId: 'image' })
  await bridge.agents.workingCopyOptions(hostEntityKey(HOST, 'p'))
  expect(raw.agents.workingCopyOptions).toHaveBeenCalledWith('p')
  expect((await bridge.files.list({ threadId: key })).value.threadId).toBe(key)
  expect(raw.files.list).toHaveBeenCalledWith({ threadId: 'thread' })
  expect(await bridge.requestDrafts.list({ kind: 'thread', ownerId: key })).toEqual([{ kind: 'thread', ownerId: key }])
  expect(raw.requestDrafts.list).toHaveBeenCalledWith({ kind: 'thread', ownerId: 'thread' })
})
it('rejects another host before dispatch and preserves legacy host-less bridges', async () => {
  const { bridge, raw, state } = setup(); await bridge.agents.get()
  expect(() => bridge.agents.command({ type: 'select-thread', threadId: hostEntityKey('22222222-2222-4222-8222-222222222222', 'thread') })).toThrow('another host')
  expect(raw.agents.command).not.toHaveBeenCalled()
  delete state.hostId; delete state.host.hostId
  expect((await hostClientBridge(raw).agents.get()).host.threads[0]!.id).toBe('visual-gate')
})

it('keeps routed agent and remote answer references intact while refusing remote local tools', async () => {
  const { raw, state } = setup()
  const remote = '22222222-2222-4222-8222-222222222222'
  state.clientScoped = true
  state.connections = [{ hostId: HOST, name: 'This computer', kind: 'local', connected: true }, { hostId: remote, name: 'Forge', kind: 'remote', connected: true }]
  raw.agents.command.mockImplementation(async () => state)
  const bridge = hostClientBridge(raw); await bridge.agents.get()
  const key = hostEntityKey(remote, 'thread')
  await bridge.agents.command({ type: 'select-thread', threadId: key })
  expect(raw.agents.command).toHaveBeenCalledWith({ type: 'select-thread', threadId: key })
  expect(await bridge.requestDrafts.list({ kind: 'thread', ownerId: key })).toEqual([{ kind: 'thread', ownerId: key }])
  expect(raw.requestDrafts.list).toHaveBeenCalledWith({ kind: 'thread', ownerId: key })
  expect(() => bridge.files.list({ threadId: key })).toThrow('another host')
  expect(raw.files.list).not.toHaveBeenCalled()
  state.connections = [{ hostId: remote, name: 'Forge', kind: 'remote', connected: true }]
  await bridge.agents.get()
  expect(() => bridge.files.list({ threadId: key })).toThrow('host machine')
})
