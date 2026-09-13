// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { codexFixture } from '../fixtures/codexFixture'
import { PersonalChatService } from '../../src/main/agents/personalChats'
import { personalChatSchema, personalChatStateSchema } from '../../src/shared/personalChats'
import type { CodexPersonalConversation } from '../../src/main/agents/codex'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
const services: PersonalChatService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})
const configuration = () => ({ reasoning: 'codex', reasoningModel: 'fixture-model', reasoningEffort: 'high' })
async function setup() {
  const fixture = await codexFixture(); fixtures.push(fixture)
  const service = makeService(fixture)
  await service.start()
  return { fixture, service, path: join(fixture.root, 'personal-chat', 'chats.json') }
}
function makeService(fixture: Awaited<ReturnType<typeof codexFixture>>, historyEnabled = true) {
  const service = new PersonalChatService({ userDataPath: fixture.root, host: fixture.adapter, configuration, historyEnabled: () => historyEnabled })
  services.push(service)
  return service
}
function serialized(service: PersonalChatService) {
  return personalChatStateSchema.parse(JSON.parse(JSON.stringify(service.get())))
}
async function stop(service: PersonalChatService) {
  services.splice(services.indexOf(service), 1)
  await service.close()
}

it('keeps two chats, exact long native message identities, bindings and newer drafts through a full service/process restart', async () => {
  const { fixture, service, path } = await setup()
  await service.connect()
  const answer = 'x'.repeat(100001)
  for (const reply of [answer, 'Other saved answer']) {
    await fixture.script({ reply })
    const chat = (await service.create()).chats[0]!
    await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Synthetic prompt', skills: [] })
    await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
    await service.refresh(chat.id)
    await service.saveDraft({ chatId: chat.id, revision: 2, text: `Unsent ${chat.id}`, skills: [] })
  }
  const before = service.get().chats
  expect(before.some(c => c.messages.some(m => m.text === answer))).toBe(true)
  const aliases = await readFile(join(fixture.root, 'codex-threads.json'), 'utf8')
  await stop(service)
  const restarted = await codexFixture(fixture.root); fixtures.push(restarted)
  const restored = makeService(restarted)
  await restored.start()
  expect(restored.get().chats).toHaveLength(2)
  expect(serialized(restored).chats.map(c => [c.id, c.messages, c.draft, c.submissions])).toEqual(before.map(c => [c.id, c.messages, c.draft, c.submissions]))
  for (const chat of JSON.parse(await readFile(path, 'utf8')).chats) expect(personalChatSchema.safeParse(chat).success).toBe(true)
  await restored.connect()
  for (const chat of before) await restored.refresh(chat.id)
  await restored.settled()
  expect(serialized(restored).chats.map(c => [c.id, c.messages, c.draft])).toEqual(before.map(c => [c.id, c.messages, c.draft]))
  expect(JSON.parse(await readFile(join(fixture.root, 'codex-threads.json'), 'utf8'))).toEqual(JSON.parse(aliases))
  expect((await restarted.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(2)
  expect((await restarted.driver.requests()).filter(r => r.method === 'thread/start')).toHaveLength(2)
})

it.each(['{"chats":[', '', 'null', '{"chats":{}}'])('preserves unreadable original %j across start/create/connect/close without plaintext copies', async contents => {
  const { fixture, service, path } = await setup()
  await stop(service)
  await writeFile(path, contents)
  const restored = makeService(fixture)
  await restored.start()
  expect(await readFile(path, 'utf8')).toBe(contents)
  expect(serialized(restored).error).toMatch(/storage.*read.only|read.only.*storage/i)
  await expect(restored.create()).rejects.toThrow(/storage/i)
  expect((await restored.connect()).error).toMatch(/storage/i)
  await stop(restored)
  expect(await readFile(path, 'utf8')).toBe(contents)
  expect(await readdir(join(fixture.root, 'personal-chat'))).toEqual(['chats.json'])
  expect((await fixture.driver.requests()).length).toBe(0)
})

it('recovers valid chats and identities/drafts around invalid observational fields without rewriting the original', async () => {
  const { fixture, service, path } = await setup()
  for (let index = 0; index < 2; index++) {
    const chat = (await service.create()).chats[0]!
    await service.saveDraft({ chatId: chat.id, revision: 1, text: `Draft ${index}`, skills: [] })
  }
  await stop(service)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  saved.chats[0].activities = [{ id: 'bad', text: 'broken observation' }]
  saved.chats[0].messages = [{ id: 'good', role: 'assistant', text: 'Keep this answer', createdAt: 'now' }, { id: 'bad', role: 'invented', text: 'bad' }]
  saved.chats[0].requests = [{ id: 'bad', text: 'q'.repeat(100001) }]
  saved.chats[0].nativeState = 'starting'
  saved.chats[0].submissions = [{ ...saved.chats[0].draft, id: 'submission', messageId: 'message', createdAt: 'now', status: 'submitting' }]
  saved.chats.push({ id: 'unreadable', draft: 'broken' })
  saved.selectedChatId = 42
  const original = JSON.stringify(saved)
  await writeFile(path, original)
  const restored = makeService(fixture)
  await restored.start()
  const state = serialized(restored)
  expect(state.chats.map(c => [c.id, c.draft])).toEqual(saved.chats.slice(0, 2).map((c: { id: string; draft: unknown }) => [c.id, c.draft]))
  expect(state.chats[0]).toMatchObject({ nativeState: 'uncertain', submissions: [{ status: 'uncertain' }], messages: [{ id: 'good', text: 'Keep this answer' }], historyStatus: 'error' })
  expect(state.error).toMatch(/read.only/i)
  await expect(restored.create()).rejects.toThrow(/storage/i)
  await restored.select(state.chats[1]!.id)
  expect(serialized(restored).selectedChatId).toBe(state.chats[1]!.id)
  await restored.connect(); await stop(restored)
  expect(await readFile(path, 'utf8')).toBe(original)
})

const activity = { id: 'activity', turnId: 'turn', sequence: 0, kind: 'command', status: 'completed', title: 'tool' }
const request = { id: 'permission', kind: 'permission', text: 'Review', options: [] }
it.each([
  { field: 'activities', label: 'output length', bad: [{ ...activity, output: 'x'.repeat(65537) }] },
  { field: 'activities', label: 'nested path length', bad: [{ ...activity, changes: [{ path: 'x'.repeat(65537), kind: 'update' }] }] },
  { field: 'activities', label: 'aggregate count', bad: Array.from({ length: 2001 }, (_, i) => ({ ...activity, id: `a${i}` })) },
  { field: 'requests', label: 'text length', bad: [{ ...request, text: 'x'.repeat(100001) }] },
  { field: 'requests', label: 'option label length', bad: [{ ...request, options: [{ id: 'yes', label: 'x'.repeat(100001) }] }] },
  { field: 'requests', label: 'context length', bad: [{ ...request, context: { details: 'x'.repeat(100001) } }] },
  { field: 'requests', label: 'permission label length', bad: [{ ...request, permissionChoices: [{ id: 'yes', kind: 'allow-once', label: 'x'.repeat(100001) }] }] },
  { field: 'requests', label: 'question count', bad: [{ ...request, kind: 'question', questions: Array.from({ length: 101 }, (_, i) => ({ id: `q${i}`, question: '?', options: [], multiSelect: false, allowFreeText: true })) }] },
  { field: 'messages', label: 'invalid role', bad: [{ id: 'bad', role: 'not-an-assistant', text: 'broken', createdAt: 'now' }] },
  { field: 'messages', label: 'non-array', bad: null },
  { field: 'status', label: 'unknown status', bad: 'unknown-native-status' },
] as const)('rejects invalid live $field ($label) without poisoning unrelated state or authorizing native work', async ({ field, bad }) => {
  const { fixture, service, path } = await setup()
  const chat = (await service.create()).chats[0]!
  await service.create()
  const native: CodexPersonalConversation = { ...chat, messages: [{ id: 'answer', role: 'assistant', text: 'Valid previous answer', createdAt: 'now' }] }
  vi.spyOn(fixture.adapter, 'personalSnapshot').mockReturnValue([native])
  vi.spyOn(fixture.adapter, 'refreshThread').mockImplementation(() => fixture.adapter.snapshot())
  await service.connect(); await service.settled()
  Object.assign(native, { [field]: bad })
  await service.refresh(chat.id); await service.settled()
  const state = serialized(service)
  expect(state.chats).toHaveLength(2)
  expect(state.chats.find(c => c.id === chat.id)).toMatchObject({ historyStatus: 'error', messages: [{ id: 'answer', text: 'Valid previous answer' }] })
  expect(state.chats.find(c => c.id === chat.id)!.historyError).toContain(field)
  for (const saved of JSON.parse(await readFile(path, 'utf8')).chats) expect(personalChatSchema.safeParse(saved).success).toBe(true)
  if (field === 'requests' || field === 'status') {
    await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Do not send through an unreadable permission', skills: [] })
    await expect(service.send({ chatId: chat.id, revision: 1 })).rejects.toThrow(/request/i)
    await expect(service.answer({ chatId: chat.id, requestId: 'permission', answer: '', approved: true })).rejects.toThrow()
    expect((await fixture.driver.requests()).some(r => r.method === 'turn/start')).toBe(false)
  }
  Object.assign(native, { [field]: field === 'messages' ? [{ id: 'answer', role: 'assistant', text: 'Valid previous answer', createdAt: 'now' }] : field === 'status' ? 'idle' : [] })
  await service.refresh(chat.id); await service.settled()
  expect(serialized(service).chats.find(c => c.id === chat.id)!.historyError).toBeUndefined()
})

it('creates normally from a missing file and preserves redaction/uncertain intents across restart', async () => {
  const fixture = await codexFixture(); fixtures.push(fixture)
  const service = makeService(fixture)
  await service.start()
  const chat = (await service.create()).chats[0]!
  await stop(service)
  const path = join(fixture.root, 'personal-chat', 'chats.json')
  const saved = JSON.parse(await readFile(path, 'utf8'))
  Object.assign(saved.chats[0], { nativeState: 'starting', title: 'Private generated title',
    messages: [{ id: 'answer', role: 'assistant', text: 'Private answer', createdAt: 'now' }],
    draft: { revision: 2, text: 'Keep unsent draft', skills: [] },
    submissions: [{ id: 'intent', messageId: 'message', revision: 1, text: 'Private prompt', skills: [], status: 'submitting', createdAt: 'now' }],
    decisions: [{ id: 'decision', requestId: 'request', answer: 'Private decision', createdAt: 'now', status: 'submitting' }] })
  await writeFile(path, JSON.stringify(saved))
  const restored = makeService(fixture, false); await restored.start()
  expect(serialized(restored).chats[0]).toMatchObject({ id: chat.id, nativeState: 'uncertain', draft: { text: 'Keep unsent draft' }, submissions: [{ status: 'uncertain' }] })
  expect(await readFile(path, 'utf8')).not.toContain('Private')
  expect((await fixture.driver.requests()).length).toBe(0)
})

it('retains decision delivery identity despite a malformed cached request, redacts the transcript view and preserves the original', async () => {
  const { fixture, service, path } = await setup()
  const chat = (await service.create()).chats[0]!
  await stop(service)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  saved.chats[0].decisions = [{ id: 'decision', requestId: 'request', answer: 'Private decision', createdAt: 'now', status: 'submitting', request: { ...request, text: 'x'.repeat(100001) } }]
  saved.chats[0].messages = [{ id: 'answer', role: 'assistant', text: 'Private cached answer', createdAt: 'now' }]
  const original = JSON.stringify(saved)
  await writeFile(path, original)
  const restored = makeService(fixture, false); await restored.start()
  expect(serialized(restored).chats[0]).toMatchObject({ id: chat.id, messages: [], decisions: [{ id: 'decision', requestId: 'request', status: 'uncertain' }] })
  expect(serialized(restored).error).toMatch(/read.only/i)
  expect(serialized(restored).error).toContain('has not been redacted')
  await expect(restored.privacyChanged()).rejects.toThrow(/storage/i)
  await stop(restored)
  expect(await readFile(path, 'utf8')).toBe(original)
  expect(await readdir(join(fixture.root, 'personal-chat'))).toEqual(['chats.json'])
})

it('keeps ambiguous duplicate IDs on disk while recovering an unrelated identity', async () => {
  const { fixture, service, path } = await setup()
  await service.create(); await service.create(); await stop(service)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  saved.chats.push({ ...saved.chats[0], draft: { revision: 1, text: 'Conflicting draft', skills: [] } })
  const original = JSON.stringify(saved)
  await writeFile(path, original)
  const restored = makeService(fixture); await restored.start()
  expect(serialized(restored).chats.map(c => c.id)).toEqual([saved.chats[1].id])
  expect(serialized(restored).error).toMatch(/read.only/i)
  await stop(restored)
  expect(await readFile(path, 'utf8')).toBe(original)
})

it('does not delete pre-existing corrupt recovery content during healthy startup', async () => {
  const { fixture, service } = await setup()
  await stop(service)
  const copy = join(fixture.root, 'personal-chat', 'chats.json.corrupt-123-00000000-0000-0000-0000-000000000000')
  await writeFile(copy, 'Original recovery content')
  const restored = makeService(fixture); await restored.start()
  expect(await readFile(copy, 'utf8')).toBe('Original recovery content')
})

it('distinguishes a storage read error from a missing file and never connects or writes through it', async () => {
  const fixture = await codexFixture(); fixtures.push(fixture)
  const path = join(fixture.root, 'personal-chat', 'chats.json')
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'owned-content'), 'Preserve me')
  const service = makeService(fixture); await service.start()
  expect(serialized(service).error).toMatch(/storage.*read.only/i)
  await expect(service.create()).rejects.toThrow(/storage/i)
  await service.connect(); await stop(service)
  expect(await readFile(join(path, 'owned-content'), 'utf8')).toBe('Preserve me')
  expect((await fixture.driver.requests()).length).toBe(0)
})
