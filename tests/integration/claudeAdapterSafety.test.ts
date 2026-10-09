// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { createAgentControl } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { claudeAnswer, claudePending } from '../../src/main/agents/claudeRequests'
import { authoredClaudeUser } from '../../src/main/agents/claudeSessionLog'
import { ClaudeSessionLog } from '../../src/main/agents/claudeSessionLog'
import { ClaudeProtocol } from '../../src/main/agents/claudeProtocol'
import { ClaudeOriginJournal } from '../../src/main/agents/claudeOriginJournal'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'

import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'
import { handleOf, PIXEL_DATA_URL, PIXEL_PNG, promptImageOf, stageInto } from '../fixtures/stagedImages'

/** Hold the actual stdin callback and bytes without replacing the protocol's deadline. */
function delayStdin(adapter: Awaited<ReturnType<typeof claudeFixture>>['adapter'], id: string) {
  const runtime = (adapter as unknown as { runtimes: Map<string, { protocol: ClaudeProtocol }> }).runtimes.get(id)!
  const stdin = (runtime.protocol as unknown as { child: import('node:child_process').ChildProcessWithoutNullStreams }).child.stdin
  const write = stdin.write.bind(stdin)
  let release = () => undefined
  let fail = () => undefined
  const spy = vi.spyOn(stdin, 'write').mockImplementationOnce(((chunk: string, callback: (error?: Error | null) => void) => {
    release = () => { release = () => undefined; write(chunk, callback) }
    fail = () => { release = () => undefined; callback(new Error('Pipe failed')) }
    return false
  }) as typeof stdin.write)
  return { release: () => release(), fail: () => fail(), restore: () => spy.mockRestore() }
}

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
    for (const frame of [{ ...user, isMeta: true }, { ...user, isCompactSummary: true }, { ...user, isSidechain: true }, { ...user, parent_tool_use_id: 'tool' }, { ...user, message: { content: [{ type: 'tool_result', content: 'Hello' }] } }, { ...user, message: { content: '<session-start-hook>Injected' } },
      // A finished background task is Claude Code's own turn, whether or not the frame carries its origin.
      { ...user, origin: { kind: 'task-notification' } }, { ...user, message: { content: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' } }]) expect(authoredClaudeUser(frame)).toBe(false)
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
    f = await claudeFixture(f.root); await f.host.connect()
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

    const { promise: blocked, resolve: release } = deferred<void>()

    const { promise: reached, resolve: entered } = deferred<void>()

    // The origin is made durable as one synced line of the origin journal (#767).
    const append = ClaudeOriginJournal.prototype.append
    vi.spyOn(ClaudeOriginJournal.prototype, 'append').mockImplementation(async function (this: ClaudeOriginJournal<unknown>, entry) {
      await append.call(this, entry)
      if ((entry.origin as { messageId: string }).messageId === 'stale-persist') { entered(); await blocked }
    })
    const command = { type: 'send' as const, commandId: 'stale-persist', messageId: 'stale-persist', threadId: id, text: 'Must not send', expectedLastUserMessageId: null }
    const sending = f.host.execute(command).then(result => ({ result }), error => ({ error: error as Error }))
    await reached; await f.driver.typeInProvider(id, 'External takeover while persisting')
    release()
    expect(await sending).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('changed') }) })
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(0)
    const aliases = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))
    expect(aliases[id].origins).toEqual([])
    // Writing the store whole cleared the journal, so the removed origin cannot come back on the next connect.
    expect(await readFile(join(f.root, 'claude-origins.jsonl'), 'utf8').catch(() => '')).not.toContain('stale-persist')
    vi.restoreAllMocks()
    const latest = (await thread()).messages.filter(message => message.role === 'user').at(-1)!.id
    expect(await f.host.execute({ ...command, expectedLastUserMessageId: latest })).toEqual({ accepted: true })
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(1)
  })
  it('folds an origin only the journal holds back into the thread store on connect, past a line a crash cut short', async () => {
    expect(await f.host.execute({ type: 'send', commandId: 'journaled', messageId: 'journaled', threadId: id, text: 'Synthetic journaled prompt' })).toEqual({ accepted: true })
    f.host.disconnect(); await f.adapter.closed()
    // Nothing wrote the store whole since the send, so the origin is in the journal alone, as a crash would leave
    // it. A second append that a crash cut short follows it.
    const storePath = join(f.root, 'claude-threads.json'); const journalPath = join(f.root, 'claude-origins.jsonl')
    type Stored = Record<string, { origins: { messageId: string }[] }>
    expect((JSON.parse(await readFile(storePath, 'utf8')) as Stored)[id]!.origins).toEqual([])
    const lines = (await readFile(journalPath, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { threadId: string; origin: { messageId: string } })
    const origin = lines.find(line => line.threadId === id && line.origin.messageId === 'journaled')!.origin
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}\n{"threadId":"${id}","origin":{"messageId":"cut-sh`)
    f = await claudeFixture(f.root); await f.host.connect()
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as Stored
    expect(stored[id]!.origins).toContainEqual(origin)
    expect(stored[id]!.origins.filter(candidate => candidate.messageId === 'journaled')).toHaveLength(1)
    // Folded in and cleared, so this connection's lines never follow the one cut short.
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    f.host.disconnect(); await f.adapter.closed()
    // A journal holding nothing the store lacks is cleared too, a cut-short line and all.
    await writeFile(journalPath, `\n${JSON.stringify({ threadId: id, origin })}\n\n{"threadId":"${id}","orig`)
    f = await claudeFixture(f.root); await f.host.connect()
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((JSON.parse(await readFile(storePath, 'utf8')) as Stored)[id]!.origins.filter(candidate => candidate.messageId === 'journaled')).toHaveLength(1)
  })
  it('still connects when a leftover journal holding nothing new cannot be cleared', async () => {
    expect(await f.host.execute({ type: 'send', commandId: 'kept', messageId: 'kept', threadId: id, text: 'Synthetic kept prompt' })).toEqual({ accepted: true })
    f.host.disconnect(); await f.adapter.closed()
    f = await claudeFixture(f.root); await f.host.connect()
    f.host.disconnect(); await f.adapter.closed()
    // The store holds the origin now; a journal left behind repeats it, and the file cannot be removed.
    const journalPath = join(f.root, 'claude-origins.jsonl')
    const stored = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8')) as Record<string, { origins: { messageId: string }[] }>
    const origin = stored[id]!.origins.find(candidate => candidate.messageId === 'kept')!
    await writeFile(journalPath, `\n${JSON.stringify({ threadId: id, origin })}\n`)
    vi.spyOn(ClaudeOriginJournal.prototype, 'clear').mockRejectedValue(Object.assign(new Error('Synthetic lock'), { code: 'EBUSY' }))
    f = await claudeFixture(f.root)
    await f.host.connect()
    expect((await f.host.snapshot()).connected).toBe(true)
  })
  it('counts a whole write of the thread store as saved when the journal behind it cannot be cleared', async () => {
    vi.spyOn(ClaudeOriginJournal.prototype, 'clear').mockRejectedValue(Object.assign(new Error('Synthetic lock'), { code: 'EBUSY' }))
    const other = randomUUID()
    await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: other, projectId: f.projectId, title: 'Other', modelId: f.modelId })).resolves.toEqual({ accepted: true })
    expect(Object.keys(JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8')) as Record<string, unknown>)).toContain(other)
  })
  it('starts a thread whose first send was refused at the dispatch check, when the journal behind its rollback could not be cleared', async () => {
    // Claude Code stops after the origin is journaled and before the prompt is written: nothing is sent. The
    // rollback writes the store whole without the origin, and the journal line it leaves cannot be removed.
    const append = ClaudeOriginJournal.prototype.append
    vi.spyOn(ClaudeOriginJournal.prototype, 'append').mockImplementation(async function (this: ClaudeOriginJournal<unknown>, entry) {
      await append.call(this, entry)
      if ((entry.origin as { messageId: string }).messageId === 'refused') await (f.adapter as unknown as { stopSession(id: string): Promise<void> }).stopSession(id)
    })
    vi.spyOn(ClaudeOriginJournal.prototype, 'clear').mockRejectedValue(Object.assign(new Error('Synthetic lock'), { code: 'EBUSY' }))
    await expect(f.host.execute({ type: 'send', commandId: 'refused', messageId: 'refused', threadId: id, text: 'Must not send' })).rejects.toThrow('Nothing was sent')
    expect(await readFile(join(f.root, 'claude-origins.jsonl'), 'utf8')).toContain('refused')
    vi.restoreAllMocks()
    // Sotto stops before another whole write. The leftover line is from before the rollback, so it stays out.
    f.host.disconnect(); await f.adapter.closed()
    f = await claudeFixture(f.root); await f.host.connect()
    expect(await f.host.execute({ type: 'send', commandId: 'after', messageId: 'after', threadId: id, text: 'Synthetic prompt after the refusal' })).toEqual({ accepted: true })
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(1)
  })
  it('folds every line of a journal into a store written before there were journal generations, then stamps the store', async () => {
    expect(await f.host.execute({ type: 'send', commandId: 'unstamped', messageId: 'unstamped', threadId: id, text: 'Synthetic unstamped prompt' })).toEqual({ accepted: true })
    f.host.disconnect(); await f.adapter.closed()
    const storePath = join(f.root, 'claude-threads.json'); const journalPath = join(f.root, 'claude-origins.jsonl')
    type Stored = Record<string, { origins: { messageId: string }[]; journalGeneration?: number }>
    const store = JSON.parse(await readFile(storePath, 'utf8')) as Stored
    for (const alias of Object.values(store)) delete alias.journalGeneration
    await writeFile(storePath, JSON.stringify(store))
    const lines = (await readFile(journalPath, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { generation?: number })
    for (const line of lines) delete line.generation
    await writeFile(journalPath, lines.map(line => `\n${JSON.stringify(line)}\n`).join(''))
    f = await claudeFixture(f.root); await f.host.connect()
    const folded = JSON.parse(await readFile(storePath, 'utf8')) as Stored
    expect(folded[id]!.origins.map(origin => origin.messageId)).toContain('unstamped')
    expect(folded[id]!.journalGeneration).toBeGreaterThan(0)
  })
  it('starts a thread whose first origin line was written before its append failed', async () => {
    const append = ClaudeOriginJournal.prototype.append
    vi.spyOn(ClaudeOriginJournal.prototype, 'append').mockImplementationOnce(async function (this: ClaudeOriginJournal<unknown>, entry) {
      await append.call(this, entry)
      throw Object.assign(new Error('Synthetic sync failure'), { code: 'EIO' })
    })
    await expect(f.host.execute({ type: 'send', commandId: 'unsynced', messageId: 'unsynced', threadId: id, text: 'Must not send' })).rejects.toThrow('Synthetic sync failure')
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(0)
    f.host.disconnect(); await f.adapter.closed()
    f = await claudeFixture(f.root); await f.host.connect()
    expect(await f.host.execute({ type: 'send', commandId: 'after', messageId: 'after', threadId: id, text: 'Synthetic prompt after the failure' })).toEqual({ accepted: true })
  })
  it('connects with the journal’s origins when folding them into the thread store fails, and keeps the journal', async () => {
    expect(await f.host.execute({ type: 'send', commandId: 'journaled', messageId: 'journaled', threadId: id, text: 'Synthetic journaled prompt' })).toEqual({ accepted: true })
    f.host.disconnect(); await f.adapter.closed()
    const storePath = join(f.root, 'claude-threads.json'); const journalPath = join(f.root, 'claude-origins.jsonl')
    type Stored = Record<string, { origins: { messageId: string }[] }>
    expect((JSON.parse(await readFile(storePath, 'utf8')) as Stored)[id]!.origins).toEqual([])
    const write = AtomicJsonStore.prototype.write
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value, compact) {
      if ((this as unknown as { filePath: string }).filePath === storePath) return Promise.reject(Object.assign(new Error('Synthetic full disk'), { code: 'ENOSPC' }))
      return write.call(this, value, compact)
    })
    const events: string[] = []
    f = await claudeFixture(f.root, undefined, undefined, { logEvent: event => events.push(event) })
    await f.host.connect()
    expect((await f.host.snapshot()).connected).toBe(true)
    expect(events).toContain('claude-origin-journal-fold-failed')
    expect(await readFile(journalPath, 'utf8')).toContain('journaled')
    // The thread still knows it sent that prompt, so asking again does not send it twice.
    expect(await f.host.execute({ type: 'send', commandId: 'journaled', messageId: 'journaled', threadId: id, text: 'Synthetic journaled prompt' })).toEqual({ accepted: true })
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(1)
    vi.restoreAllMocks()
    // The next whole write folds them in for good and clears the journal.
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, title: 'Other', modelId: f.modelId })
    expect((JSON.parse(await readFile(storePath, 'utf8')) as Stored)[id]!.origins.map(origin => origin.messageId)).toContain('journaled')
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('reconciles image-only native frames over 1 MiB and restores references without persisting image bytes', async () => {
    const image = Buffer.alloc(1024 * 1024); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image)
    const attachment = promptImageOf(image, 'image', 'image.png')
    expect(await f.host.execute({ type: 'send', commandId: 'image-command', messageId: 'image-message', threadId: id, text: '', attachments: [attachment] })).toEqual({ accepted: true })
    expect((await thread()).messages[0]).toMatchObject({ id: 'image-message', text: '', attachments: [{ id: 'image', sizeBytes: image.length }] })
    const stored = await readFile(join(f.root, 'claude-threads.json'), 'utf8')
    expect(stored).not.toContain(image.toString('base64'))
    f = await f.driver.restart() as typeof f; await f.host.connect()
    expect((await thread()).messages[0]).toMatchObject({ id: 'image-message', commandId: 'image-command', attachments: [{ id: 'image', sizeBytes: image.length }] })
  })
  it('restores submitted image previews through control after native restart under the same Sotto thread and message', async () => {
    const image = handleOf(PIXEL_PNG, 'preview', 'Screenshot.png')
    const credentials = await testCredentials(f.root, { mode: 'unavailable' })
    let registry = new ThreadRegistry(f.root)
    let wrapped = new SottoThreadHost('claude', f.adapter, registry)
    const create = () => createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: wrapped, credentials, reasoner: e2eAgentReasoner,
    })
    let control = create()
    try {
      await control.start(); await stageInto(control, PIXEL_PNG); await control.command({ type: 'connect' })
      const sottoId = registry.all().find(binding => binding.sessionId === id)!.threadId
      expect(sottoId).not.toBe(id)
      const result = await control.command({ type: 'manual-send', threadId: sottoId, text: '', attachments: [image] })
      expect(result.error).toBeNull()
      const message = result.host.threads.find(thread => thread.id === sottoId)!.messages[0]!
      expect(message.attachments?.[0]?.preview).toEqual({ available: true })
      expect(await control.attachmentPreview({ threadId: sottoId, messageId: message.id, attachmentId: image.id })).toEqual({ dataUrl: PIXEL_DATA_URL })
      const cache = await readFile(join(f.root, 'attachment-previews.json'), 'utf8')
      expect(JSON.parse(cache).entries[0]).toMatchObject({ threadId: sottoId, messageId: message.id, commandId: message.commandId })
      expect(cache).not.toContain(id)
      expect(await readFile(join(f.root, 'claude-threads.json'), 'utf8')).not.toContain(PIXEL_DATA_URL)
      control.dispose(); await control.privacyChanged(); await f.adapter.closed(); await registry.flush()
      f = await f.driver.restart() as typeof f
      registry = new ThreadRegistry(f.root); wrapped = new SottoThreadHost('claude', f.adapter, registry)
      control = create(); await control.start(); await control.command({ type: 'connect' })
      expect(control.get().host.threads.find(thread => thread.id === sottoId)!.messages[0]).toEqual(message)
      expect(await control.attachmentPreview({ threadId: sottoId, messageId: message.id, attachmentId: image.id })).toEqual({ dataUrl: PIXEL_DATA_URL })
      expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(1)
    } finally { control.dispose(); await control.privacyChanged(); await f.adapter.closed(); await registry.flush() }
  })
  it('does not resend a repeated uncertain message', async () => {
    await f.driver.delayNextAck('user')
    const command = { type: 'send' as const, commandId: 'command', messageId: 'message', threadId: id, text: 'Sensitive synthetic prompt' }
    expect(await f.host.execute(command)).toEqual({ accepted: false, uncertain: true })
    await f.host.execute(command)
    // The fake CLI records what it was asked as it reads the line, which is not necessarily before the
    // host gives up waiting for the acknowledgement. Wait for the first prompt's record, then read the
    // count again: a resend would still fail, because the second send has already been refused.
    const prompts = async (): Promise<number> => (await f.driver.requests()).filter(record => record.method === 'user').length
    await expect.poll(prompts).toBe(1)
    expect(await prompts()).toBe(1)
    expect(await readFile(join(f.root, 'claude-threads.json'), 'utf8')).not.toContain(command.text)
  })
  const chromeReply = "/chrome isn't available in this environment."
  // Claude Code 2.1.289 reports the start before the reply, so the prompt sits above it. A result alone records it after.
  it.each([
    { evidence: undefined, order: ['user', 'assistant'] },
    { evidence: 'result', order: ['assistant', 'user'] },
  ])('takes a slash command Claude Code answers itself without an echo (evidence: $evidence)', async ({ evidence, order }) => {
    await writeFile(join(f.root, 'script.json'), JSON.stringify({ localCommand: chromeReply, evidence }))
    expect(await f.host.execute({ type: 'send', commandId: 'chrome', messageId: 'chrome', threadId: id, text: '/chrome' })).toEqual({ accepted: true })
    const messages = (await thread()).messages
    expect(messages).toContainEqual(expect.objectContaining({ id: 'chrome', role: 'user', text: '/chrome', commandId: 'chrome' }))
    expect(messages).toContainEqual(expect.objectContaining({ role: 'assistant', text: chromeReply }))
    expect(messages.map(message => message.role)).toEqual(order)
    await expect.poll(async () => (await thread()).status).toBe('idle')
    await writeFile(join(f.root, 'script.json'), '{}')
    expect(await f.host.execute({ type: 'send', commandId: 'after', messageId: 'after', threadId: id, text: 'Carry on' })).toEqual({ accepted: true })
  })
  it('reads a slash command it sent back from the transcript when nothing confirmed it', async () => {
    await writeFile(join(f.root, 'script.json'), JSON.stringify({ localCommand: chromeReply, evidence: 'none' }))
    const command = { type: 'send' as const, commandId: 'chrome', messageId: 'chrome', threadId: id, text: '/chrome' }
    expect(await f.host.execute(command)).toEqual({ accepted: false, uncertain: true })
    await f.adapter.pollSessionLogs()
    expect((await thread()).messages).toContainEqual(expect.objectContaining({ id: 'chrome', role: 'user', text: '/chrome' }))
    // Checking again finds the prompt in the record rather than sending it twice.
    expect(await f.host.execute(command)).toEqual({ accepted: true })
    expect((await f.driver.requests()).filter(record => record.method === 'user')).toHaveLength(1)
  })
  it('sends a native denial for malformed question control requests', async () => {
    await f.action(id, { type: 'raw', frame: { type: 'control_request', request_id: 'malformed', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } } })
    await expect.poll(async () => JSON.stringify(await f.driver.requests())).toContain('"behavior":"deny"')
    expect((await thread()).requests).toEqual([])
  })
  it.each(['answer', 'interrupt', 'cancel'] as const)('keeps a pending request after a turn result until %s', async end => {
    await f.action(id, { type: 'raw', frame: { type: 'control_request', request_id: 'pending-after-result',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm run build' } } } })
    await expect.poll(async () => (await thread()).requests.map(request => request.id)).toEqual(['pending-after-result'])
    await f.driver.backgroundWork!.completeLeaving(id, 'The agent is still working.', 'Build')
    await expect.poll(async () => (await thread()).messages.at(-1)?.text).toBe('The agent is still working.')
    expect((await thread()).requests.map(request => request.id)).toEqual(['pending-after-result'])
    if (end === 'cancel') {
      await f.action(id, { type: 'raw', frame: { type: 'control_cancel_request', request_id: 'pending-after-result' } })
    } else {
      const result = end === 'answer'
        ? await f.host.execute({ type: 'answer', commandId: 'answer', threadId: id, requestId: 'pending-after-result', answer: '', approved: false })
        : await f.host.execute({ type: 'interrupt', commandId: 'stop', threadId: id })
      expect(result.accepted).toBe(true)
      await expect.poll(async () => (await f.driver.requests()).some(record => {
        const frame = record.params?.frame as { response?: { request_id?: string; response?: { behavior?: string } } }
        return frame.response?.request_id === 'pending-after-result' && frame.response.response?.behavior === 'deny'
      })).toBe(true)
    }
    await expect.poll(async () => (await thread()).requests).toEqual([])
  })
  it('resumes the native context after CLI takeover before another prompt', async () => {
    await f.driver.backgroundWork!.completeLeaving(id, 'Still working.', 'Build')
    await expect.poll(async () => (await thread()).backgroundWork?.length).toBe(1)
    await f.driver.typeInProvider(id, 'Typed outside Sotto')
    await f.host.execute({ type: 'send', commandId: 'next', messageId: 'next', threadId: id, text: 'Continue' })
    expect((await f.driver.requests()).filter(record => record.method === 'resume')).toHaveLength(1)
  })
  it('reads appended transcript lines before an overlapping caller returns', async () => {
    clearInterval((f.adapter as unknown as { pollTimer: NodeJS.Timeout }).pollTimer)
    await f.adapter.pollSessionLogs()
    const calls = vi.spyOn(f.adapter, 'pollSessionLogs')

    const { promise: gate, resolve: release } = deferred<void>()

    const original = ClaudeSessionLog.prototype.poll

    const { promise: read, resolve: reached } = deferred<void>()

    const poll = vi.spyOn(ClaudeSessionLog.prototype, 'poll').mockImplementationOnce(async function (this: ClaudeSessionLog) {
      await original.call(this); reached(); await gate
    })
    const first = f.adapter.pollSessionLogs()
    await read
    const joined = f.driver.typeInProvider(id, 'Appended after the first read')
    try {
      await expect.poll(() => calls.mock.calls.length).toBe(2)
      release(); await Promise.all([first, joined])
      // Inspect the projection directly: snapshot() would perform a fresh read and hide the bug.
      const messages = (f.adapter as unknown as { messageLog: { messages(id: string): { text: string }[] } }).messageLog.messages(id)
      expect(messages.some(message => message.text === 'Appended after the first read')).toBe(true)
    } finally { release(); await first; poll.mockRestore() }
    const next = vi.spyOn(ClaudeSessionLog.prototype, 'poll')
    try { await f.adapter.pollSessionLogs(); expect(next).toHaveBeenCalledTimes(1) }
    finally { next.mockRestore() }
  })
  it('releases settled runtime closures before disconnect', async () => {
    for (const mode of ['full-access', 'approval-required', 'full-access'] as const) {
      expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: mode })).accepted).toBe(true)
    }
    const retained = () => {
      const closures = (f.adapter as unknown as { closures: Promise<void>[] | Set<Promise<void>> }).closures
      return Array.isArray(closures) ? closures.length : closures.size
    }
    await expect.poll(retained).toBe(1)
  })
  it('runs a queued read after the preceding read fails', async () => {
    clearInterval((f.adapter as unknown as { pollTimer: NodeJS.Timeout }).pollTimer)
    await f.adapter.pollSessionLogs()

    const { promise: gate, reject: fail } = deferred<void>()

    const poll = vi.spyOn(ClaudeSessionLog.prototype, 'poll').mockImplementationOnce(() => gate).mockResolvedValueOnce(undefined)
    const first = f.adapter.pollSessionLogs().catch((error: Error) => error)
    const queued = f.adapter.pollSessionLogs().then(() => 'read', (error: Error) => error.message)
    fail(new Error('First read failed'))
    expect(await first).toEqual(new Error('First read failed'))
    expect(await queued).toBe('read')
    expect(poll).toHaveBeenCalledTimes(2)
  })
  it('finishes joined reads without waiting for later poll arrivals', async () => {
    clearInterval((f.adapter as unknown as { pollTimer: NodeJS.Timeout }).pollTimer)
    // Stopping the timer leaves its active read in flight. Drain it before holding our own passes.
    await f.adapter.pollSessionLogs()
    const releases: (() => void)[] = []
    const gates = Array.from({ length: 3 }, () => { const gate = deferred(); releases.push(gate.resolve); return gate.promise })
    let index = 0
    const poll = vi.spyOn(ClaudeSessionLog.prototype, 'poll').mockImplementation(() => gates[index++] ?? Promise.resolve())
    const first = f.adapter.pollSessionLogs()
    let joinedDone = false
    const joined = f.adapter.pollSessionLogs().then(() => { joinedDone = true })
    let later: Promise<void> | undefined
    try {
      releases[0]!(); await expect.poll(() => poll.mock.calls.length).toBe(2)
      later = f.adapter.pollSessionLogs()
      releases[1]!(); await expect.poll(() => poll.mock.calls.length).toBe(3)
      await expect.poll(() => joinedDone).toBe(true)
    } finally { releases.forEach(release => release()); await Promise.all([first, joined, later]); poll.mockRestore() }
  })
  it('delivers only the original answer when stdin resumes after its deadline', async () => {
    await f.driver.raisePermission(id, 'Build')
    await expect.poll(async () => (await thread()).requests.length).toBe(1)
    const requestId = (await thread()).requests[0]!.id
    const delayed = delayStdin(f.adapter, id)
    const answer = { type: 'answer' as const, commandId: 'deny', threadId: id, requestId, answer: '', approved: false }
    try {
      expect(await f.host.execute(answer)).toMatchObject({ accepted: false, uncertain: true })
      await f.host.refreshThread!(id, { retryUncertainAnswers: true })
      await f.host.execute({ ...answer, commandId: 'allow', approved: true })
      delayed.release(); delayed.restore()
      await expect.poll(async () => (await thread()).requests).toEqual([])
      await expect.poll(async () => (await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) !== undefined)
        .map(record => f.protocol!.permissionDecision(record))).toEqual([false])
    } finally { delayed.release(); delayed.restore() }
  })
  it('lets the user retry an uncertain answer after a turn result without replaying it', async () => {
    await f.driver.raisePermission(id, 'Build')
    await expect.poll(async () => (await thread()).requests.length).toBe(1)
    const requestId = (await thread()).requests[0]!.id
    const write = ClaudeProtocol.prototype.write
    const failed = vi.spyOn(ClaudeProtocol.prototype, 'write').mockImplementationOnce(() => Promise.reject(new Error('Uncertain write')))
    const command = { type: 'answer' as const, commandId: 'first-answer', threadId: id, requestId, answer: '', approved: false }
    expect(await f.host.execute(command)).toEqual({ accepted: false, uncertain: true })
    failed.mockRestore()
    await f.driver.completeTurn(id, 'Turn ended before the answer arrived.')
    await expect.poll(async () => (await thread()).status).toBe('idle')
    expect((await thread()).requests[0]!.delivery).toBe('uncertain')
    expect((await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) !== undefined)).toHaveLength(0)
    await expect(f.host.execute({ type: 'send', commandId: 'blocked', messageId: 'blocked', threadId: id, text: 'Continue' })).rejects.toThrow('pending Claude request')

    const { promise: gate, resolve: release } = deferred<void>()

    const retryWrite = vi.spyOn(ClaudeProtocol.prototype, 'write').mockImplementationOnce(async function (this: ClaudeProtocol, frame) { await gate; await write.call(this, frame) })
    const retry = f.host.execute({ ...command, commandId: 'retry', approved: true })
    try {
      await expect.poll(() => retryWrite.mock.calls.length).toBe(1)
      expect(await f.host.execute({ ...command, commandId: 'duplicate' })).toEqual({ accepted: false, uncertain: true })
      release(); expect(await retry).toEqual({ accepted: true })
    } finally { release(); await retry; retryWrite.mockRestore() }
    expect((await thread()).requests).toEqual([])
    await expect.poll(async () => (await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) !== undefined).map(record => f.protocol!.permissionDecision(record))).toEqual([true])
    expect(await f.host.execute({ type: 'send', commandId: 'unblocked', messageId: 'unblocked', threadId: id, text: 'Continue' })).toEqual({ accepted: true })
  })
  it('permits a new answer only after a delayed stdin callback fails outright', async () => {
    await f.driver.raisePermission(id, 'Build')
    await expect.poll(async () => (await thread()).requests.length).toBe(1)
    const requestId = (await thread()).requests[0]!.id
    const delayed = delayStdin(f.adapter, id)
    const answer = { type: 'answer' as const, commandId: 'deny', threadId: id, requestId, answer: '', approved: false }
    try {
      const result = await f.host.execute(answer)
      expect(result).toMatchObject({ accepted: false, uncertain: true })
      delayed.fail(); delayed.restore(); expect(await result.answerCompletion).toBe(false)
      await f.host.refreshThread!(id, { retryUncertainAnswers: true })
      expect(await f.host.execute({ ...answer, commandId: 'allow', approved: true })).toEqual({ accepted: true })
      await expect.poll(async () => (await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) !== undefined)
        .map(record => f.protocol!.permissionDecision(record))).toEqual([true])
    } finally { delayed.release(); delayed.restore() }
  })
  it.each(['none', 'draft', 'error'] as const)('settles the original project answer after a newer %s', async later => {
    const credentials = await testCredentials(f.root, { mode: 'unavailable' })
    const registry = new ThreadRegistry(f.root), wrapped = new SottoThreadHost('claude', f.adapter, registry)
    const recordAnswer = vi.fn()
    Object.assign(wrapped, { recordAnswer })
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: wrapped, credentials, reasoner: e2eAgentReasoner,
    })
    let delayed: ReturnType<typeof delayStdin> | undefined
    try {
      await control.start(); await control.command({ type: 'connect' })
      const threadId = registry.all().find(binding => binding.sessionId === id)!.threadId
      await wrapped.refreshThread(threadId); await f.driver.raiseQuestion(id, 'Color?')
      await expect.poll(async () => (await thread()).requests.length).toBe(1)
      const requestId = (await thread()).requests[0]!.id
      delayed = delayStdin(f.adapter, id)
      await control.command({ type: 'answer', threadId, requestId, answer: 'Blue' })
      expect(recordAnswer).toHaveBeenCalledTimes(1)
      await control.refreshRequestDraft(threadId)
      expect((await thread()).requests[0]!.answerRetryReady).toBeUndefined()
      expect(control.requestAnswerRecovery(threadId, 'claude').uncertainRequestIds).toEqual([requestId])
      expect(control.get().error).not.toBeNull()
      let expectedError: string | null = null
      if (later === 'draft') await control.command({ type: 'save-thread-draft', threadId, draftId: randomUUID(), text: 'Unsent draft', attachments: [], requestId: null })
      if (later === 'error') {
        expectedError = (await control.command({ type: 'answer', threadId: 'missing-thread', requestId: 'missing-request', answer: 'Later' })).error
        expect(expectedError).not.toBeNull()
      }
      delayed.release(); delayed.restore()
      await expect.poll(() => control.requestAnswerRecovery(threadId, 'claude').uncertainRequestIds).toEqual([])
      await expect.poll(() => control.requestAnswerRecovery(threadId, 'claude').completed).toMatchObject([{ requestId }])
      await expect.poll(() => control.get().error).toBe(expectedError)
      expect(recordAnswer).toHaveBeenCalledTimes(1)
      await expect.poll(async () => (await thread()).requests).toEqual([])
      await expect.poll(async () => (await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) !== undefined)
        .map(record => f.protocol!.permissionDecision(record))).toEqual([true])
      const delivered = (await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) !== undefined)
      expect(delivered[0]!.params!.frame).toMatchObject({ response: { response: { updatedInput: { answers: { 'Color?': 'Blue' } } } } })
    } finally { delayed?.release(); delayed?.restore(); control.dispose(); await registry.flush() }
  })
  it('reopens a project answer through the coordinator Check again path', async () => {
    const credentials = await testCredentials(f.root, { mode: 'unavailable' })
    const registry = new ThreadRegistry(f.root), wrapped = new SottoThreadHost('claude', f.adapter, registry)
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: wrapped, credentials, reasoner: e2eAgentReasoner,
    })
    try {
      await control.start(); await control.command({ type: 'connect' })
      const threadId = registry.all().find(binding => binding.sessionId === id)!.threadId
      await wrapped.refreshThread(threadId)
      await f.driver.raisePermission(id, 'Build')
      await expect.poll(async () => (await thread()).requests.length).toBe(1)
      const requestId = (await thread()).requests[0]!.id
      const answer = { type: 'answer' as const, threadId, requestId, answer: '', approved: false }
      const failed = vi.spyOn(ClaudeProtocol.prototype, 'write').mockRejectedValueOnce(new Error('Uncertain write'))
      await control.command(answer); failed.mockRestore()
      expect((await thread()).requests[0]!.delivery).toBe('uncertain')
      await control.refreshRequestDraft(threadId)
      expect((await thread()).requests[0]!.answerRetryReady).toBe(true)
      expect((await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) !== undefined)).toHaveLength(0)
      const result = await control.command({ ...answer, approved: true })
      expect(result.error).toBeNull()
      await expect.poll(async () => (await f.driver.requests()).filter(record => f.protocol!.permissionDecision(record) !== undefined).map(record => f.protocol!.permissionDecision(record))).toEqual([true])
    } finally { control.dispose(); await registry.flush() }
  })
  it.each(['browser', 'setup'] as const)('cancels a launch superseded during %s tool setup without blocking its next send', async tools => {

    const { promise: waiting, resolve: entered } = deferred<void>()

    const { promise: ready, resolve: release } = deferred<void>()

    const mcpServer = async () => {
      entered(); await ready
      return { name: 'sotto_browser' as const, type: 'http' as const, url: 'http://127.0.0.1:1234/mcp', headers: [] }
    }
    if (tools === 'browser') f.adapter.useBrowserTools({ definitions: [], call: async () => ({ content: [] }), mcpServer })
    else f.adapter.useThreadTools([{ name: 'fixture_tools', definitions: [], mcpServer }])
    const created = randomUUID()
    const creating = f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: created, projectId: f.projectId, title: 'Cancelled launch', modelId: f.modelId })
    const cancelled = expect(creating).resolves.toEqual({ accepted: false, uncertain: true })
    await waiting
    await f.host.connect()
    release(); await cancelled
    expect(await f.host.execute({ type: 'send', commandId: 'after-reconnect', messageId: 'after-reconnect', threadId: created, text: 'Continue' })).toEqual({ accepted: true })
    expect((await f.sessions!.starts(created))).toBe(1)
  })
  const launches = async () => (await f.driver.requests()).filter(record => record.method === 'launch' || record.method === 'resume').map(record => (record.params?.frame as { args: string[] }).args).filter(args => !args.includes('--no-session-persistence'))
  const permission = (args: string[]) => ({ mode: args[args.indexOf('--permission-mode') + 1], prompts: args[args.indexOf('--permission-prompts') + 1], allowBypass: args.includes('--allow-dangerously-skip-permissions') })
  const surface = (args: string[]) => args[args.indexOf('--permission-prompt-tool') + 1]
  it.each(['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const)('names Sotto the permission prompt surface for %s threads', async runtimeMode => {
    // Without this the CLI answers every prompt that needed a person with its own denial and withholds
    // AskUserQuestion, so approvals and questions stop reaching the user while the thread keeps working.
    const created = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: created, projectId: f.projectId, title: 'Surface', modelId: f.modelId, runtimeMode })
    expect(surface((await launches()).at(-1)!)).toBe('stdio')
  })
  it('says the approval surface was refused when a session offers no question tool', async () => {
    f.host.disconnect(); await f.adapter.closed()
    f = await claudeFixture(f.root); await f.host.connect()
    await writeFile(join(f.root, 'initialize-script.json'), JSON.stringify({ approvalSurface: false }))
    f.host.observeThreads?.([id])
    await expect.poll(async () => (await f.host.snapshot()).error ?? '').toContain('is not letting Sotto answer its permission prompts')
    expect((await f.host.snapshot()).error).toContain('No work was lost')
  })
  it('says a request for the user went unread instead of denying it in silence', async () => {
    // A question whose payload this adapter cannot read is still the CLI asking for the user, and the
    // denial Sotto must send reads to Claude as the user's own answer.
    await f.action(id, { type: 'raw', frame: { type: 'control_request', request_id: 'unreadable',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'tool', input: { questions: [] } } } })
    await expect.poll(async () => (await f.host.snapshot()).error ?? '').toContain('only you can answer')
    await expect.poll(async () => JSON.stringify(await f.driver.requests())).toContain('"behavior":"deny"')
    expect((await thread()).requests).toEqual([])
  })
  it.each(['elicitation', 'request_user_dialog'])('reports an unreadable %s request when declining it', async subtype => {
    await f.action(id, { type: 'raw', frame: { type: 'control_request', request_id: 'unreadable-dialog', request: { subtype, dialog_kind: 'unknown' } } })
    await expect.poll(async () => (await f.driver.requests()).some(record => {
      const frame = record.params?.frame as { response?: { subtype?: string; request_id?: string } }
      return frame.response?.request_id === 'unreadable-dialog' && frame.response.subtype === 'error'
    })).toBe(true)
    expect((await f.host.snapshot()).error).toContain('only you can answer')
    expect((await thread()).requests).toEqual([])
  })
  // Paired with the test above: the fixture differs only in whether its session lists the question tool,
  // so that one proves the list is read and this one proves a complete list is not complained about.
  it('stays quiet while a session offers the question tool', async () => {
    f.host.observeThreads?.([id])
    await expect.poll(async () => (await launches()).length).toBeGreaterThan(0)
    expect((await f.host.snapshot()).error ?? '').not.toContain('permission prompts')
  })
  // The label is the provider's name wherever Sotto shows one: a reply's header, the composer, the model picker and the
  // sidebar row. Codex and Devin use their PROVIDER_LABELS names too; Grok's adapter says "Grok" where PROVIDER_LABELS
  // says "Grok Build".
  it('names its models for Claude Code, as the sidebar and model picker show them', async () => {
    const labels = new Set((await f.host.snapshot()).models.map(model => model.provider))
    expect([...labels]).toEqual(['Claude Code'])
  })
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
  it('enters and leaves full access by starting the native runtime again, so bypassing is allowed only in that mode', async () => {
    const before = (await launches()).length
    expect((await f.host.execute({ type: 'configure-thread', commandId: 'config', threadId: id, runtimeMode: 'full-access' })).accepted).toBe(true)
    expect(await launches()).toHaveLength(before + 1)
    expect(permission((await launches()).at(-1)!)).toEqual({ mode: 'bypassPermissions', prompts: 'host', allowBypass: true })
    expect((await thread()).runtimeMode).toBe('full-access')
    expect(JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[id].runtimeMode).toBe('full-access')
    expect((await f.host.execute({ type: 'configure-thread', commandId: 'config-2', threadId: id, runtimeMode: 'auto-accept-edits' })).accepted).toBe(true)
    expect(await launches()).toHaveLength(before + 2)
    expect(permission((await launches()).at(-1)!)).toEqual({ mode: 'acceptEdits', prompts: 'host', allowBypass: false })
    expect((await thread()).runtimeMode).toBe('auto-accept-edits')
    // Between the other modes the running CLI takes the change in place.
    expect((await f.host.execute({ type: 'configure-thread', commandId: 'config-3', threadId: id, runtimeMode: 'auto' })).accepted).toBe(true)
    expect(await launches()).toHaveLength(before + 2)
    expect((await f.liveSettings.effective(id)).runtimeMode).toBe('auto')
    expect(JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8'))[id].runtimeMode).toBe('auto')
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
