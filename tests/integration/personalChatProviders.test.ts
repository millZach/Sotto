// @vitest-environment node
import { expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { PersonalChatService } from '../../src/main/agents/personalChats'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import { GrokAcpHost } from '../../src/main/agents/grok'

for (const provider of ['claude', 'grok'] as const) it(`${provider} personal chat keeps native skills, permissions and same history across service restart without adopting a project`, async () => {
  const factory = provider === 'claude' ? claudeFixture : grokFixture
  let f = await factory(undefined, 1500)
  const configuration = { reasoning: provider as string, reasoningModel: f.modelId, reasoningEffort: 'high' }
  const options = () => ({ userDataPath: f.root, hosts: { [provider]: f.adapter }, configuration: () => configuration,
    preferences: { retrieve: (query: unknown) => { expect(query).toEqual({ query: '$check verify' }); return [{ id: 'global', content: 'Use concise explanations.' }] } } })
  let service = new PersonalChatService(options())
  try {
    await writeFile(join(f.root, 'skills.json'), JSON.stringify(provider === 'claude' ? [{ name: 'check', description: 'Synthetic (user)' }]
      : { skills: [{ name: 'check', description: 'Synthetic', source: { path: join(f.root, 'SKILL.md'), type: 'user' }, userInvocable: true }] }))
    await service.start(); expect((await service.connect()).connected).toBe(true)
    const chat = (await service.create()).chats[0]!
    const catalog = await service.skills(chat.id)
    expect(catalog).toMatchObject({ providerId: provider, status: 'ready' })
    await service.saveDraft({ chatId: chat.id, revision: 1, text: '$check verify', skills: [{ name: catalog.skills[0]!.name, path: catalog.skills[0]!.path }] })
    await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
    expect(service.get().chats[0], JSON.stringify(service.get().chats[0]!.submissions)).toMatchObject({ providerId: provider, nativeState: 'ready', submissions: [{ status: 'accepted' }] })
    await f.driver.raisePermission(chat.id, 'Synthetic permission')
    await expect.poll(() => service.get().chats[0]!.requests.length).toBe(1)
    const request = service.get().chats[0]!.requests[0]!
    await service.answer({ chatId: chat.id, requestId: request.id, answer: '', approved: false })
    await f.driver.completeTurn(chat.id, 'Synthetic answer')
    await expect.poll(() => service.get().chats[0]!.status).toBe('idle')
    await service.refresh(chat.id); await service.settled()
    const before = service.get().chats[0]!
    expect(before.messages.some(message => message.role === 'assistant' && message.text === 'Synthetic answer')).toBe(true)
    expect(JSON.stringify(before.messages)).not.toContain('SottoPersonalContext')
    expect((await f.host.snapshot()).threads).toEqual([])
    expect((await f.host.snapshot()).projects).toEqual([])
    const aliasBefore = JSON.parse(await readFile(join(f.root, `${provider}-threads.json`), 'utf8'))[chat.id]
    expect(aliasBefore).toMatchObject({ kind: 'personal' }); expect(aliasBefore).not.toHaveProperty('projectId')
    expect(JSON.stringify(aliasBefore)).not.toContain('Use concise explanations')
    // The fixture control file is a driver command, not native session state.
    // Consume it before starting another fake process so it cannot manufacture a second completion.
    await f.action(chat.id, { type: 'noop' })
    await service.close(); f = await factory(f.root, 1500); service = new PersonalChatService(options())
    await service.start(); expect(service.get().chats[0]!.messages).toEqual(before.messages)
    configuration.reasoning = 'codex'; configuration.reasoningModel = 'new-model'
    expect((await service.connect()).connected).toBe(true)
    await service.refresh(chat.id); await service.settled()
    expect(service.get().chats[0]).toMatchObject({ providerId: provider, modelId: f.modelId, messages: before.messages })
    const aliasAfter = JSON.parse(await readFile(join(f.root, `${provider}-threads.json`), 'utf8'))[chat.id]
    expect(provider === 'claude' ? aliasAfter.sessionId : aliasAfter.grokSessionId).toBe(provider === 'claude' ? aliasBefore.sessionId : aliasBefore.grokSessionId)
    const calls = await f.driver.requests()
    expect(calls.filter(call => call.method === f.protocol!.promptMethod)).toHaveLength(1)
    expect(JSON.stringify(calls)).toContain('Use concise explanations.')
    const newer = (await service.create()).chats[0]!
    expect(newer).toMatchObject({ providerId: 'codex', modelId: 'new-model', nativeState: 'unstarted' })
    expect((await service.select(chat.id)).connected).toBe(true)
  } finally { await service.close(); await f.cleanup() }
}, 20000)

for (const provider of ['claude', 'grok'] as const) it(`${provider} keeps saved history and drafts when its native connection fails`, async () => {
  const f = provider === 'claude' ? await claudeFixture() : await grokFixture()
  const configuration = () => ({ reasoning: provider, reasoningModel: f.modelId, reasoningEffort: '' })
  let service = new PersonalChatService({ userDataPath: f.root, hosts: { [provider]: f.adapter }, configuration })
  try {
    await service.start(); await service.connect(); const chat = (await service.create()).chats[0]!
    await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Keep this history', skills: [] })
    await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
    await f.driver.completeTurn(chat.id, 'Saved answer')
    await expect.poll(() => service.get().chats[0]!.status).toBe('idle')
    await service.saveDraft({ chatId: chat.id, revision: 2, text: 'Unsent next thought', skills: [] })
    const saved = service.get().chats[0]!
    await service.close()
    const broken = provider === 'claude' ? new ClaudeStreamJsonHost({ userDataPath: f.root, executable: join(f.root, 'missing-claude.exe') })
      : new GrokAcpHost(f.root, { executable: join(f.root, 'missing-grok.exe'), requestTimeoutMs: 100 })
    service = new PersonalChatService({ userDataPath: f.root, hosts: { [provider]: broken }, configuration })
    await service.start(); const failed = await service.connect()
    expect(failed.connected).toBe(false); expect(failed.error).toBeTruthy()
    expect(failed.chats[0]).toMatchObject({ providerId: provider, messages: saved.messages, draft: saved.draft })
    await expect(service.send({ chatId: chat.id, revision: 2 })).rejects.toThrow('Connect')
    expect(service.get().chats[0]!.submissions).toHaveLength(1)
  } finally { await service.close(); await f.cleanup() }
}, 15000)
