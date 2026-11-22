// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAntigravityChild } from '../../../src/main/agents/antigravityChildren'

// The records agy 1.5.14 wrote for a parent that launched one child, read live on November 21, 2026 (ids shortened).
const PARENT = 'b6a16745-4f3f-4712-8084-bba4df9c5ae0', CHILD = 'ce42f6a1-2bb2-4038-8815-5bc19a14894a', CALL = 'call_5759505500507281460'

describe('a child agy launched, read from its records', () => {
  let appData = ''
  const generated = (conversation: string, ...rest: string[]) => join(appData, 'brain', conversation, '.system_generated', ...rest)
  const put = async (path: string, value: unknown) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)) }
  const record = (state = 'SUBAGENT_STATE_ALIVE') => put(generated(PARENT, 'subagents', `${CHILD}.json`),
    { conversationId: CHILD, subagentDescriptor: { typeName: 'self', role: 'Kestrel Responder' }, state, spawnStepIndex: 2 })
  const launch = (call = CALL) => put(generated(CHILD, 'messages', 'a6f0d935.json'), { id: 'a6f0d935', recipient: CHILD, sender: PARENT,
    content: 'Reply with the word KESTREL and nothing else.', timestamp: '2026-11-22T03:13:58.111178300Z',
    sourceMetadata: { tool: { conversationId: PARENT, stepIndex: 2, toolCall: { id: call, name: 'invoke_subagent' } } } })
  const answer = (name: string, content: string, timestamp: string) => put(generated(PARENT, 'messages', `${name}.json`),
    { id: name, recipient: PARENT, sender: CHILD, content, timestamp, renderDetails: { messageTitle: 'Message from Kestrel Responder (self)' } })
  beforeEach(async () => { appData = await mkdtemp(join(tmpdir(), 'sotto-agy-children-')) })
  afterEach(async () => { await rm(appData, { recursive: true, force: true }) })

  it('finds the child by the launching tool call and is running until it answers', async () => {
    await record(); await launch()
    expect(await readAntigravityChild(appData, PARENT, CALL)).toEqual({ conversationId: CHILD, status: 'running' })
  })

  it('is done with the child’s newest answer once one is in the parent’s inbox', async () => {
    await record(); await launch()
    await answer('first', 'Working on it', '2026-11-22T03:14:01.000000000Z')
    await answer('last', 'KESTREL', '2026-11-22T03:14:03.510280400Z')
    expect(await readAntigravityChild(appData, PARENT, CALL, CHILD)).toEqual({ conversationId: CHILD, status: 'completed', message: 'KESTREL', completedAt: '2026-11-22T03:14:03.510Z' })
  })

  it('is stopped when the record says the child was killed and it never answered', async () => {
    await record('SUBAGENT_STATE_KILLED'); await launch()
    expect(await readAntigravityChild(appData, PARENT, CALL)).toEqual({ conversationId: CHILD, status: 'interrupted' })
  })

  it('names no child for another tool call, a parent with no records, or a conversation id that is not one', async () => {
    await record(); await launch('call_other')
    expect(await readAntigravityChild(appData, PARENT, CALL)).toBeUndefined()
    expect(await readAntigravityChild(appData, 'a1b2c3d4-0000-0000-0000-000000000000', CALL)).toBeUndefined()
    expect(await readAntigravityChild(appData, '../escape', CALL)).toBeUndefined()
  })
})
