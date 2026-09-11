// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { ConfiguredAgentReasoner, type AgentDecision, type AgentIntent } from '../../../src/main/agents/reasoning'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { agentCommandSchema, type AgentCommand, type AgentConfiguration } from '../../../src/shared/agents'

const roots: string[] = []
const controls: AgentControl[] = []
const ROUTER_KEY = 'fixture-openrouter-key'
const OPENAI_KEY = 'fixture-openai-key'

// Only external effects are replaced: OS encryption, T3, and provider HTTP.
// The controller, configured reasoner, and durable credential/state stores are real.
const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)),
  decryptString: value => Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8'),
}

class UnacknowledgedCreationHost extends E2EAgentHost {
  readonly creationAttempts: AgentHostCommand[] = []
  private pending: AgentHostCommand | null = null
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type !== 'create-project' && command.type !== 'create-thread') return super.execute(command)
    this.creationAttempts.push(command)
    this.pending = command
    return { accepted: false, uncertain: true }
  }
  async revealOriginalCreation(): Promise<void> {
    if (!this.pending) throw new Error('No fixture creation is pending')
    await super.execute(this.pending)
    this.pending = null
  }
}

type HostEvent = Parameters<E2EAgentHost['event']>[0]
class DispatchEventHost extends E2EAgentHost {
  sendCalls = 0
  constructor(private readonly eventsAfterSend: readonly (readonly HostEvent[])[]) { super() }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    const result = await super.execute(command)
    if (command.type === 'send') {
      for (const event of this.eventsAfterSend[this.sendCalls++] ?? []) this.event(event)
    }
    return result
  }
}

async function fixture(host = new E2EAgentHost()) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-control-recovery-'))
  roots.push(root)
  const credentialsDirectory = join(root, 'vault')
  const credentials = new AgentCredentials(credentialsDirectory, encryption)
  await credentials.load()
  const service = { offline: false, intent: { type: 'select-project', projectId: 'project' } as AgentIntent,
    decision: { decision: 'followup', text: 'Fix the current failing test within the assigned scope.' } as AgentDecision,
    decisionGate: null as Promise<void> | null }
  const requests: { origin: string; authorization: string | null; utterance: string }[] = []
  const decisions: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
    const message = JSON.parse(body.messages[1]!.content) as { utterance?: string; messages?: { text: string }[] }
    if (message.utterance !== undefined) requests.push({ origin: new URL(String(input)).origin,
      authorization: new Headers(init?.headers).get('authorization'), utterance: message.utterance })
    else decisions.push(message.messages?.at(-1)?.text ?? '')
    if (service.offline) throw new TypeError('Fixture provider is offline')
    if (message.utterance === undefined) await service.decisionGate
    const result = message.utterance === undefined ? service.decision : service.intent
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
  })
  let control: AgentControl
  const reasoner = new ConfiguredAgentReasoner(() => control.get().configuration, credentials)
  const create = async (): Promise<void> => {
    control = new AgentControl({ directory: root, host, credentials, reasoner,
      membership: {
        status: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
        action: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
      } })
    controls.push(control)
    await control.start()
    if (!control.get().host.connected) await control.command({ type: 'connect' })
  }
  await create()
  return {
    root, credentialsDirectory, credentials, host, requests, decisions, service,
    get control() { return control },
    async restart() { control.dispose(); await create() },
    async account(provider: AgentConfiguration['reasoning'] = 'openrouter', key = ROUTER_KEY) {
      await control.command({ type: 'configure', patch: { reasoning: provider, reasoningModel: 'fixture-model' } })
      await control.command({ type: 'credential', slot: 'reasoning', value: key })
    },
    async clarification() {
      await this.account()
      service.intent = { type: 'clarify', text: 'Which folder should contain the project?' }
      return control.command({ type: 'utterance', text: 'Create a project called Lantern.' })
    },
  }
}

afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-control-recovery-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('reasoning account route isolation', () => {
  it('persists Grok speech credentials separately and preserves both voices through unrelated settings and restart', async () => {
    const f = await fixture()
    await f.account()
    const key = 'fixture-dedicated-grok-speech-key'
    await f.control.command({ type: 'credential', slot: 'grokSpeech', value: key })
    await f.control.command({ type: 'configure', patch: { speechProvider: 'grok', grokSpeechVoice: 'my-custom-voice', speechVoice: 'M3' } })
    await f.control.command(agentCommandSchema.parse({ type: 'configure', patch: { followupLimit: 4 } }))
    await f.restart()
    expect(f.control.get().configuration).toMatchObject({ speechProvider: 'grok', grokSpeechVoice: 'my-custom-voice', speechVoice: 'M3', reasoning: 'openrouter' })
    expect(f.control.get().credentials).toMatchObject({ grokSpeech: true, reasoning: true })
    expect(JSON.stringify(f.control.get())).not.toContain(key)
    expect(await readFile(join(f.credentialsDirectory, 'credentials.json'), 'utf8')).not.toContain(key)
    expect(await readFile(join(f.root, 'agents.json'), 'utf8')).not.toContain(key)
    const reloaded = new AgentCredentials(f.credentialsDirectory, encryption)
    await reloaded.load()
    expect(reloaded.get('grokSpeech')).toBe(key)
    expect(reloaded.get('reasoning')).toBe(ROUTER_KEY)
    await f.control.command({ type: 'configure', patch: { reasoning: 'openai', speechProvider: 'natural' } })
    expect(f.credentials.get('grokSpeech')).toBe(key)
    await f.control.command({ type: 'credential', slot: 'grokSpeech', value: '' })
    expect(f.control.get().credentials.grokSpeech).toBe(false)
  })

  it.each([
    ['openrouter', ROUTER_KEY, 'https://openrouter.ai', 'openai', OPENAI_KEY, 'https://api.openai.com'],
    ['openai', OPENAI_KEY, 'https://api.openai.com', 'openrouter', ROUTER_KEY, 'https://openrouter.ai'],
  ] as const)('requires a new key when switching %s to another provider', async (before, oldKey, oldOrigin, after, newKey, newOrigin) => {
    const f = await fixture()
    await f.account(before, oldKey)
    await f.control.command({ type: 'utterance', text: 'Choose the test project.' })
    await f.control.command({ type: 'configure', patch: { reasoning: after } })
    const missing = await f.control.command({ type: 'utterance', text: 'Choose the test project again.' })
    expect(missing.credentials.reasoning).toBe(false)
    expect(missing.error).toMatch(/connect.*reasoning api account/iu)
    expect(f.requests).toHaveLength(1)
    await f.control.command({ type: 'credential', slot: 'reasoning', value: newKey })
    await f.control.command({ type: 'utterance', text: 'Choose the test project with the new account.' })
    expect(f.requests.map(({ origin, authorization }) => ({ origin, authorization }))).toEqual([
      { origin: oldOrigin, authorization: `Bearer ${oldKey}` },
      { origin: newOrigin, authorization: `Bearer ${newKey}` },
    ])
  })

  it('retains the current provider key when only its model changes', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'configure', patch: { reasoningModel: 'another-fixture-model' } })
    const state = await f.control.command({ type: 'utterance', text: 'Choose the test project.' })
    expect(state.error).toBeNull()
    expect(f.requests[0]).toMatchObject({ origin: 'https://openrouter.ai', authorization: `Bearer ${ROUTER_KEY}` })
  })

  it('clears the T3 token before changing its server while preserving it for unrelated settings', async () => {
    const f = await fixture()
    await f.control.command({ type: 'credential', slot: 't3', value: 'fixture-first-t3-token' })
    const unchanged = await f.control.command({ type: 'configure', patch: { followupLimit: 3 } })
    expect(unchanged.credentials.t3).toBe(true)
    const changed = await f.control.command({ type: 'configure', patch: { endpoint: 'http://127.0.0.1:4773' } })
    expect(changed.credentials.t3).toBe(false)
    expect(changed.connection).toBe('disconnected')
    const blocked = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Wrong server', modelId: 'claude:test' })
    expect(blocked.error).toMatch(/reconnect t3/iu)
    expect(blocked.host.threads).toHaveLength(2)
    const reloaded = new AgentCredentials(f.credentialsDirectory, encryption)
    await reloaded.load()
    expect(reloaded.has('t3')).toBe(false)
  })

  it('keeps the original route when deleting its credential fails', async () => {
    const f = await fixture()
    await f.account()
    const credentialFile = join(f.credentialsDirectory, 'credentials.json')
    await rename(credentialFile, credentialFile + '.saved')
    await mkdir(credentialFile)
    const state = await f.control.command({ type: 'configure', patch: { reasoning: 'openai' } })
    expect(state.error).not.toBeNull()
    expect(state.configuration.reasoning).toBe('openrouter')
    await f.control.command({ type: 'utterance', text: 'Choose the test project.' })
    expect(f.requests[0]).toMatchObject({ origin: 'https://openrouter.ai', authorization: `Bearer ${ROUTER_KEY}` })
  })

  it('durably deletes the old key before attempting to persist the new provider', async () => {
    const f = await fixture()
    await f.account()
    const stateFile = join(f.root, 'agents.json')
    await rename(stateFile, stateFile + '.saved')
    await mkdir(stateFile)
    const failed = await f.control.command({ type: 'configure', patch: { reasoning: 'openai' } })
    expect(failed.error).toMatch(/could not save/iu)
    const reloaded = new AgentCredentials(f.credentialsDirectory, encryption)
    await reloaded.load()
    expect(reloaded.has('reasoning')).toBe(false)
    await f.control.command({ type: 'utterance', text: 'Choose the test project.' })
    expect(f.requests).toEqual([])
  })
})

describe('composition navigation and explicit spoken controls', () => {
  it('previews the configured voice while agents are disabled without inference or host work', async () => {
    const f = await fixture()
    await f.control.command({ type: 'disconnect' })
    const before = f.control.get()
    const previewed = await f.control.command({ type: 'preview-voice' })
    expect(previewed).toMatchObject({ error: null, configuration: { enabled: false },
      speech: { id: before.speech.id + 1, text: 'Hi, I’m Sotto. Your agents are ready when you are.', preview: true } })
    expect(previewed.host).toEqual(before.host)
    expect(previewed.assignments).toEqual(before.assignments)
    expect(f.requests).toEqual([])
  })

  it('dictates and sends the first prompt immediately after creating a managed thread without reasoning', async () => {
    const f = await fixture()
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'New voice thread', modelId: 'claude:test' })
    const threadId = created.activeThreadId!
    expect(created).toMatchObject({ error: null, composing: true, draft: '', draftThreadId: threadId })
    const dictated = await f.control.command({ type: 'utterance', text: 'Build a settings page with the existing colors.' })
    expect(dictated.draft).toBe('Build a settings page with the existing colors.')
    const sent = await f.control.command({ type: 'utterance', text: 'Send it.' })
    expect(sent.error).toBeNull()
    expect(sent.composing).toBe(false)
    expect(sent.host.threads.find(thread => thread.id === threadId)?.messages).toMatchObject([
      { role: 'user', text: 'Build a settings page with the existing colors.' },
    ])
    expect(f.requests).toEqual([])
  })

  it.each(["Here's my prompt: Build the page.", 'Start prompt'])('keeps the optional prompt prefix after creating a thread: %s', async text => {
    const f = await fixture()
    await f.control.command({ type: 'create-thread', projectId: 'project', title: 'New voice thread', modelId: 'claude:test' })
    const dictated = await f.control.command({ type: 'utterance', text })
    expect(dictated.error).toBeNull()
    expect(dictated.draft).toBe(text === 'Start prompt' ? '' : 'Build the page.')
    expect(dictated.composing).toBe(true)
    expect(f.requests).toEqual([])
  })

  it('preserves an unfinished draft and creates no extra thread when creation is blocked', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Finish Workshop first.' })
    const blocked = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Another thread', modelId: 'claude:test' })
    expect(blocked.error).toMatch(/send or clear your draft/iu)
    expect(blocked).toMatchObject({ draft: 'Finish Workshop first.', draftThreadId: 'workshop', activeThreadId: 'workshop' })
    expect(blocked.host.threads).toHaveLength(2)
  })

  it('pins a newly created thread while another completed thread is queued, including after clearing the empty draft', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'Workshop is ready for review.' })
    await f.control.command({ type: 'refresh' })
    expect(f.control.get().queue.some(item => item.threadId === 'workshop')).toBe(true)
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Beta', modelId: 'claude:test' })
    const beta = created.host.threads.find(thread => thread.title === 'Beta')!
    expect(created).toMatchObject({ activeThreadId: beta.id, draftThreadId: beta.id, composing: true })
    const refreshed = await f.control.command({ type: 'refresh' })
    expect(refreshed).toMatchObject({ activeThreadId: beta.id, draftThreadId: beta.id })
    expect(refreshed.queue.some(item => item.threadId === 'workshop')).toBe(true)
    await f.control.command({ type: 'cancel-draft' })
    const cleared = await f.control.command({ type: 'refresh' })
    expect(cleared.activeThreadId).toBe(beta.id)
    const next = await f.control.command({ type: 'utterance', text: 'Next' })
    expect(next.activeThreadId).toBe('workshop')
  })

  it('keeps an explicitly created or selected project open while another project has a queued thread', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'Workshop is ready for review.' })
    const created = await f.control.command({ type: 'create-project', title: 'New project', path: join(f.root, 'new-project') })
    const projectId = created.host.projects.find(project => project.title === 'New project')!.id
    expect(created).toMatchObject({ activeProjectId: projectId, activeThreadId: null })
    const refreshed = await f.control.command({ type: 'refresh' })
    expect(refreshed).toMatchObject({ activeProjectId: projectId, activeThreadId: null })
    await f.control.command({ type: 'next' })
    expect(f.control.get().activeThreadId).toBe('workshop')
    await f.control.command({ type: 'select-project', projectId })
    const selected = await f.control.command({ type: 'refresh' })
    expect(selected).toMatchObject({ activeProjectId: projectId, activeThreadId: null })
    expect(selected.queue.some(item => item.threadId === 'workshop')).toBe(true)
    await f.control.command({ type: 'next' })
    await f.control.command({ type: 'compose', text: 'Continue Workshop after review.' })
    await f.control.command({ type: 'select-project', projectId })
    const retained = await f.control.command({ type: 'refresh' })
    expect(retained).toMatchObject({ activeProjectId: projectId, activeThreadId: null,
      draft: 'Continue Workshop after review.', draftThreadId: 'workshop', composing: true })
  })

  it.each(['next', 'later'] as const)('leaves an empty draft when %s moves to another queued thread', async command => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'assign', threadId: 'docs' })
    f.host.event({ type: 'question', threadId: 'workshop', text: 'Choose Workshop colors.', requestId: 'workshop-question' })
    f.host.event({ type: 'question', threadId: 'docs', text: 'Choose Docs colors.', requestId: 'docs-question' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    const composing = await f.control.command({ type: 'compose', text: command === 'next' ? '' : '  ' })
    expect(composing.draftRequestId).toBe('workshop-question')
    const moved = await f.control.command({ type: command })
    expect(moved.error).toBeNull()
    expect(moved).toMatchObject({ activeThreadId: 'docs', composing: false, draft: '', draftThreadId: null, draftRequestId: null })
    expect(moved.queue.find(item => item.threadId === 'workshop')?.deferred).toBe(true)
    expect(moved.host.threads.find(thread => thread.id === 'workshop')?.requests).toHaveLength(1)
  })

  it('explains reserved queue and thread controls without adding them to an unfinished prompt', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'assign', threadId: 'docs' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Keep the existing colors.' })
    for (const text of ['Next.', 'Later!', 'Pause managing Workshop', 'Resume managing Workshop', 'Manage Docs', 'Select Docs', 'Open Docs']) {
      const state = await f.control.command({ type: 'utterance', text })
      expect(state.draft).toBe('Keep the existing colors.')
      expect(state.draftThreadId).toBe('workshop')
      expect(state.activeThreadId).toBe('workshop')
      expect(state.error).toMatch(/send or clear your draft/iu)
    }
    const dictated = await f.control.command({ type: 'utterance', text: 'Open the index file and update the heading.' })
    expect(dictated.error).toBeNull()
    expect(dictated.draft).toBe('Keep the existing colors. Open the index file and update the heading.')
    expect(f.requests).toEqual([])
  })

  it('executes an exact thread control after clearing an empty composition', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: '' })
    const paused = await f.control.command({ type: 'utterance', text: 'Pause managing Workshop.' })
    expect(paused.error).toBeNull()
    expect(paused.composing).toBe(false)
    expect(paused.assignments[0]?.paused).toBe(true)
    const resumed = await f.control.command({ type: 'utterance', text: 'Resume managing Workshop.' })
    expect(resumed.assignments[0]?.paused).toBe(false)
  })

  it('does not dictate an ambiguous exact thread control when titles are duplicated', async () => {
    const f = await fixture()
    await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Docs', modelId: 'claude:test' })
    await f.control.command({ type: 'compose', text: 'Keep this draft.' })
    const state = await f.control.command({ type: 'utterance', text: 'Select Docs' })
    expect(state.draft).toBe('Keep this draft.')
    expect(state.error).toMatch(/send or clear your draft/iu)
    await f.control.command({ type: 'cancel-draft' })
    const ambiguous = await f.control.command({ type: 'utterance', text: 'Select Docs' })
    expect(ambiguous.error).toMatch(/more than one thread/iu)
    expect(f.requests).toEqual([])
  })
})

describe('supervision event ordering', () => {
  it('restores a completed response without paying for another review, while new responses and explicit resume still work', async () => {
    const f = await fixture()
    await f.account()
    f.service.decision = { decision: 'done', text: 'The assigned change is complete.' }
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Finish the assigned change.' })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'The implementation is complete.' })
    await expect.poll(() => f.control.get().queue[0]?.text).toBe(f.service.decision.text)
    const before = await f.control.command({ type: 'refresh' })
    expect(f.decisions).toHaveLength(1)
    await f.restart()
    const restored = await f.control.command({ type: 'refresh' })
    expect(f.decisions).toHaveLength(1)
    expect(restored.queue).toEqual(before.queue)
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'A genuinely new response arrived.' })
    await expect.poll(() => f.decisions.length).toBe(2)
    await f.control.command({ type: 'refresh' })
    await f.control.command({ type: 'resume', threadId: 'workshop' })
    await expect.poll(() => f.decisions.length).toBe(3)
    await f.control.command({ type: 'refresh' })
  })

  it.each(['blocked', 'question'] as const)('restores a completed %s review and allows explicit resume', async kind => {
    const f = await fixture()
    await f.account()
    f.service.decision = { decision: 'human', text: 'Your choice is needed.' }
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Finish the assigned change.' })
    f.host.event({ type: kind === 'question' ? 'question' : 'ready', threadId: 'workshop', text: 'Choose the final behavior.', requestId: 'request:with:colons' })
    await expect.poll(() => f.control.get().queue[0]?.kind).toBe(kind)
    const before = await f.control.command({ type: 'refresh' })
    await f.restart()
    const restored = await f.control.command({ type: 'refresh' })
    expect(f.decisions).toHaveLength(1)
    expect(restored.queue).toEqual(before.queue)
    await f.control.command({ type: 'resume', threadId: 'workshop' })
    await expect.poll(() => f.decisions.length).toBe(2)
    await f.control.command({ type: 'refresh' })
    if (kind === 'question') {
      await f.host.execute({ type: 'answer', commandId: 'external-answer', threadId: 'workshop', requestId: 'request:with:colons', answer: 'The original behavior.' })
      f.host.event({ type: 'question', threadId: 'workshop', text: 'A new question needs review.', requestId: 'new:request' })
      await expect.poll(() => f.decisions.length).toBe(3)
      const next = await f.control.command({ type: 'refresh' })
      expect(next.queue.some(item => item.requestId === 'new:request')).toBe(true)
      expect(next.queue.some(item => item.requestId === 'request:with:colons')).toBe(false)
    }
  })

  it('keeps another restored pending question in the attention queue after the first is answered', async () => {
    const f = await fixture()
    await f.account()
    f.service.decision = { decision: 'human', text: 'Your choice is needed.' }
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Finish the assigned change.' })
    await f.control.command({ type: 'pause', threadId: 'workshop' })
    f.host.event({ type: 'question', threadId: 'workshop', text: 'First choice.', requestId: 'first:request' })
    f.host.event({ type: 'question', threadId: 'workshop', text: 'Second choice.', requestId: 'second:request' })
    await f.control.command({ type: 'resume', threadId: 'workshop' })
    await expect.poll(() => f.decisions.length).toBe(1)
    await f.control.command({ type: 'refresh' })
    await f.restart()
    await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'first:request', answer: 'Use the first option.' })
    const next = await f.control.command({ type: 'refresh' })
    expect(f.decisions).toHaveLength(1)
    expect(next.queue.map(item => item.requestId)).toEqual(['second:request'])
  })

  it('recovers unfinished reasoning after a crash instead of treating a merely observed message as complete', async () => {
    const f = await fixture()
    await f.account()
    f.service.decision = { decision: 'done', text: 'Review finished.' }
    let release!: () => void
    f.service.decisionGate = new Promise<void>(resolve => { release = resolve })
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Finish the assigned change.' })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'This result was still being reviewed at the crash.' })
    await expect.poll(() => f.decisions.length).toBe(1)
    await f.control.command({ type: 'refresh' })
    const interruptedState = await readFile(join(f.root, 'agents.json'), 'utf8')
    expect(JSON.parse(interruptedState).queue).toEqual([])
    release()
    await expect.poll(() => f.control.get().queue.length).toBe(1)
    await f.control.command({ type: 'refresh' })
    // Reopen the exact durable state that existed before the external result.
    await writeFile(join(f.root, 'agents.json'), interruptedState)
    await f.restart()
    await expect.poll(() => f.decisions.length).toBe(2)
    await expect.poll(() => f.control.get().queue[0]?.text).toBe('Review finished.')
    await f.control.command({ type: 'refresh' })
  })

  it('processes failures arriving during dispatch and still enforces the follow-up limit and repeated-failure stop', async () => {
    const host = new DispatchEventHost([
      [{ type: 'failure', threadId: 'workshop', text: 'Fixable test two' }],
      [{ type: 'failure', threadId: 'workshop', text: 'Fixable test three' }],
      [{ type: 'failure', threadId: 'workshop', text: 'Fixable test three' }],
    ])
    const f = await fixture(host)
    await f.account()
    await f.control.command({ type: 'configure', patch: { followupLimit: 2 } })
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the existing failing tests.' })
    host.event({ type: 'failure', threadId: 'workshop', text: 'Fixable test one' })
    await expect.poll(() => f.control.get().assignments[0]?.followups).toBe(2)
    await expect.poll(() => f.control.get().assignments[0]?.paused).toBe(true)
    expect(host.sendCalls).toBe(2)
    expect(f.decisions).toEqual(['Fixable test one', 'Fixable test two'])
    expect(f.control.get().queue.some(item => item.text.includes('follow-up limit'))).toBe(true)
    await f.control.command({ type: 'resume', threadId: 'workshop' })
    await expect.poll(() => f.control.get().queue.some(item => item.text.includes('repeating a failure'))).toBe(true)
    expect(host.sendCalls).toBe(3)
    expect(f.control.get().assignments[0]).toMatchObject({ followups: 1, paused: true })
  })

  it('reasons about the newest failure when an earlier decision becomes stale before dispatch', async () => {
    const f = await fixture()
    await f.account()
    let release!: () => void
    f.service.decisionGate = new Promise<void>(resolve => { release = resolve })
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the existing failing tests.' })
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'Superseded failure' })
    await expect.poll(() => f.decisions.length).toBe(1)
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'Newest failure' })
    release()
    await expect.poll(() => f.control.get().host.threads[0]?.messages.filter(message => message.role === 'user').length).toBe(1)
    expect(f.decisions).toEqual(['Superseded failure', 'Newest failure'])
    expect(f.control.get().assignments[0]).toMatchObject({ followups: 1, paused: false })
  })

  it('does not continue automatically after manual takeover during an earlier dispatch', async () => {
    const host = new DispatchEventHost([[
      { type: 'manual', threadId: 'workshop', text: 'I am handling this now.' },
      { type: 'failure', threadId: 'workshop', text: 'New failure under manual control' },
    ]])
    const f = await fixture(host)
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the existing failing tests.' })
    host.event({ type: 'failure', threadId: 'workshop', text: 'Original failure' })
    await expect.poll(() => f.control.get().assignments[0]?.mode).toBe('manual')
    await f.control.command({ type: 'refresh' })
    expect(host.sendCalls).toBe(1)
    expect(f.decisions).toEqual(['Original failure'])
    expect(f.control.get().queue.some(item => item.text === 'New failure under manual control')).toBe(true)
  })
})

describe('question draft recovery', () => {
  it('preserves a matching draft on a rejected option answer, then clears it and advances only after confirmation', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'assign', threadId: 'docs' })
    f.host.event({ type: 'question', threadId: 'workshop', text: 'Choose colors.', requestId: 'workshop-colors' })
    f.host.event({ type: 'question', threadId: 'docs', text: 'Choose the heading.', requestId: 'docs-heading' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Use the existing palette.' })
    f.host.event({ type: 'reject', threadId: 'workshop', text: 'Fixture option answer was rejected.' })
    const failed = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'workshop-colors', answer: 'Blue' })
    expect(failed.error).toContain('rejected')
    expect(failed).toMatchObject({ draft: 'Use the existing palette.', draftThreadId: 'workshop', draftRequestId: 'workshop-colors', composing: true })
    const confirmed = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'workshop-colors', answer: 'Blue' })
    expect(confirmed.error).toBeNull()
    expect(confirmed).toMatchObject({ draft: '', draftThreadId: null, draftRequestId: null, composing: false, activeThreadId: 'docs' })
    expect(confirmed.host.threads.find(thread => thread.id === 'workshop')?.requests).toEqual([])
  })

  it.each(['another-question', 'another-thread'] as const)('preserves the current draft when a confirmed option answers %s', async target => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'assign', threadId: 'docs' })
    f.host.event({ type: 'question', threadId: 'workshop', text: 'Choose colors.', requestId: 'workshop-colors' })
    const answeredThread = target === 'another-question' ? 'workshop' : 'docs'
    f.host.event({ type: 'question', threadId: answeredThread, text: 'Choose the heading.', requestId: 'other-question' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Use the existing palette.' })
    const confirmed = await f.control.command({ type: 'answer', threadId: answeredThread, requestId: 'other-question', answer: 'Original heading' })
    expect(confirmed.error).toBeNull()
    expect(confirmed).toMatchObject({ draft: 'Use the existing palette.', draftThreadId: 'workshop', draftRequestId: 'workshop-colors', composing: true })
    expect(confirmed.host.threads.find(thread => thread.id === 'workshop')?.requests.some(request => request.id === 'workshop-colors')).toBe(true)
  })
})

describe('clarification recovery', () => {
  it('asks for the thread before capturing a prompt prefix when no thread is selected', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'select-project', projectId: 'project' })
    f.service.intent = { type: 'clarify', text: 'Which thread should receive your prompt?' }
    const question = await f.control.command({ type: 'utterance', text: "Here's my prompt: Keep the existing colors." })
    expect(question.error).toBeNull()
    expect(question.pendingRequest).toContain('Keep the existing colors.')
    f.service.intent = { type: 'compose', threadId: 'workshop', text: 'Keep the existing colors.' }
    const answer = await f.control.command({ type: 'utterance', text: 'Workshop.' })
    expect(answer).toMatchObject({ error: null, draft: 'Keep the existing colors.', draftThreadId: 'workshop', composing: true })
  })

  it('begins listening after a thread clarification when no prompt has been dictated yet', async () => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'select-project', projectId: 'project' })
    f.service.intent = { type: 'clarify', text: 'Which thread should receive your prompt?' }
    await f.control.command({ type: 'utterance', text: 'I want to add a prompt to a thread.' })
    f.service.intent = { type: 'compose', threadId: 'workshop', text: '' }
    const selected = await f.control.command({ type: 'utterance', text: 'Workshop.' })
    expect(selected).toMatchObject({ error: null, composing: true, draftThreadId: 'workshop', draft: '' })
    const dictated = await f.control.command({ type: 'utterance', text: 'Keep the existing colors.' })
    expect(dictated).toMatchObject({ error: null, draft: 'Keep the existing colors.', draftThreadId: 'workshop' })
    expect(f.requests).toHaveLength(2)
  })

  it('requires explicit management before sending a prepared prompt to an unassigned thread', async () => {
    const f = await fixture()
    await f.account()
    f.service.intent = { type: 'compose', threadId: 'workshop', text: 'Keep the existing colors.' }
    const drafted = await f.control.command({ type: 'utterance', text: 'Add a prompt to Workshop: Keep the existing colors.' })
    expect(drafted).toMatchObject({ error: null, draft: 'Keep the existing colors.', draftThreadId: 'workshop', assignments: [] })
    const blocked = await f.control.command({ type: 'utterance', text: 'Send it.' })
    expect(blocked.error).toContain('Assign this thread')
    expect(blocked.draft).toBe('Keep the existing colors.')
    const managed = await f.control.command({ type: 'utterance', text: 'Manage Workshop.' })
    expect(managed).toMatchObject({ error: null, draft: 'Keep the existing colors.', draftThreadId: 'workshop' })
    const sent = await f.control.command({ type: 'utterance', text: 'Send it.' })
    expect(sent.error).toBeNull()
    expect(sent.host.threads.find(thread => thread.id === 'workshop')?.messages).toHaveLength(1)
  })

  it('keeps the pending prompt and presents a readable error when its clarification has an invalid model response', async () => {
    const f = await fixture()
    await f.account()
    f.service.intent = { type: 'clarify', text: 'Which thread should receive your prompt?' }
    const pending = await f.control.command({ type: 'utterance', text: 'Add a prompt: Keep the existing colors.' })
    f.service.intent = { type: 'submit', threadId: 'workshop' } as unknown as AgentIntent
    const failed = await f.control.command({ type: 'utterance', text: 'Workshop.' })
    expect(failed.error).toContain('Sotto could not interpret')
    expect(failed.error).not.toContain('invalid_union')
    expect(failed.pendingRequest).toBe(pending.pendingRequest)
    expect(failed.host.threads.every(thread => thread.messages.length === 0)).toBe(true)
  })

  it.each(['Workshop.', 'Select Workshop.', 'Open Workshop.'])('retains a spoken prompt through naming its thread (%s) and sends only after explicit confirmation', async clarification => {
    const f = await fixture()
    await f.account()
    await f.control.command({ type: 'assign', threadId: 'workshop' })
    await f.control.command({ type: 'select-project', projectId: 'project' })
    f.service.intent = { type: 'clarify', text: 'Which thread should receive your prompt?' }
    const clarified = await f.control.command({ type: 'utterance', text: 'Add a prompt to a thread: Keep the existing colors and fix the heading.' })
    expect(clarified.pendingRequest).toContain('Keep the existing colors and fix the heading.')
    await f.restart()
    f.service.intent = { type: 'compose', threadId: 'workshop', text: 'Keep the existing colors and fix the heading.' }
    const named = await f.control.command({ type: 'utterance', text: clarification })
    expect(named.error).toBeNull()
    expect(named).toMatchObject({ activeThreadId: 'workshop', draftThreadId: 'workshop', draft: 'Keep the existing colors and fix the heading.', composing: true, pendingRequest: '' })
    expect(f.requests.at(-1)?.utterance).toContain(`User clarification: ${clarification}`)
    expect(named.host.threads.every(thread => thread.messages.length === 0)).toBe(true)
    const sent = await f.control.command({ type: 'utterance', text: 'Send it.' })
    expect(sent.error).toBeNull()
    expect(sent.host.threads.find(thread => thread.id === 'workshop')?.messages).toMatchObject([{ role: 'user', text: 'Keep the existing colors and fix the heading.' }])
    expect(sent.host.threads.find(thread => thread.id === 'docs')?.messages).toEqual([])
  })

  it('retains a valid spoken project request and its execution failure for a corrective folder reply', async () => {
    const f = await fixture()
    await f.account()
    const existing = join(f.root, 'existing-project')
    await mkdir(existing)
    f.service.intent = { type: 'create-project', title: 'Lantern', path: existing }
    const failed = await f.control.command({ type: 'utterance', text: `Create a project called Lantern in ${existing}.` })
    expect(failed.error).toMatch(/folder already exists/iu)
    expect(failed.pendingRequest).toContain('Create a project called Lantern')
    expect(failed.pendingRequest).toContain(failed.error)
    await f.restart()
    const corrected = join(f.root, 'corrected-project')
    f.service.intent = { type: 'create-project', title: 'Lantern', path: corrected }
    const done = await f.control.command({ type: 'utterance', text: `Use ${corrected} instead.` })
    expect(done.error).toBeNull()
    expect(f.requests.at(-1)?.utterance).toContain('Create a project called Lantern')
    expect(f.requests.at(-1)?.utterance).toContain('folder already exists')
    expect(f.requests.at(-1)?.utterance).toContain(`User clarification: Use ${corrected} instead.`)
    expect(done.host.projects.filter(project => project.title === 'Lantern')).toMatchObject([{ path: corrected }])
    expect(done.pendingRequest).toBe('')
  })

  it('retains a valid spoken thread request when its selected model cannot execute', async () => {
    const f = await fixture()
    await f.account()
    f.service.intent = { type: 'create-thread', title: 'Lantern implementation', projectId: 'project', modelId: 'missing:model' }
    const failed = await f.control.command({ type: 'utterance', text: 'Create a thread called Lantern implementation with the experimental model.' })
    expect(failed.error).toMatch(/model or account is unavailable/iu)
    expect(failed.pendingRequest).toContain('Lantern implementation')
    f.service.intent = { type: 'create-thread', title: 'Lantern implementation', projectId: 'project', modelId: 'claude:test' }
    const done = await f.control.command({ type: 'utterance', text: 'Use Claude Test instead.' })
    expect(done.error).toBeNull()
    expect(f.requests.at(-1)?.utterance).toContain('Lantern implementation')
    expect(f.requests.at(-1)?.utterance).toContain('model or account is unavailable')
    expect(done.host.threads.filter(thread => thread.title === 'Lantern implementation')).toHaveLength(1)
    expect(done.pendingRequest).toBe('')
  })

  it.each(['create-project', 'create-thread'] as const)('blocks fresh creation intents while %s has an unknown acknowledgment, including after restart', async type => {
    const host = new UnacknowledgedCreationHost()
    const f = await fixture(host)
    await f.account()
    f.service.intent = type === 'create-project'
      ? { type, title: 'Lantern', path: join(f.root, 'first-project') }
      : { type, title: 'Lantern', projectId: 'project', modelId: 'claude:test' }
    const failed = await f.control.command({ type: 'utterance', text: 'Create Lantern.' })
    expect(failed.error).toMatch(/did not confirm/iu)
    await f.restart()
    const retry = await f.control.command({ type: 'utterance', text: 'Try creating it again.' })
    expect(retry.error).toMatch(/unknown result/iu)
    const alternativePath = join(f.root, 'must-not-be-created')
    const another = await f.control.command({ type: 'create-project', title: 'Another', path: alternativePath })
    expect(another.error).toMatch(/unknown result/iu)
    await expect(stat(alternativePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(host.creationAttempts).toHaveLength(1)
    await host.revealOriginalCreation()
    const observed = await f.control.command({ type: 'refresh' })
    const existing = type === 'create-project'
      ? observed.host.projects.find(project => project.title === 'Lantern')!
      : observed.host.threads.find(thread => thread.title === 'Lantern')!
    const selected = await f.control.command(type === 'create-project'
      ? { type: 'select-project', projectId: existing.id } : { type: 'select-thread', threadId: existing.id })
    expect(selected.error).toBeNull()
    expect(selected.pendingRequest).toBe('')
    expect(host.creationAttempts).toHaveLength(1)
  })

  it.each(['unconfigured', 'missing-key', 'offline'] as const)('does not turn a %s failure into a saved clarification', async failure => {
    const f = await fixture()
    if (failure !== 'unconfigured') await f.account()
    if (failure === 'missing-key') await f.control.command({ type: 'credential', slot: 'reasoning', value: '' })
    if (failure === 'offline') f.service.offline = true
    const failed = await f.control.command({ type: 'utterance', text: 'Create a project called Forgotten.' })
    expect(failed.error).not.toBeNull()
    expect(failed.pendingRequest).toBe('')
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).pendingRequest).toBe('')
    await f.restart()
    await f.account()
    f.service.offline = false
    await f.control.command({ type: 'utterance', text: 'Choose the test project.' })
    expect(f.requests.at(-1)?.utterance).toBe('Choose the test project.')
  })

  it('preserves a genuine clarification through a failed retry and restart without accumulating the failed reply', async () => {
    const f = await fixture()
    const clarified = await f.clarification()
    const pending = clarified.pendingRequest
    expect(pending).toContain('Create a project called Lantern.')
    f.service.offline = true
    const failed = await f.control.command({ type: 'utterance', text: 'Use my old folder.' })
    expect(failed.error).not.toBeNull()
    expect(failed.pendingRequest).toBe(pending)
    await f.restart()
    expect(f.control.get().pendingRequest).toBe(pending)
    f.service.offline = false
    f.service.intent = { type: 'select-project', projectId: 'project' }
    const done = await f.control.command({ type: 'utterance', text: 'Use the test project instead.' })
    expect(done.pendingRequest).toBe('')
    expect(f.requests.at(-1)?.utterance).toBe(`${pending}\nUser clarification: Use the test project instead.`)
  })

  it.each(['select-project', 'select-thread', 'create-project', 'create-thread'] as const)('clears a superseded clarification after successful explicit %s', async type => {
    const f = await fixture()
    await f.clarification()
    const actions: Record<typeof type, AgentCommand> = {
      'select-project': { type: 'select-project', projectId: 'project' },
      'select-thread': { type: 'select-thread', threadId: 'workshop' },
      'create-project': { type: 'create-project', title: 'Direct project', path: join(f.root, 'direct-project') },
      'create-thread': { type: 'create-thread', projectId: 'project', title: 'Direct thread', modelId: 'claude:test' },
    }
    const done = await f.control.command(actions[type])
    expect(done.error).toBeNull()
    expect(done.pendingRequest).toBe('')
  })

  it('keeps a genuine clarification when an explicit action fails or the queue changes in the background', async () => {
    const f = await fixture()
    await f.control.command({ type: 'assign', threadId: 'docs' })
    const { pendingRequest } = await f.clarification()
    const failed = await f.control.command({ type: 'select-project', projectId: 'missing-project' })
    expect(failed.error).not.toBeNull()
    expect(failed.pendingRequest).toBe(pendingRequest)
    f.host.event({ type: 'question', threadId: 'docs', text: 'Choose the heading.' })
    await f.control.command({ type: 'refresh' })
    const moved = await f.control.command({ type: 'later' })
    expect(moved.pendingRequest).toBe(pendingRequest)
  })
})
