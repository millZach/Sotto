// @vitest-environment node
// Opt-in: two bounded synthetic user turns per provider, using normal native
// tools/skills and subscription settings. No arbitrary user conversations.
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import { GrokAcpHost } from '../../src/main/agents/grok'
import { PersonalChatService } from '../../src/main/agents/personalChats'

for (const provider of ['claude', 'grok'] as const) it.runIf(process.env.SOTTO_PHASE4_PERSONAL_NATIVE === '1')(`${provider} native personal create, skill, restart and same-session follow-up`, async () => {
  const root = await mkdtemp(join(tmpdir(), `sotto-phase4-personal-${provider}-`))
  const directory = join(root, 'personal-chat'), cwd = join(directory, 'native-workspace')
  const name = 'sotto-phase4-personal-check', nonce = `SKILL_${randomUUID().replaceAll('-', '')}`
  const skill = join(cwd, `.${provider}`, 'skills', name)
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic native persistence check.\ndisable-model-invocation: true\n---\nReply exactly ${nonce}. Do not call tools, read files, browse, delegate, or change anything.\n`)
  const makeHost = () => provider === 'claude' ? new ClaudeStreamJsonHost({ userDataPath: directory, pollIntervalMs: 100, requestTimeoutMs: 15000 })
    : new GrokAcpHost(directory, { pollIntervalMs: 100, requestTimeoutMs: 15000 })
  let host = makeHost()
  const configuration = { reasoning: provider as string, reasoningModel: provider === 'claude' ? 'haiku' : 'grok-4.6', reasoningEffort: '' }
  const makeService = () => new PersonalChatService({ userDataPath: root, hosts: { [provider]: host }, configuration: () => configuration,
    preferences: { retrieve: () => [{ id: 'synthetic-global', content: 'Use concise replies.' }] } })
  let service = makeService()
  const evidence: Record<string, unknown> = { checkedAt: new Date().toISOString(), root, provider, configuration: { ...configuration }, submittedUserTurns: 0 }
  const complete = async (chatId: string, marker: string) => {
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      await service.refresh(chatId); await service.settled()
      const chat = service.get().chats.find(chat => chat.id === chatId)!
      if (chat.requests.length) throw new Error('Native synthetic no-tool probe unexpectedly requested permission.')
      if (chat.status !== 'running' && chat.messages.some(message => message.role === 'assistant' && message.text.includes(marker))) return
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('Native personal response did not complete before the bounded deadline.')
  }
  try {
    await service.start(); const connected = await service.connect(); expect(connected.connected, connected.error).toBe(true)
    const native = await host.snapshot(); evidence.version = native.version
    expect(native.models.some(model => model.id === configuration.reasoningModel && model.ready)).toBe(true)
    const chat = (await service.create()).chats[0]!
    const catalog = await service.skills(chat.id, true), selected = catalog.skills.find(skill => skill.name === name)
    evidence.catalog = { status: catalog.status, count: catalog.skills.length, selected: !!selected }
    expect(selected, catalog.error).toBeDefined()
    await service.saveDraft({ chatId: chat.id, revision: 1, text: `$${name}`, skills: [{ name: selected!.name, path: selected!.path }] })
    evidence.submittedUserTurns = 1
    await service.send({ chatId: chat.id, revision: 1 }); await service.settled(); await complete(chat.id, nonce)
    const before = service.get().chats[0]!
    const aliasBefore = JSON.parse(await readFile(join(directory, `${provider}-threads.json`), 'utf8'))[chat.id]
    evidence.skillExpanded = true; evidence.nativeId = provider === 'claude' ? aliasBefore.sessionId : aliasBefore.grokSessionId
    await service.close(); host = makeHost(); service = makeService()
    await service.start(); expect(service.get().chats[0]!.messages).toEqual(before.messages)
    configuration.reasoning = 'codex' // Reconnect the saved provider, not the newly configured one.
    expect((await service.connect()).connected).toBe(true)
    await service.refresh(chat.id); await service.settled()
    expect(service.get().chats[0]).toMatchObject({ providerId: provider, messages: before.messages })
    const followup = `FOLLOWUP_${randomUUID().replaceAll('-', '')}`
    await service.saveDraft({ chatId: chat.id, revision: 2, text: `Reply exactly ${followup}. Do not call tools, read files, browse, delegate, or change anything.`, skills: [] })
    evidence.submittedUserTurns = 2
    await service.send({ chatId: chat.id, revision: 2 }); await service.settled(); await complete(chat.id, followup)
    const final = service.get().chats[0]!
    evidence.version = (await host.snapshot()).version
    evidence.changedCoordinator = configuration.reasoning
    const aliasAfter = JSON.parse(await readFile(join(directory, `${provider}-threads.json`), 'utf8'))[chat.id]
    expect(provider === 'claude' ? aliasAfter.sessionId : aliasAfter.grokSessionId).toBe(evidence.nativeId)
    expect(final.messages.filter(message => message.role === 'user' && message.commandId)).toHaveLength(2)
    expect((await host.snapshot()).projects).toEqual([]); expect((await host.snapshot()).threads).toEqual([])
    evidence.sameNativeId = true; evidence.restartFollowup = true; evidence.messages = final.messages; evidence.submissions = final.submissions.map(submission => submission.status)
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); throw error }
  finally {
    await service.close(); await mkdir('artifacts/phase-four-native-chats', { recursive: true })
    await writeFile(`artifacts/phase-four-native-chats/${provider}.json`, JSON.stringify(evidence, null, 2))
  }
}, 210000)
