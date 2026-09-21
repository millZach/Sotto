// @vitest-environment node
import { expect, it } from 'vitest'
import { e2eAgentEventSchema } from '../../../src/shared/e2e'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'

it('bounds synthetic history injection and updates one assistant message without changing thread identity or another thread', async () => {
  const message = { id: 'retained', role: 'user' as const, text: 'Retained prompt', createdAt: '2026-09-01T00:00:00.000Z' }
  expect(e2eAgentEventSchema.safeParse({ type: 'history', threadId: 'workshop', text: '', messages: Array(4_001).fill(message) }).success).toBe(false)
  const host = new E2EAgentHost()
  host.event(e2eAgentEventSchema.parse({ type: 'history', threadId: 'workshop', text: '', messages: [message], status: 'idle' }))
  for (const text of ['First delta', 'First delta plus second']) host.event(e2eAgentEventSchema.parse({ type: 'stream', threadId: 'workshop', messageId: 'streaming', text, status: 'running' }))
  const snapshot = await host.snapshot()
  expect(snapshot.threads.map(thread => thread.id)).toEqual(['workshop', 'docs'])
  expect(snapshot.threads[0]!.messages.map(message => [message.id, message.text])).toEqual([['retained', 'Retained prompt'], ['streaming', 'First delta plus second']])
  expect(snapshot.threads[1]!.messages).toEqual([])
})
