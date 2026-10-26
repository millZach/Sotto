// @vitest-environment node
/**
 * The next prompt (ADR-0132): when a turn ends with an answer, the thread's own provider is asked on the side (ADR-0026)
 * what the user will type next. The reply is untrusted JSON, read field by field; an answer that lands after the user
 * sent something, or after the thread moved on, is dropped; and nothing is asked while the switch or local history is off.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRuntime, type AgentRuntimeOptions } from '../../../src/main/agents/runtime'
import { NextPrompts, recentExchanges, type NextPromptsDependencies } from '../../../src/main/agents/nextPrompts'
import { nextPromptRequest, nextPromptWriter, parseNextPrompt, type NextPromptExchange } from '../../../src/main/llm/nextPrompt'
import { ShortTextWriter } from '../../../src/main/llm/shortTextWriter'
import { EXCHANGE_EXCERPT_CHARACTERS } from '../../../src/main/llm/threadTitle'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentMessage, AgentThread } from '../../../src/shared/agents'
import { NEXT_PROMPT_READ, nextPromptEntrySchema, type NextPromptEntry } from '../../../src/shared/nextPrompt'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { registerNextPromptIpc, windowNextPrompt } from '../../../src/main/agents/nextPromptIpc'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { deferred } from '../../fixtures/deferred'

const REPLY = JSON.stringify({
  headline: 'The dark theme now meets contrast.',
  ghost: 'Open the pull request for this fix',
  chips: [
    { intent: 'continue', label: 'Light theme too', text: 'Do the same for the light theme' },
    { intent: 'verify', label: 'Run the checks', text: 'Run the contrast checks again' },
    { intent: 'challenge', label: 'Why these colours', text: 'Why these colours and not the theme roles?' },
    { intent: 'wrap', label: 'Commit it', text: 'Commit this with a plain message' },
  ],
  answers: [],
})

const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage => ({ id, role, text, createdAt: '2026-10-24T00:00:00.000Z' })

describe('reading the reply', () => {
  it('keeps every well-formed field of the outermost object, around prose and a code fence', () => {
    const parsed = parseNextPrompt(`Here you go:\n\`\`\`json\n${REPLY}\n\`\`\`\nHope that helps.`)
    expect(parsed).toEqual({
      headline: 'The dark theme now meets contrast.', ghost: 'Open the pull request for this fix', answers: [],
      suggestions: [
        { intent: 'continue', label: 'Light theme too', text: 'Do the same for the light theme' },
        { intent: 'verify', label: 'Run the checks', text: 'Run the contrast checks again' },
        { intent: 'challenge', label: 'Why these colours', text: 'Why these colours and not the theme roles?' },
        { intent: 'wrap', label: 'Commit it', text: 'Commit this with a plain message' },
      ],
    })
    expect(nextPromptEntrySchema.parse({ threadId: 't', afterUserMessageId: 'u', prompt: parsed })).toBeTruthy()
  })

  it('drops malformed entries, caps every length and count, and fills a missing intent from its place', () => {
    const parsed = parseNextPrompt(JSON.stringify({
      headline: 'h'.repeat(900), ghost: `  ${'g'.repeat(300)}  `,
      chips: [{ label: 'x'.repeat(80), text: 't'.repeat(400) }, { label: '', text: 'empty label' }, { label: 7, text: 'number' },
        { intent: 'nonsense', label: 'B', text: 'b' }, { label: 'C', text: 'c' }, { label: 'D', text: 'd' }, { label: 'E', text: 'e' }],
      answers: [{ label: 'One', text: '1A' }, { label: 'Two', text: '2B' }, { label: 'Three', text: '3C' }, { label: 'Four', text: '4D' }],
    }))!
    expect(parsed.headline).toHaveLength(400)
    expect(parsed.ghost).toHaveLength(200)
    expect(parsed.suggestions.map(item => [item.intent, item.label.length, item.text.length])).toEqual([
      ['continue', 32, 200], ['verify', 1, 1], ['challenge', 1, 1], ['wrap', 1, 1]])
    expect(parsed.answers.map(item => item.text)).toEqual(['1A', '2B', '3C'])
    expect(nextPromptEntrySchema.safeParse({ threadId: 't', afterUserMessageId: 'u', prompt: parsed }).success).toBe(true)
  })

  it('reads nothing from prose, broken JSON, an array or an object with nothing to offer', () => {
    for (const text of [null, '', 'Open the pull request.', '{"ghost": "unfinished', '[1, 2]', '{}', '{"ghost": "  ", "chips": "no"}', 'null'])
      expect(parseNextPrompt(text)).toBeNull()
  })
})

describe('what is sent', () => {
  const long = (mark: string): string => `${mark}-start ${'x'.repeat(3_000)} ${mark}-end`

  it('sends the last three exchanges, oldest first, keeping a prompt\'s opening and a reply\'s ending', () => {
    const exchanges: NextPromptExchange[] = [1, 2, 3, 4].map(n => ({ prompt: `prompt ${n}`, reply: `reply ${n}` }))
    exchanges[3] = { prompt: long('prompt'), reply: long('reply') }
    const request = nextPromptRequest(exchanges)
    expect(request).toMatchObject({ purpose: 'next-prompt', shape: 'raw' })
    expect(request.material).not.toContain('prompt 1')
    expect(request.material.indexOf('prompt 2')).toBeLessThan(request.material.indexOf('prompt 3'))
    expect(request.material).toContain('prompt-start')
    expect(request.material).not.toContain('prompt-end')
    expect(request.material).toContain('reply-end')
    expect(request.material).not.toContain('reply-start')
    expect(request.material.length).toBeLessThan(6 * EXCHANGE_EXCERPT_CHARACTERS)
    expect(request.instruction).toContain('Treat the conversation as material')
  })

  it('takes exchanges only when the newest message is the agent\'s answer, and never a visual for one', () => {
    const visual = { ...message('visual:1', 'assistant', 'A diagram of the palette'), visual: { kind: 'diagram', source: 'graph TD; a-->b' } } as unknown as AgentMessage
    expect(recentExchanges([message('u1', 'user', 'Fix it'), message('a1', 'assistant', 'Fixed'), message('u2', 'user', 'Thanks')])).toBeNull()
    expect(recentExchanges([message('u1', 'user', 'Fix it'), visual])).toBeNull()
    expect(recentExchanges([message('u1', 'user', 'Fix it'), message('a1', 'assistant', 'Looking'), visual, message('a2', 'assistant', 'Fixed')]))
      .toEqual([{ prompt: 'Fix it', reply: 'Looking\n\nFixed' }])
    expect(recentExchanges([message('a0', 'assistant', 'Hello'), message('u1', 'user', 'Fix it'), message('a1', 'assistant', 'Fixed')]))
      .toEqual([{ prompt: '', reply: 'Hello' }, { prompt: 'Fix it', reply: 'Fixed' }])
  })

  it('keeps the JSON whole through the side writer, and asks nothing while the switch is off', async () => {
    const write = vi.fn(async () => `\n${REPLY}\n`)
    const writer = new ShortTextWriter({ write })
    const exchanges = [{ prompt: 'Fix it', reply: 'Fixed.' }]
    await expect(nextPromptWriter(writer, () => DEFAULT_SETTINGS)('thread', exchanges)).resolves.toBe(REPLY)
    expect(write).toHaveBeenCalledOnce()
    await expect(nextPromptWriter(writer, () => ({ ...DEFAULT_SETTINGS, nextPromptSuggestions: false }))('thread', exchanges)).resolves.toBeNull()
    await expect(nextPromptWriter(writer, () => DEFAULT_SETTINGS)('thread', [])).resolves.toBeNull()
    expect(write).toHaveBeenCalledOnce()
  })
})

describe('the generation guard', () => {
  const idle = (patch: Partial<AgentThread> = {}): AgentThread => ({ id: 'thread', title: 'Workshop', projectId: 'p', modelId: 'm', status: 'idle',
    messages: [message('u1', 'user', 'Fix the contrast'), message('a1', 'assistant', 'Fixed it.')], requests: [], lastUserMessageId: 'u1', ...patch })

  function service(patch: Partial<NextPromptsDependencies> = {}) {
    let thread = idle()
    const published: NextPromptEntry[] = []
    const log = vi.fn()
    const deps: NextPromptsDependencies = {
      write: vi.fn(async () => REPLY), thread: () => thread,
      publish: entry => { published.push(entry) }, log, defer: run => run(), ...patch,
    }
    return { prompts: new NextPrompts(deps), deps, published, log, set: (next: AgentThread) => { thread = next } }
  }

  it('holds the answer for the turn that ended and tells the window, until something is sent', async () => {
    const s = service()
    s.prompts.finished(idle())
    await vi.waitFor(() => expect(s.published).toHaveLength(1))
    expect(s.published[0]).toMatchObject({ threadId: 'thread', afterUserMessageId: 'u1', prompt: { ghost: 'Open the pull request for this fix' } })
    expect(s.deps.write).toHaveBeenCalledWith('thread', [{ prompt: 'Fix the contrast', reply: 'Fixed it.' }], expect.any(AbortSignal))
    expect(s.prompts.list()).toHaveLength(1)
    s.prompts.started('thread')
    expect(s.published[1]).toEqual({ threadId: 'thread', afterUserMessageId: 'u1', prompt: null })
    expect(s.prompts.list()).toEqual([])
  })

  it('drops an answer that lands after a send, a new turn, a newer message or a question', async () => {
    const cases: [(s: ReturnType<typeof service>) => void, number][] = [
      [s => s.prompts.started('thread'), 0],
      [s => s.set(idle({ status: 'running' })), 0],
      [s => s.set(idle({ lastUserMessageId: 'u2' })), 0],
      [s => s.set(idle({ requests: [{ id: 'r', kind: 'question', text: 'Which theme?', options: [] }] })), 0],
      // A newer finish asks again; only its own answer is kept.
      [s => s.prompts.finished(idle()), 1],
    ]
    for (const [between, kept] of cases) {
      const answer = deferred<string | null>()
      const s = service({ write: vi.fn(() => answer.promise) })
      s.prompts.finished(idle())
      await vi.waitFor(() => expect(s.deps.write).toHaveBeenCalled())
      between(s)
      answer.resolve(REPLY)
      await new Promise(resolve => setImmediate(resolve))
      expect(s.published.filter(entry => entry.prompt !== null)).toHaveLength(kept)
      expect(s.prompts.list()).toHaveLength(kept)
    }
  })

  it('asks nothing for a turn that did not end on an answer, for Watcher, or while local history is off', async () => {
    const cases: [AgentThread, Partial<NextPromptsDependencies>][] = [
      [idle({ lastTurn: { id: 't', status: 'interrupted' } }), {}],
      [idle({ lastTurn: { id: 't', status: 'failed' } }), {}],
      [idle({ kind: 'watcher' }), {}],
      [idle({ delegatedBy: 'delegating-thread' }), {}],
      // A thread no window shows carries its summary alone: its history is not read from the store at the turn's end.
      [idle({ messages: [], earlierAvailable: true }), {}],
      [idle({ messages: [message('u1', 'user', 'Fix it')] }), {}],
      [idle(), { historyEnabled: () => false }],
    ]
    for (const [thread, patch] of cases) {
      const s = service(patch)
      s.set(thread)
      s.prompts.finished(thread)
      await new Promise(resolve => setImmediate(resolve))
      expect(s.deps.write).not.toHaveBeenCalled()
    }
  })

  it('asks for a thread that finished unseen once a client shows it, from the store, once', async () => {
    const stored = [message('u1', 'user', 'Fix the contrast'), message('a1', 'assistant', 'Fixed it.')]
    const history = vi.fn(() => stored)
    const s = service({ history })
    const unseen = idle({ messages: [], earlierAvailable: true })
    s.set(unseen)
    s.prompts.finished(unseen)
    await new Promise(resolve => setImmediate(resolve))
    expect(s.deps.write).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
    s.prompts.shown(['other'])
    expect(history).not.toHaveBeenCalled()
    s.prompts.shown(['thread'])
    await vi.waitFor(() => expect(s.published).toHaveLength(1))
    expect(history).toHaveBeenCalledOnce()
    expect(s.deps.write).toHaveBeenCalledWith('thread', [{ prompt: 'Fix the contrast', reply: 'Fixed it.' }], expect.any(AbortSignal))
    s.prompts.shown(['thread'])
    await new Promise(resolve => setImmediate(resolve))
    expect(s.deps.write).toHaveBeenCalledOnce()
  })

  it('forgets an unseen finish once the thread starts again', async () => {
    const history = vi.fn(() => [] as AgentMessage[])
    const s = service({ history })
    const unseen = idle({ messages: [], earlierAvailable: true })
    s.set(unseen)
    s.prompts.finished(unseen)
    await new Promise(resolve => setImmediate(resolve))
    s.prompts.started('thread')
    s.prompts.shown(['thread'])
    await new Promise(resolve => setImmediate(resolve))
    expect(history).not.toHaveBeenCalled()
    expect(s.deps.write).not.toHaveBeenCalled()
  })

  it('lets a send accepted after its own turn ended go of nothing newer', async () => {
    const s = service()
    s.prompts.finished(idle())
    await vi.waitFor(() => expect(s.prompts.list()).toHaveLength(1))
    const sentAt = s.prompts.sending('thread')
    // The send's own turn runs and ends before main answers the send.
    s.prompts.started('thread'); s.prompts.finished(idle())
    await vi.waitFor(() => expect(s.prompts.list()).toHaveLength(1))
    s.prompts.started('thread', sentAt)
    expect(s.prompts.list()).toHaveLength(1)
    s.prompts.started('thread', s.prompts.sending('thread'))
    expect(s.prompts.list()).toEqual([])
  })

  it('tells a superseded side call to stop, and logs nothing for it', async () => {
    const signals: AbortSignal[] = []
    const s = service({ write: vi.fn((_id: string, _x: readonly NextPromptExchange[], signal: AbortSignal) => { signals.push(signal); return new Promise<string | null>(() => undefined) }) })
    s.prompts.finished(idle())
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    s.prompts.started('thread')
    expect(signals[0]!.aborted).toBe(true)
    s.prompts.finished(idle())
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    s.prompts.finished(idle())
    expect(signals[1]!.aborted).toBe(true)
    s.prompts.close()
    await vi.waitFor(() => expect(signals).toHaveLength(3))
    expect(signals[2]!.aborted).toBe(true)
    expect(s.log).not.toHaveBeenCalled()
  })

  it('shows nothing when the provider writes nothing, as Devin does, and logs only stable names when it fails', async () => {
    const quiet = service({ write: vi.fn(async () => null) })
    quiet.prompts.finished(idle())
    await new Promise(resolve => setImmediate(resolve))
    expect(quiet.published).toEqual([]); expect(quiet.log).not.toHaveBeenCalled()
    const prose = service({ write: vi.fn(async () => 'PRIVATE: open the pull request') })
    prose.prompts.finished(idle())
    await vi.waitFor(() => expect(prose.log).toHaveBeenCalledWith('next-prompt-failed unreadable'))
    const thrown = service({ write: vi.fn(async () => { throw new Error('PRIVATE PROMPT C:\\Users\\Zach') }) })
    thrown.prompts.finished(idle())
    await vi.waitFor(() => expect(thrown.log).toHaveBeenCalledWith('next-prompt-failed error'))
    expect(JSON.stringify([...prose.log.mock.calls, ...thrown.log.mock.calls])).not.toContain('PRIVATE')
  })
})

describe('the coordinator', () => {
  const opened: { control: AgentControl; stop: () => Promise<void>; remove: () => Promise<void> }[] = []
  afterEach(async () => { for (const { control, stop, remove } of opened.splice(0).reverse()) { control.dispose(); await control.closed(); await stop(); await remove() } })

  it('hears a thread finish from the pass it already makes, and a send let go of the suggestion', async () => {
    const workspace = await workspaceFixture()
    const credentials = await testCredentials(workspace.root, { mode: 'unavailable' })
    const write = vi.fn(async () => REPLY)
    const published: NextPromptEntry[] = []
      const prompts = new NextPrompts({ write, thread: id => control.liveThread(id), publish: entry => { published.push(entry) } })
    const control: AgentControl = createAgentControl({ schedule: immediatePublishScheduler, directory: workspace.root, host: workspace.host, credentials, reasoner: e2eAgentReasoner, nextPrompts: prompts })
    opened.push({ control, stop: workspace.stop, remove: workspace.remove })
    await control.start()
    await control.command({ type: 'connect' })
    const adapter = workspace.adapters.codex
    const native = adapter.state.threads[0]!
    // A window shows the thread, so its messages are held in memory.
    await control.command({ type: 'select-thread', threadId: control.get().host.threads.find(thread => thread.providerId === 'codex')!.id })
    native.status = 'running'
    adapter.emit()
    await vi.waitFor(() => expect(control.liveThread(control.get().host.threads.find(thread => thread.providerId === 'codex')!.id)?.status).toBe('running'))
    native.messages = [message('first-prompt', 'user', 'The palette is unreadable.'), message('first-reply', 'assistant', 'I raised the contrast.')]
    native.status = 'idle'
    adapter.emit()
    await vi.waitFor(() => expect(published).toHaveLength(1))
    const threadId = published[0]!.threadId
    expect(write).toHaveBeenCalledWith(threadId, [{ prompt: 'The palette is unreadable.', reply: 'I raised the contrast.' }], expect.any(AbortSignal))
    expect(prompts.list()).toHaveLength(1)
    // The suggestion stays while the send is on its way, and goes once main has taken it.
    const sending = control.command({ type: 'manual-send', threadId, draftId: 'next', text: 'Open the pull request for this fix' })
    expect(prompts.list()).toHaveLength(1)
    expect((await sending).error).toBeNull()
    expect(prompts.list()).toEqual([])
    expect(published.at(-1)).toMatchObject({ threadId, prompt: null })
  })
})

describe('the Owl gate', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  async function built(options: Partial<AgentRuntimeOptions>) {
    const root = await mkdtemp(join(tmpdir(), 'sotto-next-prompt-gate-')); roots.push(root)
    const credentials = await testCredentials(root, { mode: 'unavailable' })
    const providers = { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), muse: new E2EAgentHost(), opencode: new E2EAgentHost(), cursor: new E2EAgentHost(), deepseek: new E2EAgentHost() }
    const runtime = await createAgentRuntime({ directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
      historyEnabled: () => true, openExternal: async () => undefined, reasoner: e2eAgentReasoner, providers, ...options })
    const answer = runtime.nextPrompts
    await runtime.close()
    return answer
  }

  it('builds next prompts only while the Owl feature is on, and only for this computer\'s own threads', async () => {
    await expect(built({})).resolves.toBeUndefined()
    await expect(built({ nextPromptEnabled: false })).resolves.toBeUndefined()
    await expect(built({ nextPromptEnabled: true, runsAs: 'headless-host' })).resolves.toBeUndefined()
    await expect(built({ nextPromptEnabled: true })).resolves.toBeInstanceOf(NextPrompts)
  })

  it('registers no channel while off, and names each thread by its host for the window', () => {
    const ipc = { handle: vi.fn(), removeHandler: vi.fn() }
    registerNextPromptIpc(ipc as never, undefined, () => 'host', () => [])
    expect(ipc.handle).not.toHaveBeenCalled()
    registerNextPromptIpc(ipc as never, { list: () => [] }, () => 'host', () => [])
    expect(ipc.handle).toHaveBeenCalledWith(NEXT_PROMPT_READ, expect.any(Function))
    expect(windowNextPrompt('host', { threadId: 'thread', afterUserMessageId: 'u1', prompt: null }).threadId).toBe(hostEntityKey('host', 'thread'))
  })
})
