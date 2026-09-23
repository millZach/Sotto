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
import { threadTitleWriter, type ThreadTitleExchange } from '../../../src/main/llm/threadTitle'
import { e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentThread } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

const membership = { status: async () => ({ status: 'beta' as const, label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta' as const, label: 'Test', expiresAt: null }) }

const opened: { control: AgentControl; stop: () => Promise<void> }[] = []
const removals: (() => Promise<void>)[] = []

async function coordinator(options: {
  root?: string
  writeThreadTitle?: (threadId: string, exchange: ThreadTitleExchange) => Promise<string | null>
  /** Names threads through the provider hosts' own side calls rather than a stand-in writer. */
  providerWriting?: AppSettings
  historyEnabled?: () => boolean
} = {}) {
  const workspace = await workspaceFixture(options.root)
  if (options.root === undefined) removals.push(workspace.remove)
  const credentials = new AgentCredentials(workspace.root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  const settings = options.providerWriting
  const writer = settings ? threadTitleWriter(new ShortTextWriter({ write: (threadId, prompt) => workspace.host.writeShortText(threadId, prompt) }), () => settings) : undefined
  const titles = vi.fn<(threadId: string, exchange: ThreadTitleExchange) => Promise<string | null>>(options.writeThreadTitle ?? writer ?? (async () => 'Dark theme contrast'))
  const control = new AgentControl({
    schedule: immediatePublishScheduler, directory: workspace.root, host: workspace.host, credentials, reasoner: e2eAgentReasoner, membership,
    writeThreadTitle: titles,
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
