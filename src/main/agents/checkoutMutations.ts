import { checkoutIdentity } from './threadWorktrees'
import { GitActionRefusal } from './gitActions'

export type CheckoutPendingWork = 'pending-work' | 'failed-followups' | 'paused-followups' | 'paused-assignment' | 'managed-assignment' | 'uncertain-send'
export type CheckoutHolder = { kind: 'git-action' | 'automatic-pull' | 'checkpoint' | 'checkpoint-revert' | 'settle' | 'remove-folder' }
  | { kind: 'send' | 'turn' | 'waiting-answer' | 'history-error' | 'history-loading' | 'preparation' | CheckoutPendingWork; threadId: string; title: string }

function holdingMessage(holder: CheckoutHolder): string {
  switch (holder.kind) {
    case 'automatic-pull': return 'Sotto is pulling this folder.'
    case 'checkpoint': return 'Sotto is saving a checkpoint in this folder.'
    case 'checkpoint-revert': return 'Sotto is reverting a checkpoint in this folder.'
    case 'remove-folder': return 'Sotto is removing this folder.'
    case 'settle': return 'Sotto is settling a thread in this folder.'
    case 'send': return `A message is being sent in thread "${holder.title}" in this folder.`
    case 'turn': return `Thread "${holder.title}" is working in this folder.`
    case 'pending-work': return `Thread "${holder.title}" has pending work in this folder.`
    case 'waiting-answer': return `Thread "${holder.title}" is waiting for your answer.`
    case 'history-error': return `Thread "${holder.title}" could not load its history.`
    case 'history-loading': return `Thread "${holder.title}" is loading its history.`
    case 'preparation': return `Sotto is setting up the working copy for thread "${holder.title}".`
    case 'failed-followups': return `Thread "${holder.title}" has queued follow-ups that did not send.`
    case 'paused-followups': return `Thread "${holder.title}" has paused follow-ups.`
    case 'paused-assignment': return `Thread "${holder.title}" has paused management and queued work.`
    case 'managed-assignment': return `Thread "${holder.title}" is managed by Sotto.`
    case 'uncertain-send': return `Thread "${holder.title}" has a message whose delivery is unconfirmed.`
    case 'git-action': return 'A Git action is running in this folder.'
  }
}
export function checkoutMutationRefusal(holder: CheckoutHolder): GitActionRefusal {
  let recovery: string
  switch (holder.kind) {
    case 'waiting-answer': recovery = 'Answer it, then try again.'; break
    case 'history-error': recovery = 'Open it to retry, or archive it, then try again.'; break
    case 'failed-followups':
    case 'paused-followups': recovery = 'Resume or remove them, then try again.'; break
    case 'paused-assignment': recovery = 'Stop managing it and review its queue, or archive it, then try again.'; break
    case 'managed-assignment': recovery = 'Stop managing it, or archive it, then try again.'; break
    case 'uncertain-send': recovery = 'Open it and refresh to check whether it was sent, then try again.'; break
    case 'pending-work': recovery = 'Open it to review that work, or archive it, then try again.'; break
    case 'history-loading':
    case 'preparation':
    case 'automatic-pull':
    case 'checkpoint':
    case 'settle': recovery = 'Try again in a moment.'; break
    default: recovery = 'Wait for it to finish before changing this folder.'
  }
  return new GitActionRefusal(`${holdingMessage(holder)} ${recovery}`)
}

/** A definitive refusal before the provider receives a prompt. Queue delivery supplies its own recovery copy. */
export class CheckoutSendRefusal extends Error {
  constructor(private readonly holder: CheckoutHolder = { kind: 'git-action' }) {
    super(`${holdingMessage(holder)} Your message was not sent. Send it again when the action finishes.`)
  }
  draftMessage(): string { return `${holdingMessage(this.holder)} Your message was not sent. Your text is kept. Send it again when the action finishes.` }
  queuedMessage(): string { return `${holdingMessage(this.holder)} Your follow-up was not sent. It is kept in the queue. Resume the queue when the action finishes.` }
}

/** Sends may share a checkout, but a mutation excludes sends and other mutations from its first check to completion. */
export class CheckoutMutations {
  private readonly active = new Map<string, { reads: Set<CheckoutHolder>; mutation: CheckoutHolder | null }>()
  async isMutating(folder: string): Promise<boolean> {
    if (![...this.active.values()].some(state => state.mutation)) return false
    return Boolean(this.active.get(await checkoutIdentity(folder))?.mutation)
  }
  async acquire(folder: string, kind: 'send' | 'mutation', holder?: CheckoutHolder): Promise<() => void> {
    return this.acquireIdentity(await checkoutIdentity(folder), kind, holder)
  }
  acquireIdentity(key: string, kind: 'send' | 'mutation', holder: CheckoutHolder = { kind: 'git-action' }): () => void {
    const state = this.active.get(key) ?? { reads: new Set<CheckoutHolder>(), mutation: null }
    const held = state.mutation ?? (kind === 'mutation' ? state.reads.values().next().value : undefined)
    if (held) throw kind === 'send' ? new CheckoutSendRefusal(held) : checkoutMutationRefusal(held)
    if (kind === 'mutation') state.mutation = holder
    else state.reads.add(holder)
    this.active.set(key, state)
    return () => {
      if (kind === 'mutation') state.mutation = null
      else state.reads.delete(holder)
      if (!state.mutation && state.reads.size === 0) this.active.delete(key)
    }
  }
}
