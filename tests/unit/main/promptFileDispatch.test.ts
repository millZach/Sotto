// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { claudeFixture } from '../../fixtures/claudeFixture'
import { grokFixture } from '../../fixtures/fakeGrokThreadFixture'
import { codexFixture } from '../../fixtures/codexFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const FILES = [{ path: 'docs/plan.md' }]
const TEXT = 'Read @docs/plan.md and summarise it'

// The composer's token is already the provider-facing form, so this proves the real dispatch keeps it
// intact end to end and that a mention the user deleted never travels as a stale path.
for (const provider of ['claude', 'grok'] as const) it(`${provider} receives a mentioned file as @docs/plan.md through a real send`, async () => {
  const f = provider === 'claude' ? await claudeFixture() : await grokFixture()
  cleanups.push(() => f.cleanup())
  const threadId = randomUUID()
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 't', threadId, projectId: 'p', modelId: f.modelId, title: 'T' })
  expect(await f.host.execute({ type: 'send', commandId: 'send', messageId: 'user', threadId, text: TEXT, files: FILES })).toEqual({ accepted: true })
  await f.driver.completeTurn(threadId, 'Read')
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.status).toBe('idle')
  const prompts = (await f.driver.requests()).filter(r => r.method === (provider === 'claude' ? 'user' : 'session/prompt'))
  expect(JSON.stringify(prompts)).toContain('@docs/plan.md')
  await expect(f.host.execute({ type: 'send', commandId: 'stale', messageId: 'stale', threadId, text: 'Read the plan', files: FILES }))
    .rejects.toThrow(/no longer in this prompt/u)
  await expect(f.host.execute({ type: 'send', commandId: 'spaced', messageId: 'spaced', threadId, text: 'Read @my notes.md', files: [{ path: 'my notes.md' }] }))
    .rejects.toThrow(/space/u)
  expect((await f.driver.requests()).filter(r => r.method === (provider === 'claude' ? 'user' : 'session/prompt'))).toHaveLength(1)
})

it('codex receives a mentioned file as @docs/plan.md through a real turn', async () => {
  const f = await codexFixture(undefined, true)
  cleanups.push(() => f.cleanup())
  const threadId = randomUUID()
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Files', modelId: f.modelId })
  await f.host.execute({ type: 'send', commandId: 'send', messageId: 'message', threadId, text: TEXT, files: FILES })
  expect((await f.driver.requests()).findLast(r => r.method === 'turn/start')?.params?.input).toEqual([{ type: 'text', text: TEXT }])
  await f.driver.completeTurn(threadId, 'Read')
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.status).toBe('idle')
  await expect(f.host.execute({ type: 'send', commandId: 'stale', messageId: 'stale', threadId, text: 'Read the plan', files: FILES }))
    .rejects.toThrow(/no longer in this prompt/u)
  await expect(f.host.execute({ type: 'send', commandId: 'spaced', messageId: 'spaced', threadId, text: 'Read @my notes.md', files: [{ path: 'my notes.md' }] }))
    .rejects.toThrow(/space/u)
  expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(1)
})
