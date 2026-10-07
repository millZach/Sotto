// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { unreadableRequest } from '../../src/main/agents/nativeRequests'

const fixtures: { cleanup(): Promise<void> }[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup() })

it.each([
  { provider: 'Codex', method: 'item/commandExecution/requestApproval', params: { itemId: null } },
  { provider: 'Codex', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: null }] } },
  { provider: 'Codex', method: 'mcpServer/elicitation/request', params: { message: null } },
  { provider: 'Grok', method: 'session/request_permission', params: { toolCall: { toolCallId: 'tool' }, options: [{ optionId: 'new', name: 'New choice', kind: 'new_kind' }] } },
  { provider: 'Grok', method: 'x.ai/ask_user_question', params: { questions: [{ question: 'Which?', options: null }] } },
])('refuses an unreadable $provider $method and keeps its turn working', async ({ provider, method, params }) => {
  const f = provider === 'Codex' ? await codexFixture() : await grokFixture()
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const threadId = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, modelId: f.modelId, title: 'Test' })
  await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId, text: 'Synthetic prompt' })
  await f.action(threadId, { type: provider === 'Codex' ? 'question' : 'unreadable', text: 'Choose', method, params })
  await expect.poll(async () => (await f.host.snapshot()).error).toBe(unreadableRequest(provider))
  await expect.poll(async () => (await f.driver.requests()).some(record => 'error' in record)).toBe(true)
  const snapshot = await f.host.snapshot()
  expect(snapshot.connected).toBe(true)
  expect(snapshot.threads.find(thread => thread.id === threadId)).toMatchObject({ status: 'running', requests: [] })
  await f.driver.completeTurn(threadId, 'Finished')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === threadId)?.status).toBe('idle')
})

it('keeps unreadable Grok request notices on the asking thread', async () => {
  const f = await grokFixture()
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const threadIds = [randomUUID(), randomUUID()]
  for (const threadId of threadIds) {
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, modelId: f.modelId, title: 'Test' })
    await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId, text: 'Synthetic prompt' })
  }
  const notice = unreadableRequest('Grok')
  for (const [index, threadId] of threadIds.entries()) {
    await f.action(threadId, { type: 'unreadable', method: 'x.ai/ask_user_question', params: { questions: [{ question: 'Which?', options: null }] } })
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === threadId)?.requestNotice).toBe(notice)
    const snapshot = await f.host.snapshot()
    expect(snapshot.connected).toBe(true)
    expect(snapshot.threads.find(thread => thread.id === threadId)).toMatchObject({ status: 'running', requests: [] })
    if (index === 0) expect(snapshot.threads.find(thread => thread.id === threadIds[1])?.requestNotice).toBeUndefined()
  }
  await expect.poll(async () => (await f.driver.requests()).filter(record => 'error' in record).length).toBe(2)
  for (const threadId of threadIds) {
    await f.driver.completeTurn(threadId, 'Finished')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === threadId)?.status).toBe('idle')
  }
})
