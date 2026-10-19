// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { describeAdapterContract } from './adapterContract'
import { museFixture, museFixtureSkips } from '../fixtures/museFixture'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

describeAdapterContract('Muse MSP', session => museFixture(undefined, undefined, session), museFixtureSkips)

it('starts every host without the sandbox only when the setting says so, captured at connect', async () => {
  let off = false
  const f = await museFixture(undefined, undefined, {}, { disableSandbox: () => off })
  const argv = f.hostArguments
  // A thread's own host keeps a session log; the connect and update probes do not.
  const threadHosts = async () => (await argv()).filter(args => !args.includes('--no-session-log'))
  const sendTo = async (title: string) => {
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title })
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'Synthetic prompt' })
  }
  try {
    expect((await f.host.connect()).sandboxDisabled).toBe(false)
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await sendTo('Before the switch')
    // Turning the switch off changes nothing until Muse connects again: a thread started now gets the sandbox too.
    off = true
    await sendTo('After the switch, before reconnecting')
    expect(await threadHosts()).toHaveLength(2)
    expect((await argv()).every(args => !args.includes('--disable-sandbox'))).toBe(true)
    expect((await f.host.snapshot()).sandboxDisabled).toBe(false)
    expect((await f.host.connect()).sandboxDisabled).toBe(true)
    const probe = (await argv()).at(-1)!
    expect(probe).toEqual(expect.arrayContaining(['--disable-sandbox', '--no-session-log']))
    await sendTo('After reconnecting')
    expect((await threadHosts()).at(-1)).toContain('--disable-sandbox')
    f.host.disconnect()
    expect((await f.host.snapshot()).sandboxDisabled).toBeUndefined()
  } finally { await f.cleanup() }
})

const museModel = (modelId: string, isDefault: boolean) => ({ modelId, providerId: 'meta', displayLabel: modelId, isDefault, cost: null, contextWindow: null, profileId: null })
const twoModels = [museModel('fixture-base', true), museModel('fixture-full', false)]
type MuseFixture = Awaited<ReturnType<typeof museFixture>>
const setModelTo = (record: RecordedRpc) => record.method === 'session/setModel' ? (record.params as { model: { modelId: string } }).model.modelId : undefined
/** The model each turn of the thread's session ran on, as the fake Muse recorded it. */
const turnModels = async (f: MuseFixture, id: string): Promise<string[]> => {
  const saved = JSON.parse(await readFile(join(f.root, 'native-sessions.json'), 'utf8')) as { sessions: Record<string, { turnModels?: string[] }> }
  return saved.sessions[await f.realId(id)]?.turnModels ?? []
}
const twoModelThread = async (f: MuseFixture, modelId: string, script: Record<string, unknown> = {}) => {
  await f.script({ models: twoModels, ...script })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId, title: 'Muse thread' })
  return id
}

it('keeps a thread on its own model when Muse describes it reopened by its default, and holds no send back for it', async () => {
  // Muse 1.4.10 runs a session on the model it started on or was last set to, but describes a resumed session by its
  // catalog's default model. The fixture does the same.
  const f = await museFixture()
  try {
    const id = await twoModelThread(f, 'fixture-full', { reopenedAsDefault: true })
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'Before reconnecting' })
    await f.action(id, { type: 'complete', text: 'First reply' })
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    // Reconnecting reopens the session, which Muse now describes as on its default.
    await f.host.connect()
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'After reconnecting' })).resolves.toEqual({ accepted: true })
    await f.action(id, { type: 'complete', text: 'Second reply' })
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await thread(f, id)).modelId).toBe('fixture-full')
    // Sotto set the thread's model again after reopening it, before the turn, rather than taking the description's word.
    const log = await f.driver.requests()
    const reopened = log.findLastIndex(record => record.method === 'session/resume')
    const set = log.findLastIndex(record => setModelTo(record) === 'fixture-full')
    expect(reopened).toBeGreaterThanOrEqual(0)
    expect(set).toBeGreaterThan(reopened)
    expect(set).toBeLessThan(log.findLastIndex(record => record.method === 'turn/start'))
    expect(await turnModels(f, id)).toEqual(['fixture-full', 'fixture-full'])
  } finally { await f.cleanup() }
})

it('keeps a thread on its last model when Muse refuses a model change, and never asks for the refused one again', async () => {
  const f = await museFixture()
  try {
    const id = await twoModelThread(f, 'fixture-base')
    await f.script({ models: twoModels, rejectSetModel: ['fixture-full'] })
    const refusal = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-full' })
      .then(() => undefined, (error: unknown) => error)
    expect((await thread(f, id)).modelId).toBe('fixture-base')
    expect((await thread(f, id)).status).toBe('idle')
    const asked = (await f.driver.requests()).filter(record => setModelTo(record)).length
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'After the refusal' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'On the same model')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    // The send did not ask for the refused model again, ran on the one Muse had, and nothing saved the refused one.
    expect((await f.driver.requests()).filter(record => setModelTo(record))).toHaveLength(asked)
    expect(await turnModels(f, id)).toEqual(['fixture-base'])
    expect((await thread(f, id)).modelId).toBe('fixture-base')
    const saved = JSON.parse(await readFile(join(f.root, 'muse-threads.json'), 'utf8')) as Record<string, { modelId: string, settingsConfirmed: boolean }>
    expect(saved[id]).toMatchObject({ modelId: 'fixture-base', settingsConfirmed: true })
    expect(String(refusal)).toContain('Muse rejected fixture-full. This thread stays on fixture-base.')
  } finally { await f.cleanup() }
})

it('keeps a model change Muse may have taken wanted, and asks for it again before the next turn', async () => {
  const f = await museFixture(undefined, 500)
  try {
    const id = await twoModelThread(f, 'fixture-base')
    await f.script({ models: twoModels, holdSetModel: true })
    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-full' }))
      .resolves.toEqual({ accepted: false, uncertain: true })
    // The chip shows the model Muse last accepted until Muse answers.
    expect((await thread(f, id)).modelId).toBe('fixture-base')
    // The wanted model was saved before Muse was asked, so a reconnect still asks for it.
    const saved = JSON.parse(await readFile(join(f.root, 'muse-threads.json'), 'utf8')) as Record<string, { modelId: string, nativeModelId: string }>
    expect(saved[id]).toMatchObject({ modelId: 'fixture-full', nativeModelId: 'fixture-base' })
    await f.script({ models: twoModels })
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'After the lost answer' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'On the new model')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await thread(f, id)).modelId).toBe('fixture-full')
    expect(await turnModels(f, id)).toEqual(['fixture-full'])
  } finally { await f.cleanup() }
})

it('takes a model Muse moved the thread to as the thread’s own, so the next send does not set the old one back', async () => {
  const f = await museFixture()
  try {
    const id = await twoModelThread(f, 'fixture-full')
    await f.action(id, { type: 'model-changed', modelId: 'fixture-base' })
    await expect.poll(async () => (await thread(f, id)).modelId).toBe('fixture-base')
    expect((await thread(f, id)).status).toBe('idle')
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'On the model Muse moved to' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Done on the base model')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await f.driver.requests()).filter(record => setModelTo(record))).toHaveLength(0)
    expect(await turnModels(f, id)).toEqual(['fixture-base'])
    expect((await thread(f, id)).modelId).toBe('fixture-base')
    const saved = JSON.parse(await readFile(join(f.root, 'muse-threads.json'), 'utf8')) as Record<string, { modelId: string, nativeModelId: string }>
    expect(saved[id]).toMatchObject({ modelId: 'fixture-base', nativeModelId: 'fixture-base' })
  } finally { await f.cleanup() }
})

it('lets the newest model Muse names win when it moves the thread while answering a model change', async () => {
  const f = await museFixture()
  try {
    const id = await twoModelThread(f, 'fixture-base')
    // Muse takes the change to fixture-full, then moves the session back to fixture-base before it answers.
    await f.script({ models: twoModels, moveAfterSetModel: 'fixture-base' })
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-full' })
    expect((await thread(f, id)).modelId).toBe('fixture-base')
    expect((await thread(f, id)).status).toBe('idle')
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'On the newest model' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Done on the base model')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    // The one model change was all Sotto asked for: nothing set fixture-full again.
    expect((await f.driver.requests()).filter(record => setModelTo(record))).toHaveLength(1)
    expect(await turnModels(f, id)).toEqual(['fixture-base'])
  } finally { await f.cleanup() }
})

it('keeps the model Muse moved to while a permission-only change was answered, and sets no model', async () => {
  const f = await museFixture()
  try {
    const id = await twoModelThread(f, 'fixture-full')
    await f.script({ models: twoModels, moveDuringApprovalMode: 'fixture-base' })
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'auto' })
    expect((await f.driver.requests()).filter(record => setModelTo(record))).toHaveLength(0)
    expect((await thread(f, id)).modelId).toBe('fixture-base')
    expect((await thread(f, id)).runtimeMode).toBe('auto')
  } finally { await f.cleanup() }
})

it('keeps the model Muse announced while a reopen was answered when it refuses to set the thread’s own again', async () => {
  const f = await museFixture()
  try {
    const id = await twoModelThread(f, 'fixture-base', { reopenedAsDefault: true })
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-full' })
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'Before reconnecting' })
    await f.driver.completeTurn(id, 'First reply')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    // Muse says the session runs fixture-full while it answers the resume, whose description still names the default.
    await f.script({ models: twoModels, reopenedAsDefault: true, rejectSetModel: true, moveDuringResume: 'fixture-full' })
    await f.host.connect()
    await f.host.refreshThread!(id)
    expect((await thread(f, id)).modelId).toBe('fixture-full')
  } finally { await f.cleanup() }
})

it('keeps a newer model choice when Muse accepts a resync\u2019s older re-apply late, without saying so', async () => {
  const f = await museFixture()
  try {
    const id = await twoModelThread(f, 'fixture-full', { reopenedAsDefault: true })
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'Before the gap' })
    await f.driver.completeTurn(id, 'First reply')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    // A gap makes the thread read again; Muse describes it by its default, so Sotto sets fixture-full again, and Muse
    // holds that answer while the user picks fixture-base.
    await f.script({ models: twoModels, reopenedAsDefault: true, silentSetModel: true, delaySetModel: { modelId: 'fixture-full', ms: 1_500 } })
    await f.action(id, { type: 'gap' })
    await expect.poll(async () => (await f.driver.requests()).some(record => setModelTo(record) === 'fixture-full')).toBe(true)
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-base' })
    // Muse answers the older re-apply after the user's choice; the thread still wants fixture-base.
    await new Promise(resolve => setTimeout(resolve, 2_000))
    const saved = JSON.parse(await readFile(join(f.root, 'muse-threads.json'), 'utf8')) as Record<string, { modelId: string }>
    expect(saved[id]?.modelId).toBe('fixture-base')
    await f.script({ models: twoModels, reopenedAsDefault: true })
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'After the late answer' })
    await f.driver.completeTurn(id, 'On the chosen model')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await turnModels(f, id)).at(-1)).toBe('fixture-base')
  } finally { await f.cleanup() }
})

it('takes the model Muse has when it refuses a wanted model at a send, and asks for it no more', async () => {
  const f = await museFixture(undefined, 500)
  try {
    const id = await twoModelThread(f, 'fixture-base')
    // A change whose answer is lost stays wanted, as one a failed save or an exit left wanted does.
    await f.script({ models: twoModels, holdSetModel: true })
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'fixture-full' })
    await f.script({ models: twoModels, rejectSetModel: ['fixture-full'] })
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'Muse refuses the wanted model' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'On the model Muse has')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    const asked = (await f.driver.requests()).filter(record => setModelTo(record) === 'fixture-full').length
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'And again' })
    await f.driver.completeTurn(id, 'Still on it')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await f.driver.requests()).filter(record => setModelTo(record) === 'fixture-full')).toHaveLength(asked)
    expect((await thread(f, id)).modelId).toBe('fixture-base')
    const saved = JSON.parse(await readFile(join(f.root, 'muse-threads.json'), 'utf8')) as Record<string, { modelId: string }>
    expect(saved[id]?.modelId).toBe('fixture-base')
  } finally { await f.cleanup() }
})

it('sets no model on a reopened thread whose turn started while the resume was answered', async () => {
  const f = await museFixture()
  try {
    const id = await twoModelThread(f, 'fixture-full', { reopenedAsDefault: true })
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'Before reconnecting' })
    await f.driver.completeTurn(id, 'First reply')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    await f.script({ models: twoModels, reopenedAsDefault: true, resumeTurnRace: 'start' })
    await f.host.connect()
    await f.host.refreshThread!(id)
    await expect.poll(async () => (await thread(f, id)).status).toBe('running')
    expect((await f.driver.requests()).filter(record => setModelTo(record))).toHaveLength(0)
  } finally { await f.cleanup() }
})

it('sends and steers a reopened thread whose model Muse refuses to set again, showing the model Muse describes', async () => {
  // Muse 1.4.10 describes a reopened session by its catalog's default. Here it also refuses to set the thread's own
  // model, so what it described is the best word on the model it runs.
  const f = await museFixture()
  try {
    const id = await twoModelThread(f, 'fixture-full', { reopenedAsDefault: true })
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'Before reconnecting' })
    await f.driver.completeTurn(id, 'First reply')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await f.driver.requests()).filter(record => setModelTo(record))).toHaveLength(0)
    await f.script({ models: twoModels, reopenedAsDefault: true, rejectSetModel: true })
    await f.host.connect()
    await f.host.refreshThread!(id)
    expect((await thread(f, id)).modelId).toBe('fixture-base')
    expect((await thread(f, id)).status).toBe('idle')
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'After reconnecting' })).resolves.toEqual({ accepted: true })
    await expect(f.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'And this too' })).resolves.toEqual({ accepted: true })
    // Sotto asked for the thread's own model after reopening it and again before the turn; Muse refused both, and the
    // turn went ahead.
    const log = await f.driver.requests()
    const sets = log.flatMap((record, at) => setModelTo(record) === 'fixture-full' ? [at] : [])
    expect(sets.length).toBeGreaterThanOrEqual(2)
    expect(sets[0]).toBeGreaterThan(log.findIndex(record => record.method === 'session/resume'))
    expect(sets.at(-1)).toBeLessThan(log.findLastIndex(record => record.method === 'turn/start'))
    await f.driver.completeTurn(id, 'Done on the base model')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    // The turn ran. Which model it ran on is Muse's to say; the chip shows the one Muse described, the best word there is.
    expect(await turnModels(f, id)).toHaveLength(2)
    expect((await thread(f, id)).modelId).toBe('fixture-base')
  } finally { await f.cleanup() }
})

it('runs a queued follow-up on a reopened thread whose model Muse refuses to set again', async () => {
  const f = await museFixture()
  const stack = await agentControlFixture({ host: f.host, credentialOptions: { mode: 'unavailable' }, reasoner: {} })
  const { control } = stack
  const ownThread = () => control.get().host.threads.find(candidate => candidate.id === id)
  let id = ''
  try {
    id = await twoModelThread(f, 'fixture-full', { reopenedAsDefault: true })
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text: 'Before reconnecting' })
    await f.driver.completeTurn(id, 'First reply')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    await f.script({ models: twoModels, reopenedAsDefault: true, rejectSetModel: true })
    await control.start(); await control.command({ type: 'connect' })
    expect((await control.command({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'After reconnecting' })).error).toBeNull()
    await expect.poll(() => ownThread()?.lastTurn?.status).toBe('running')
    const queued = { type: 'queue-followup' as const, threadId: id, draftId: randomUUID(), text: 'The queued follow-up' }
    expect((await control.command(queued)).error).toBeNull()
    await f.driver.completeTurn(id, 'Second reply')
    await expect.poll(() => control.get().followups?.length).toBe(0)
    await expect.poll(() => ownThread()?.lastTurn?.status).toBe('running')
    await f.driver.completeTurn(id, 'Third reply')
    await expect.poll(() => ownThread()?.status).toBe('idle')
    expect((await f.driver.requests()).filter(record => record.method === 'turn/start')).toHaveLength(3)
    expect(ownThread()?.modelId).toBe('fixture-base')
  } finally { await stack.dispose(); await f.cleanup() }
})

const open = async () => {
  const f = await museFixture()
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Muse thread' })
  return { f, id }
}
const thread = async (f: Awaited<ReturnType<typeof museFixture>>, id: string) =>
  (await f.host.snapshot()).threads.find(candidate => candidate.id === id)!

it('recovers missed history after a view gap without blocking its resume reply or duplicating messages', async () => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await f.action(id, { type: 'gap', text: 'A reply missed by the stream', repeat: true })
    await expect.poll(async () => (await thread(f, id)).messages.filter(message => message.text === 'A reply missed by the stream').length).toBe(1)
    expect((await thread(f, id)).status).toBe('running')
    expect((await f.driver.requests()).filter(record => record.method === 'session/resume')).toHaveLength(1)
    await f.driver.completeTurn(id, 'The stream still works')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await thread(f, id)).messages.map(message => message.text)).toContain('The stream still works')
  } finally { await f.cleanup() }
})

it('reconciles a missed turn ending without inventing its outcome and restores a missed question', async () => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await f.script({ suppressQuestion: true })
    await f.driver.raiseQuestion(id, 'A question missed by the stream')
    // The hidden request must exist natively before the next control-file action replaces it.
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(join(f.root, 'native-sessions.json'), 'utf8')) as {
        sessions: Record<string, { pendingInputs?: { text: string }[] }>
      }
      return saved.sessions[await f.realId(id)]?.pendingInputs?.some(input => input.text === 'A question missed by the stream')
    }).toBe(true)
    expect((await thread(f, id)).requests).toHaveLength(0)
    await f.action(id, { type: 'gap' })
    await expect.poll(async () => (await thread(f, id)).requests[0]?.text).toBe('A question missed by the stream')
    const request = (await thread(f, id)).requests[0]!
    await f.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: 'Blue' })
    await f.script({ suppressTurnCompleted: true })
    await f.driver.completeTurn(id, 'The terminal event was missed')
    await expect.poll(async () => (await thread(f, id)).messages.some(message => message.text === 'The terminal event was missed')).toBe(true)
    expect((await thread(f, id)).status).toBe('running')
    await f.action(id, { type: 'gap' })
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await thread(f, id)).lastTurn).toBeUndefined()
    expect((await thread(f, id)).activities?.find(activity => activity.kind === 'turn')?.status).toBe('unknown')
    await f.script({})
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'next', text: 'Continue' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'A normal completion')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
  } finally { await f.cleanup() }
})

it.each(['approval-required', 'auto', 'full-access'] as const)('replays the exact creation envelope after a lost acknowledgement in %s mode', async runtimeMode => {
  const f = await museFixture(), id = randomUUID()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.script({ loseStartAckOnce: true })
    await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId,
      modelId: f.modelId, title: 'Replay thread', runtimeMode })).resolves.toEqual({ accepted: false, uncertain: true })
    await f.host.refreshThread!(id)
    const starts = (await f.driver.requests()).filter(record => record.method === 'session/start')
    expect(starts).toHaveLength(2)
    expect(starts[1]?.params).toEqual(starts[0]?.params)
    expect((await thread(f, id)).runtimeMode).toBe(runtimeMode)
    expect((await thread(f, id)).status).toBe('idle')
  } finally { await f.cleanup() }
})

it('keeps its catalog and working process when an updated client has no signed-in models', async () => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    const before = await f.host.snapshot()
    await f.script({ models: [] })
    await expect(f.host.clientUpdated!()).rejects.toThrow('new client is not signed in')
    expect((await f.host.snapshot()).models).toEqual(before.models)
    expect((await f.host.snapshot()).version).toBe(before.version)
    await f.driver.completeTurn(id, 'The working client carries on')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await f.driver.requests()).filter(record => record.method === 'fixture/process')).toHaveLength(1)
  } finally { await f.cleanup() }
})

it.each(['malformed', 'gap'] as const)('closes a lost host after %s and lets its thread restart', async type => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    if (type === 'gap') await f.script({ rejectResume: true })
    await f.action(id, { type })
    await expect.poll(async () => (await thread(f, id)).status).toBe('error')
    await expect.poll(() => f.sessions.stopped(id)).toBe(true)
    expect((await f.host.snapshot()).connected).toBe(true)
    await f.script({})
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'next', text: 'Try again' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Recovered')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await thread(f, id)).messages.map(message => message.text)).toContain('Recovered')
  } finally { await f.cleanup() }
})

it('fails a prompt whose host ends after the turn acknowledgement and before message delivery', async () => {
  const { f, id } = await open()
  try {
    await f.script({ suppressUserMessage: true })
    const send = f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await expect.poll(async () => (await thread(f, id)).lastTurn).toEqual({ id: 'first', status: 'running' })
    await f.action(id, { type: 'exit' })
    await expect(send).resolves.toEqual({ accepted: false, uncertain: true })
    expect((await thread(f, id)).status).toBe('error')
    await f.script({})
    await expect(f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'second', text: 'Continue' })).resolves.toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Recovered after process loss')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
  } finally { await f.cleanup() }
})

it('offers the permission modes the client let a probe select, and only those (ADR-0079)', async () => {
  const openF = await museFixture()
  try {
    await openF.script({ ceiling: true })
    const snapshot = await openF.host.connect()
    // Under the fixture's ceiling, allowAll and onRequest are refused, so neither is promised.
    expect(snapshot.models[0]?.runtimeModes).toEqual(['approval-required'])
  } finally { await openF.cleanup() }
  const { f, id } = await open()
  try {
    const snapshot = await f.host.snapshot()
    expect(snapshot.models[0]?.runtimeModes).toEqual(['approval-required', 'auto', 'full-access'])
    expect((await thread(f, id)).runtimeMode).toBe('approval-required')
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' })
    expect((await thread(f, id)).runtimeMode).toBe('full-access')
    expect((await f.driver.requests()).filter(record => record.method === 'session/setApprovalMode')
      .map(record => record.params)).toEqual([expect.objectContaining({ mode: 'allowAll' })])
  } finally { await f.cleanup() }
})

it('sends the chosen reasoning effort on the turn, and Muse’s tier list in order', async () => {
  const { f, id } = await open()
  try {
    const model = (await f.host.snapshot()).models[0]!
    expect(model.reasoningEfforts).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(model.defaultReasoningEffort).toBe('high')
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    const starts = (await f.driver.requests()).filter(record => record.method === 'turn/start')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.params).toMatchObject({ reasoningEffort: 'high' })
    await f.driver.completeTurn(id, 'Done')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'low' })
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'second', text: 'Again' })
    expect((await f.driver.requests()).filter(record => record.method === 'turn/start')[1]?.params)
      .toMatchObject({ reasoningEffort: 'low' })
  } finally { await f.cleanup() }
})

it('steers a running turn and refuses to steer an idle one', async () => {
  const { f, id } = await open()
  try {
    await expect(f.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'too-early', text: 'Wait' }))
      .rejects.toThrow('no running turn to steer')
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await expect(f.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'steered', text: 'Also check the tests' }))
      .resolves.toEqual({ accepted: true })
    expect((await f.driver.requests()).filter(record => record.method === 'turn/steer')).toHaveLength(1)
    expect((await thread(f, id)).messages.map(message => message.id)).toContain('steered')
    await f.driver.completeTurn(id, 'Done after steering')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    const finished = await thread(f, id)
    expect(finished.lastTurn).toEqual({ id: 'first', status: 'completed' })
    expect(finished.activities?.filter(activity => activity.kind === 'turn')).toEqual([
      expect.objectContaining({ turnId: 'first', status: 'completed' }),
    ])
  } finally { await f.cleanup() }
})

it('refuses a client Sotto cannot drive: an older one, and another MSP version', async () => {
  const old = await museFixture()
  try {
    await old.script({ cliVersion: '1.0.0' })
    await expect(old.host.connect()).rejects.toThrow('Could not connect Muse.')
    expect((await old.host.snapshot()).connected).toBe(false)
  } finally { await old.cleanup() }
  const future = await museFixture()
  try {
    await future.script({ schemaVersion: 2 })
    await expect(future.host.connect()).rejects.toThrow('Could not connect Muse.')
  } finally { await future.cleanup() }
})

it('calls an empty catalog signed out only when it is the bundled one a client with no sign-in answers with', async () => {
  // Muse 1.4.8 and 1.4.9 with no sign-in answer `bundledCatalog` and no models; signed in, `providerCatalog`, even offline.
  for (const [source, problem, said] of [['bundledCatalog', 'signed-out', 'Sign in to Muse on this machine with muse login'],
    ['', 'cannot-start', 'Muse is set up but listed no models'],
    ['unresolvedCatalog', 'cannot-start', 'Muse is set up but listed no models']] as const) {
    const f = await museFixture()
    try {
      await f.script({ models: [], catalogSource: source })
      const refusal = await f.host.connect().then(() => undefined, (error: unknown) => error)
      expect(refusal).toMatchObject({ problem, message: expect.stringContaining(said) })
      expect((await f.host.snapshot()).connected).toBe(false)
    } finally { await f.cleanup() }
  }
})

it('keeps the account’s keys out of the client’s environment', async () => {
  const saved = process.env.META_API_KEY
  process.env.META_API_KEY = 'fixture-secret'
  try {
    const { f } = await open()
    try {
      const processes = (await f.driver.requests()).filter(record => record.method === 'fixture/process')
      expect(processes.length).toBeGreaterThan(0)
      for (const started of processes) expect((started.params as { environment?: unknown }).environment).toEqual({})
    } finally { await f.cleanup() }
  } finally { if (saved === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = saved }
})

it('answers a question with free text when it names no option, and cancels on a decline', async () => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await f.driver.raiseQuestion(id, 'Which color?')
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const request = (await thread(f, id)).requests[0]!
    await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '',
      questionAnswers: { q1: { optionIds: ['not-offered'] } } })).rejects.toThrow()
    expect((await f.driver.requests()).filter(record => record.method === 'userInput/answer')).toHaveLength(0)
    expect((await thread(f, id)).requests[0]?.delivery).toBeUndefined()
    expect(JSON.parse(await readFile(join(f.root, 'muse-threads.json'), 'utf8'))[id].answeredRequestIds).not.toContain(request.id)
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: 'Blue' })
    const answers = (await f.driver.requests()).filter(record => record.method === 'userInput/answer')
    expect(answers).toHaveLength(1)
    expect(answers[0]?.params).toMatchObject({ answers: [{ questionId: 'q1', freeText: 'Blue' }] })
    await f.driver.raiseQuestion(id, 'Another?')
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const second = (await thread(f, id)).requests[0]!
    await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: second.id, answer: '', approved: false })
    expect((await f.driver.requests()).filter(record => record.method === 'userInput/cancel')).toHaveLength(1)
  } finally { await f.cleanup() }
})

it('does not start a side call when MSP cannot enforce that all tools are disabled', async () => {
  const { f, id } = await open()
  try {
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })
    await f.driver.completeTurn(id, 'Done')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    const before = await readFile(join(f.root, 'oneshot.jsonl'), 'utf8')
    await expect(f.host.writeShortText!(id, { instruction: 'Name it.', material: 'Marker material' })).resolves.toBeNull()
    await expect(f.host.writeShortText!(id, { instruction: 'Name it.', material: 'Aborted material' }, AbortSignal.abort())).resolves.toBeNull()
    expect(await readFile(join(f.root, 'oneshot.jsonl'), 'utf8')).toBe(before)
    expect((await f.host.snapshot()).threads).toHaveLength(1)
    expect(JSON.stringify(await f.driver.requests())).not.toContain('Marker material')
  } finally { await f.cleanup() }
})
