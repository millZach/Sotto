/**
 * A New thread asked for in the sidebar beside another page. The press leads to the Threads page, and the page
 * opens the New thread dialog when it arrives; the intent is taken once and never kept.
 */
export interface NewThreadIntent { readonly projectId?: string | undefined }

let pending: NewThreadIntent | null = null

export function setNewThreadIntent(intent: NewThreadIntent): void { pending = intent }

export function takeNewThreadIntent(): NewThreadIntent | null {
  const taken = pending
  pending = null
  return taken
}
