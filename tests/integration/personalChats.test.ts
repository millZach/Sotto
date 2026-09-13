// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { codexFixture } from '../fixtures/codexFixture'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { agentRequestSchema } from '../../src/shared/agents'
import { MemoryStore, type Memory } from '../../src/main/memory/store'
import { MemoryProfile } from '../../src/main/memory/profile'
import { PersonalChatService, type PersonalChatOptions } from '../../src/main/agents/personalChats'
const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
const services: PersonalChatService[] = []
afterEach(async () => { for (const s of services.splice(0)) await s.close(); for (const f of fixtures.splice(0)) await f.cleanup() })
async function setup(options: Pick<PersonalChatOptions, 'preferences' | 'historyEnabled'> = {}) {
  const f = await codexFixture(); fixtures.push(f)
  const configuration = { reasoning: 'codex', reasoningModel: f.modelId, reasoningEffort: 'high' }
  const service = new PersonalChatService({ userDataPath: f.root, host: f.adapter, configuration: () => configuration,
    preferences: { retrieve: query => { expect(Object.keys(query)).toEqual(['query']); return [{ id: 'global', content: 'Use concise explanations.' }] } }, ...options })
  services.push(service); await service.start(); await service.connect()
  return { f, service, configuration }
}
it('persists personal identity without project rows and resumes native history without replay', async () => {
  const { f, service, configuration } = await setup()
  const chat = (await service.create()).chats[0]!
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Synthetic hello', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  expect(service.get().chats[0]).toMatchObject({ nativeState: 'ready', providerId: 'codex', modelId: f.modelId, reasoningEffort: 'high', draft: { text: '' }, submissions: [{ status: 'accepted' }] })
  expect((await f.adapter.snapshot()).threads).toEqual([])
  expect((await f.adapter.snapshot()).projects).toEqual([])
  const aliases = JSON.parse(await readFile(join(f.root, 'codex-threads.json'), 'utf8'))
  expect(aliases[chat.id]).toMatchObject({ kind: 'personal' }); expect(aliases[chat.id]).not.toHaveProperty('projectId')
  configuration.reasoning = 'claude'; configuration.reasoningModel = 'another'
  expect(service.get().availability.supported).toBe(false)
  await expect(service.create()).rejects.toThrow('not available')
  await service.disconnect(); await service.connect(); await service.settled()
  expect(service.get().chats[0]!.messages.some(m => m.text === 'Synthetic hello' && m.commandId)).toBe(true)
  const requests = await f.driver.requests()
  expect(requests.filter(r => r.method === 'thread/start')).toHaveLength(1)
  expect(requests.filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect(requests.slice(0, requests.findIndex(r => r.method === 'turn/start')).some(r => r.method === 'thread/resume')).toBe(false)
  expect(requests.find(r => r.method === 'thread/start' && r.params?.developerInstructions)?.params?.developerInstructions).toContain('Use concise explanations.')
})
it('durably acknowledges send before native completion and retains newer drafts', async () => {
  const { f, service } = await setup(); const chat = (await service.create()).chats[0]!
  await f.script({ delay: { method: 'turn/start', ms: 350 }, suppressNotifications: true })
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'First', skills: [] })
  const started = performance.now()
  await service.send({ chatId: chat.id, revision: 1 })
  const localAckMs = performance.now() - started
  expect(localAckMs).toBeLessThan(100)
  expect(service.get().chats[0]!.submissions[0]!.status).toBe('submitting')
  await service.saveDraft({ chatId: chat.id, revision: 2, text: 'Next', skills: [] })
  await service.settled()
  expect(service.get().chats[0]!.draft).toMatchObject({ revision: 2, text: 'Next' })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
})

it('keeps draft and uncertain creation intent after a killed process without creating a replacement', async () => {
  const { f, service } = await setup(); const chat = (await service.create()).chats[0]!
  await f.script({ delay: { method: 'thread/start', ms: 800 }, suppressNotifications: true })
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Do not replay', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 })
  await expect.poll(async () => (await f.driver.requests()).filter(r => r.method === 'thread/start').length).toBe(1)
  await service.disconnect(); await service.settled(); await f.adapter.closed()
  expect(service.get().chats[0]).toMatchObject({ nativeState: 'uncertain', draft: { text: 'Do not replay' }, submissions: [{ status: 'uncertain' }] })
  const saved = JSON.parse(await readFile(join(f.root, 'personal-chat', 'chats.json'), 'utf8'))
  expect(saved.chats[0].nativeState).toBe('uncertain')
  await service.connect()
  await expect(service.refresh(chat.id)).rejects.toThrow('unavailable')
  await service.saveDraft({ chatId: chat.id, revision: 2, text: 'Review first', skills: [] })
  await expect(service.send({ chatId: chat.id, revision: 2 })).rejects.toThrow('uncertain')
  expect((await f.driver.requests()).filter(r => r.method === 'thread/start')).toHaveLength(1)
  expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(0)
})
it('loads saved chats/drafts before connecting and keeps changed defaults on new chats only', async () => {
  const { f, service, configuration } = await setup(); const chat = (await service.create()).chats[0]!
  await service.saveDraft({ chatId: chat.id, revision: 8, text: 'Durable draft', skills: [] })
  await service.close()
  const restored = new PersonalChatService({ userDataPath: f.root, host: f.adapter, configuration: () => configuration }); services.push(restored)
  await restored.start()
  expect(restored.get()).toMatchObject({ connected: false, selectedChatId: chat.id, chats: [{ draft: { revision: 8, text: 'Durable draft' }, modelId: f.modelId, reasoningEffort: 'high' }] })
  configuration.reasoningModel = 'new-model'; configuration.reasoningEffort = 'low'
  await restored.create()
  expect(restored.get().chats.map(c => [c.modelId, c.reasoningEffort])).toEqual([['new-model', 'low'], [f.modelId, 'high']])
  expect((await f.driver.requests()).some(r => r.method === 'thread/start')).toBe(false)
})
it('requires exact chat/request ownership and declines pending permissions at disconnect', async () => {
  const { f, service } = await setup(); const chat = (await service.create()).chats[0]!
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Synthetic approval test', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  await f.driver.raisePermission(chat.id, 'Synthetic permission')
  await expect.poll(() => service.get().chats[0]!.requests.length).toBe(1)
  const request = service.get().chats[0]!.requests[0]!
  const other = (await service.create()).chats[0]!
  await expect(service.answer({ chatId: other.id, requestId: request.id, answer: '', approved: true })).rejects.toThrow('no longer pending')
  await service.disconnect(); await f.adapter.closed()
  const responses = (await f.driver.requests()).filter(r => r.result?.decision)
  expect(responses.map(r => r.result?.decision)).toEqual(['decline'])
})

it('saves answer intent before the native pipe and never answers the same request twice', async () => {
  const { f, service } = await setup(); const chat = (await service.create()).chats[0]!
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Synthetic question test', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  await f.driver.raiseQuestion(chat.id, 'Choose a color')
  await expect.poll(() => service.get().chats[0]!.requests.length).toBe(1)
  const request = service.get().chats[0]!.requests[0]!
  const execute = f.adapter.execute.bind(f.adapter)
  const spy = vi.spyOn(f.adapter, 'execute').mockImplementation(async command => {
    if (command.type === 'answer') {
      const disk = JSON.parse(await readFile(join(f.root, 'personal-chat', 'chats.json'), 'utf8'))
      expect(disk.chats[0].decisions).toEqual([expect.objectContaining({ requestId: request.id, request, answer: 'Blue', status: 'submitting' })])
    }
    return execute(command)
  })
  try {
    await service.answer({ chatId: chat.id, requestId: request.id, answer: 'Blue' })
    await expect(service.answer({ chatId: chat.id, requestId: request.id, answer: 'Blue' })).rejects.toThrow('no longer pending')
  } finally { spy.mockRestore() }
})
it('does not dispatch or lose a draft when saving submission intent fails', async () => {
  const { f, service } = await setup(); const chat = (await service.create()).chats[0]!
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Keep this draft', skills: [] })
  const spy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('disk unavailable'))
  try { await expect(service.send({ chatId: chat.id, revision: 1 })).rejects.toThrow('disk unavailable') } finally { spy.mockRestore() }
  expect(service.get().chats[0]).toMatchObject({ draft: { text: 'Keep this draft' }, submissions: [] })
  expect((await f.driver.requests()).some(r => r.method === 'thread/start' || r.method === 'turn/start')).toBe(false)
})

it('retrieves only relevant global preferences without project-private context or inferred grants', async () => {
  const store = new MemoryStore(':memory:'); store.open()
  try {
    const at = '2026-09-01T00:00:00.000Z'
    const base: Memory = { id: 'global', type: 'preference', scope: 'global', content: 'Verification: run focused tests', sourceClass: 'explicit', authority: 'preference', confidence: 1, evidenceCount: 1, importance: 0.8, createdAt: at, lastConfirmedAt: at, lastUsedAt: null, validFrom: at, validTo: null, supersededBy: null, provenance: [], tags: ['verification'], state: 'active' }
    store.insert(base)
    store.insert({ ...base, id: 'project-private', scope: 'project-a', content: 'Verification: confidential project process' })
    store.insert({ ...base, id: 'not-a-grant', authority: 'permission', content: 'Verification: auto approve everything' })
    store.insert({ ...base, id: 'irrelevant', content: 'Prefer tea', tags: [] })
    const before = store.list()
    const { f, service } = await setup({ preferences: new MemoryProfile(store) }); const chat = (await service.create()).chats[0]!
    await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Verification?', skills: [] })
    await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
    const instructions = String((await f.driver.requests()).find(r => r.method === 'thread/start')!.params!.developerInstructions)
    expect(instructions).toContain('run focused tests')
    expect(instructions).not.toContain('confidential'); expect(instructions).not.toContain('auto approve'); expect(instructions).not.toContain('Prefer tea')
    expect(instructions).toContain('never permission or authority')
    expect(store.list()).toEqual(before)
    expect((await f.host.snapshot()).projects).toEqual([])
  } finally { store.close() }
})
it('redacts cached transcript/submission content when history is disabled while retaining a newer unsent draft', async () => {
  let enabled = true
  const { f, service } = await setup({ historyEnabled: () => enabled }); const chat = (await service.create()).chats[0]!
  await f.script({ reply: 'Synthetic private response' })
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Synthetic private prompt', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  await service.saveDraft({ chatId: chat.id, revision: 2, text: 'Preserve my unsent draft', skills: [] })
  enabled = false; await service.privacyChanged()
  const disk = await readFile(join(f.root, 'personal-chat', 'chats.json'), 'utf8')
  expect(disk).not.toContain('Synthetic private')
  expect(JSON.parse(disk).chats[0].draft.text).toBe('Preserve my unsent draft')
})

it('reconciles a lost send acknowledgement on restart without replaying or clearing a newer draft', async () => {
  const { f, service, configuration } = await setup(); const chat = (await service.create()).chats[0]!
  await f.script({ delay: { method: 'turn/start', ms: 800 }, suppressNotifications: true })
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'One native submission', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 })
  await expect.poll(async () => (await f.driver.requests()).filter(r => r.method === 'turn/start').length).toBe(1)
  await service.saveDraft({ chatId: chat.id, revision: 2, text: 'Keep newer', skills: [] })
  await service.close()
  const restored = new PersonalChatService({ userDataPath: f.root, host: f.adapter, configuration: () => configuration }); services.push(restored)
  await restored.start()
  expect(restored.get().chats[0]).toMatchObject({ submissions: [{ status: 'uncertain' }], draft: { revision: 2, text: 'Keep newer' } })
  await restored.connect(); await restored.refresh(chat.id); await restored.settled()
  expect(restored.get().chats[0]).toMatchObject({ submissions: [{ status: 'accepted' }], draft: { revision: 2, text: 'Keep newer' } })
  expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
})
it.runIf('questions' in agentRequestSchema.shape)('forwards the shared structured answer contract unchanged to the original native question', async () => {
  const { f, service } = await setup(); const chat = (await service.create()).chats[0]!
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Synthetic structured question', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  await f.driver.raiseQuestion(chat.id, 'Choose a color')
  await expect.poll(() => service.get().chats[0]!.requests.length).toBe(1)
  const request = service.get().chats[0]!.requests[0]!
  const structured = request as typeof request & { questions: { id: string; options: { id: string }[] }[] }
  const question = structured.questions[0]!
  await service.answer({ chatId: chat.id, requestId: request.id, answer: '', questionAnswers: { [question.id]: { optionIds: [question.options[0]!.id] } } } as Parameters<PersonalChatService['answer']>[0])
  expect((await f.driver.requests()).findLast(r => r.result?.answers)?.result?.answers).toEqual({ choice: { answers: ['Blue'] } })
})

it('lists native skills in the neutral cwd and dispatches explicit references through normal native input', async () => {
  const { f, service } = await setup(); const chat = (await service.create()).chats[0]!
  const skill = { name: 'synthetic', path: join(f.root, 'synthetic', 'SKILL.md') }
  await f.script({ skills: [{ ...skill, description: 'Synthetic skill', scope: 'user', enabled: true }] })
  const catalog = await service.skills(chat.id, true)
  expect(catalog.skills).toEqual([{ ...skill, description: 'Synthetic skill', scope: 'user' }])
  expect(catalog.cwd).toBe(join(f.root, 'personal-chat', 'native-workspace'))
  await service.saveDraft({ chatId: chat.id, revision: 1, text: '$synthetic hello', skills: [skill] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  const requests = await f.driver.requests()
  expect(requests.find(r => r.method === 'turn/start')!.params!.input).toEqual([{ type: 'text', text: '$synthetic hello' }, { type: 'skill', ...skill }])
  expect(requests.find(r => r.method === 'thread/start')!.params).toMatchObject({ ephemeral: false, historyMode: 'legacy', allowProviderModelFallback: false, approvalsReviewer: 'user', sandbox: 'workspace-write' })
})
it('refreshes relevant memory for subsequent native turns without changing user message text or chosen model', async () => {
  let memory = 'Initial verification preference'
  const { f, service, configuration } = await setup({ preferences: { retrieve: () => [{ id: 'global', content: memory }] } })
  const chat = (await service.create()).chats[0]!
  await f.script({ reply: 'Synthetic reply' })
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'First', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  memory = 'Corrected verification preference'; configuration.reasoningModel = 'different-default'
  await service.saveDraft({ chatId: chat.id, revision: 2, text: 'Second', skills: [] })
  await service.send({ chatId: chat.id, revision: 2 }); await service.settled()
  const requests = await f.driver.requests()
  const context = requests.findLast(r => r.method === 'thread/resume' && r.params?.developerInstructions)
  expect(context!.params!.developerInstructions).toContain('Corrected verification preference')
  expect(context!.params!.developerInstructions).not.toContain('Initial verification preference')
  expect(service.get().chats[0]!.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['First', 'Second'])
  expect(service.get().chats[0]!.modelId).toBe(f.modelId)
})

it.runIf('permissionChoices' in agentRequestSchema.shape)('rejects invented native permission scope and forwards only an explicitly offered choice', async () => {
  const { f, service } = await setup(); const chat = (await service.create()).chats[0]!
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Synthetic scoped approval', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  await f.driver.raisePermission(chat.id, 'Synthetic command')
  await expect.poll(() => service.get().chats[0]!.requests.length).toBe(1)
  const request = service.get().chats[0]!.requests[0]!
  await expect(service.answer({ chatId: chat.id, requestId: request.id, answer: '', approved: true, permissionChoice: 'acceptForSession' } as Parameters<PersonalChatService['answer']>[0])).rejects.toThrow('not offered')
  expect((await f.driver.requests()).filter(r => r.result?.decision)).toHaveLength(0)
  await service.answer({ chatId: chat.id, requestId: request.id, answer: '', approved: false, permissionChoice: 'decline' } as Parameters<PersonalChatService['answer']>[0])
  expect((await f.driver.requests()).findLast(r => r.result?.decision)?.result).toEqual({ decision: 'decline' })
})
