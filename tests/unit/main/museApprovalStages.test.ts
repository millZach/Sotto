// @vitest-environment node
import { expect, it } from 'vitest'
import { agentRequestSchema } from '../../../src/shared/agents'
import { museApprovalPending, museApprovalRefreshed, type MuseApproval } from '../../../src/main/agents/museRequests'

const approval: MuseApproval = {
  approvalId: 'native-approval', sessionId: 'session', turnId: 'turn', toolName: 'bash', toolCallId: 'call', itemId: 'item', rawArgs: '',
  subject: { kind: 'shell', command: 'build && test' },
  availableChoices: [{ choiceId: 'yes', decision: 'approved', label: 'Allow once', scope: 'once' }],
  currentRequirementId: { approvalId: 'native-approval', sourceIndex: 0 },
}

it('gives each native requirement a bounded stable request ID independent of property ordering', () => {
  const first = museApprovalPending('thread', approval)
  const same = museApprovalPending('thread', { ...approval, currentRequirementId: { sourceIndex: 0, approvalId: approval.approvalId } })
  const second = museApprovalPending('thread', { ...approval, currentRequirementId: { approvalId: approval.approvalId, sourceIndex: 1 } })
  expect(same.request.id).toBe(first.request.id)
  expect(second.request.id).not.toBe(first.request.id)
  expect(agentRequestSchema.safeParse(second.request).success).toBe(true)
  expect(second.request.id.length).toBeLessThan(100)
})

it('makes an updated stage a fresh request without changing the earlier answer delivery record', () => {
  const first = museApprovalPending('thread', approval)
  first.answering = true; first.request.delivery = 'uncertain'
  const second = museApprovalRefreshed(first, { approvalId: approval.approvalId, sessionId: approval.sessionId,
    subject: { kind: 'shell', command: 'test' }, availableChoices: approval.availableChoices,
    currentRequirementId: { approvalId: approval.approvalId, sourceIndex: 1 } })
  expect(second.request.id).not.toBe(first.request.id)
  expect(second.request.text).toBe('Run a command: test')
  expect(second.request.delivery).toBeUndefined()
  expect(second.answering).toBeUndefined()
  expect(first.request.delivery).toBe('uncertain')
  expect(first.approval.currentRequirementId.sourceIndex).toBe(0)
})
