// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { providerIdOfLabel, type ProviderId } from '../../src/shared/agents'
import { OPENCODE_FORM_UNSHOWN } from '../../src/main/agents/opencodeRequests'
import { opencodeRules } from '../../src/main/agents/opencode'
import { ensureOpenCodeFolders, opencodeDatabase, opencodeEnvironment, opencodeFolders, opencodePassword, opencodeServerLedger, recordOpenCodeServer, systemProcessStart } from '../../src/main/agents/opencodeServer'
import { describeAdapterContract } from './adapterContract'
import { opencodeFixture, opencodeFixtureSkips } from '../fixtures/fakeOpenCodeFixture'
import { handleOf, PIXEL_PNG } from '../fixtures/stagedImages'

describeAdapterContract('OpenCode 2', session => opencodeFixture(undefined, undefined, session), opencodeFixtureSkips)

type Fixture = Awaited<ReturnType<typeof opencodeFixture>>
const open = async (f?: Fixture, runtimeMode?: 'approval-required' | 'auto-accept-edits' | 'full-access') => {
  f ??= await opencodeFixture()
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'OpenCode thread', ...(runtimeMode ? { runtimeMode } : {}) })
  f.host.observeThreads?.([id])
  return { f, id }
}
const thread = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(candidate => candidate.id === id)!
const send = (f: Fixture, id: string, messageId: string, text = 'Synthetic prompt') =>
  f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId, text })
const running = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }

it('gives each server a password of its own and never logs one, even when OpenCode prints it', async () => {
  const f = await opencodeFixture()
  try {
    await f.script({ printPassword: true })
    const { id } = await open(f)
    await send(f, id, 'first')
    await f.driver.completeTurn(id, 'Done')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    const passwords = await Promise.all((await readdir(f.root)).filter(name => name.startsWith('password-')).map(name => readFile(join(f.root, name), 'utf8')))
    // The connect check's server and the thread's each got one, and no two were the same.
    expect(passwords.length).toBeGreaterThanOrEqual(2)
    expect(new Set(passwords).size).toBe(passwords.length)
    expect(passwords.every(password => password.length >= 32)).toBe(true)
    const processes = (await f.driver.requests()).filter(record => record.method === 'fixture/process')
    expect(processes.every(record => (record.params as { environment: { passwordSet: boolean } }).environment.passwordSet)).toBe(true)
    // Only stable event names were logged, and no password is anywhere Sotto writes or shows.
    expect(f.events.every(event => /^opencode-server-[a-z]+$/u.test(event))).toBe(true)
    const kept = JSON.stringify(await f.host.snapshot()) + JSON.stringify(f.events) + await readFile(join(f.root, 'opencode-threads.json'), 'utf8')
    for (const password of passwords) expect(kept).not.toContain(password)
  } finally { await f.cleanup() }
})

it('starts OpenCode on Sotto’s own folders with none of the account’s keys, no share links and no update of its own', async () => {
  const saved = { anthropic: process.env.ANTHROPIC_API_KEY, xdg: process.env.XDG_DATA_HOME, server: process.env.OPENCODE_SERVER_PASSWORD }
  process.env.ANTHROPIC_API_KEY = 'fixture-secret'; process.env.XDG_DATA_HOME = join('C:', 'users-own-data'); process.env.OPENCODE_SERVER_PASSWORD = 'inherited'
  try {
    const { f } = await open()
    try {
      const processes = (await f.driver.requests()).filter(record => record.method === 'fixture/process')
      expect(processes.length).toBeGreaterThan(0)
      for (const started of processes) {
        expect((started.params as { environment: unknown }).environment).toEqual({
          dataHome: join(f.root, 'opencode', 'data'), configHome: join(f.root, 'opencode', 'config'), stateHome: join(f.root, 'opencode', 'state'), cacheHome: join(f.root, 'opencode', 'cache'),
          passwordSet: true, configContent: JSON.stringify({ share: 'disabled', update: 'disable' }), disableAutoupdate: '1', leaked: [],
        })
      }
    } finally { await f.cleanup() }
  } finally {
    for (const [key, value] of [['ANTHROPIC_API_KEY', saved.anthropic], ['XDG_DATA_HOME', saved.xdg], ['OPENCODE_SERVER_PASSWORD', saved.server]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})

it.each([
  // OpenCode 1 is too old to use, so setup offers OpenCode 2's install guide for it (#1104).
  ['1.19.3', 'too-old', 'Sotto works with OpenCode 2 only'],
  ['2.0.30', 'too-old', 'OpenCode 2.0.31 or newer is required, and this client is 2.0.30.'],
  ['3.0.0', 'cannot-start', 'This is OpenCode 3.0.0, and Sotto works with OpenCode 2 only.'],
] as const)('refuses OpenCode %s at connect, in words, before any server starts', async (version, problem, said) => {
  const f = await opencodeFixture()
  try {
    await f.script({ version })
    const refusal = await f.host.connect().then(() => undefined, (error: unknown) => error)
    expect(refusal).toMatchObject({ problem, message: expect.stringContaining(said), ...(problem === 'too-old' ? { requiredVersion: '2.0.31', version } : {}) })
    expect((await f.host.snapshot()).connected).toBe(false)
    expect((await f.driver.requests()).filter(record => record.method === 'fixture/process')).toEqual([])
  } finally { await f.cleanup() }
})

it('offers each model under its model source with the OpenCode label, effort from its variants and images from its input', async () => {
  const f = await opencodeFixture()
  try {
    const snapshot = await f.host.connect()
    expect(snapshot.account).toBe('No model source signed in yet; OpenCode Zen’s free models only')
    const [first, second] = snapshot.models
    expect(first).toMatchObject({ id: 'opencode/fixture-model', name: 'Fixture Model', provider: 'OpenCode', source: 'OpenCode Zen', supportsImages: true,
      reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', recommended: true, runtimeModes: ['approval-required', 'auto-accept-edits', 'full-access'] })
    expect(second).toMatchObject({ id: 'opencode/text-only', supportsImages: false })
    expect(second?.reasoningEfforts).toBeUndefined()
    expect(providerIdOfLabel(first!.provider)).toBe('opencode')
  } finally { await f.cleanup() }
  const signed = await opencodeFixture()
  try {
    await signed.script({
      providers: [{ id: 'opencode', name: 'OpenCode', activation: 'enabled' }, { id: 'anthropic', name: 'Anthropic', activation: 'enabled' }],
      models: [{ id: 'claude-sonnet-5', providerID: 'anthropic', name: 'Claude Sonnet 5', capabilities: { input: ['text', 'image'] }, variants: [{ id: 'high' }, { id: 'low' }], enabled: true },
        { id: 'retired', providerID: 'anthropic', name: 'Retired', capabilities: { input: ['text'] }, variants: [], enabled: true, status: 'deprecated' }],
      unavailable: 2,
    })
    const snapshot = await signed.host.connect()
    expect(snapshot.account).toBe('Signed in to Anthropic')
    // A model from Anthropic is still an OpenCode model: its provider label never reads as Claude Code.
    expect(snapshot.models).toEqual([expect.objectContaining({ id: 'anthropic/claude-sonnet-5', provider: 'OpenCode', source: 'Anthropic', reasoningEfforts: ['low', 'high'] })])
    expect(providerIdOfLabel(snapshot.models[0]!.provider)).not.toBe('claude')
    // A folder's first requests may answer 503 while its plugins load; they are retried.
    expect((await signed.driver.requests()).filter(record => record.method === 'model.list').length).toBeGreaterThanOrEqual(3)
  } finally { await signed.cleanup() }
})

it.each(['approval-required', 'auto-accept-edits', 'full-access'] as const)('creates a %s thread with its rule set and changes it on the live session', async runtimeMode => {
  const { f, id } = await open(undefined, runtimeMode)
  try {
    const created = (await f.driver.requests()).filter(record => record.method === 'session.create')
    expect(created).toHaveLength(1)
    expect(created[0]?.params?.permissions).toEqual(opencodeRules(runtimeMode))
    expect((await thread(f, id)).runtimeMode).toBe(runtimeMode)
    const next = runtimeMode === 'full-access' ? 'approval-required' : 'full-access'
    const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: next })
    expect(result.accepted).toBe(true)
    expect(result.snapshot?.threads.find(candidate => candidate.id === id)?.runtimeMode).toBe(next)
    expect((await f.driver.requests()).filter(record => record.method === 'session.update').map(record => record.params?.permissions)).toEqual([opencodeRules(next)])
    // OpenCode has no mode that matches Automatic, so it is never offered.
    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'auto' })).rejects.toThrow('not supported')
    expect(opencodeRules('approval-required')).toEqual(['shell', 'edit', 'external_directory', 'webfetch', 'websearch', 'subagent'].map(action => ({ action, resource: '*', effect: 'ask' })))
    expect(opencodeRules('auto-accept-edits').filter(item => item.effect === 'ask').map(item => item.action)).toEqual(['shell', 'external_directory', 'webfetch', 'websearch', 'subagent'])
    expect(opencodeRules('auto-accept-edits')).toContainEqual({ action: 'edit', resource: '*', effect: 'allow' })
    expect(opencodeRules('full-access')).toEqual([{ action: '*', resource: '*', effect: 'allow' }])
  } finally { await f.cleanup() }
})

it('finds the provider session a creation made when its answer was lost, and makes no second one', async () => {
  const f = await opencodeFixture()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.script({ delay: { 'session.create': 4000 } })
    const id = randomUUID()
    await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Lost answer' }))
      .resolves.toEqual({ accepted: false, uncertain: true })
    // OpenCode chooses the provider session's ID, so Sotto finds it by the mark it left in the session's metadata.
    // The fake answers a second after the adapter gave up; the next read waits for the session it made to be there.
    await expect.poll(async () => (await f.nativeSessions()).filter(session => session.title === 'Lost answer').length, { timeout: 10_000 }).toBe(1)
    await f.host.refreshThread!(id)
    expect((await thread(f, id)).status).toBe('idle')
    const creations = (await f.driver.requests()).filter(record => record.method === 'session.create')
    expect(creations).toHaveLength(1)
    expect(creations[0]?.params).not.toHaveProperty('id')
    expect((await f.driver.requests()).some(record => record.method === 'session.list')).toBe(true)
    await expect(send(f, id, 'first')).resolves.toEqual({ accepted: true })
  } finally { await f.cleanup() }
})

it('changes the model and effort on the live session without starting another', async () => {
  const { f, id } = await open()
  try {
    await f.host.refreshThread!(id)
    const starts = await f.sessions.starts(id)
    const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high' })
    expect(result.snapshot?.threads.find(candidate => candidate.id === id)?.reasoningEffort).toBe('high')
    expect((await f.driver.requests()).filter(record => record.method === 'session.switchModel').map(record => record.params?.model))
      .toEqual([{ id: 'fixture-model', providerID: 'opencode', variant: 'high' }])
    expect(await f.sessions.starts(id)).toBe(starts)
  } finally { await f.cleanup() }
})

it.each(['an update', 'a sign-in'] as const)('lets a settings change finish on its server when %s lands meanwhile, then moves the idle thread on', { timeout: 60_000 }, async change => {
  // The model switch is held under a longer request deadline, so the change is still in the middle of its command when
  // the client or the sign-ins change: checking a new client starts a server of its own, which takes a moment. Everything
  // is scripted before the change starts, so no server reads the script while it is being written.
  const { f, id } = await open(await opencodeFixture(undefined, 15_000))
  try {
    await f.host.refreshThread!(id)
    await expect.poll(async () => f.holder(id)).toBeDefined()
    const first = await f.holder(id)
    // The newer client is on disk before the change starts; the thread's server, already running, is still the old one.
    await f.script({ delay: { 'session.switchModel': 6_000 }, ...(change === 'an update' ? { version: '2.0.40' } : {}) })
    let done = false
    const changing = f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high' }).finally(() => { done = true })
    await expect.poll(async () => (await f.driver.requests()).filter(record => record.method === 'session.switchModel').length).toBe(1)
    if (change === 'an update') await f.host.clientUpdated!()
    else expect((await f.host.signIn.signInWithKey({ sourceId: 'anthropic', key: 'sk-fixture-made-up-key-3c9a' })).status).toBe('ok')
    // The change was still in the middle of its command when its server became outdated, and that server was left to it.
    expect(done).toBe(false)
    const result = await changing
    expect(result.accepted).toBe(true)
    expect(result.snapshot?.threads.find(candidate => candidate.id === id)?.reasoningEffort).toBe('high')
    // Once the change is done the thread is idle, so it moves to a fresh server.
    await expect.poll(async () => { const holder = await f.holder(id); return holder !== undefined && holder !== first }, { timeout: 15_000 }).toBe(true)
    expect((await thread(f, id)).reasoningEffort).toBe('high')
    if (change === 'an update') expect((await f.host.snapshot()).version).toContain('2.0.40')
  } finally { await f.cleanup() }
})

it('answers a permission once or with a reject, never always, and shows the diff it would apply', async () => {
  const { f, id } = await open()
  try {
    await send(f, id, 'first')
    await f.driver.raisePermission(id, 'npm test')
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const request = (await thread(f, id)).requests[0]!
    expect(request).toMatchObject({ kind: 'permission', text: 'Run a command: npm test', context: { command: 'npm test', details: expect.stringContaining('+hi') } })
    expect(request.permissionChoices?.map(choice => choice.kind)).toEqual(['allow-once', 'deny'])
    // A choice OpenCode would read as always cannot be named: it was never offered.
    await expect(f.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: '', approved: true, permissionChoice: 'always' })).rejects.toThrow('not offered')
    expect((await f.driver.requests()).filter(record => record.method === 'session.permission.reply')).toEqual([])
    await f.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: '', approved: false })
    const replies = (await f.driver.requests()).filter(record => record.method === 'session.permission.reply')
    expect(replies.map(record => [record.params?.decision, record.params?.message])).toEqual([['reject', 'The user declined this request.']])
    // A plain allow and an explicit Allow once are both OpenCode's `once`; the fake records `always` as a violation.
    for (const permissionChoice of [undefined, 'once']) {
      await f.driver.raisePermission(id, 'npm run build')
      await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
      await f.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: (await thread(f, id)).requests[0]!.id, answer: '', approved: true, ...(permissionChoice ? { permissionChoice } : {}) })
    }
    expect((await f.driver.requests()).filter(record => record.method === 'session.permission.reply').map(record => record.params?.decision)).toEqual(['reject', 'once', 'once'])
  } finally { await f.cleanup() }
})

it('draws a form with text, choice, yes-or-no, number and several-choice fields, and answers it in their own types', async () => {
  const { f, id } = await open()
  try {
    await send(f, id, 'first')
    await f.action(id, { type: 'form', fields: [
      { key: 'colour', title: 'Colour', description: 'Which colour?', type: 'string', options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] },
      { key: 'tests', description: 'Run the tests?', type: 'boolean' },
      { key: 'count', description: 'How many?', type: 'integer' },
      { key: 'parts', description: 'Which parts?', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { key: 'note', description: 'Anything else?', type: 'string', required: false },
    ] })
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const request = (await thread(f, id)).requests[0]!
    expect(request.questions?.map(question => [question.id, question.options.map(option => option.label), question.multiSelect, question.allowFreeText]))
      .toEqual([['colour', ['Red', 'Blue'], false, false], ['tests', ['Yes', 'No'], false, false], ['count', [], false, true], ['parts', ['A', 'B'], true, false], ['note', [], false, true]])
    await expect(f.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: '', questionAnswers: {
      colour: { optionIds: ['option-1'] }, tests: { optionIds: ['option-0'] }, count: { optionIds: [], text: 'three' }, parts: { optionIds: ['option-0', 'option-1'] } } })).rejects.toThrow('whole number')
    expect((await f.driver.requests()).filter(record => record.method === 'session.form.reply')).toEqual([])
    await f.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: '', questionAnswers: {
      colour: { optionIds: ['option-1'] }, tests: { optionIds: ['option-0'] }, count: { optionIds: [], text: '3' }, parts: { optionIds: ['option-0', 'option-1'] } } })
    expect((await f.driver.requests()).filter(record => record.method === 'session.form.reply').map(record => record.params?.answer))
      .toEqual([{ colour: 'blue', tests: true, count: 3, parts: ['a', 'b'] }])
    expect((await thread(f, id)).requests).toEqual([])
  } finally { await f.cleanup() }
})

it('cancels a form it cannot draw with a sentence the model reads, and shows nothing', async () => {
  const { f, id } = await open()
  try {
    await send(f, id, 'first')
    await f.action(id, { type: 'form', fields: [
      { key: 'kind', description: 'Which kind?', type: 'string', options: [{ value: 'other', label: 'Other' }] },
      { key: 'detail', description: 'Say more', type: 'string', when: [{ key: 'kind', op: 'eq', value: 'other' }] },
    ] })
    await expect.poll(async () => (await f.driver.requests()).filter(record => record.method === 'session.form.cancel').map(record => (record.params?.query as { message?: string } | undefined)?.message))
      .toEqual([OPENCODE_FORM_UNSHOWN])
    expect((await thread(f, id)).requests).toEqual([])
  } finally { await f.cleanup() }
})

it('sends an image as a data URI for a model that takes images, and refuses one before sending for a model that does not', async () => {
  const { f, id } = await open()
  try {
    const handle = handleOf(PIXEL_PNG, 'contract-image', 'Contract.png')
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'image', text: 'Look', attachments: [{ ...handle, read: async () => PIXEL_PNG }] })
    const prompt = (await f.driver.requests()).find(record => record.method === 'session.prompt')!
    expect(prompt.params?.files).toEqual([{ uri: `data:image/png;base64,${PIXEL_PNG.toString('base64')}`, name: 'Contract.png' }])
    await f.driver.completeTurn(id, 'Seen')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    const textOnly = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: textOnly, projectId: f.projectId, modelId: 'opencode/text-only', title: 'Text only' })
    let reads = 0
    await expect(f.host.execute({ type: 'send', threadId: textOnly, commandId: randomUUID(), messageId: 'refused', text: 'Look', attachments: [{ ...handle, read: async () => { reads++; return PIXEL_PNG } }] }))
      .rejects.toThrow(/image support/)
    expect(reads).toBe(0)
    expect((await f.driver.requests()).filter(record => record.method === 'session.prompt')).toHaveLength(1)
  } finally { await f.cleanup() }
})

it('steers a running turn inside the same execution, and refuses to steer an idle one', async () => {
  const { f, id } = await open()
  try {
    await expect(f.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'too-early', text: 'Wait' })).rejects.toThrow('no running turn to steer')
    await send(f, id, 'first')
    await expect(f.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'steered', text: 'Also check the tests' })).resolves.toEqual({ accepted: true })
    const prompts = (await f.driver.requests()).filter(record => record.method === 'session.prompt')
    expect(prompts.map(record => record.params?.delivery)).toEqual([undefined, 'steer'])
    expect((await thread(f, id)).messages.map(message => message.id)).toEqual(['first', 'steered'])
    await f.driver.completeTurn(id, 'Done after steering')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    expect((await thread(f, id)).lastTurn).toEqual({ id: 'first', status: 'completed' })
    expect((await thread(f, id)).activities?.filter(activity => activity.kind === 'turn').map(activity => [activity.turnId, activity.status])).toEqual([['first', 'completed']])
  } finally { await f.cleanup() }
})

// Two real servers end here, one killed and one left behind by a restart, and each exit sweeps for the tools it left.
it('ends a turn as interrupted when its server dies, and shows a resumed turn with no outcome as stopped', { timeout: 60_000 }, async () => {
  const { f, id } = await open()
  try {
    await send(f, id, 'first')
    await f.action(id, { type: 'tool', name: 'shell', input: { command: 'ping -n 90 127.0.0.1' }, running: true })
    await expect.poll(async () => (await thread(f, id)).activities?.find(activity => activity.kind === 'command')?.status).toBe('running')
    process.kill((await f.holder(id))!)
    await expect.poll(async () => (await thread(f, id)).lastTurn).toEqual({ id: 'first', status: 'interrupted' })
    const lost = await thread(f, id)
    expect(lost.status).toBe('idle')
    expect(lost.activities?.find(activity => activity.kind === 'turn')?.error).toContain('OpenCode stopped before this reply finished')
    expect(lost.activities?.find(activity => activity.kind === 'command')?.status).toBe('interrupted')
    expect((await f.host.snapshot()).connected).toBe(true)
  } finally { await f.cleanup() }
  // Sotto itself stopped too, before it could save what it saw: the provider session alone shows the turn never ended.
  const { f: g, id: other } = await open()
  let restarted: Fixture | undefined
  try {
    await send(g, other, 'first')
    await g.action(other, { type: 'tool', name: 'shell', input: { command: 'ping -n 90 127.0.0.1' }, running: true })
    await expect.poll(async () => (await thread(g, other)).activities?.some(activity => activity.kind === 'command')).toBe(true)
    restarted = await g.driver.restart()
    const saved = JSON.parse(await readFile(join(g.root, 'opencode-threads.json'), 'utf8')) as Record<string, { endedTurn?: unknown }>
    delete saved[other]!.endedTurn
    await writeFile(join(g.root, 'opencode-threads.json'), JSON.stringify(saved))
    restarted.host.observeThreads?.([other]); await restarted.host.connect()
    await expect.poll(async () => (await thread(restarted!, other)).lastTurn).toEqual({ id: 'first', status: 'interrupted' })
    const resumed = await thread(restarted, other)
    expect(resumed.status).toBe('idle')
    expect(resumed.activities?.find(activity => activity.kind === 'command')).toMatchObject({ command: 'ping -n 90 127.0.0.1', status: 'interrupted' })
    expect(resumed.messages.map(message => message.id)).toEqual(['first'])
    await expect(send(restarted, other, 'second', 'Carry on')).resolves.toEqual({ accepted: true })
  } finally { await (restarted ?? g).cleanup() }
})

it('starts the first server on a new data folder alone, then the rest side by side', async () => {
  const { f } = await open()
  try {
    // The connect check made the database; take it away so two threads' first servers would race to make it again.
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'second', title: 'Second', path: f.root })
    f.host.disconnect(); await f.host.closed()
    await rm(join(f.root, 'opencode', 'data', 'opencode', 'opencode.db'))
    await f.script({ migrationMs: 600 })
    await f.host.connect()
    await rm(join(f.root, 'opencode', 'data', 'opencode', 'opencode.db'))
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const results = await Promise.all(ids.map(id => f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Parallel' })))
    expect(results.every(result => result.accepted)).toBe(true)
    // No server lost the migration race (the fake records one as a violation and exits).
    await expect(f.driver.requests()).resolves.toBeDefined()
  } finally { await f.cleanup() }
})

it('stops a server with its whole process tree, so a tool it started does not outlive it', async () => {
  const { f, id } = await open()
  let child: number | undefined
  try {
    await send(f, id, 'first')
    await f.action(id, { type: 'child' })
    await expect.poll(async () => (await f.driver.requests()).some(record => record.method === 'fixture/child')).toBe(true)
    const pid = (await f.driver.requests()).find(record => record.method === 'fixture/child')!.params!.pid as number
    child = pid
    expect(running(pid)).toBe(true)
    f.host.disconnect(); await f.host.closed()
    await expect.poll(() => running(pid), { timeout: 10_000 }).toBe(false)
  } finally {
    // A tool process that outlived its server would hold the fixture's folder open; the test, not the cleanup, reports it.
    if (child !== undefined && running(child)) process.kill(child)
    await f.cleanup()
  }
})

it.each([
  ['stable, with Muse held', undefined, 'Choose a Codex, Claude Code or Grok Build model for Watcher.'],
  ['Owl, with nothing held', new Set<ProviderId>(), 'Choose a Codex, Claude Code, Grok Build or Muse model for Watcher.'],
] as const)('refuses Watcher in words before any OpenCode process starts, naming Watcher’s providers on %s', async (_run, heldProviders, choose) => {
  const f = await opencodeFixture(undefined, undefined, {}, heldProviders ? { heldProviders } : {})
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const before = (await f.driver.requests()).filter(record => record.method === 'fixture/process').length
    let revoked: string | undefined
    f.host.useLaunchProfiles!({ profileFor: async () => ({ kind: 'watcher' as const, server: { name: 'sotto_threads', type: 'http' as const, url: 'http://127.0.0.1:9/mcp', headers: [] }, toolNames: [], revoke: reason => { revoked = reason } }) })
    await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, modelId: f.modelId, title: 'Watcher' }))
      .rejects.toThrow(`OpenCode cannot host Watcher. Nothing was sent. ${choose}`)
    expect(revoked).toBe(`OpenCode cannot host Watcher. Nothing was sent. ${choose}`)
    expect((await f.driver.requests()).filter(record => record.method === 'fixture/process')).toHaveLength(before)
  } finally { await f.cleanup() }
})

it('ends the tools of a server that exits by itself, since a tool it started outlives it', { timeout: 60_000 }, async () => {
  const { f, id } = await open()
  let child: number | undefined
  try {
    await send(f, id, 'first')
    await f.action(id, { type: 'child' })
    await expect.poll(async () => (await f.driver.requests()).some(record => record.method === 'fixture/child')).toBe(true)
    child = (await f.driver.requests()).find(record => record.method === 'fixture/child')!.params!.pid as number
    expect(running(child)).toBe(true)
    // The server ends on its own, not by Sotto's stop: its process tree is gone with it, but the tool is still running.
    await f.action(id, { type: 'exit' })
    await expect.poll(async () => (await thread(f, id)).lastTurn).toEqual({ id: 'first', status: 'interrupted' })
    await f.host.closed()
    const tool = child
    await expect.poll(() => running(tool), { timeout: 15_000 }).toBe(false)
  } finally {
    if (child !== undefined && running(child)) process.kill(child)
    await f.cleanup()
  }
})

it('stops a thread’s server when its event stream fails before the first event', { timeout: 60_000 }, async () => {
  const f = await opencodeFixture()
  let left: number[] = []
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.script({ eventStream: 'refuse' })
    const before = await f.processes()
    const result = await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, modelId: f.modelId, title: 'No stream' })
      .catch((error: unknown) => error)
    expect(result).not.toEqual({ accepted: true })
    const started = (await f.processes()).filter(pid => !before.includes(pid))
    expect(started).toHaveLength(1)
    // Nothing is left of it once the adapter says its work is done.
    await f.host.closed()
    left = started.filter(running)
  } finally {
    // A server left running holds the fixture's folder open; the assertion below, not the cleanup, reports it.
    for (const pid of left) process.kill(pid)
    await f.cleanup()
  }
  expect(left).toEqual([])
})

it('stops the connect check’s server when Sotto disconnects while it is still answering', { timeout: 60_000 }, async () => {
  const f = await opencodeFixture(undefined, 30_000)
  try {
    await f.script({ delay: { 'model.list': 20_000 } })
    const connecting = f.host.connect().then(() => undefined, (error: unknown) => error)
    await expect.poll(async () => (await f.driver.requests()).some(record => record.method === 'model.list'), { timeout: 15_000 }).toBe(true)
    const [probe] = await f.processes()
    f.host.disconnect(); await f.host.closed()
    expect(running(probe!)).toBe(false)
    expect(await connecting).toBeInstanceOf(Error)
  } finally { await f.cleanup() }
})

it('restores each turn’s activity under its own prompt when the thread’s messages are already known', async () => {
  const { f, id } = await open()
  let restarted: Fixture | undefined
  try {
    for (const [turn, command] of [['first', 'npm test'], ['second', 'npm run build']] as const) {
      await send(f, id, turn, `Run ${command}`)
      await f.action(id, { type: 'tool', name: 'shell', input: { command }, output: 'ok' })
      await expect.poll(async () => (await thread(f, id)).activities?.some(activity => activity.command === command)).toBe(true)
      await f.driver.completeTurn(id, `Ran ${command}`)
      await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    }
    const before = await thread(f, id)
    const placed = (activities: typeof before.activities) => activities?.filter(activity => activity.kind === 'command').map(activity => [activity.command, activity.turnId, activity.afterMessageId])
    expect(placed(before.activities)).toEqual([['npm test', 'first', 'first'], ['npm run build', 'second', 'second']])
    restarted = await f.driver.restart()
    // Sotto's own store already holds the thread's messages, as it does after any restart.
    restarted.host.useThreadHistory!({ messageIdentities: threadId => threadId === id ? before.messages.map(({ id: messageId, role }) => ({ id: messageId, role })) : [] })
    restarted.host.observeThreads?.([id]); await restarted.host.connect()
    await expect.poll(async () => (await thread(restarted!, id)).activities?.filter(activity => activity.kind === 'command').length ?? 0).toBe(2)
    expect(placed((await thread(restarted, id)).activities)).toEqual(placed(before.activities))
  } finally { await (restarted ?? f).cleanup() }
})

it('shows the files a step changed as a file change, live and restored, without repeating one an edit tool reported', async () => {
  const { f, id } = await open()
  let restarted: Fixture | undefined
  try {
    await send(f, id, 'first')
    // A shell command changed a file: only the step's own list says so.
    await f.action(id, { type: 'tool', name: 'shell', input: { command: 'npm run format' }, output: 'formatted', files: ['src/notes.txt'] })
    await expect.poll(async () => (await thread(f, id)).activities?.some(activity => activity.kind === 'file-change')).toBe(true)
    // A write tool reported its own file; the step names it again, and it is shown once.
    await f.action(id, { type: 'tool', name: 'write', input: { path: join(f.root, 'probe.txt'), content: 'hi' }, output: 'Wrote file', files: ['probe.txt'] })
    await expect.poll(async () => (await thread(f, id)).activities?.filter(activity => activity.kind === 'file-change').length).toBe(2)
    await f.driver.completeTurn(id, 'Done')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    const changes = (activities: Awaited<ReturnType<typeof thread>>['activities']) => activities?.filter(activity => activity.kind === 'file-change')
      .map(activity => [activity.title, activity.turnId, activity.status, activity.changes?.map(change => [resolve(change.path), change.kind])])
    const live = changes((await thread(f, id)).activities)
    expect(live).toEqual([
      ['File changes', 'first', 'completed', [[resolve(f.root, 'src', 'notes.txt'), 'update']]],
      ['Write file', 'first', 'completed', [[resolve(f.root, 'probe.txt'), 'Write']]],
    ])
    restarted = await f.driver.restart()
    restarted.host.observeThreads?.([id]); await restarted.host.connect()
    await expect.poll(async () => changes((await thread(restarted!, id)).activities)?.length ?? 0).toBe(2)
    expect(changes((await thread(restarted, id)).activities)).toEqual(live)
  } finally { await (restarted ?? f).cleanup() }
})

it('makes one provider session when a thread is read while its creation is still answering', async () => {
  const f = await opencodeFixture()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.script({ delay: { 'session.create': 1000 } })
    const id = randomUUID()
    const creating = f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'In flight' })
    await expect.poll(async () => (await f.driver.requests()).some(record => record.method === 'session.create')).toBe(true)
    // Sotto's store opens the thread while OpenCode is still making its provider session.
    f.host.observeThreads?.([id])
    const reading = f.host.refreshThread!(id)
    await expect(creating).resolves.toEqual({ accepted: true })
    await reading
    expect((await thread(f, id)).status).toBe('idle')
    expect((await f.driver.requests()).filter(record => record.method === 'session.create')).toHaveLength(1)
    expect((await f.nativeSessions()).filter(session => session.title === 'In flight')).toHaveLength(1)
  } finally { await f.cleanup() }
})

it('makes no second provider session when a thread is read at once after its creation answer was lost', { timeout: 60_000 }, async () => {
  const f = await opencodeFixture()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.script({ delay: { 'session.create': 4000 } })
    const id = randomUUID()
    await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Lost then read' }))
      .resolves.toEqual({ accepted: false, uncertain: true })
    const took = ((await f.driver.requests()).find(record => record.method === 'session.create') as { process?: number } | undefined)?.process
    expect(took).toBeTypeOf('number')
    // Read at once: the server that took the creation may still be making the session its lost answer was for.
    await f.host.refreshThread!(id)
    expect((await thread(f, id)).status).toBe('idle')
    // That server has gone, so it cannot finish a second session later, and the thread has one.
    expect(running(took!)).toBe(false)
    expect((await f.nativeSessions()).filter(session => session.title === 'Lost then read')).toHaveLength(1)
    await expect(send(f, id, 'first')).resolves.toEqual({ accepted: true })
  } finally { await f.cleanup() }
})

it.each([
  ['OpenCode refuses its creation', 'refused'],
  ['Watcher’s check fails before it is created', 'guard'],
] as const)('stops the server of a thread that was never made when %s, and keeps no record of it', async (_case, how) => {
  const f = await opencodeFixture()
  let left: number[] = []
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    if (how === 'refused') await f.script({ refuse: { 'session.create': 400 } })
    const before = await f.processes()
    const id = randomUUID()
    const command = { type: 'create-thread' as const, commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Never made' }
    if (how === 'refused') await expect(f.host.execute(command)).rejects.toThrow('OpenCode refused to create this thread. Nothing was created.')
    else await expect(f.host.executeFromWatcher!(command, () => { throw new Error('Watcher no longer holds this grant.') })).rejects.toThrow('Watcher no longer holds this grant.')
    const started = (await f.processes()).filter(pid => !before.includes(pid))
    expect(started).toHaveLength(1)
    // Nothing is left of it once the adapter says its work is done.
    await f.host.closed()
    left = started.filter(running)
    expect(JSON.parse(await readFile(join(f.root, 'opencode-threads.json'), 'utf8').catch(() => '{}'))).not.toHaveProperty(id)
    expect((await f.host.snapshot()).threads.some(candidate => candidate.id === id)).toBe(false)
    expect((await f.driver.requests()).filter(record => record.method === 'session.create')).toHaveLength(how === 'refused' ? 1 : 0)
  } finally {
    for (const pid of left) process.kill(pid)
    await f.cleanup()
  }
  expect(left).toEqual([])
})

it('ends a server a crash left running when Sotto next connects, and nothing that is not its own', { timeout: 60_000 }, async () => {
  const f = await opencodeFixture()
  const strays: ChildProcess[] = []
  const spawned = (args: string[], env: NodeJS.ProcessEnv = process.env): number => {
    const child = spawn(process.execPath, args, { env, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
    strays.push(child); return child.pid!
  }
  try {
    const folders = opencodeFolders(join(f.root, 'opencode'))
    await ensureOpenCodeFolders(folders)
    // The Sotto that started them has gone.
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
    const owner = gone.pid!
    await new Promise(done => gone.once('close', done))
    const startedAt = Date.now()
    // A server Sotto started before it crashed, still running.
    const left = spawned([resolve('tests/fixtures/fakeOpenCodeServer.mjs'), f.root, 'serve', '--hostname=127.0.0.1', '--port=0'], opencodeEnvironment(process.env, folders, opencodePassword()))
    // Processes that are not servers the crashed Sotto left: one started an hour before its record says, one that is no
    // OpenCode server, and one whose Sotto is still running.
    const late = spawned(['-e', 'setInterval(() => {}, 1000)', 'serve', '--hostname=127.0.0.1', '--port=0'])
    const other = spawned(['-e', 'setInterval(() => {}, 1000)'])
    const owned = spawned(['-e', 'setInterval(() => {}, 1000)', 'serve', '--hostname=127.0.0.1', '--port=0'])
    const ledger = opencodeServerLedger(folders)
    // Written down as Sotto writes a server down: by its own clock, and on macOS and Linux by when the system says it started.
    const started = async (pid: number, offset = 0): Promise<{ started?: number }> => {
      const reported = await systemProcessStart(pid)
      return reported === undefined ? {} : { started: reported + offset }
    }
    await recordOpenCodeServer(ledger, { pid: left, startedAt, ...await started(left), owner })
    await recordOpenCodeServer(ledger, { pid: late, startedAt: startedAt + 3_600_000, ...await started(late, 3_600_000), owner })
    await recordOpenCodeServer(ledger, { pid: other, startedAt, ...await started(other), owner })
    await recordOpenCodeServer(ledger, { pid: owned, startedAt, ...await started(owned), owner: process.pid })
    if (process.platform !== 'win32') expect(JSON.parse(await readFile(join(ledger, `${left}.json`), 'utf8'))).toHaveProperty('started')
    // The left server has made its database, so the connect check's server does not race it.
    await expect.poll(() => existsSync(opencodeDatabase(folders)), { timeout: 15_000 }).toBe(true)
    await f.host.connect()
    // Connect sweeps before it starts anything; what is left to wait for is this process reaping the server it ended.
    await expect.poll(() => running(left), { timeout: 30_000 }).toBe(false)
    expect([late, other, owned].map(running)).toEqual([true, true, true])
    // What was swept is no longer written down; the record of a running Sotto's server stays.
    expect((await readdir(ledger)).sort()).toEqual([`${owned}.json`])
    await rm(join(ledger, `${owned}.json`))
    // A thread's server is written down while it runs, and its record goes with it.
    const id = randomUUID()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Written down' })
    const serving = await f.holder(id)
    expect(await readdir(ledger)).toEqual([`${serving}.json`])
    expect(JSON.parse(await readFile(join(ledger, `${serving}.json`), 'utf8'))).toMatchObject({ pid: serving, owner: process.pid })
    f.host.disconnect(); await f.host.closed()
    expect(await readdir(ledger)).toEqual([])
  } finally {
    for (const child of strays) if (child.pid !== undefined && running(child.pid)) process.kill(child.pid)
    await f.cleanup()
  }
})

it('keeps a steer in the turn it joined when the thread is restored', async () => {
  const { f, id } = await open()
  let restarted: Fixture | undefined
  try {
    await send(f, id, 'first')
    await f.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'steered', text: 'Also check the tests' })
    await f.action(id, { type: 'tool', name: 'shell', input: { command: 'npm test' }, output: 'ok' })
    await expect.poll(async () => (await thread(f, id)).activities?.some(activity => activity.command === 'npm test')).toBe(true)
    await f.driver.completeTurn(id, 'Done')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    const before = await thread(f, id)
    const placed = (activities: typeof before.activities) => activities?.filter(activity => activity.kind === 'command').map(activity => [activity.command, activity.turnId, activity.afterMessageId])
    expect(placed(before.activities)).toEqual([['npm test', 'first', 'steered']])
    restarted = await f.driver.restart()
    restarted.host.useThreadHistory!({ messageIdentities: threadId => threadId === id ? before.messages.map(({ id: messageId, role }) => ({ id: messageId, role })) : [] })
    restarted.host.observeThreads?.([id]); await restarted.host.connect()
    await expect.poll(async () => placed((await thread(restarted!, id)).activities)?.length ?? 0).toBe(1)
    expect(placed((await thread(restarted, id)).activities)).toEqual(placed(before.activities))
  } finally { await (restarted ?? f).cleanup() }
})

it('settles a steered turn its server never finished under the prompt that started it', async () => {
  const { f, id } = await open()
  let restarted: Fixture | undefined
  try {
    await send(f, id, 'first')
    await f.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'steered', text: 'Also check the tests' })
    await f.action(id, { type: 'tool', name: 'shell', input: { command: 'ping -n 90 127.0.0.1' }, running: true })
    await expect.poll(async () => (await thread(f, id)).activities?.some(activity => activity.kind === 'command')).toBe(true)
    restarted = await f.driver.restart()
    // Sotto stopped before it could save what it saw: only the provider session shows the turn never ended.
    const saved = JSON.parse(await readFile(join(f.root, 'opencode-threads.json'), 'utf8')) as Record<string, { endedTurn?: unknown }>
    delete saved[id]!.endedTurn
    await writeFile(join(f.root, 'opencode-threads.json'), JSON.stringify(saved))
    restarted.host.observeThreads?.([id]); await restarted.host.connect()
    await expect.poll(async () => (await thread(restarted!, id)).lastTurn).toEqual({ id: 'first', status: 'interrupted' })
    const resumed = await thread(restarted, id)
    expect(resumed.activities?.find(activity => activity.kind === 'command')).toMatchObject({ turnId: 'first', status: 'interrupted' })
    expect(resumed.activities?.some(activity => activity.turnId === 'steered')).toBe(false)
  } finally { await (restarted ?? f).cleanup() }
})

it('names as signed in only the model sources whose models it offers', async () => {
  const f = await opencodeFixture()
  try {
    await f.script({
      providers: [{ id: 'opencode', name: 'OpenCode', activation: 'enabled' }, { id: 'anthropic', name: 'Anthropic', activation: 'enabled' }],
      models: [{ id: 'fixture-model', providerID: 'opencode', name: 'Fixture Model', capabilities: { input: ['text'] }, variants: [], enabled: true, status: 'active' },
        { id: 'retired', providerID: 'anthropic', name: 'Retired', capabilities: { input: ['text'] }, variants: [], enabled: true, status: 'deprecated' }],
    })
    const snapshot = await f.host.connect()
    expect(snapshot.models.map(model => model.id)).toEqual(['opencode/fixture-model'])
    expect(snapshot.account).toBe('No model source signed in yet; OpenCode Zen’s free models only')
  } finally { await f.cleanup() }
})

it('retires a thread that was opening during an update once its opening completes and it is idle', { timeout: 60_000 }, async () => {
  const { f, id } = await open()
  try {
    await expect.poll(async () => f.holder(id)).toBeDefined()
    const first = await f.holder(id)
    // On a fresh connection the thread opens when it is shown; its reads are held so the update lands meanwhile.
    f.host.observeThreads?.([])
    f.host.disconnect(); await f.host.closed()
    await f.host.connect()
    // Each read is held under the request deadline, so the opening lasts about four seconds.
    await f.script({ delay: { 'session.get': 2_000, 'session.messages': 2_000 } })
    f.host.observeThreads?.([id])
    await expect.poll(async () => (await f.driver.requests()).filter(record => record.method === 'session.get').length, { timeout: 15_000 }).toBe(1)
    // The newer client is installed with the history read still held.
    await f.script({ version: '2.0.40', delay: { 'session.messages': 2_000 } })
    await f.host.clientUpdated!()
    // The server the opening runs on holds the session once its held read is answered.
    await expect.poll(async () => { const holder = await f.holder(id); return holder !== undefined && holder !== first }, { timeout: 15_000 }).toBe(true)
    const opening = await f.holder(id)
    // The thread is idle once open, so its outdated server stops and the watched thread opens again on a fresh one.
    await expect.poll(async () => { const holder = await f.holder(id); return holder !== undefined && holder !== opening }, { timeout: 15_000 }).toBe(true)
    expect((await f.host.snapshot()).version).toContain('2.0.40')
  } finally { await f.cleanup() }
})
