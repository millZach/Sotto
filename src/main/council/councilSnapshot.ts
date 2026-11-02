import { t } from '@lingui/core/macro'
import { access, mkdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { BranchBundles } from '../agents/branchBundles'
import type { RunGitCommand } from '../agents/gitStatus'

/**
 * A Council's snapshot (ADR-0177 decision 2): the origin thread's folder as it was at Ask the Council, its commit and
 * its uncommitted changes, as a commit on no branch made from a copy of the index (`BranchBundles.snapshotOf`, which a
 * check's test run uses too), checked out as a detached worktree in Sotto's data folder. Every thread in the Council
 * works there, so they cite the same code and nothing they run can change the user's checkout. It is removed when the
 * Council is settled. Git's output never reaches a log or an answer.
 */

export { COUNCIL_WORKTREE_FOLDER } from './councilFolders'

export interface CouncilSnapshot { readonly path: string; readonly repositoryRoot: string; readonly commit: string; readonly branch: string; readonly untracked: number
  /** It carried uncommitted changes, so its commit is a snapshot's rather than the branch's own. */
  readonly dirty: boolean }

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
    return { path: input.path, repositoryRoot, commit: source.commit, branch: source.branch, untracked: source.snapshot?.untrackedCount ?? 0, dirty: source.snapshot !== undefined }
  } catch {
    await rm(input.path, { recursive: true, force: true }).catch(() => undefined)
    return { refused: refusalWords('failed') }
  }
}

/**
 * Removes a settled Council's snapshot, and says whether it is gone: the folder off the disk and Git no longer listing
 * it. A snapshot that may still be there is kept on the record and removed again at the next start. Its commit is on no
 * branch, so Git lets it go in time.
 */
export async function removeCouncilSnapshot(run: RunGitCommand, snapshot: Pick<CouncilSnapshot, 'path' | 'repositoryRoot'>): Promise<boolean> {
  await run(snapshot.repositoryRoot, 'git', ['worktree', 'remove', '--force', '--force', '--', snapshot.path], { timeoutMs: 300_000 }).catch(async () => {
    // A folder already gone, or a repository moved: remove what is left and prune the registration.
    await rm(snapshot.path, { recursive: true, force: true }).catch(() => undefined)
    await run(snapshot.repositoryRoot, 'git', ['worktree', 'prune'], { timeoutMs: 60_000 }).catch(() => undefined)
  })
  if (await present(snapshot.path)) return false
  // A repository that is gone registers nothing.
  if (!await present(snapshot.repositoryRoot)) return true
  const listed = await run(snapshot.repositoryRoot, 'git', ['worktree', 'list', '--porcelain'], { timeoutMs: 60_000 }).catch((): undefined => undefined)
  if (listed === undefined) return false
  const path = await samePath(snapshot.path)
  const others = await Promise.all(listed.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => samePath(line.slice('worktree '.length))))
  return !others.includes(path)
}

const present = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
/** A path as Git and the disk would both write it: its folder's real path (macOS's /var is /private/var), and on Windows in one case. */
const samePath = async (path: string): Promise<string> => {
  const full = resolve(path)
  const real = join(await realpath(dirname(full)).catch(() => dirname(full)), basename(full))
  return process.platform === 'win32' ? real.toLowerCase() : real
}
