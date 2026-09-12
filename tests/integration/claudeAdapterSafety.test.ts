// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { claudeAnswer, claudePending } from '../../src/main/agents/claudeRequests'
import { authoredClaudeUser } from '../../src/main/agents/claudeSessionLog'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'

describe('Claude native request mapping', () => {
  it('rejects malformed permissions and questions', () => {
    for (const request of [{ subtype: 'other' }, { subtype: 'can_use_tool', tool_name: 'Bash', input: [] }, { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [] } }]) expect(claudePending({ request_id: 'id', request })).toBeUndefined()
  })
  it('preserves tool input and only grants on explicit approval', () => {
    const pending = claudePending({ request_id: 'id', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm run build' } } })!
    expect(claudeAnswer(pending, 'yes')).toMatchObject({ behavior: 'deny' })
    expect(claudeAnswer(pending, '', true)).toEqual({ behavior: 'allow', updatedInput: { command: 'npm run build' } })
  })
  it('maps multiple user questions without creating permission grants', () => {
    const pending = claudePending({ request_id: 'id', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Color?' }, { question: 'Size?' }] } } })!
    expect(claudeAnswer(pending, '1. Blue\n2. Large')).toMatchObject({ updatedInput: { answers: { 'Color?': 'Blue', 'Size?': 'Large' } } })
    expect(() => claudeAnswer(pending, 'Blue')).toThrow('every question')
  })
  it('ignores injected, tool-result and subagent input for takeover', () => {
    const user = { type: 'user', message: { content: 'Hello' } }
    for (const frame of [{ ...user, isMeta: true }, { ...user, isCompactSummary: true }, { ...user, isSidechain: true }, { ...user, parent_tool_use_id: 'tool' }, { ...user, message: { content: [{ type: 'tool_result', content: 'Hello' }] } }, { ...user, message: { content: '<session-start-hook>Injected' } }]) expect(authoredClaudeUser(frame)).toBe(false)
    expect(authoredClaudeUser(user)).toBe(true)
  })
})

describe('Claude recovery and safety', () => {
  let f: Awaited<ReturnType<typeof claudeFixture>>
  let id: string
  const thread = async () => (await f.host.snapshot()).threads.find(t => t.id === id)!
  beforeEach(async () => {
    f = await claudeFixture(); await f.host.connect(f.connection)
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    id = randomUUID(); await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Synthetic', modelId: f.modelId })
  })
  afterEach(async () => f.cleanup())
  it('reconciles image-only prompts and restores references without persisting image bytes', async () => {
    const attachment = { id: 'image', name: 'image.png', mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }
    expect(await f.host.execute({ type: 'send', commandId: 'image-command', messageId: 'image-message', threadId: id, text: '', attachments: [attachment] })).toEqual({ accepted: true })
    expect((await thread()).messages[0]).toMatchObject({ id: 'image-message', text: '', attachments: [{ id: 'image', sizeBytes: 8 }] })
    const stored = await readFile(join(f.root, 'claude-threads.json'), 'utf8')
    expect(stored).not.toContain('iVBORw0KGgo=')
    f = await f.driver.restart() as typeof f; await f.host.connect(f.connection)
    expect((await thread()).messages[0]).toMatchObject({ id: 'image-message', commandId: 'image-command', attachments: [{ id: 'image', sizeBytes: 8 }] })
  })
  it('does not resend a repeated uncertain message', async () => {
    await f.driver.delayNextAck('user')
    const command = { type: 'send' as const, commandId: 'command', messageId: 'message', threadId: id, text: 'Sensitive synthetic prompt' }
    expect(await f.host.execute(command)).toEqual({ accepted: false, uncertain: true })
    await f.host.execute(command)
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(1)
    expect(await readFile(join(f.root, 'claude-threads.json'), 'utf8')).not.toContain(command.text)
  })
  it('sends a native denial for malformed question control requests', async () => {
    await f.action(id, { type: 'raw', frame: { type: 'control_request', request_id: 'malformed', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } } })
    await expect.poll(async () => JSON.stringify(await f.driver.requests())).toContain('"behavior":"deny"')
    expect((await thread()).requests).toEqual([])
  })
  it('resumes the native context after CLI takeover before another prompt', async () => {
    await f.driver.typeInProvider(id, 'Typed outside Sotto')
    await f.host.execute({ type: 'send', commandId: 'next', messageId: 'next', threadId: id, text: 'Continue' })
    expect((await f.driver.requests()).filter(record => record.method === 'resume')).toHaveLength(1)
  })
  it('rejects unsupported runtime modes before dispatch', async () => {
    await expect(f.host.execute({ type: 'configure-thread', commandId: 'config', threadId: id, runtimeMode: 'full-access' })).rejects.toThrow('permission mode')
  })
  it('keeps native and adapter identifiers behind the durable Sotto thread registry', async () => {
    let registry = new ThreadRegistry(f.root)
    let wrapped = new SottoThreadHost('claude', f.adapter, registry)
    await wrapped.connect(f.connection)
    const sottoId = randomUUID()
    await wrapped.execute({ type: 'create-thread', commandId: 'wrapped-create', threadId: sottoId, projectId: f.projectId, title: 'Wrapped', modelId: f.modelId })
    const binding = registry.byThread(sottoId)!
    const nativeId = await f.realId(binding.sessionId)
    expect(binding.sessionId).not.toBe(sottoId); expect(nativeId).not.toBe(binding.sessionId)
    await wrapped.execute({ type: 'send', commandId: 'wrapped-send', messageId: 'wrapped-message', threadId: sottoId, text: 'Synthetic wrapped prompt' })
    expect(JSON.stringify(await wrapped.snapshot())).not.toContain(nativeId)
    expect(JSON.stringify(await wrapped.snapshot())).not.toContain(binding.sessionId)
    wrapped.disconnect(); await f.adapter.closed(); await registry.flush()
    f = await f.driver.restart() as typeof f
    registry = new ThreadRegistry(f.root); wrapped = new SottoThreadHost('claude', f.adapter, registry)
    await wrapped.connect(f.connection)
    expect((await wrapped.snapshot()).threads.find(thread => thread.id === sottoId)?.messages).toContainEqual(expect.objectContaining({ id: 'wrapped-message', commandId: 'wrapped-send' }))
    expect(registry.byThread(sottoId)).toEqual(binding)
    wrapped.disconnect(); await f.adapter.closed(); await registry.flush()
  })
})
