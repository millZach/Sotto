// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { fixture, registerAgentControlRecoveryCleanup } from '../../fixtures/agentControlRecovery'

registerAgentControlRecoveryCleanup()

describe('the hidden coordinator', () => {
  it('releases every managed thread, queue rows included, when it starts with the coordinator switched off', async () => {
    let enabled = true
    const f = await fixture(new E2EAgentHost(), { coordinatorEnabled: () => enabled })
    await f.account()
    f.service.decision = { decision: 'done', text: 'The assigned change is complete.' }
    await f.control.command({ type: 'assign', threadId: 'workshop', instruction: 'Finish the assigned change.' })
    f.host.event({ type: 'ready', threadId: 'workshop', text: 'The implementation is complete.' })
    await expect.poll(() => f.control.get().queue[0]?.text).toBe(f.service.decision.text)
    expect(f.control.get().assignments).toMatchObject([{ threadId: 'workshop' }])
    await f.restart()
    expect(f.control.get().assignments).toMatchObject([{ threadId: 'workshop' }])
    enabled = false
    await f.restart()
    expect(f.control.get().assignments).toEqual([])
    expect(f.control.get().queue).toEqual([])
  })
})
