// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { claudeAnswer, claudePending } from '../../src/main/agents/claudeRequests'
import { authoredClaudeUser } from '../../src/main/agents/claudeSessionLog'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'

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
    f = await claudeFixture(); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    id = randomUUID(); await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Synthetic', modelId: f.modelId })
  })
  afterEach(async () => { vi.restoreAllMocks(); await f.cleanup() })
  it.each(['ide_opened_file', 'ide_selection'])('detects authored takeover after %s IDE metadata', async tag => {
    const metadata = `<${tag}>Synthetic editor context</${tag}>`
    expect(authoredClaudeUser({ type: 'user', message: { content: metadata } })).toBe(false)
    const text = `${metadata}\nPlease fix this crash.`
    await f.driver.typeInProvider(id, text)
    expect((await thread()).messages).toContainEqual(expect.objectContaining({ role: 'user', text }))
    await expect(f.host.execute({ type: 'send', commandId: 'stale-ide', messageId: 'stale-ide', threadId: id, text: 'Stale automatic reply', expectedLastUserMessageId: null })).rejects.toThrow('changed')
  })
  it.each([false, true])('waits for observed-thread initialization before sending (failed=%s)', async fail => {
    f.host.disconnect(); await f.adapter.closed()
    f = await claudeFixture(f.root, 1000); await f.host.connect()
    await writeFile(join(f.root, 'initialize-script.json'), JSON.stringify({ gate: true, fail }))
    f.host.observeThreads?.([id])
    await expect.poll(async () => readFile(join(f.root, 'initialize-waiting'), 'utf8').catch(() => '')).not.toBe('')
    let settled = false
    const sending = f.host.execute({ type: 'send', commandId: 'initializing', messageId: 'initializing', threadId: id, text: 'Wait for initialization' })
      .then(result => { settled = true; return { result } }, error => { settled = true; return { error: error as Error } })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(0)
    await writeFile(join(f.root, 'initialize-release'), '')
    const outcome = await sending
    if (fail) {
      expect(outcome).toMatchObject({ error: expect.any(Error) })
      expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(0)
    } else expect(outcome).toEqual({ result: { accepted: true } })
  })
  it('rejects takeover during origin persistence and durably removes the undispatched origin', async () => {
    let release!: () => void; let entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { entered = resolve })
    const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      await write.call(this, value)
      const aliases = value as Record<string, { origins?: { messageId: string }[] }>
      if (aliases[id]?.origins?.some(origin => origin.messageId === 'stale-persist')) { entered(); await blocked }
    })
    const command = { type: 'send' as const, commandId: 'stale-persist', messageId: 'stale-persist', threadId: id, text: 'Must not send', expectedLastUserMessageId: null }
    const sending = f.host.execute(command).then(result => ({ result }), error => ({ error: error as Error }))
    await reached; await f.driver.typeInProvider(id, 'External takeover while persisting')
    release()
    expect(await sending).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('changed') }) })
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(0)
    const aliases = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))
    expect(aliases[id].origins).toEqual([])
    vi.restoreAllMocks()
    const latest = (await thread()).messages.filter(message => message.role === 'user').at(-1)!.id
    expect(await f.host.execute({ ...command, expectedLastUserMessageId: latest })).toEqual({ accepted: true })
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(1)
  })
  it('reconciles image-only native frames over 1 MiB and restores references without persisting image bytes', async () => {
    const image = Buffer.alloc(1024 * 1024); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image)
    const attachment = { id: 'image', name: 'image.png', mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${image.toString('base64')}` }
    expect(await f.host.execute({ type: 'send', commandId: 'image-command', messageId: 'image-message', threadId: id, text: '', attachments: [attachment] })).toEqual({ accepted: true })
    expect((await thread()).messages[0]).toMatchObject({ id: 'image-message', text: '', attachments: [{ id: 'image', sizeBytes: image.length }] })
    const stored = await readFile(join(f.root, 'claude-threads.json'), 'utf8')
    expect(stored).not.toContain(image.toString('base64'))
    f = await f.driver.restart() as typeof f; await f.host.connect()
    expect((await thread()).messages[0]).toMatchObject({ id: 'image-message', commandId: 'image-command', attachments: [{ id: 'image', sizeBytes: image.length }] })
  })
  it('restores submitted image previews through control after native restart under the same Sotto thread and message', async () => {
    const image = { id: 'preview', name: 'Screenshot.png', mimeType: 'image/png' as const,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=' }
    const credentials = new AgentCredentials(f.root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
    await credentials.load()
    let registry = new ThreadRegistry(f.root)
    let wrapped = new SottoThreadHost('claude', f.adapter, registry)
    const create = () => new AgentControl({ directory: f.root, host: wrapped, credentials, reasoner: e2eAgentReasoner,
      membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
    let control = create()
    try {
      await control.start(); await control.command({ type: 'connect' })
      const sottoId = registry.all().find(binding => binding.sessionId === id)!.threadId
      expect(sottoId).not.toBe(id)
      const result = await control.command({ type: 'manual-send', threadId: sottoId, text: '', attachments: [image] })
      expect(result.error).toBeNull()
      const message = result.host.threads.find(thread => thread.id === sottoId)!.messages[0]!
      expect(message.attachments?.[0]?.preview).toEqual({ dataUrl: image.dataUrl })
      const cache = await readFile(join(f.root, 'attachment-previews.json'), 'utf8')
      expect(JSON.parse(cache).entries[0]).toMatchObject({ threadId: sottoId, messageId: message.id, commandId: message.commandId })
      expect(cache).not.toContain(id)
      expect(await readFile(join(f.root, 'claude-threads.json'), 'utf8')).not.toContain(image.dataUrl)
      control.dispose(); await control.privacyChanged(); await f.adapter.closed(); await registry.flush()
      f = await f.driver.restart() as typeof f
      registry = new ThreadRegistry(f.root); wrapped = new SottoThreadHost('claude', f.adapter, registry)
      control = create(); await control.start(); await control.command({ type: 'connect' })
      expect(control.get().host.threads.find(thread => thread.id === sottoId)!.messages[0]).toEqual(message)
      expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(1)
    } finally { control.dispose(); await control.privacyChanged(); await f.adapter.closed(); await registry.flush() }
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
  const launches = async () => (await f.driver.requests()).filter(record => record.method === 'launch' || record.method === 'resume').map(record => (record.params?.frame as { args: string[] }).args).filter(args => !args.includes('--no-session-persistence'))
  const permission = (args: string[]) => ({ mode: args[args.indexOf('--permission-mode') + 1], prompts: args[args.indexOf('--permission-prompts') + 1], allowBypass: args.includes('--allow-dangerously-skip-permissions') })
  it('advertises every runtime mode on Claude models', async () => {
    expect((await f.host.snapshot()).models.every(model => model.runtimeModes?.join() === 'approval-required,auto-accept-edits,auto,full-access')).toBe(true)
  })
  it('launches a thread without a stored mode as approval-required with the native default mode', async () => {
    expect(permission((await launches()).at(-1)!)).toEqual({ mode: 'default', prompts: 'host', allowBypass: false })
    expect((await thread()).runtimeMode).toBe('approval-required')
    expect(JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[id]).not.toHaveProperty('runtimeMode')
    f = await f.driver.restart() as typeof f; await f.host.connect(); f.host.observeThreads?.([id])
    await expect.poll(async () => (await launches()).length).toBe(2)
    expect(permission((await launches()).at(-1)!)).toEqual({ mode: 'default', prompts: 'host', allowBypass: false })
    expect((await thread()).runtimeMode).toBe('approval-required')
  })
  it.each([
    ['approval-required', 'default', false], ['auto-accept-edits', 'acceptEdits', false], ['auto', 'auto', false], ['full-access', 'bypassPermissions', true],
  ] as const)('launches %s threads with --permission-mode %s', async (runtimeMode, mode, allowBypass) => {
    const created = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: created, projectId: f.projectId, title: 'Mode', modelId: f.modelId, runtimeMode })
    expect(permission((await launches()).at(-1)!)).toEqual({ mode, prompts: 'host', allowBypass })
    expect((await f.host.snapshot()).threads.find(t => t.id === created)!.runtimeMode).toBe(runtimeMode)
  })
  it('persists the runtime mode across adapter restart', async () => {
    const created = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: created, projectId: f.projectId, title: 'Mode', modelId: f.modelId, runtimeMode: 'auto' })
    const before = (await launches()).length
    f = await f.driver.restart() as typeof f; await f.host.connect()
    expect((await f.host.snapshot()).threads.find(t => t.id === created)!.runtimeMode).toBe('auto')
    f.host.observeThreads?.([created])
    await expect.poll(async () => (await launches()).length).toBe(before + 1)
    expect(permission((await launches()).at(-1)!)).toEqual({ mode: 'auto', prompts: 'host', allowBypass: false })
  })
  it('restarts the native runtime with the configured mode', async () => {
    expect(await f.host.execute({ type: 'configure-thread', commandId: 'config', threadId: id, runtimeMode: 'full-access' })).toEqual({ accepted: true })
    expect(permission((await launches()).at(-1)!)).toEqual({ mode: 'bypassPermissions', prompts: 'host', allowBypass: true })
    expect((await thread()).runtimeMode).toBe('full-access')
    expect(JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[id].runtimeMode).toBe('full-access')
    expect(await f.host.execute({ type: 'configure-thread', commandId: 'config-2', threadId: id, runtimeMode: 'auto-accept-edits' })).toEqual({ accepted: true })
    expect(permission((await launches()).at(-1)!)).toEqual({ mode: 'acceptEdits', prompts: 'host', allowBypass: false })
    expect((await thread()).runtimeMode).toBe('auto-accept-edits')
  })
  it('keeps native and adapter identifiers behind the durable Sotto thread registry', async () => {
    let registry = new ThreadRegistry(f.root)
    let wrapped = new SottoThreadHost('claude', f.adapter, registry)
    await wrapped.connect()
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
    await wrapped.connect()
    expect((await wrapped.snapshot()).threads.find(thread => thread.id === sottoId)?.messages).toContainEqual(expect.objectContaining({ id: 'wrapped-message', commandId: 'wrapped-send' }))
    expect(registry.byThread(sottoId)).toEqual(binding)
    wrapped.disconnect(); await f.adapter.closed(); await registry.flush()
  })
})
