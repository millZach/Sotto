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

/**
 * What leads a refusal because something holds the folder: the Git action's notice for any hold (#1823), and Bring changes
 * back's outcome for a hold another thread caused (#1866). Nothing failed, and nothing was changed.
 */
export const ON_HOLD = msg({ message: 'On hold', comment: 'Leads a Git action or Bring changes back refused because another thread or Sotto holds the folder. Nothing failed and nothing was changed.' })

/** The words of the control that opens the thread holding the folder, its title kept apart from the sentence. */
export function openHolderWords(title: string): MessageDescriptor {
  return msg({ message: `Open ${ph({ title: own(title) })}`, comment: '{title} is the title of the thread that holds this folder. Opens that thread.' })
}
