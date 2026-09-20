// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { codexFixture } from '../fixtures/codexFixture'
import { RequestDraftService, personalRequestDraftState, requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import { requestDraftQuestions } from '../../src/shared/requestDrafts'
import type { AgentRequest } from '../../src/shared/agents'
import { PersonalChatService } from '../../src/main/agents/personalChats'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { personalChatStateSchema, type PersonalChat } from '../../src/shared/personalChats'

type Fixture = Awaited<ReturnType<typeof codexFixture>>
const fixtures: Fixture[] = []
const services: PersonalChatService[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const service of services.splice(0)) await service.close()
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})
const configuration = { reasoning: 'codex', reasoningModel: 'fixture-model', reasoningEffort: 'high' }
function makeService(fixture: Fixture, historyEnabled = () => false, config = configuration) {
  const service = new PersonalChatService({ userDataPath: fixture.root, host: fixture.adapter, configuration: () => config, historyEnabled })
  services.push(service)
  return service
}
async function stop(service: PersonalChatService) {
  await service.close()
  services.splice(services.indexOf(service), 1)
}
async function setup(historyEnabled = () => false) {
  const fixture = await codexFixture(); fixtures.push(fixture)
  const service = makeService(fixture, historyEnabled)
  await service.start(); await service.connect()
  const chat = (await service.create()).chats[0]!
  await fixture.script({ reply: 'PRIVATE native response' })
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'PRIVATE prompt', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  return { fixture, service, chat, path: join(fixture.root, 'personal-chat', 'chats.json') }
}
async function diskChat(path: string): Promise<PersonalChat> {
  const contents = await readFile(path, 'utf8')
  expect(contents).not.toContain('PRIVATE')
  return personalChatStateSchema.shape.chats.parse(JSON.parse(contents).chats)[0]!
}

it.each(['question', 'permission'] as const)('saves a redacted %s reservation before the native write and keeps the accepted identity after events/restart', async kind => {
  const { fixture, service, chat, path } = await setup()
  if (kind === 'question') await fixture.action(chat.id, { type: 'question', text: 'PRIVATE question', params: {
    questions: [{ id: 'choice', question: 'PRIVATE question', isOther: true, options: [{ label: 'PRIVATE option', description: 'PRIVATE option detail' }] }],
  } })
  else await fixture.driver.raisePermission(chat.id, 'PRIVATE command')
  await expect.poll(() => service.get().chats[0]!.requests.length).toBe(1)
  const request = service.get().chats[0]!.requests[0]!
  const digest = request.questions?.length ? { questionsDigest: requestQuestionsDigest(request.questions) } : {}
  const answer = kind === 'question'
    ? { answer: '', questionAnswers: { [request.questions![0]!.id]: { optionIds: [], text: 'PRIVATE structured answer' } } }
    : { answer: '', approved: false, permissionChoice: 'decline' }
  const execute = fixture.adapter.execute.bind(fixture.adapter)
  const spy = vi.spyOn(fixture.adapter, 'execute').mockImplementation(async command => {
    if (command.type === 'answer') {
      const disk = await diskChat(path)
      expect(disk.decisions).toEqual([{ id: command.commandId, requestId: request.id, ...digest, answer: '', status: 'submitting', createdAt: expect.any(String) }])
      expect(command).toEqual({ ...answer, type: 'answer', threadId: chat.id, requestId: request.id, commandId: command.commandId })
    }
    return execute(command)
  })
  await service.answer({ chatId: chat.id, requestId: request.id, ...answer })
  await expect(service.answer({ chatId: chat.id, requestId: request.id, ...answer })).rejects.toThrow(/no longer pending/)
  await fixture.driver.completeTurn(chat.id, 'PRIVATE later native event')
  await expect.poll(async () => {
    await service.refresh(chat.id)
    return service.get().chats[0]!.messages.some(m => m.text === 'PRIVATE later native event')
  }).toBe(true)
  await service.settled()
  const disk = await diskChat(path)
  expect(disk.decisions).toEqual([{ id: expect.any(String), requestId: request.id, ...digest, answer: '', status: 'accepted', createdAt: expect.any(String) }])
  expect(service.get().chats[0]!.decisions![0]).toMatchObject({ ...answer, request })
  spy.mockRestore()
  await stop(service)
  const restarted = await codexFixture(fixture.root); fixtures.push(restarted)
  const restored = makeService(restarted)
  await restored.start(); await restored.connect(); await restored.refresh(chat.id); await restored.settled()
  expect(restored.get().chats[0]!.decisions).toEqual(disk.decisions)
  await diskChat(path)
  const replies = (await restarted.driver.requests()).filter(r => kind === 'question' ? r.result?.answers : r.result?.decision)
  expect(replies).toHaveLength(1)
  expect(replies[0]!.result).toEqual(kind === 'question' ? { answers: { choice: { answers: ['PRIVATE structured answer'] } } } : { decision: 'decline' })
})

it.each(['uncertain', 'submitting checkpoint'] as const)('retains %s through disk/process restart and holds a rehydrated request without replay or changed provider authority', async recovery => {
  const { fixture, service, chat, path } = await setup()
  await fixture.driver.raiseQuestion(chat.id, 'PRIVATE uncertain question')
  await expect.poll(() => service.get().chats[0]!.requests.length).toBe(1)
  const request = service.get().chats[0]!.requests[0]!
  const digest = request.questions?.length ? { questionsDigest: requestQuestionsDigest(request.questions) } : {}
  const execute = fixture.adapter.execute.bind(fixture.adapter)
  let checkpoint = ''
  const spy = vi.spyOn(fixture.adapter, 'execute').mockImplementation(async command => {
    if (command.type === 'answer') checkpoint = await readFile(path, 'utf8')
    const result = await execute(command)
    return command.type === 'answer' ? { ...result, accepted: false, uncertain: true } : result
  })
  await service.answer({ chatId: chat.id, requestId: request.id, answer: 'PRIVATE uncertain answer' })
  const before = service.get().chats[0]!.decisions![0]!
  expect(before.status).toBe('uncertain')
  spy.mockRestore()
  await stop(service)
  // Restore the actual atomic file captured at the pre-pipe boundary, as if
  // the app exited before its acknowledgement/status commit. No invented row.
  if (recovery === 'submitting checkpoint') {
    expect(JSON.parse(checkpoint).chats[0].decisions[0].status).toBe('submitting')
    await writeFile(path, checkpoint)
  }
  const restarted = await codexFixture(fixture.root); fixtures.push(restarted)
  const restored = makeService(restarted, () => false, { reasoning: 'claude', reasoningModel: 'changed-default', reasoningEffort: 'low' })
  await restored.start()
  expect(restored.get().chats[0]).toMatchObject({ providerId: 'codex', modelId: chat.modelId, reasoningEffort: chat.reasoningEffort })
  await restored.connect(); await restored.refresh(chat.id)
  // Rehydrate the original pending identity at the native snapshot boundary:
  // a stale observation cannot establish whether the prior pipe write arrived.
  const native = restarted.adapter.personalSnapshot().find(c => c.id === chat.id)!
  const snapshot = vi.spyOn(restarted.adapter, 'personalSnapshot').mockReturnValue([{ ...native, requests: [request] }])
  await restored.refresh(chat.id); await restored.settled()
  const dispatch = vi.spyOn(restarted.adapter, 'execute')
  await expect(restored.answer({ chatId: chat.id, requestId: request.id, answer: 'PRIVATE duplicate' })).rejects.toThrow(/uncertain/)
  await expect(restored.answer({ chatId: chat.id, requestId: 'unowned-request', answer: 'PRIVATE wrong request' })).rejects.toThrow(/no longer pending/)
  expect(dispatch).not.toHaveBeenCalled()
  expect(personalChatStateSchema.parse(restored.get()).chats[0]!.decisions).toEqual([{ id: before.id, requestId: request.id, ...digest, status: 'uncertain', createdAt: before.createdAt, answer: '' }])
  expect((await diskChat(path)).decisions).toEqual(restored.get().chats[0]!.decisions)
  expect((await restarted.driver.requests()).filter(r => r.result?.answers)).toHaveLength(1)
  expect((await restarted.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect((await restarted.driver.requests()).filter(r => r.method === 'thread/start')).toHaveLength(1)
  snapshot.mockRestore()
})

it('does not write an answer to the native pipe when its history-disabled reservation cannot be saved', async () => {
  const { fixture, service, chat, path } = await setup()
  await fixture.driver.raiseQuestion(chat.id, 'PRIVATE question')
  await expect.poll(() => service.get().chats[0]!.requests.length).toBe(1)
  await service.settled()
  const request = service.get().chats[0]!.requests[0]!
  const dispatch = vi.spyOn(fixture.adapter, 'execute')
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('reservation disk unavailable'))
  await expect(service.answer({ chatId: chat.id, requestId: request.id, answer: 'Blue' })).rejects.toThrow('reservation disk unavailable')
  write.mockRestore()
  expect(dispatch).not.toHaveBeenCalled()
  expect((await diskChat(path)).decisions ?? []).toEqual([])
  expect(service.get().chats[0]!.decisions ?? []).toEqual([])
  await service.answer({ chatId: chat.id, requestId: request.id, answer: 'Blue' })
  await expect.poll(async () => (await fixture.driver.requests()).filter(r => r.result?.answers).length).toBe(1)
})

it('redacts existing decision content and diagnostics for every delivery status while retaining restart recovery metadata', async () => {
  let historyEnabled = true
  const { service, fixture, chat, path } = await setup(() => historyEnabled)
  await stop(service)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  saved.chats[0].decisions = ['submitting', 'uncertain', 'accepted', 'failed'].map((status, index) => ({
    id: `decision-${index}`, requestId: `request-${index}`, status, createdAt: '2026-09-13T00:00:00Z',
    answer: 'PRIVATE answer', approved: true, permissionChoice: 'PRIVATE choice',
    questionAnswers: { question: { optionIds: ['PRIVATE option'], text: 'PRIVATE free text' } },
    request: { id: `request-${index}`, kind: 'permission', text: 'PRIVATE request', options: [], context: { command: 'PRIVATE command' } },
    error: 'PRIVATE diagnostic echo',
  }))
  await writeFile(path, JSON.stringify(saved))
  const restored = makeService(fixture, () => historyEnabled)
  await restored.start()
  historyEnabled = false; await restored.privacyChanged()
  await restored.saveDraft({ chatId: chat.id, revision: 2, text: 'Preserve unsent draft', skills: [] })
  const disk = await diskChat(path)
  expect(disk.decisions).toEqual(saved.chats[0].decisions.map((d: { id: string; requestId: string; status: string; createdAt: string }) => ({
    id: d.id, requestId: d.requestId, status: d.status === 'submitting' ? 'uncertain' : d.status, createdAt: d.createdAt, answer: '', error: 'Answer could not be confirmed. Local history is off.',
  })))
  await stop(restored)
  const restarted = makeService(fixture, () => false); await restarted.start()
  expect(restarted.get().chats[0]!.decisions).toEqual(disk.decisions)
  expect(restarted.get().chats[0]!.draft.text).toBe('Preserve unsent draft')
})

it.each([false, true])('recovers original structured content after actual Codex shutdown with native requests absent (held %s)', async held => {
  const { fixture, service, chat } = await setup()
  await fixture.action(chat.id, { type: 'question', text: 'PRIVATE context', params: {
    questions: [{ id: 'choice', question: 'PRIVATE destination?', isOther: true, options: [{ label: 'PRIVATE coast', description: 'PRIVATE detail' }] }],
  } })
  await expect.poll(() => service.get().chats[0]!.requests.length).toBe(1)
  const request = service.get().chats[0]!.requests[0]!
  const owner = { kind: 'personal' as const, ownerId: chat.id, providerId: 'codex' as const }
  const target = { ...owner, requestId: request.id, questions: request.questions! }
  const drafts = new RequestDraftService(fixture.root, owner => personalRequestDraftState(service.get(), owner), async () => { await service.refresh(chat.id) })
  await drafts.start()
  const retained = { target, revision: 1, held, selections: { choice: { optionIds: [request.questions![0]!.options[0]!.id], other: false, text: 'PRIVATE local notes' } } }
  await drafts.save(retained)
  await stop(service)
  // Exercise the real adapter shutdown/reset; do not re-emit native questions.
  expect(fixture.adapter.personalSnapshot().flatMap(c => c.requests)).toEqual([])
  const nextFixture = await codexFixture(fixture.root); fixtures.push(nextFixture)
  const restored = makeService(nextFixture)
  await restored.start()
  const recovered = new RequestDraftService(fixture.root, owner => personalRequestDraftState(restored.get(), owner), async () => { await restored.refresh(chat.id) })
  await recovered.start(); await recovered.reconcile()
  expect(await recovered.list(owner)).toEqual([retained])
  const dispatch = vi.spyOn(nextFixture.adapter, 'execute')
  await restored.connect(); await restored.refresh(chat.id); await restored.settled(); await recovered.reconcile()
  expect(restored.get().chats[0]!.requests).toEqual([])
  expect(await recovered.list(owner)).toEqual([retained])
  expect(await recovered.list({ ...owner, ownerId: 'not-this-chat' })).toEqual([])
  expect(await recovered.list({ ...owner, providerId: 'claude' })).toEqual([])
  await expect(recovered.check(target)).rejects.toThrow('still unconfirmed')
  expect(dispatch).not.toHaveBeenCalled()
  const records = await nextFixture.driver.requests()
  expect(JSON.stringify(records.filter(r => r.result?.answers))).not.toContain('PRIVATE local notes')
  expect(JSON.parse(await readFile(join(fixture.root, 'request-drafts.json'), 'utf8')).drafts).toEqual([retained])
})

it.each(['different', 'same'] as const)('keeps the newer %s-definition hold through old accepted/new submitting receipts and a request-free restart', async definition => {
  const fixture = await codexFixture(); fixtures.push(fixture)
  const service = new PersonalChatService({ userDataPath: fixture.root, host: fixture.adapter, configuration: () => configuration, historyEnabled: () => false,
    bindRequestDraftDecision: (target, id, answers) => drafts!.bindDecision(target, id, answers) })
  services.push(service)
  await service.start(); await service.connect()
  const chat = (await service.create()).chats[0]!
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'PRIVATE prompt', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  await fixture.action(chat.id, { type: 'question', text: 'PRIVATE context', params: {
    questions: [{ id: 'notes', question: 'PRIVATE original question', isOther: true, options: [] }],
  } })
  await expect.poll(() => service.get().chats[0]!.requests.length).toBe(1)
  const original = service.get().chats[0]!.requests[0]!
  const owner = { kind: 'personal' as const, ownerId: chat.id, providerId: 'codex' as const }
  const drafts: RequestDraftService = new RequestDraftService(fixture.root, owner => personalRequestDraftState(service.get(), owner), async () => { await service.refresh(chat.id) })
  await drafts.start()
  const target = { ...owner, requestId: original.id, questions: original.questions! }
  const makeDraft = (text: string) => ({ target, revision: 1, held: true, selections: { notes: { optionIds: [], other: false, text } } })
  await drafts.save(makeDraft('PRIVATE first answer'))
  await service.answer({ chatId: chat.id, requestId: original.id, answer: '', questionAnswers: { notes: { optionIds: [], text: 'PRIVATE first answer' } } })
  await service.settled(); await drafts.reconcile()
  expect(await drafts.list(owner)).toEqual([])
  const oldId = service.get().chats[0]!.decisions![0]!.id
  // Provider request-ID reuse at the native observation seam; the old decision remains real.
  const native = fixture.adapter.personalSnapshot().find(c => c.id === chat.id)!
  if (definition === 'different') target.questions = [{ ...target.questions[0]!, question: 'PRIVATE redefined question' }]
  const snapshot = vi.spyOn(fixture.adapter, 'personalSnapshot').mockReturnValue([{ ...native, requests: [{ ...original, questions: target.questions }] }])
  await service.refresh(chat.id); await service.settled()
  await drafts.save(makeDraft('PRIVATE newer answer'))
  const path = join(fixture.root, 'personal-chat', 'chats.json')
  const execute = vi.spyOn(fixture.adapter, 'execute').mockImplementation(async command => {
    expect(command.type).toBe('answer')
    await drafts!.reconcile()
    const held = await drafts!.list(owner)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ held: true, decisionId: command.commandId, selections: { notes: { text: 'PRIVATE newer answer' } } })
    expect(command.commandId).not.toBe(oldId)
    const disk = await diskChat(path)
    expect(disk.decisions!.map(d => d.status)).toEqual(['accepted', 'submitting'])
    expect(disk.decisions![1]!.questionsDigest).toBe(requestQuestionsDigest(target.questions))
    return { accepted: false, uncertain: true }
  })
  await service.answer({ chatId: chat.id, requestId: original.id, answer: '', questionAnswers: { notes: { optionIds: [], text: 'PRIVATE newer answer' } } })
  expect(execute).toHaveBeenCalledTimes(1)
  snapshot.mockRestore(); execute.mockRestore()
  await stop(service)
  const nextFixture = await codexFixture(fixture.root); fixtures.push(nextFixture)
  const restored = makeService(nextFixture)
  await restored.start(); await restored.connect(); await restored.refresh(chat.id); await restored.settled()
  const recovered = new RequestDraftService(fixture.root, owner => personalRequestDraftState(restored.get(), owner), async () => { await restored.refresh(chat.id) })
  await recovered.start(); await recovered.reconcile()
  expect(restored.get().chats[0]!.requests).toEqual([])
  expect((await recovered.list(owner))[0]).toMatchObject({ held: true, selections: { notes: { text: 'PRIVATE newer answer' } } })
  expect((await nextFixture.driver.requests()).filter(r => r.result?.answers)).toHaveLength(1)
  expect((await diskChat(path)).decisions!.map(d => d.status)).toEqual(['accepted', 'uncertain'])
})


it.each([true, false])('binds a personal legacy choice before native delivery and retains only uncertain drafts (accepted %s)', async accepted => {
  const fixture = await codexFixture(); fixtures.push(fixture)
  const service: PersonalChatService = new PersonalChatService({ userDataPath: fixture.root, host: fixture.adapter, configuration: () => configuration, historyEnabled: () => false,
    bindRequestDraftDecision: (target, id, answers) => drafts.bindDecision(target, id, answers) })
  services.push(service)
  await service.start(); await service.connect()
  const chat = (await service.create()).chats[0]!
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'PRIVATE prompt', skills: [] })
  await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
  const request: AgentRequest = { id: 'legacy-choice', kind: 'question', text: 'PRIVATE question', options: [{ id: 'PRIVATE option', label: 'PRIVATE label' }] }
  const native = fixture.adapter.personalSnapshot().find(item => item.id === chat.id)!
  const snapshot = vi.spyOn(fixture.adapter, 'personalSnapshot').mockReturnValue([{ ...native, requests: [request] }])
  await service.refresh(chat.id); await service.settled()
  const owner = { kind: 'personal' as const, ownerId: chat.id, providerId: 'codex' as const }
  const target = { ...owner, requestId: request.id, questions: requestDraftQuestions(request) }
  const drafts: RequestDraftService = new RequestDraftService(fixture.root, input => personalRequestDraftState(service.get(), input), async () => { await service.refresh(chat.id) })
  await drafts.start()
  await drafts.save({ target, revision: 1, held: true, selections: { [request.id]: { optionIds: ['PRIVATE option'], other: false, text: '' } } })
  const execute = vi.spyOn(fixture.adapter, 'execute').mockImplementation(async command => {
    expect(command).toEqual({ type: 'answer', commandId: expect.any(String), threadId: chat.id, requestId: request.id, answer: 'PRIVATE option' })
    expect((await drafts.get(target))?.decisionId).toBe(command.commandId)
    return { accepted, uncertain: !accepted }
  })
  await service.answer({ chatId: chat.id, requestId: request.id, answer: 'PRIVATE option' })
  await drafts.reconcile()
  expect(execute).toHaveBeenCalledOnce()
  expect(await drafts.list(owner)).toHaveLength(accepted ? 0 : 1)
  const path = join(fixture.root, 'personal-chat', 'chats.json')
  expect((await diskChat(path)).decisions![0]).toMatchObject({ answer: '', questionsDigest: requestQuestionsDigest(target.questions), status: accepted ? 'accepted' : 'uncertain' })
  execute.mockRestore(); snapshot.mockRestore()
  await stop(service)
  const restored = makeService(fixture)
  await restored.start()
  const recovered = new RequestDraftService(fixture.root, input => personalRequestDraftState(restored.get(), input), async () => {})
  await recovered.start(); await recovered.reconcile()
  expect(await recovered.list(owner)).toHaveLength(accepted ? 0 : 1)
})
