// @vitest-environment node
import { expect, it } from 'vitest'
import { CheckoutHeldRefusal, CheckoutMutations, CheckoutSendRefusal, checkoutMutationRefusal } from '../../../src/main/agents/checkoutMutations'

it.each([
  [{ kind: 'automatic-pull' } as const, 'Sotto is pulling this folder. Nothing was changed. Try again in a moment.'],
  [{ kind: 'git-action' } as const, 'A Git action is running in this folder.'],
  [{ kind: 'checkpoint-revert' } as const, 'Sotto is reverting a checkpoint in this folder.'],
  [{ kind: 'settle' } as const, 'Sotto is settling a thread in this folder.'],
  [{ kind: 'send', threadId: 'a', title: 'Fix parser' } as const, 'A message is being sent in thread "Fix parser" in this folder.'],
  [{ kind: 'turn', threadId: 'a', title: 'Fix parser' } as const, 'Thread "Fix parser" is working in this folder.'],
  [{ kind: 'preparation', threadId: 'a', title: 'Fix parser' } as const, 'Sotto is setting up the working copy for thread "Fix parser". Nothing was changed. Try again in a moment.'],
])('names the checkout holder %j and releases it after refusal', (holder, copy) => {
  const guard = new CheckoutMutations()
  const release = guard.acquireIdentity('checkout', holder.kind === 'send' || holder.kind === 'turn' ? 'send' : 'mutation', holder)
  expect(() => guard.acquireIdentity('checkout', 'mutation')).toThrow(copy)
  if (holder.kind !== 'send' && holder.kind !== 'turn') expect(() => guard.acquireIdentity('checkout', 'send')).toThrow(CheckoutSendRefusal)
  release()
  guard.acquireIdentity('checkout', 'mutation')()
})

// #1823: a refusal because something holds the folder is a hold, says nothing was changed and names the holding thread.
it.each([
  [{ kind: 'waiting-answer', threadId: 'b', title: 'Visual gate flake' } as const, 'Thread "Visual gate flake" is waiting for your answer. Nothing was changed. Answer it, then try again.', 'b'],
  [{ kind: 'turn', threadId: 'b', title: 'Visual gate flake' } as const, 'Thread "Visual gate flake" is working in this folder. Nothing was changed. Wait for it to finish before changing this folder.', 'b'],
  [{ kind: 'git-action' } as const, 'A Git action is running in this folder. Nothing was changed. Wait for it to finish before changing this folder.', undefined],
])('words the hold %j and names the thread holding it', (holder, copy, threadId) => {
  const refusal = checkoutMutationRefusal(holder)
  expect(refusal).toBeInstanceOf(CheckoutHeldRefusal)
  expect(refusal.message).toBe(copy)
  expect(refusal.threadId).toBe(threadId)
})

// #1866: Bring changes back says the same hold with what it did not do, in place of "Nothing was changed.".
it('says the same hold with another account of what was not done', () => {
  const refusal = checkoutMutationRefusal({ kind: 'waiting-answer', threadId: 'b', title: 'Visual gate flake' })
  expect(refusal.withOutcome('Nothing was brought back.')).toBe('Thread "Visual gate flake" is waiting for your answer. Nothing was brought back. Answer it, then try again.')
  expect(refusal.message).toBe('Thread "Visual gate flake" is waiting for your answer. Nothing was changed. Answer it, then try again.')
  // One made from its message alone, as a host's own refusal is, keeps that message.
  expect(new CheckoutHeldRefusal('Sotto is pulling this folder. Nothing was changed. Try again in a moment.', undefined).withOutcome('Nothing was brought back.'))
    .toBe('Sotto is pulling this folder. Nothing was changed. Try again in a moment.')
})
