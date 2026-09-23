// @vitest-environment node
/**
 * Opt-in only (`SOTTO_SIDE_WRITING_LIVE=1`): against each installed, signed-in client, one new thread in a
 * throwaway project is sent one harmless prompt, and the coordinator names it through a side call to that
 * thread's own client (ADR-0026). Then the thread's own transcript is searched for the naming instruction,
 * and everything the client keeps (its whole home folder) and Sotto's data folder for the side call's own
 * material, which must be in none of them. Grok's side call runs on a throwaway home of its own, which must
 * be gone when the call ends. `SOTTO_SIDE_WRITING_PROVIDERS` narrows the
 * run (comma-separated: claude, codex, grok) and `SOTTO_SIDE_WRITING_MODEL_<PROVIDER>` picks a model by a
 * substring of its name; otherwise the cheapest-sounding model the client lists is used.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { GrokAcpHost } from '../../src/main/agents/grok'
import type { AgentHost } from '../../src/main/agents/host'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { ShortTextWriter } from '../../src/main/llm/shortTextWriter'
import { threadTitleWriter } from '../../src/main/llm/threadTitle'
import type { ProviderId } from '../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

const live = process.env.SOTTO_SIDE_WRITING_LIVE === '1'
const wanted = (process.env.SOTTO_SIDE_WRITING_PROVIDERS ?? 'claude,codex,grok').split(',').map(item => item.trim())
/** The opening words of the title instruction: if these are anywhere in a transcript, the side call leaked. */
const MARKER = 'You name a coding conversation for a sidebar.'
const QUESTION = 'In one sentence, what does a README file in a code repository usually hold? Do not use tools, read files or run commands.'
// Codex lists models a ChatGPT sign-in cannot use (its mini models among them), so it runs on the one it recommends.
const cheap: Record<string, RegExp> = { claude: /haiku/iu, grok: /fast/iu }
/** Everything each client keeps: session lists, archives, prompt history, state and log databases. */
const stores: Record<string, string[]> = {
  claude: [join(homedir(), '.claude'), join(homedir(), '.claude.json')],
  codex: [process.env.CODEX_HOME ?? join(homedir(), '.codex')],
  grok: [process.env.GROK_HOME ?? join(homedir(), '.grok')],
}

/** Whether a file holds any of `needles`, read in chunks so a log database of gigabytes is searched whole. */
async function holds(path: string, needles: readonly Buffer[]): Promise<boolean> {
  const overlap = Math.max(...needles.map(needle => needle.length))
  let tail = Buffer.alloc(0)
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 }) as AsyncIterable<Buffer>) {
      const window = Buffer.concat([tail, chunk])
      if (needles.some(needle => window.includes(needle))) return true
      tail = window.subarray(Math.max(0, window.length - overlap))
    }
  } catch { /* A file the client holds locked or removed mid-read is skipped. */ }
  return false
}

/** Every file at or under each root, written since `since`, that holds any of `texts`. */
async function mentions(roots: readonly string[], since: number, texts: readonly string[]): Promise<string[]> {
  const needles = texts.map(text => Buffer.from(text, 'utf8')), found: string[] = []
  const visit = async (path: string): Promise<void> => {
    const info = await stat(path).catch(() => null)
    if (info?.isDirectory()) { for (const entry of await readdir(path).catch(() => [])) await visit(join(path, entry)); return }
    if (info?.isFile() && info.mtimeMs >= since && await holds(path, needles)) found.push(path)
  }
  for (const root of roots) await visit(root)
  return found
}

function adapter(provider: ProviderId, data: string): AgentHost & { closed?: () => Promise<void> } {
  if (provider === 'claude') return new ClaudeStreamJsonHost({ userDataPath: data, pollIntervalMs: 500 })
  if (provider === 'codex') return new CodexAppServerHost({ userDataPath: data, pollIntervalMs: 500 })
  return new GrokAcpHost(data, { pollIntervalMs: 500 })
}

describe.skipIf(!live)('side writing against the installed clients', () => {
  for (const provider of (['claude', 'codex', 'grok'] as const).filter(id => wanted.includes(id))) {
    it(`${provider} names a new thread on the side, and the thread never sees the naming prompt`, async () => {
      const started = Date.now()
      // A reference no earlier run or other session can hold, so only this run's side call can match. The side
      // call's material opens with the first message under its heading, which the thread's own turn never has;
      // a store keeps that line break raw or JSON-escaped.
      const PROMPT = `${QUESTION} (Reference ${randomUUID()}.)`
      const sideCall = [`First message:\n${PROMPT}`, `First message:\\n${PROMPT}`, `First message:\r\n${PROMPT}`, `First message:\\r\\n${PROMPT}`]
      const root = await mkdtemp(join(tmpdir(), `sotto-side-writing-${provider}-`))
      const data = join(root, 'data'); const project = join(root, 'project')
      await mkdir(data); await mkdir(project)
      const registry = new ThreadRegistry(data)
      const native = adapter(provider, data)
      const hosts = { claude: new FakeProviderHost() as AgentHost, codex: new FakeProviderHost() as AgentHost, grok: new FakeProviderHost() as AgentHost, devin: new FakeProviderHost() as AgentHost }
      hosts[provider] = new SottoThreadHost(provider, native, registry)
      const host = new WorkspaceHost(new ConfiguredProviderHost({ directory: data, provider: () => provider, enabledProviders: () => [provider],
        threadProvider: id => registry.byThread(id)?.provider, hosts }), data)
      const failures: string[] = []
      const credentials = new AgentCredentials(data, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
      await credentials.load()
      const control = new AgentControl({ schedule: immediatePublishScheduler, directory: data, host, credentials, reasoner: e2eAgentReasoner,
        membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) },
        writeThreadTitle: threadTitleWriter(new ShortTextWriter({ write: (threadId, prompt) => host.writeShortText(threadId, prompt),
          onFailure: failure => failures.push(`${failure.purpose}:${failure.reason}`) }), () => DEFAULT_SETTINGS) })
      try {
        await control.start()
        await host.connect(provider)
        const projectId = host.createProjectId(provider)
        await host.execute({ type: 'create-project', commandId: randomUUID(), provider, projectId, title: 'Side writing live check', path: project })
        const models = (await host.snapshot()).models.filter(model => model.providerId === provider && model.ready)
        const pick = process.env[`SOTTO_SIDE_WRITING_MODEL_${provider.toUpperCase()}`]
        const model = models.find(item => pick ? `${item.id} ${item.name}`.toLowerCase().includes(pick.toLowerCase()) : cheap[provider]?.test(`${item.id} ${item.name}`))
          ?? models.find(item => item.recommended) ?? models[0]!
        const threadId = randomUUID()
        await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId, title: 'New thread', modelId: model.id })
        expect(await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'live-prompt', text: PROMPT })).toMatchObject({ accepted: true })
        // The window looks at the thread it just sent to, which is what has its client read the reply.
        await expect.poll(() => control.get().host.threads.some(thread => thread.id === threadId), { timeout: 30_000 }).toBe(true)
        await control.command({ type: 'observe-threads', threadIds: [threadId] })
        await expect.poll(() => control.get().host.threads.find(thread => thread.id === threadId)?.titleSource, { timeout: 180_000, interval: 1_000 }).toBe('generated')
        const named = control.get().host.threads.find(thread => thread.id === threadId)!
        console.info(`[side-writing-live] ${provider} ${model.name}: "${named.title}" in ${Math.round((Date.now() - started) / 1000)} s`)
        expect(failures).toEqual([])
        expect(named.title.length).toBeGreaterThan(0)
        expect(named.title.length).toBeLessThanOrEqual(60)
        // The thread's own transcript, read back from its client, holds the one prompt and nothing of the naming.
        await host.refreshThread(threadId)
        const messages = host.threadMessages?.(threadId) ?? (await host.snapshot()).threads.find(thread => thread.id === threadId)!.messages
        expect(messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([PROMPT])
        expect(JSON.stringify(messages)).not.toContain(MARKER)
        // Nor did the client keep the side call anywhere, nor Sotto outside the thread's own record.
        expect(await mentions(stores[provider]!, started, sideCall)).toEqual([])
        expect(await mentions([data], started, [MARKER, ...sideCall])).toEqual([])
        // Grok's throwaway home held the side call's session while it ran; it is gone with the call.
        expect(await readdir(join(data, 'writing', 'grok')).catch(() => [])).toEqual([])
      } finally {
        control.dispose(); host.disconnect(); await native.closed?.(); await host.privacyChanged(); host.dispose(); await registry.flush()
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }, 600_000)
  }
})
