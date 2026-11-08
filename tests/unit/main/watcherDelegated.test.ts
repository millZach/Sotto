// @vitest-environment node
import { expect, it } from 'vitest'
import { delegatedRefusalWords } from '../../../src/main/agents/watcherDelegated'

const HERE = '11111111-1111-4111-8111-111111111111'

it('says what the thread is, which thread to direct instead by its ID and title, and that nothing happened', () => {
  expect(delegatedRefusalWords({ hostId: HERE, threadId: 'parent' }, 'Fix the login bug', 'send')).toBe('This thread is another thread’s delegated worker, and only the thread '
    + `that delegated it directs it. Direct that thread instead: “Fix the login bug”, threadId parent, hostId ${HERE}. You can still read this one. Nothing was sent.`)
  expect(delegatedRefusalWords({ threadId: 'parent' }, undefined, 'watch')).toBe('This thread is another thread’s delegated worker, and only the thread '
    + 'that delegated it directs it. Direct that thread instead: threadId parent, on another computer. You can still read this one. Nothing was watched.')
})
