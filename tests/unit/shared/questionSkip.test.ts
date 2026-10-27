// @vitest-environment node
import { expect, it } from 'vitest'
import { agentCommandSchema, agentRequestSchema } from '../../../src/shared/agents'
import { watcherPhoneAnswerSchema } from '../../../src/shared/watcherPhone'

const answer = { type: 'answer', threadId: 'thread', requestId: 'request', answer: '' } as const

it('takes a skip as its own answer shape, and an answer from a client that predates it as before', () => {
  expect(agentCommandSchema.parse({ ...answer, skipped: true })).toMatchObject({ skipped: true })
  expect(agentCommandSchema.parse(answer)).not.toHaveProperty('skipped')
  expect(agentCommandSchema.safeParse({ ...answer, skipped: false }).success).toBe(false)
  expect(watcherPhoneAnswerSchema.parse({ target: { hostId: '00000000-0000-4000-8000-000000000000', threadId: 'watcher' }, command: { ...answer, skipped: true } }).command).toMatchObject({ skipped: true })
})

it('marks a question its provider lets the user skip, and leaves a request from an older host unmarked', () => {
  const request = { id: 'request', kind: 'question', text: 'Which?' } as const
  expect(agentRequestSchema.parse({ ...request, skippable: true }).skippable).toBe(true)
  expect(agentRequestSchema.parse(request).skippable).toBeUndefined()
})
