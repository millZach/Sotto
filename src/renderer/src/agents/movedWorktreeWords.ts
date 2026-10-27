import { t } from '@lingui/core/macro'
import { movedWorktreeWords } from '../../../shared/branchMoves'

/**
 * A worktree's error in the interface language (ADR-0123). Main sets the English sentences in src/shared/branchMoves.ts
 * when a worker's worktree cannot be made from a moved branch (#1033); the window reads each by its English, its key,
 * and shows this catalog's message. Any other error is shown as main wrote it.
 */
export function worktreeErrorWords(error: string | undefined): string | undefined {
  switch (error) {
    case movedWorktreeWords.notMoved: return t`That is not a branch Sotto moved here. Nothing was made.`
    case movedWorktreeWords.notInProject: return t`The branch this worker starts from is not in this project. Start the worker again. Nothing was made.`
    case movedWorktreeWords.gone: return t`The branch this worker starts from is no longer here. Start the worker again. Nothing was made.`
    case movedWorktreeWords.noSubdirectory: return t`The project subdirectory is not on the branch this worker starts from. Nothing was made.`
    default: return error
  }
}
