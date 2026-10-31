import type { MessageDescriptor } from '@lingui/core'
import { msg, ph } from '@lingui/core/macro'

import { own } from '../components/isolated'

/**
 * The thread holding a folder a change was refused for (#1823), from the reply's `checkoutHold`, when it is another
 * thread the window lists. The refused thread itself, or one the window does not list, gives nothing to open.
 */
export function holdingThread<T extends { readonly id: string }>(threads: readonly T[], holderId: string | undefined, refusedId: string): T | undefined {
  return holderId === undefined || holderId === refusedId ? undefined : threads.find(thread => thread.id === holderId)
}

/** The words of the control that opens the thread holding the folder, its title kept apart from the sentence. */
export function openHolderWords(title: string): MessageDescriptor {
  return msg({ message: `Open ${ph({ title: own(title) })}`, comment: '{title} is the title of the thread that holds this folder. Opens that thread.' })
}
