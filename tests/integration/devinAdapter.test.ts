// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { describeAdapterContract } from './adapterContract'
import { devinFixture } from '../fixtures/devinFixture'

describeAdapterContract('Devin ACP', session => devinFixture(undefined, undefined, undefined, session))

describe('Devin dispatch and decision boundaries', () => {
  let f: Awaited<ReturnType<typeof devinFixture>>
  let threadId: string
  const thread = async (id = threadId) => (await f.host.snapshot()).threads.find(thread => thread.id === id)!
  const create = async (): Promise<string> => {
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id,
      projectId: f.projectId, modelId: f.modelId, title: 'Synthetic thread' })
    return id
  }
  const send = (id = threadId, text = 'Identical synthetic prompt') => f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text })
  beforeEach(async () => {
    f = await devinFixture(); await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    threadId = await create(); f.host.observeThreads([threadId])
  })
  afterEach(async () => { await f?.cleanup() })

  it('distinguishes repeated identical prompts and keeps prompt text out of dispatch metadata', async () => {
    await send()
    await f.driver.completeTurn(threadId, 'First reply')
    await expect.poll(async () => (await thread()).status).toBe('idle')
    await send()
    await expect.poll(async () => (await thread()).messages.filter(message => message.role === 'user').length).toBe(2)
    const prompts = (await f.driver.requests()).filter(record => record.method === 'session/prompt')
    const nativeIds = prompts.map(record => (record.params?._meta as Record<string, unknown>)['cognition.ai/clientMessageId'])
    expect(new Set(nativeIds).size).toBe(2)
    expect(await readFile(join(f.root, 'devin-threads.json'), 'utf8')).not.toContain('Identical synthetic prompt')
  })

  it('rejects duplicate permission answers without sending another native decision', async () => {
    await send(); await f.driver.raisePermission(threadId, 'Run synthetic check?')
    await expect.poll(async () => (await thread()).requests.length).toBe(1)
    const requestId = (await thread()).requests[0]!.id
    const answer = { type: 'answer' as const, commandId: randomUUID(), threadId, requestId, answer: '', approved: true }
    expect(await f.host.execute(answer)).toEqual({ accepted: true })
    await expect(f.host.execute({ ...answer, commandId: randomUUID() })).rejects.toThrow('no longer pending')
    await expect.poll(async () => (await f.driver.requests()).filter(record => f.protocol.permissionDecision(record) === true).length).toBe(1)
  })

  it('keeps simultaneous threads and their permission decisions separate', async () => {
    const second = await create(); f.host.observeThreads([threadId, second])
    await Promise.all([send(threadId, 'First thread prompt'), send(second, 'Second thread prompt')])
    await f.driver.raisePermission(threadId, 'First thread permission')
    await expect.poll(async () => (await thread()).requests.length).toBe(1)
    const requestId = (await thread()).requests[0]!.id
    await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: second, requestId, answer: '', approved: true })).rejects.toThrow('no longer pending')
    expect((await thread()).requests).toHaveLength(1)
    expect((await thread(second)).messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Second thread prompt'])
    await f.driver.completeTurn(second, 'Second thread done')
    await expect.poll(async () => (await thread(second)).status).toBe('idle')
    expect((await thread()).status).toBe('running')
    expect((await f.driver.requests()).some(record => f.protocol.permissionDecision(record) === true)).toBe(false)
  })

  it('keeps a missing native session binding and never creates a replacement on resume', async () => {
    await send()
    const native = await f.realId(threadId)
    f = await f.driver.restart(); await f.host.connect()
    const createsBefore = (await f.driver.requests()).filter(record => record.method === 'session/new').length
    await rm(join(f.root, `native-${native}.json`))
    f.host.observeThreads([threadId])
    await expect.poll(async () => (await thread()).status).toBe('error')
    expect(await f.realId(threadId)).toBe(native)
    expect((await f.driver.requests()).filter(record => record.method === 'session/new')).toHaveLength(createsBefore)
  })

  it('reconciles the same dispatch identity without transmitting it again', async () => {
    const command = { type: 'send' as const, commandId: randomUUID(), messageId: randomUUID(), threadId, text: 'One synthetic dispatch' }
    expect(await f.host.execute(command)).toEqual({ accepted: true })
    expect(await f.host.execute(command)).toEqual({ accepted: true })
    expect((await f.driver.requests()).filter(record => record.method === 'session/prompt')).toHaveLength(1)
    await expect(f.host.execute({ ...command, text: 'Changed content with reused identity' })).rejects.toThrow('already in use')
    expect((await f.driver.requests()).filter(record => record.method === 'session/prompt')).toHaveLength(1)
  })

  it('refuses a changed native model on resume without substituting it or sending', async () => {
    await send()
    const native = await f.realId(threadId)
    f = await f.driver.restart(); await f.host.connect()
    await f.script({ replayModel: 'different-model', loadModel: 'different-model' })
    await expect(f.host.refreshThread(threadId)).rejects.toThrow('Restore the original model in Devin')
    f.host.observeThreads([threadId])
    await expect.poll(async () => (await thread()).status).toBe('error')
    expect((await thread()).modelId).toBe(f.modelId)
    expect(await f.realId(threadId)).toBe(native)
    expect((await f.driver.requests()).filter(record => record.method === 'session/prompt')).toHaveLength(1)
  })

  it('checks the final loaded model after replaying earlier model updates', async () => {
    await send()
    await f.driver.completeTurn(threadId, 'Finished')
    await expect.poll(async () => (await thread()).status).toBe('idle')
    f = await f.driver.restart(); await f.host.connect()
    await f.script({ replayModel: 'earlier-model' })
    await f.host.refreshThread(threadId)
    expect((await thread()).status).toBe('idle')
    expect((await thread()).modelId).toBe(f.modelId)
    expect((await f.driver.requests()).filter(record => record.method === 'session/prompt')).toHaveLength(1)
  })

  it('fails a malformed native stream while preserving the binding and confirmed authored message', async () => {
    await send()
    const native = await f.realId(threadId)
    await f.action(threadId, { type: 'malformed' })
    await expect.poll(async () => (await thread()).status).toBe('error')
    expect(await f.realId(threadId)).toBe(native)
    expect((await thread()).lastTurn?.status).toBe('failed')
    expect((await thread()).activities?.some(activity => activity.status === 'running')).toBe(false)
    expect((await thread()).messages.some(message => message.role === 'user')).toBe(true)
  })

  it('keeps Sotto history in memory when local history is off', async () => {
    const directory = join(f.root, 'sotto-workspace')
    const workspace = new WorkspaceHost(f.host, directory, () => false)
    try {
      await workspace.initialize(); workspace.observeThreads([threadId])
      await send(threadId, 'PRIVATE_DEVIN_SYNTHETIC_PROMPT')
      await f.driver.completeTurn(threadId, 'PRIVATE_DEVIN_SYNTHETIC_REPLY')
      await expect.poll(() => workspace.threadMessages(threadId).some(message => message.text === 'PRIVATE_DEVIN_SYNTHETIC_REPLY')).toBe(true)
      await workspace.privacyChanged()
      for (const name of await readdir(directory)) {
        const bytes = await readFile(join(directory, name)).catch(() => Buffer.alloc(0))
        expect(bytes.toString('utf8')).not.toContain('PRIVATE_DEVIN_SYNTHETIC_')
      }
      expect(await readFile(join(f.root, 'devin-threads.json'), 'utf8')).not.toContain('PRIVATE_DEVIN_SYNTHETIC_')
    } finally { workspace.dispose() }
  })

  it('admits only one concurrent send to the same thread', async () => {
    const sends = await Promise.allSettled([send(), send()])
    expect(sends.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(sends.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await f.driver.requests()).filter(record => record.method === 'session/prompt')).toHaveLength(1)
  })

  it('admits only one concurrent native creation for the same thread ID', async () => {
    const id = randomUUID()
    const before = (await f.driver.requests()).filter(record => record.method === 'session/new').length
    const command = { type: 'create-thread' as const, commandId: randomUUID(), threadId: id,
      projectId: f.projectId, modelId: f.modelId, title: 'One creation' }
    const creates = await Promise.allSettled([f.host.execute(command), f.host.execute({ ...command, commandId: randomUUID() })])
    expect(creates.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(creates.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await f.driver.requests()).filter(record => record.method === 'session/new')).toHaveLength(before + 1)
  })

  it('refuses a changed request reusing the same native wire ID without approving it', async () => {
    await send(); await f.driver.raisePermission(threadId, 'Original action')
    await expect.poll(async () => (await thread()).requests.length).toBe(1)
    const requestId = (await thread()).requests[0]!.id
    await f.action(threadId, { type: 'changed-permission', text: 'Different action' })
    await expect.poll(async () => (await thread()).status).toBe('error')
    await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId, requestId, answer: '', approved: true })).rejects.toThrow()
    expect((await f.driver.requests()).some(record => f.protocol.permissionDecision(record) === true)).toBe(false)
  })

  it.each(['interrupt', 'disconnect'] as const)('keeps failed acceptance observation uncertain after %s', async action => {
    await f.script({ rejectLoadAfterPrompt: true })
    expect(await send()).toEqual({ accepted: false, uncertain: true })
    if (action === 'interrupt') await f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId })
    else { f.host.disconnect(); await f.adapter.closed() }
    expect((await f.driver.requests()).filter(record => record.method === 'session/prompt')).toHaveLength(1)
    const aliases = JSON.parse(await readFile(join(f.root, 'devin-threads.json'), 'utf8'))
    expect(aliases[threadId].origins).toHaveLength(1)
    expect(aliases[threadId].origins[0].confirmed).toBe(false)
  })


  it('marks interrupted work settled when the provider is disconnected', async () => {
    await send()
    await f.driver.raisePermission(threadId, 'Pending action')
    await expect.poll(async () => (await thread()).requests.length).toBe(1)
    f.host.disconnect(); await f.adapter.closed()
    const stopped = await thread()
    expect(stopped.status).toBe('idle')
    expect(stopped.lastTurn?.status).toBe('interrupted')
    expect(stopped.activities?.some(activity => activity.status === 'running')).toBe(false)
    expect(stopped.requests).toHaveLength(0)
    expect((await f.driver.requests()).some(record => f.protocol.permissionDecision(record) === true)).toBe(false)
  })

  it('does not recreate an empty session whose owner crashed', async () => {
    const native = await f.realId(threadId)
    await f.action(threadId, { type: 'malformed' })
    await expect.poll(async () => (await thread()).status).toBe('error')
    f = await f.driver.restart(); await f.host.connect()
    const createsBefore = (await f.driver.requests()).filter(record => record.method === 'session/new').length
    await expect(f.adapter.refreshThread(threadId)).rejects.toThrow('Devin could not find this saved session')
    expect(await f.realId(threadId)).toBe(native)
    expect((await f.driver.requests()).filter(record => record.method === 'session/new')).toHaveLength(createsBefore)
  })

  it('keeps creation uncertain after losing its acknowledgement instead of creating again', async () => {
    await f.script({ delayCreate: 30_000 })
    const command = { type: 'create-thread' as const, commandId: randomUUID(), threadId: randomUUID(),
      projectId: f.projectId, modelId: f.modelId, title: 'Uncertain creation' }
    const createsBefore = (await f.driver.requests()).filter(record => record.method === 'session/new').length
    const creation = f.host.execute(command)
    await expect.poll(async () => (await f.driver.requests()).filter(record => record.method === 'session/new').length).toBe(createsBefore + 1)
    f.host.disconnect(); await f.adapter.closed()
    expect(await creation).toEqual({ accepted: false, uncertain: true })
    await f.script({})
    f = await f.driver.restart(); await f.host.connect()
    const createsAfterReconnect = (await f.driver.requests()).filter(record => record.method === 'session/new').length
    expect(await f.host.execute(command)).toEqual({ accepted: false, uncertain: true })
    expect((await f.driver.requests()).filter(record => record.method === 'session/new')).toHaveLength(createsAfterReconnect)
  })

  it('rejects model changes and unsupported prompt controls before native dispatch', async () => {
    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId, modelId: f.modelId })).rejects.toThrow('only change this thread')
    await expect(send(threadId, '/compact')).rejects.toThrow('not supported')
    expect((await f.driver.requests()).filter(record => record.method === 'session/prompt')).toHaveLength(0)
  })

  it('offers Devin its own permission modes and starts every thread on the asking one', async () => {
    const model = (await f.host.snapshot()).models.find(candidate => candidate.id === f.modelId)!
    expect(model.runtimeModes ?? []).toEqual([])
    expect(model.providerModes?.map(mode => mode.id)).toEqual(['ask-first', 'accept-edits', 'smart', 'plan', 'ask', 'bypass'])
    // Every mode says what Sotto will still put to the user under it, including the one named for not asking.
    expect(model.providerModes?.every(mode => (mode.asks ?? '').length > 0)).toBe(true)
    expect(model.providerModes?.find(mode => mode.id === 'bypass')?.asks).toMatch(/nothing/iu)
    expect(await thread()).toMatchObject({ providerMode: 'ask-first', runtimeMode: 'approval-required' })
  })

  it('changes a thread\u2019s permission mode by moving it onto that mode\u2019s own profile', async () => {
    await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId, providerMode: 'bypass' })
    expect(await thread()).toMatchObject({ providerMode: 'bypass', runtimeMode: 'full-access' })
    // The grant lives in a profile of its own, written and confirmed before the thread runs under it.
    const profile = JSON.parse(await readFile(join(f.root, 'devin', 'approval-policy-v1-everything.json'), 'utf8'))
    expect(profile.permissions).toMatchObject({ ask: [] })
    expect(profile.permissions.allow).toEqual(expect.arrayContaining(['edit', 'exec']))
    // The session is left stopped; the next action resumes it under the new profile and sets it back to the
    // recorded mode. The send itself has to go through: a profile checked as the wrong allowance fails closed.
    const prompts = (await f.driver.requests()).filter(record => record.method === 'session/prompt').length
    expect(await send()).toMatchObject({ accepted: true })
    const requests = await f.driver.requests()
    expect(requests.filter(record => record.method === 'session/prompt')).toHaveLength(prompts + 1)
    const mode = requests.filter(record => record.method === 'session/set_config_option' && record.params?.configId === 'mode').at(-1)
    expect(mode?.params).toMatchObject({ value: 'bypass' })
    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId, providerMode: 'not-a-mode' })).rejects.toThrow('does not offer')
    expect(await thread()).toMatchObject({ providerMode: 'bypass' })
  })

  it('refuses a permission change while a turn is running, and leaves the recorded mode alone', async () => {
    await send()
    // The running turn already chose its profile; changing the mode under it would leave the two out of step.
    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId, providerMode: 'bypass' })).rejects.toThrow(/permission setting is unchanged/u)
    expect(await thread()).toMatchObject({ providerMode: 'ask-first' })
    await f.driver.completeTurn(threadId, 'Done')
    await expect.poll(async () => (await thread()).status).toBe('idle')
  })
})
