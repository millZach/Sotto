// @vitest-environment node
import { expect, it } from 'vitest'
import { sendOutcome } from '../../../src/main/agents/sendOutcome'
import type { AgentDelivery, AgentFollowup, AgentState } from '../../../src/shared/agents'

const identity = { threadId: 'thread', draftId: 'draft' }
const at = '2026-11-09T00:00:00.000Z'
const delivery = (status: AgentDelivery['status']): AgentDelivery => ({ ...identity, status, createdAt: at, updatedAt: at })
const queued = (status: AgentFollowup['status']): AgentFollowup => ({ ...identity, id: 'item', status, text: 'prompt', attachments: [], createdAt: at, updatedAt: at })
const outcome = (state: Partial<AgentState>) => sendOutcome({ error: null, ...state }, identity.threadId, identity.draftId).status

it('requires delivery evidence, not an empty error or a past queue receipt', () => {
  expect(outcome({})).toBe('unconfirmed')
  expect(outcome({ followupReceipts: [identity] })).toBe('unconfirmed')
  expect(sendOutcome(undefined, identity.threadId, identity.draftId).status).toBe('unconfirmed')
})
it('matches both thread and draft for delivery and receipts', () => {
  expect(outcome({ deliveries: [{ ...delivery('accepted'), threadId: 'other' }], deliveredDrafts: [{ ...identity, draftId: 'other' }] })).toBe('unconfirmed')
  expect(outcome({ deliveredDrafts: [identity] })).toBe('accepted')
})
it.each<AgentDelivery['status']>(['accepted', 'uncertain', 'submitting', 'failed', 'queued'])('translates a %s delivery', status => {
  expect(outcome({ deliveries: [delivery(status)] })).toBe(status === 'submitting' ? 'uncertain' : status)
})
it.each<AgentFollowup['status']>(['queued', 'paused', 'dispatching', 'uncertain', 'failed'])('translates a current %s queue item', status => {
  expect(outcome({ followups: [queued(status)] })).toBe(status === 'paused' ? 'queued' : status === 'dispatching' ? 'uncertain' : status)
})
it('keeps positive delivery evidence when a later command error is present', () => {
  expect(outcome({ deliveries: [delivery('accepted')], error: 'Later save failed' })).toBe('accepted')
  expect(outcome({ error: 'Send refused' })).toBe('failed')
})
