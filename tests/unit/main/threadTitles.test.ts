// @vitest-environment node
/**
 * A thread naming itself: the coordinator asks the thread's own provider, on the side, for a name once the
 * first reply lands on a thread that still carries a stand-in name (ADR-0026), leaves a name set by hand
 * alone, and asks for nothing when generation is off or local history is not kept.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { ShortTextWriter } from '../../../src/main/llm/shortTextWriter'
import { firstMessageTitle, firstMessageTitleWriter, threadTitleWriter, type ThreadTitleExchange } from '../../../src/main/llm/threadTitle'
import { e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentThread } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

const opened: { control: AgentControl; stop: () => Promise<void> }[] = []
const removals: (() => Promise<void>)[] = []

async function coordinator(options: {
  root?: string
  writeThreadTitle?: (threadId: string, exchange: ThreadTitleExchange) => Promise<string | null>
  /** Names threads through the provider hosts' own side calls rather than a stand-in writer. */
  providerWriting?: AppSettings
  historyEnabled?: () => boolean
  logFailure?: (code: string, detail: string) => void
  /** Gives first-message titles under these settings; absent, no thread is given one. */
  firstMessageTitles?: AppSettings
} = {}) {
  const workspace = await workspaceFixture(options.root)
  if (options.root === undefined) removals.push(workspace.remove)
  const credentials = new AgentCredentials(workspace.root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  const settings = options.providerWriting
  const writer = settings ? threadTitleWriter(new ShortTextWriter({ write: (threadId, prompt) => workspace.host.writeShortText(threadId, prompt) }), () => settings) : undefined
  const titles = vi.fn<(threadId: string, exchange: ThreadTitleExchange) => Promise<string | null>>(options.writeThreadTitle ?? writer ?? (async () => 'Dark theme contrast'))
  const control = new AgentControl({
    schedule: immediatePublishScheduler, directory: workspace.root, host: workspace.host, credentials, reasoner: e2eAgentReasoner,
    writeThreadTitle: titles,
    ...(options.firstMessageTitles ? { writeFirstMessageTitle: firstMessageTitleWriter(() => options.firstMessageTitles!) } : {}),
    ...(options.logFailure ? { logFailure: options.logFailure } : {}),
    ...(options.historyEnabled ? { historyEnabled: options.historyEnabled } : {}),
  })
  opened.push({ control, stop: workspace.stop })
  await control.start()
  await control.command({ type: 'connect' })
  return { ...workspace, control, titles }
}

const workshop = (control: AgentControl): AgentThread =>
  control.get().host.threads.find(thread => thread.providerId === 'codex' && thread.title === 'Workshop')
  ?? control.get().host.threads.find(thread => thread.providerId === 'codex')!
const titled = (control: AgentControl, threadId: string): AgentThread => control.get().host.threads.find(thread => thread.id === threadId)!

/** The provider answers the thread's first prompt; the coordinator sees the exchange on the next frame. */
function reply(adapter: { state: { threads: AgentThread[] }; emit: () => void }, index = 0, prompt = 'The palette is unreadable in dark mode.', answer = 'I raised the foreground contrast on both dark themes.'): void {
  const thread = adapter.state.threads[index]!
  const at = new Date().toISOString()
  thread.messages = [
    { id: 'first-prompt', role: 'user', text: prompt, createdAt: at },
    { id: 'first-reply', role: 'assistant', text: answer, createdAt: at },
  ]
  thread.status = 'idle'
  adapter.emit()
}

afterEach(async () => {
  for (const { control, stop } of opened.splice(0).reverse()) { control.dispose(); await stop() }
  for (const remove of removals.splice(0)) await remove()
})

describe('naming a thread from its first exchange', () => {
  it('logs only a stable failure code when a title request throws private text', async () => {
    const logFailure = vi.fn()
    const f = await coordinator({ logFailure, writeThreadTitle: async () => { throw new Error('PRIVATE PROMPT C:\\Users\\Zach\\project') } })
    const threadId = workshop(f.control).id
    reply(f.adapters.codex)
    await vi.waitFor(() => expect(logFailure).toHaveBeenCalledOnce())
    expect(logFailure).toHaveBeenCalledWith('thread-title-failed', 'failed')
    expect(titled(f.control, threadId).title).toBe('Workshop')
    expect(f.control.get().error).toBeNull()
  })

  it('drains an automatic title request without applying its result after disposal', async () => {
    let finish!: (title: string) => void
    const f = await coordinator({ writeThreadTitle: () => new Promise(resolve => { finish = resolve }) })
    const threadId = workshop(f.control).id
    reply(f.adapters.codex)
    await vi.waitFor(() => expect(f.titles).toHaveBeenCalledOnce())
    const rename = vi.spyOn(f.host, 'renameThread')
    f.control.dispose()
    const settled = vi.fn()
    const closed = f.control.closed().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    finish('Late generated title')
    await closed
    expect(rename).not.toHaveBeenCalled()
    expect(titled(f.control, threadId).title).toBe('Workshop')
  })

  it('writes a title from the agent\'s own reply, never from a visual drawn before it (ADR-0056)', async () => {
    const f = await coordinator()
    const threadId = workshop(f.control).id
    const thread = f.adapters.codex.state.threads[0]!
    const at = new Date().toISOString()
    // The agent draws before it writes: the workspace slots the visual in under the prompt, as it does in the app.
    f.host.observeThreads([threadId])
    thread.messages = [{ id: 'first-prompt', role: 'user', text: 'How does a send work?', createdAt: at }]
    thread.status = 'running'
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(item => item.id === threadId)?.messages.map(message => message.id)).toEqual(['first-prompt']))
    expect(await f.host.addVisual(threadId, { title: 'How a send moves', kind: 'diagram', source: 'flowchart LR\n  A --> B' })).toMatchObject({ added: true, anchor: 'user' })
    thread.messages = [...thread.messages, { id: 'first-reply', role: 'assistant', text: 'The diagram above shows it.', createdAt: at }]
    thread.status = 'idle'
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(item => item.id === threadId)?.messages.map(message => message.id)).toEqual(['first-prompt', expect.stringMatching(/^visual:/u), 'first-reply']))
    await vi.waitFor(() => expect(f.titles).toHaveBeenCalledOnce())
    expect(f.titles.mock.calls[0]).toEqual([threadId, { prompt: 'How does a send work?', reply: 'The diagram above shows it.' }])
  })

  it('names a stand-in titled thread once the first reply lands, keeping the name across provider events and a restart', async () => {
    const f = await coordinator()
    const threadId = workshop(f.control).id
    expect(titled(f.control, threadId).title).toBe('Workshop')
    reply(f.adapters.codex)
    await vi.waitFor(() => expect(titled(f.control, threadId)).toMatchObject({ title: 'Dark theme contrast', titleSource: 'generated' }))
    // Only the first message and the first reply were offered, for this thread.
    expect(f.titles.mock.calls).toEqual([[threadId, { prompt: 'The palette is unreadable in dark mode.', reply: 'I raised the foreground contrast on both dark themes.' }]])
    // The provider still calls its session "Workshop"; the written name is not flickered back to the default.
    f.adapters.codex.emit()
    await f.control.command({ type: 'refresh' })
    expect(titled(f.control, threadId)).toMatchObject({ title: 'Dark theme contrast', titleSource: 'generated' })
    expect(f.titles).toHaveBeenCalledTimes(1)

    const reopened = await coordinator({ root: f.root })
    expect(titled(reopened.control, threadId)).toMatchObject({ title: 'Dark theme contrast', titleSource: 'generated' })
    expect(reopened.titles).not.toHaveBeenCalled()
  })

  it('names a thread whose reply streamed in while the turn was still running, once the turn ends', async () => {
    const f = await coordinator()
    const threadId = workshop(f.control).id
    // A real client shows the reply while the turn is still running, and ends the turn on a later frame
    // that adds no message. The name is asked for on that later frame, not skipped for good.
    reply(f.adapters.codex)
    f.adapters.codex.state.threads[0]!.status = 'running'
    f.adapters.codex.emit()
    await f.control.command({ type: 'refresh' })
    expect(f.titles).not.toHaveBeenCalled()
    f.adapters.codex.state.threads[0]!.status = 'idle'
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(titled(f.control, threadId)).toMatchObject({ title: 'Dark theme contrast', titleSource: 'generated' }))
    expect(f.titles).toHaveBeenCalledTimes(1)
  })

  it('leaves a name set by hand alone, and a rename after the name was written sticks', async () => {
    const f = await coordinator()
    const threadId = workshop(f.control).id
    await f.control.command({ type: 'rename-thread', threadId, title: 'Palette work' })
    reply(f.adapters.codex)
    await f.control.command({ type: 'refresh' })
    expect(f.titles).not.toHaveBeenCalled()
    expect(titled(f.control, threadId)).toMatchObject({ title: 'Palette work', titleSource: 'user' })

    // A second thread is named, then renamed by hand: the rename is the last word.
    const other = f.control.get().host.threads.find(thread => thread.providerId === 'codex' && thread.id !== threadId)!
    reply(f.adapters.codex, 1)
    await vi.waitFor(() => expect(titled(f.control, other.id).titleSource).toBe('generated'))
    await f.control.command({ type: 'rename-thread', threadId: other.id, title: 'Docs sweep' })
    f.adapters.codex.emit()
    await f.control.command({ type: 'refresh' })
    expect(titled(f.control, other.id)).toMatchObject({ title: 'Docs sweep', titleSource: 'user' })
  })

  it('writes the name again on request, replacing the one it wrote, and leaves a hand-set name untouched', async () => {
    const f = await coordinator()
    const threadId = workshop(f.control).id
    reply(f.adapters.codex)
    await vi.waitFor(() => expect(titled(f.control, threadId).title).toBe('Dark theme contrast'))
    f.titles.mockResolvedValue('Dark theme legibility')
    await f.control.command({ type: 'regenerate-thread-title', threadId })
    expect(titled(f.control, threadId)).toMatchObject({ title: 'Dark theme legibility', titleSource: 'generated' })

    await f.control.command({ type: 'rename-thread', threadId, title: 'Palette work' })
    f.titles.mockResolvedValue('Something else entirely')
    await f.control.command({ type: 'regenerate-thread-title', threadId })
    expect(titled(f.control, threadId)).toMatchObject({ title: 'Palette work', titleSource: 'user' })
  })

  it('keeps the stand-in name and shows no error when the provider writes nothing, and does not ask again', async () => {
    const f = await coordinator({ writeThreadTitle: async () => null })
    const threadId = workshop(f.control).id
    reply(f.adapters.codex)
    await f.control.command({ type: 'refresh' })
    await vi.waitFor(() => expect(f.titles).toHaveBeenCalledTimes(1))
    expect(titled(f.control, threadId).title).toBe('Workshop')
    expect(f.control.get().error).toBeNull()
    f.adapters.codex.emit()
    await f.control.command({ type: 'refresh' })
    expect(f.titles).toHaveBeenCalledTimes(1)
  })

  it('asks for nothing while local history is off', async () => {
    let history = true
    const f = await coordinator({ historyEnabled: () => history })
    history = false
    f.setHistory(false)
    reply(f.adapters.codex)
    await f.control.command({ type: 'refresh' })
    expect(f.titles).not.toHaveBeenCalled()
    expect(titled(f.control, workshop(f.control).id).title).toBe('Workshop')
    // Nor on request: Regenerate title sends nothing either while history is off.
    await f.control.command({ type: 'regenerate-thread-title', threadId: workshop(f.control).id })
    expect(f.titles).not.toHaveBeenCalled()
    expect(titled(f.control, workshop(f.control).id).title).toBe('Workshop')
  })

  it("asks the thread's own provider on the side, and the thread's session sees nothing of it", async () => {
    const f = await coordinator({ providerWriting: DEFAULT_SETTINGS })
    f.adapters.codex.sideWriter = async () => '"Dark theme contrast."'
    const threadId = workshop(f.control).id
    reply(f.adapters.codex)
    await vi.waitFor(() => expect(titled(f.control, threadId)).toMatchObject({ title: 'Dark theme contrast', titleSource: 'generated' }))
    // The provider was asked about its own session, never another provider and never inside the thread.
    expect(f.adapters.codex.sideWrites).toHaveLength(1)
    expect(f.adapters.codex.sideWrites[0]!.sessionId).toBe(f.registry.byThread(threadId)!.sessionId)
    expect(f.adapters.codex.sideWrites[0]!.prompt.material).toContain('The palette is unreadable in dark mode.')
    expect(f.adapters.claude.sideWrites).toEqual([])
    expect(f.adapters.codex.commands.filter(command => command.type === 'send')).toEqual([])
    expect(f.adapters.codex.state.threads[0]!.messages.map(message => message.id)).toEqual(['first-prompt', 'first-reply'])
  })

  it('keeps the stand-in name for a provider that writes nothing, or one that is disconnected', async () => {
    const devinLike = await coordinator({ providerWriting: DEFAULT_SETTINGS })
    const threadId = workshop(devinLike.control).id
    reply(devinLike.adapters.codex)
    await devinLike.control.command({ type: 'refresh' })
    await vi.waitFor(() => expect(devinLike.adapters.codex.sideWrites).toHaveLength(1))
    expect(titled(devinLike.control, threadId)).toMatchObject({ title: 'Workshop' })
    expect(devinLike.control.get().error).toBeNull()

    const disconnected = await coordinator({ providerWriting: DEFAULT_SETTINGS })
    disconnected.adapters.codex.sideWriter = async () => 'Never asked'
    disconnected.native.disconnect('codex')
    await expect(disconnected.host.writeShortText(workshop(disconnected.control).id, { instruction: 'Name it', material: 'Anything' })).resolves.toBeNull()
    expect(disconnected.adapters.codex.sideWrites).toEqual([])
  })

  it('asks the provider nothing with generation off', async () => {
    const f = await coordinator({ providerWriting: { ...DEFAULT_SETTINGS, threadTitles: false } })
    f.adapters.codex.sideWriter = async () => 'Never asked'
    const threadId = workshop(f.control).id
    reply(f.adapters.codex)
    await f.control.command({ type: 'refresh' })
    await vi.waitFor(() => expect(f.titles).toHaveBeenCalledTimes(1))
    expect(f.adapters.codex.sideWrites).toEqual([])
    expect(titled(f.control, threadId).title).toBe('Workshop')
  })
})

describe('naming a thread from its first message while the first turn runs', () => {
  /** The thread's first message arrives while its turn is still running, as it does the moment it is sent. */
  function send(adapter: { state: { threads: AgentThread[] }; emit: () => void }, ...texts: string[]): void {
    const thread = adapter.state.threads[0]!
    const at = new Date().toISOString()
    thread.messages = texts.map((text, index) => ({ id: index === 0 ? 'first-prompt' : `steer-${index}`, role: 'user' as const, text, createdAt: at }))
    thread.status = 'running'
    adapter.emit()
  }

  it('takes the opening words of the message, on one line, cut at a word to fit a sidebar row', () => {
    expect(firstMessageTitle('  Fix the\n  sidebar logos  ')).toBe('Fix the sidebar logos')
    const long = firstMessageTitle('Fix the sidebar so each thread shows the provider logo instead of the provider name')!
    expect(long).toBe('Fix the sidebar so each thread shows the provider logo…')
    expect(long.length).toBeLessThanOrEqual(60)
    // A word that ends exactly where the ellipsis goes is kept whole.
    expect(firstMessageTitle(`${'w'.repeat(50)} abcdefgh and more`)).toBe(`${'w'.repeat(50)} abcdefgh…`)
    expect(firstMessageTitle('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`)
    // A long run is never cut between the halves of an emoji.
    expect(firstMessageTitle(`${'x'.repeat(58)}😀yyy`)).toBe(`${'x'.repeat(58)}…`)
    expect(firstMessageTitle(' \n ')).toBeNull()
  })

  it('names a thread from its first message as soon as it is sent, then takes the generated name when it lands', async () => {
    let finish!: (title: string) => void
    const f = await coordinator({ firstMessageTitles: DEFAULT_SETTINGS, writeThreadTitle: () => new Promise(resolve => { finish = resolve }) })
    const threadId = workshop(f.control).id
    send(f.adapters.codex, 'The palette is unreadable in dark mode.')
    await vi.waitFor(() => expect(titled(f.control, threadId)).toMatchObject({ title: 'The palette is unreadable in dark mode.', titleSource: 'default', titledFromFirstMessage: true }))
    expect(f.titles).not.toHaveBeenCalled()
    // The provider still calls its session "Workshop"; the first-message title is not flickered back.
    f.adapters.codex.emit()
    await f.control.command({ type: 'refresh' })
    expect(titled(f.control, threadId)).toMatchObject({ title: 'The palette is unreadable in dark mode.', titledFromFirstMessage: true })

    reply(f.adapters.codex)
    await vi.waitFor(() => expect(f.titles).toHaveBeenCalledOnce())
    finish('Dark theme contrast')
    await vi.waitFor(() => expect(titled(f.control, threadId)).toMatchObject({ title: 'Dark theme contrast', titleSource: 'generated' }))
    expect(titled(f.control, threadId).titledFromFirstMessage).toBeUndefined()
  })

  it('still names a thread that was steered during its first turn, across a restart', async () => {
    const f = await coordinator({ firstMessageTitles: DEFAULT_SETTINGS, writeThreadTitle: async () => null })
    const threadId = workshop(f.control).id
    // The steer is already beside the first message on the frame that brings it.
    send(f.adapters.codex, 'The palette is unreadable in dark mode.', 'Light mode too.')
    await vi.waitFor(() => expect(titled(f.control, threadId)).toMatchObject({ title: 'The palette is unreadable in dark mode.', titledFromFirstMessage: true }))

    const reopened = await coordinator({ root: f.root, firstMessageTitles: DEFAULT_SETTINGS })
    const thread = reopened.adapters.codex.state.threads[0]!
    const at = new Date().toISOString()
    thread.messages = [
      { id: 'first-prompt', role: 'user', text: 'The palette is unreadable in dark mode.', createdAt: at },
      { id: 'steer-1', role: 'user', text: 'Light mode too.', createdAt: at },
      { id: 'first-reply', role: 'assistant', text: 'I raised the foreground contrast on both themes.', createdAt: at }]
    thread.status = 'idle'
    reopened.adapters.codex.emit()
    await vi.waitFor(() => expect(titled(reopened.control, threadId)).toMatchObject({ title: 'Dark theme contrast', titleSource: 'generated' }))
    expect(reopened.titles.mock.calls[0]![1]).toEqual({ prompt: 'The palette is unreadable in dark mode.', reply: 'I raised the foreground contrast on both themes.' })
  })

  it('leaves an older thread alone: one that already had history when Sotto first saw it', async () => {
    const before = await coordinator({ writeThreadTitle: async () => null })
    const threadId = workshop(before.control).id
    reply(before.adapters.codex)
    await vi.waitFor(() => expect(before.titles).toHaveBeenCalledOnce())

    const reopened = await coordinator({ root: before.root, firstMessageTitles: DEFAULT_SETTINGS, writeThreadTitle: async () => null })
    reply(reopened.adapters.codex)
    await reopened.control.command({ type: 'refresh' })
    expect(titled(reopened.control, threadId)).toMatchObject({ title: 'Workshop' })
    expect(titled(reopened.control, threadId).titledFromFirstMessage).toBeUndefined()
  })

  it('leaves the stand-in with generated titles off', async () => {
    const f = await coordinator({ firstMessageTitles: { ...DEFAULT_SETTINGS, threadTitles: false }, writeThreadTitle: async () => null })
    send(f.adapters.codex, 'The palette is unreadable in dark mode.')
    reply(f.adapters.codex)
    await vi.waitFor(() => expect(f.titles).toHaveBeenCalledOnce())
    expect(titled(f.control, workshop(f.control).id)).toMatchObject({ title: 'Workshop' })
  })

  it('leaves the stand-in while local history is off', async () => {
    const f = await coordinator({ firstMessageTitles: DEFAULT_SETTINGS, historyEnabled: () => false })
    f.setHistory(false)
    send(f.adapters.codex, 'The palette is unreadable in dark mode.')
    await f.control.command({ type: 'refresh' })
    expect(titled(f.control, workshop(f.control).id).title).toBe('Workshop')
  })
})
