// @vitest-environment node
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fixture, registerAgentControlRecoveryCleanup } from '../../fixtures/agentControlRecovery'

registerAgentControlRecoveryCleanup()

describe('question draft recovery', () => {

  it.each(['another-question', 'another-thread'] as const)('preserves the current draft when a confirmed option answers %s', async target => {
    const f = await fixture()
    f.host.event({ type: 'question', threadId: 'workshop', text: 'Choose colors.', requestId: 'workshop-colors' })
    const answeredThread = target === 'another-question' ? 'workshop' : 'docs'
    f.host.event({ type: 'question', threadId: answeredThread, text: 'Choose the heading.', requestId: 'other-question' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Use the existing palette.' })
    const confirmed = await f.control.command({ type: 'answer', threadId: answeredThread, requestId: 'other-question', answer: 'Original heading' })
    expect(confirmed.error).toBeNull()
    expect(confirmed).toMatchObject({ draft: 'Use the existing palette.', draftThreadId: 'workshop', draftRequestId: 'workshop-colors', composing: true })
    expect(confirmed.host.threads.find(thread => thread.id === 'workshop')?.requests.some(request => request.id === 'workshop-colors')).toBe(true)
  })
})

it('preserves a matching draft on a rejected option answer, then clears it only after confirmation', async () => {
    const f = await fixture()
    f.host.event({ type: 'question', threadId: 'workshop', text: 'Choose colors.', requestId: 'workshop-colors' })
    f.host.event({ type: 'question', threadId: 'docs', text: 'Choose the heading.', requestId: 'docs-heading' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Use the existing palette.' })
    f.host.event({ type: 'reject', threadId: 'workshop', text: 'Fixture option answer was rejected.' })
    const failed = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'workshop-colors', answer: 'Blue' })
    expect(failed.error).toContain('rejected')
    expect(failed).toMatchObject({ draft: 'Use the existing palette.', draftThreadId: 'workshop', draftRequestId: 'workshop-colors', composing: true })
    const confirmed = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'workshop-colors', answer: 'Blue' })
    expect(confirmed.error).toBeNull()
    expect(confirmed).toMatchObject({ draft: '', draftThreadId: null, draftRequestId: null, composing: false, activeThreadId: 'workshop' })
    expect(confirmed.host.threads.find(thread => thread.id === 'workshop')?.requests).toEqual([])
  })
