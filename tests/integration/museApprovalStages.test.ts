// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { museFixture } from '../fixtures/museFixture'

type Fixture = Awaited<ReturnType<typeof museFixture>>
const thread = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(candidate => candidate.id === id)!
const decisions = async (f: Fixture) => (await f.driver.requests()).filter(record => record.method === 'approval/decide')
const native = async (f: Fixture, id: string) => {
  const saved = JSON.parse(await readFile(join(f.root, 'native-sessions.json'), 'utf8')) as {
    sessions: Record<string, { pendingApprovals: { currentRequirementId: { sourceIndex: number } }[] }>
  }
  return saved.sessions[await f.realId(id)]!
}
const recordedAnswers = async (f: Fixture, id: string) => {
  const saved = JSON.parse(await readFile(join(f.root, 'muse-threads.json'), 'utf8')) as Record<string, { answeredRequestIds: string[] }>
  return saved[id]!.answeredRequestIds
}

async function open() {
  const f = await museFixture()
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Muse thread' })
  await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'first', threadId: id, text: 'Run the commands' })
  return { f, id }
}

it.each(['before', 'after'])('requires another user answer when the next approval stage updates %s its acknowledgement', async updateTiming => {
  const { f, id } = await open()
  try {
    await f.action(id, { type: 'permission', text: 'Build and test', stages: 2, updateTiming })
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const first = (await thread(f, id)).requests[0]!
    await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: first.id, answer: '', approved: true }))
      .resolves.toEqual({ accepted: true })
    await expect.poll(async () => (await thread(f, id)).requests[0]?.text).toContain('stage 2')
    const second = (await thread(f, id)).requests[0]!
    expect(second.id).not.toBe(first.id)
    expect(second.delivery).toBeUndefined()
    expect(await decisions(f)).toHaveLength(1)
    expect(await recordedAnswers(f, id)).toContain(first.id)
    expect(await recordedAnswers(f, id)).not.toContain(second.id)
    await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: first.id, answer: '', approved: true }))
      .rejects.toThrow('no longer pending')
    expect(await decisions(f)).toHaveLength(1)
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: second.id, answer: '', approved: false })
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(0)
    const sent = await decisions(f)
    expect(sent.map(record => record.params?.requirementId)).toEqual([
      expect.objectContaining({ sourceIndex: 0 }), expect.objectContaining({ sourceIndex: 1 }),
    ])
    expect(sent.map(record => record.params?.choiceId)).toEqual(['yes', 'no'])
    expect(sent[0]?.params?.approvalId).toBe(sent[1]?.params?.approvalId)
    expect(sent[0]?.params?.commandId).not.toBe(sent[1]?.params?.commandId)
  } finally { await f.cleanup() }
})

it('restores the next approval stage after restart without inheriting an earlier answer or deciding on disconnect', async () => {
  const opened = await open()
  let f = opened.f
  const { id } = opened
  try {
    await f.action(id, { type: 'permission', text: 'Build and test', stages: 2 })
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const first = (await thread(f, id)).requests[0]!
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: first.id, answer: '', approved: true })
    await expect.poll(async () => (await thread(f, id)).requests[0]?.text).toContain('stage 2')
    const secondId = (await thread(f, id)).requests[0]!.id
    f = await f.driver.restart()
    expect(await decisions(f)).toHaveLength(1)
    await f.host.connect()
    await f.host.refreshThread(id)
    const restored = (await thread(f, id)).requests[0]!
    expect(restored.id).toBe(secondId)
    expect(restored.delivery).toBeUndefined()
    expect(restored.answerRetryReady).toBeUndefined()
    expect(await decisions(f)).toHaveLength(1)
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: restored.id, answer: '', permissionChoice: 'yes' })
    expect((await decisions(f))[1]?.params?.requirementId).toEqual(expect.objectContaining({ sourceIndex: 1 }))
    expect((await thread(f, id)).requests).toEqual([])
  } finally { await f.cleanup() }
})

it('leaves a rejected approval answer immediately answerable and gives the next decision a fresh command ID', async () => {
  const { f, id } = await open()
  try {
    await f.driver.raisePermission(id, 'Run tests')
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const request = (await thread(f, id)).requests[0]!
    await f.script({ rejectApprovalChoice: true })
    await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true })).rejects.toThrow()
    expect((await thread(f, id)).requests[0]?.delivery).toBeUndefined()
    expect(await recordedAnswers(f, id)).not.toContain(request.id)
    await f.script({})
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: false })
    const sent = await decisions(f)
    expect(sent.map(record => record.params?.choiceId)).toEqual(['yes', 'no'])
    expect(sent[0]?.params?.commandId).not.toBe(sent[1]?.params?.commandId)
    expect((await thread(f, id)).requests).toEqual([])
  } finally { await f.cleanup() }
})

it('refreshes a stale requirement without carrying its rejected choice into the current stage', async () => {
  const { f, id } = await open()
  try {
    await f.action(id, { type: 'permission', text: 'Build and test', stages: 2 })
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const first = (await thread(f, id)).requests[0]!
    await f.action(id, { type: 'permission-update', silent: true })
    await expect.poll(async () => (await native(f, id)).pendingApprovals[0]?.currentRequirementId.sourceIndex).toBe(1)
    await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: first.id, answer: '', approved: true }))
      .rejects.toThrow('This request changed')
    const second = (await thread(f, id)).requests[0]!
    expect(second.id).not.toBe(first.id)
    expect(second.text).toContain('stage 2')
    expect(second.delivery).toBeUndefined()
    expect(await decisions(f)).toHaveLength(1)
    expect(await recordedAnswers(f, id)).not.toContain(first.id)
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: second.id, answer: '', approved: false })
    const sent = await decisions(f)
    expect(sent[0]?.params?.commandId).not.toBe(sent[1]?.params?.commandId)
    expect(sent[1]?.params?.requirementId).toEqual(expect.objectContaining({ sourceIndex: 1 }))
    expect((await thread(f, id)).requests).toEqual([])
  } finally { await f.cleanup() }
})

it('keeps a request delivered after an empty pending-list snapshot was captured', async () => {
  const { f, id } = await open()
  try {
    await f.script({ pendingListRace: 'request' })
    await f.action(id, { type: 'gap' })
    await expect.poll(async () => (await thread(f, id)).usage?.contextUsed).toBe(789)
    const requests = (await thread(f, id)).requests
    expect(requests).toHaveLength(1)
    expect(requests[0]?.text).toContain('A new approval after the read')
    expect(await decisions(f)).toHaveLength(0)
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: requests[0]!.id, answer: '', approved: false })
    expect((await thread(f, id)).requests).toEqual([])
  } finally { await f.cleanup() }
})

it('keeps a newer uncertain stage when an older pending-list reply arrives afterward', async () => {
  const { f, id } = await open()
  try {
    await f.action(id, { type: 'permission', text: 'Build and test', stages: 3, updateTiming: 'silent' })
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const first = (await thread(f, id)).requests[0]!
    await f.script({ pendingListRace: 'stage', holdPendingList: true })
    const reading = f.host.refreshThread(id, { retryUncertainAnswers: true })
    void reading.catch(() => undefined)
    await expect.poll(async () => (await thread(f, id)).requests[0]?.text).toContain('stage 2')
    const second = (await thread(f, id)).requests[0]!
    await f.script({ unreadableApprovalAck: true })
    await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: second.id, answer: '', approved: true }))
      .resolves.toEqual({ accepted: false, uncertain: true })
    await f.action(id, { type: 'permission-read-release' })
    await reading
    await expect.poll(async () => (await thread(f, id)).usage?.contextUsed).toBe(789)
    const retained = (await thread(f, id)).requests
    expect(retained).toHaveLength(1)
    expect(retained[0]?.id).toBe(second.id)
    expect(retained[0]?.delivery).toBe('uncertain')
    expect(retained[0]?.answerRetryReady).toBeUndefined()
    expect(retained.some(request => request.id === first.id)).toBe(false)
    expect(await decisions(f)).toHaveLength(1)
    await f.script({})
    await f.host.refreshThread(id, { retryUncertainAnswers: true })
    const third = (await thread(f, id)).requests[0]!
    expect(third.id).not.toBe(second.id)
    expect(third.text).toContain('stage 3')
    expect(third.delivery).toBeUndefined()
    expect(await decisions(f)).toHaveLength(1)
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: third.id, answer: '', approved: false })
    expect((await thread(f, id)).requests).toEqual([])
  } finally { await f.cleanup() }
})

it('does not reintroduce an approval resolved while its pending-list snapshot was in flight', async () => {
  const { f, id } = await open()
  try {
    await f.driver.raisePermission(id, 'Run tests')
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    await f.script({ pendingListRace: 'resolved' })
    await f.action(id, { type: 'gap' })
    await expect.poll(async () => (await thread(f, id)).usage?.contextUsed).toBe(789)
    expect((await thread(f, id)).requests).toEqual([])
    expect(await decisions(f)).toHaveLength(0)
  } finally { await f.cleanup() }
})

it('does not restore a resolved approval from a stale pending-list reply while reopening its session', async () => {
  const opened = await open()
  let f = opened.f
  const { id } = opened
  try {
    await f.driver.raisePermission(id, 'Run tests')
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    f = await f.driver.restart()
    await f.script({ pendingListRace: 'resolved' })
    await f.host.connect()
    await f.host.refreshThread(id)
    await expect.poll(async () => (await thread(f, id)).usage?.contextUsed).toBe(789)
    expect((await thread(f, id)).requests).toEqual([])
    expect(await decisions(f)).toHaveLength(0)
  } finally { await f.cleanup() }
})

it.each(['gap', 'reopen'])('keeps a newer turn started after an idle resume snapshot during %s', async surface => {
  const opened = await open()
  let f = opened.f
  const { id } = opened
  try {
    await f.driver.completeTurn(id, 'Finished before the read')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    if (surface === 'reopen') { f = await f.driver.restart(); await f.host.connect() }
    await f.script({ resumeTurnRace: 'start' })
    if (surface === 'gap') await f.action(id, { type: 'gap' })
    else await f.host.refreshThread(id)
    await expect.poll(async () => (await thread(f, id)).usage?.contextUsed).toBe(654)
    expect((await thread(f, id)).status).toBe('running')
    await expect(f.host.execute({ type: 'steer', commandId: randomUUID(), threadId: id, messageId: 'steering-new-turn', text: 'Check another file' }))
      .resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Finished the newer turn')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
  } finally { await f.cleanup() }
})

it('keeps a turn completed after a running resume snapshot settled', async () => {
  const { f, id } = await open()
  try {
    await f.script({ resumeTurnRace: 'complete' })
    await f.action(id, { type: 'gap' })
    await expect.poll(async () => (await thread(f, id)).usage?.contextUsed).toBe(654)
    expect((await thread(f, id)).status).toBe('idle')
    expect((await thread(f, id)).lastTurn?.status).toBe('completed')
    await expect(f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: 'next-turn', text: 'Continue' }))
      .resolves.toEqual({ accepted: true })
  } finally { await f.cleanup() }
})
