import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { ThreadClearKeptReason } from '../../../shared/threadClear'

/**
 * Why a settled thread is kept back (ADR-0140 decision 3), as the window shows it in the interface language (ADR-0123):
 * the same short lower-case clauses `threadClearKeptWords` writes in English for main's own errors, which read after a
 * thread's title. Clear settled threads' kept list and Delete thread… both read them; a new reason fails the typecheck
 * until it has words here.
 */
export const THREAD_CLEAR_KEPT_MESSAGES: Readonly<Record<ThreadClearKeptReason, MessageDescriptor>> = {
  working: msg`still working`,
  'waiting-on-you': msg`waiting on you`,
  queued: msg`something is queued for it`,
  'pull-request': msg`pull request still open`,
  'delegated-working': msg`a thread it delegated to is still working`,
  babysitting: msg`being babysat`,
  watched: msg`Watcher is watching it`,
  uncommitted: msg`uncommitted changes in its worktree`,
  'worktree-files': msg`its worktree holds files Git ignores; delete it on its own to review them`,
  'worktree-in-use': msg`its worktree is in use`,
  'worktree-error': msg`its worktree could not be removed; delete it on its own to see why`,
  'not-settled': msg`not settled`,
  hidden: msg`hidden`,
}
