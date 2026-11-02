import { t } from '@lingui/core/macro'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BranchBundles } from '../agents/branchBundles'
import type { RunGitCommand } from '../agents/gitStatus'
import { HISTORY_FILE, HISTORY_FOLDER } from './councilPrompts'

/**
 * A Council's snapshot (ADR-0176 decision 2): the origin thread's folder as it was at Ask the Council, its commit and
 * its uncommitted changes, as a commit on no branch made from a copy of the index (`BranchBundles.snapshotOf`, which a
 * check's test run uses too), checked out as a detached worktree in Sotto's data folder. Every thread in the Council
 * works there, so they cite the same code and nothing they run can change the user's checkout. It is removed when the
 * Council is settled. Git's output never reaches a log or an answer.
 */

export { COUNCIL_WORKTREE_FOLDER } from './councilFolders'

export interface CouncilSnapshot { readonly path: string; readonly repositoryRoot: string; readonly commit: string; readonly branch: string; readonly untracked: number }

const refusalWords = (reason: string): string => {
  switch (reason) {
    case 'not-a-repository': return t`The thread's folder is not a Git repository, so the Council has no snapshot to work in. Nothing was started.`
    case 'not-on-branch': return t`The thread's folder is not on a branch. Check out a branch, then ask the Council again. Nothing was started.`
    case 'unsupported': return t`The thread's branch has characters in its name a snapshot cannot carry. Rename the branch, then ask again. Nothing was started.`
    case 'uncommitted': return t`A submodule in the thread's folder has uncommitted changes, and a snapshot can't carry them. Commit them inside the submodule, then ask again. Nothing was started.`
    default: return t`Git could not take a snapshot of the thread's folder. Nothing was started. Ask the Council again.`
  }
}

/** Takes the snapshot of `folder` and checks it out at `path`; the words for the user when it cannot. */
export async function makeCouncilSnapshot(input: { readonly bundles: Pick<BranchBundles, 'snapshotOf'>; readonly run: RunGitCommand; readonly folder: string; readonly path: string }): Promise<CouncilSnapshot | { readonly refused: string }> {
  const source = await input.bundles.snapshotOf(input.folder)
  if ('type' in source) return { refused: refusalWords(source.reason) }
  try {
    const repositoryRoot = (await input.run(input.folder, 'git', ['rev-parse', '--show-toplevel'], { timeoutMs: 30_000 })).trim()
    await mkdir(dirname(input.path), { recursive: true })
    await input.run(repositoryRoot, 'git', ['worktree', 'add', '--detach', '--', input.path, source.commit], { timeoutMs: 300_000 })
    return { path: input.path, repositoryRoot, commit: source.commit, branch: source.branch, untracked: source.snapshot?.untrackedCount ?? 0 }
  } catch {
    await rm(input.path, { recursive: true, force: true }).catch(() => undefined)
    return { refused: refusalWords('failed') }
  }
}

/** Writes the conversation into the snapshot for threads to read, in a folder whose own ignore file keeps it out of Git. */
export async function writeCouncilHistory(path: string, text: string): Promise<void> {
  await mkdir(join(path, HISTORY_FOLDER), { recursive: true })
  await writeFile(join(path, HISTORY_FOLDER, '.gitignore'), '*\n', 'utf8')
  await writeFile(join(path, HISTORY_FILE), text, 'utf8')
}

/** Removes a settled Council's snapshot. Its commit is on no branch, so Git lets it go in time. */
export async function removeCouncilSnapshot(run: RunGitCommand, snapshot: Pick<CouncilSnapshot, 'path' | 'repositoryRoot'>): Promise<void> {
  try { await run(snapshot.repositoryRoot, 'git', ['worktree', 'remove', '--force', '--force', '--', snapshot.path], { timeoutMs: 300_000 }) }
  catch {
    // A folder already gone, or a repository moved: prune the registration and remove what is left.
    await rm(snapshot.path, { recursive: true, force: true }).catch(() => undefined)
    await run(snapshot.repositoryRoot, 'git', ['worktree', 'prune'], { timeoutMs: 60_000 }).catch(() => undefined)
  }
}
