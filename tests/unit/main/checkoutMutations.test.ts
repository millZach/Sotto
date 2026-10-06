// @vitest-environment node
import { expect, it } from 'vitest'
import { CheckoutMutations, CheckoutSendRefusal } from '../../../src/main/agents/checkoutMutations'

it.each([
  [{ kind: 'automatic-pull' } as const, 'Sotto is pulling this folder. Try again in a moment.'],
  [{ kind: 'git-action' } as const, 'A Git action is running in this folder.'],
  [{ kind: 'checkpoint-revert' } as const, 'Sotto is reverting a checkpoint in this folder.'],
  [{ kind: 'settle' } as const, 'Sotto is settling a thread in this folder.'],
  [{ kind: 'send', threadId: 'a', title: 'Fix parser' } as const, 'A message is being sent in thread "Fix parser" in this folder.'],
  [{ kind: 'turn', threadId: 'a', title: 'Fix parser' } as const, 'Thread "Fix parser" is working in this folder.'],
  [{ kind: 'preparation', threadId: 'a', title: 'Fix parser' } as const, 'Sotto is setting up the working copy for thread "Fix parser". Try again in a moment.'],
])('names the checkout holder %j and releases it after refusal', (holder, copy) => {
  const guard = new CheckoutMutations()
  const release = guard.acquireIdentity('checkout', holder.kind === 'send' || holder.kind === 'turn' ? 'send' : 'mutation', holder)
  expect(() => guard.acquireIdentity('checkout', 'mutation')).toThrow(copy)
  if (holder.kind !== 'send' && holder.kind !== 'turn') expect(() => guard.acquireIdentity('checkout', 'send')).toThrow(CheckoutSendRefusal)
  release()
  guard.acquireIdentity('checkout', 'mutation')()
})
