// @vitest-environment node
import { expect, it } from 'vitest'
import { delegatedRefusalWords, delegatingThread } from '../../../src/main/agents/watcherDelegated'

const HERE = '11111111-1111-4111-8111-111111111111', THERE = '22222222-2222-4222-8222-222222222222'

it('reads the thread that delegated from each form its link takes on the delegated thread’s own machine (#1217)', () => {
  // A thread on the same machine, by its ID.
  expect(delegatingThread('parent', HERE)).toEqual({ hostId: HERE, threadId: 'parent' })
  // One on another machine that the desktop relay started this for.
  expect(delegatingThread(`host:${THERE}:parent`, HERE)).toEqual({ hostId: THERE, threadId: 'parent' })
  // One a desktop asked for: keyed by its machine, or the desktop's own thread by its bare ID, which names no machine.
  expect(delegatingThread(`relay:client-1:host:${THERE}:parent`, HERE)).toEqual({ hostId: THERE, threadId: 'parent' })
  expect(delegatingThread('relay:client-1:parent', HERE)).toEqual({ threadId: 'parent' })
})

it('says what the thread is, which thread to direct instead by its ID and title, and that nothing happened', () => {
  expect(delegatedRefusalWords({ hostId: HERE, threadId: 'parent' }, 'Fix the login bug', 'send')).toBe('This thread is another thread’s delegated worker, and only the thread '
    + `that delegated it directs it. Direct that thread instead: “Fix the login bug”, threadId parent, hostId ${HERE}. You can still read this one. Nothing was sent.`)
  expect(delegatedRefusalWords({ threadId: 'parent' }, undefined, 'watch')).toBe('This thread is another thread’s delegated worker, and only the thread '
    + 'that delegated it directs it. Direct that thread instead: threadId parent, on another computer. You can still read this one. Nothing was watched.')
})
