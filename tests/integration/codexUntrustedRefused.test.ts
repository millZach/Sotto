// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ASK_FOR_APPROVAL_REFUSED } from '../../src/main/agents/codex'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { codexFixture } from '../fixtures/codexFixture'

// #2185, ADR-0005's November 5 amendment: Codex 0.165 and newer refuse `untrusted` in config. A Codex that refuses it on
// a request too turns Ask for approval off for that Codex: the request fails with a plain line, nothing runs, and the
// mode is offered as refused rather than replaced with a policy that asks less.

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.cleanup() })

async function fixture() {
  const f = await codexFixture(); fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const create = (runtimeMode: AgentRuntimeMode, threadId = randomUUID()) => f.host.execute({ type: 'create-thread', threadId, commandId: randomUUID(),
    projectId: f.projectId, modelId: f.modelId, title: 'Thread', runtimeMode }).then(result => ({ result, threadId }))
  const model = async () => (await f.host.snapshot()).models.find(candidate => candidate.id === f.modelId)!
  const sent = async (method: string) => (await f.driver.requests()).filter(request => request.method === method).length
  return { f, create, model, sent }
}

describe('a Codex that refuses Ask for approval (#2185)', () => {
  it('refuses a new thread on it with a plain line, then offers it as refused and refuses it before asking Codex', async () => {
    const { f, create, model, sent } = await fixture()
    expect((await model()).runtimeModes).toContain('approval-required')
    await f.script({ refuseUntrusted: true })

    await expect(create('approval-required')).rejects.toThrow(ASK_FOR_APPROVAL_REFUSED)
    expect((await f.host.snapshot()).threads).toHaveLength(0)
    expect(await model()).toMatchObject({ runtimeModes: ['auto-accept-edits', 'auto', 'full-access'], refusedRuntimeModes: ['approval-required'] })

    const starts = await sent('thread/start')
    await expect(create('approval-required')).rejects.toThrow(ASK_FOR_APPROVAL_REFUSED)
    expect(await sent('thread/start')).toBe(starts)
    expect((await create('auto-accept-edits')).result).toEqual({ accepted: true })
  })

  it('refuses a change to it and keeps the thread on its mode', async () => {
    const { f, create, model } = await fixture()
    const { threadId } = await create('auto-accept-edits')
    await f.script({ refuseUntrusted: true })

    await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId, runtimeMode: 'approval-required' })).rejects.toThrow(ASK_FOR_APPROVAL_REFUSED)
    expect((await f.host.snapshot()).threads.find(thread => thread.id === threadId)?.runtimeMode).toBe('auto-accept-edits')
    expect((await model()).refusedRuntimeModes).toEqual(['approval-required'])
  })

  it('refuses a send on a thread already on it, and nothing runs', async () => {
    const { f, create, model, sent } = await fixture()
    const { threadId } = await create('approval-required')
    await f.script({ refuseUntrusted: true })

    await expect(f.host.execute({ type: 'send', threadId, commandId: randomUUID(), messageId: randomUUID(), text: 'Hello' })).rejects.toThrow(ASK_FOR_APPROVAL_REFUSED)
    expect((await f.host.snapshot()).threads.find(thread => thread.id === threadId)).toMatchObject({ status: 'idle', messages: [] })
    expect((await model()).refusedRuntimeModes).toEqual(['approval-required'])

    const turns = await sent('turn/start')
    await expect(f.host.execute({ type: 'send', threadId, commandId: randomUUID(), messageId: randomUUID(), text: 'Again' })).rejects.toThrow(ASK_FOR_APPROVAL_REFUSED)
    expect(await sent('turn/start')).toBe(turns)
  })

  it('leaves the mode on when Codex refuses a request that did not carry it', async () => {
    const { f, create, model } = await fixture()
    await f.script({ refuseUntrusted: 'always' })

    const refused = create('auto-accept-edits')
    await expect(refused).rejects.toThrow()
    await expect(refused).rejects.not.toThrow(ASK_FOR_APPROVAL_REFUSED)
    expect((await model()).runtimeModes).toContain('approval-required')
    expect((await model()).refusedRuntimeModes).toBeUndefined()
  })

  it('offers it again once another version of Codex runs', async () => {
    const { f, create, model } = await fixture()
    await f.script({ refuseUntrusted: true })
    await expect(create('approval-required')).rejects.toThrow(ASK_FOR_APPROVAL_REFUSED)

    await f.script({ version: 'codex/0.200.0' })
    f.host.disconnect(); await f.adapter.closed()
    await f.host.connect()
    expect((await model()).runtimeModes).toContain('approval-required')
    expect((await model()).refusedRuntimeModes).toBeUndefined()
    expect((await create('approval-required')).result).toEqual({ accepted: true })
  })
})
