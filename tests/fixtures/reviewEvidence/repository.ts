import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { E2E_THREADS_NOW } from '../../../src/shared/e2e'

/**
 * The working copy the review-evidence captures read: a real Git repository, a real bare remote and a real diff, the
 * files one of Sotto's own big merges touched, at its two sides. Nothing here is invented, so Changes shows what such a
 * change really looks like: long lines, moved code, added and deleted files. Both commits are pinned, and `main` keeps
 * them, so the diff is the same however far the code under capture has moved. It needs a clone with full history.
 */
const BASE = 'e18ebc431fac5fa164a7f85da9ed0a46632c076a'
const HEAD = 'ead571a0d0a491782de4479d723dc467c3eacb55'
/** A few files nothing in that merge touched, so the folder reads as a project. */
const ALSO_KEPT = ['README.md', 'package.json', 'AGENTS.md']
export const EVIDENCE_BRANCH = 'feat/thread-store-worker'
export const EVIDENCE_PULL = 1612
export const EVIDENCE_PULL_TITLE = 'Write the thread store on a worker thread and read it only on main'
const GITHUB_URL = 'https://github.com/sotto-fixture/owned'
const IDENTITY = ['-c', 'user.name=Mira Okafor', '-c', 'user.email=mira@sotto.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', '-c', 'init.defaultBranch=main']

/** A changed file as GitHub counts it, from the real diff. */
export interface EvidenceFile { readonly path: string; readonly additions: number; readonly deletions: number }
export interface EvidenceRepository {
  readonly path: string
  readonly ghState: string
  /** What the pull request changes: the real diff's files and their real counts. */
  readonly files: readonly EvidenceFile[]
}

/** Fixed on purpose, so a path shown anywhere reads the same in every run. Rebuilt at each start. */
export const evidenceRoot = (): string => join(tmpdir(), 'sotto-e2e-review-evidence-repository')

function git(cwd: string, ...args: string[]): string {
  // Fixed dates give both commits the same hashes in every run, and the Git status the same short names.
  const date = '2026-07-12T12:00:00-07:00'
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim()
}

async function place(repository: string, path: string, contents: Buffer | string): Promise<void> {
  const target = join(repository, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

function blob(source: string, commit: string, path: string): Buffer {
  return execFileSync('git', ['show', `${commit}:${path}`], { cwd: source, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A morning's next step, not yet committed, for the Git action's changed-files dialog. */
const UNCOMMITTED: Readonly<Record<string, (text: string) => string>> = {
  'docs/plans/store-worker.md': text => `${text}\n## Reads after the worker\n\nMain keeps every read. A read that needs a write it has not seen waits on the overlay, not on the worker, so the update path never crosses a thread to answer a question it already holds.\n`,
  'src/main/agents/storeWorkerProtocol.ts': text => `// Version 2 adds the checkpoint acknowledgement; a worker that answers version 1 is restarted, never negotiated with.\n${text}`,
  'tests/integration/threadStoreWorker.test.ts': text => `${text}\n// A checkpoint that lands during a burst of writes is covered by the equivalence fixture; this file holds the crash paths.\n`,
  'CONTEXT.md': text => `${text}\n**Store worker.** The thread that writes the thread store. Main reads the store and hands the worker its writes in order; nothing else opens it for writing.\n`,
}

export async function buildEvidenceRepository(source = resolve('.')): Promise<EvidenceRepository> {
  const root = evidenceRoot()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  const repository = join(root, 'sotto'), remote = join(root, 'owned-remote.git'), ghState = join(root, 'gh-state.json')
  await mkdir(repository, { recursive: true })
  const changed = git(source, 'diff', '--name-status', '--no-renames', BASE, HEAD).split('\n').map(line => line.split('\t') as [string, string])
  const files = git(source, 'diff', '--numstat', '--no-renames', BASE, HEAD).split('\n').map(line => {
    const [additions, deletions, path] = line.split('\t') as [string, string, string]
    return { path, additions: Number(additions) || 0, deletions: Number(deletions) || 0 }
  })

  git(repository, 'init', '-q')
  git(repository, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  for (const [status, path] of changed) if (status !== 'A') await place(repository, path, blob(source, BASE, path))
  for (const path of ALSO_KEPT) await place(repository, path, blob(source, BASE, path))
  git(repository, 'add', '-A')
  git(repository, 'commit', '-q', '-m', 'Keep the thread store on main and checkpoint it from a worker')
  git(root, 'init', '-q', '--bare', remote)
  git(repository, 'remote', 'add', 'origin', remote)
  git(repository, 'push', '-q', '-u', 'origin', 'main')
  git(repository, 'remote', 'set-head', 'origin', 'main')
  // Origin is written as GitHub's address and Git rewrites it to the owned remote: the status reader asks gh only about
  // a repository on GitHub, and nothing leaves this machine.
  git(repository, 'config', `url.${remote}.insteadOf`, GITHUB_URL)
  git(repository, 'remote', 'set-url', 'origin', GITHUB_URL)

  git(repository, 'checkout', '-q', '-b', EVIDENCE_BRANCH)
  for (const [status, path] of changed) {
    if (status === 'D') await rm(join(repository, path))
    else await place(repository, path, blob(source, HEAD, path))
  }
  git(repository, 'add', '-A')
  git(repository, 'commit', '-q', '-m', EVIDENCE_PULL_TITLE)
  git(repository, 'push', '-q', '-u', 'origin', EVIDENCE_BRANCH)
  for (const [path, edit] of Object.entries(UNCOMMITTED)) await place(repository, path, edit(blob(source, HEAD, path).toString('utf8')))
  await place(repository, 'docs/perf/2026-10-27-store-worker-reads.md', '# Store worker reads\n\nMain answered 40,000 reads during a burst of 2,000 writes with a p99 of 0.4 ms, against 11 ms when it wrote them itself.\n')
  return { path: repository, ghState, files }
}

export type PullRequestMoment = 'checks-running' | 'checks-failed' | 'ready'

/** A time before the capture's held clock, as GitHub would record it. */
const ago = (minutes: number): string => new Date(E2E_THREADS_NOW - minutes * 60_000).toISOString()
/** A check run, with how long it took in seconds once it finished, or has taken so far while it runs. */
const run = (name: string, workflowName: string, status: 'IN_PROGRESS' | 'QUEUED' | 'COMPLETED', conclusion: string | null, id: number, seconds = 0) => {
  const started = 34 + id
  return { __typename: 'CheckRun', name, workflowName, status, conclusion, detailsUrl: `${GITHUB_URL}/actions/runs/${id}`,
    startedAt: status === 'QUEUED' ? null : ago(status === 'IN_PROGRESS' ? seconds / 60 : started), completedAt: status === 'COMPLETED' ? new Date(Date.parse(ago(started)) + seconds * 1_000).toISOString() : null }
}

const SUCCESS = 'SUCCESS'
const LEADING = [run('Greptile Review', 'Greptile', 'COMPLETED', SUCCESS, 1, 94), run('Pull request checks', 'CI', 'COMPLETED', SUCCESS, 2, 41), run('Typecheck and lint', 'CI', 'COMPLETED', SUCCESS, 3, 262)]
const CHECKS: Readonly<Record<PullRequestMoment, readonly ReturnType<typeof run>[]>> = {
  'checks-running': [...LEADING,
    run('Gates (Windows)', 'CI', 'IN_PROGRESS', null, 4, 512), run('Test shard 1 of 4', 'CI', 'COMPLETED', SUCCESS, 5, 388), run('Test shard 2 of 4', 'CI', 'IN_PROGRESS', null, 6, 455),
    run('Test shard 3 of 4', 'CI', 'IN_PROGRESS', null, 7, 402), run('Test shard 4 of 4', 'CI', 'QUEUED', null, 8), run('Package result', 'CI', 'QUEUED', null, 9), run('Desktop result', 'CI', 'QUEUED', null, 10),
  ],
  'checks-failed': [...LEADING,
    run('Gates (Windows)', 'CI', 'COMPLETED', 'FAILURE', 4, 618), run('Test shard 1 of 4', 'CI', 'COMPLETED', SUCCESS, 5, 388), run('Test shard 2 of 4', 'CI', 'COMPLETED', 'FAILURE', 6, 571),
    run('Test shard 3 of 4', 'CI', 'COMPLETED', SUCCESS, 7, 402), run('Test shard 4 of 4', 'CI', 'COMPLETED', SUCCESS, 8, 366), run('Package result', 'CI', 'COMPLETED', SUCCESS, 9, 845), run('Desktop result', 'CI', 'IN_PROGRESS', null, 10, 734),
  ],
  ready: [...LEADING,
    run('Gates (Windows)', 'CI', 'COMPLETED', SUCCESS, 4, 633), run('Test shard 1 of 4', 'CI', 'COMPLETED', SUCCESS, 5, 388), run('Test shard 2 of 4', 'CI', 'COMPLETED', SUCCESS, 6, 571),
    run('Test shard 3 of 4', 'CI', 'COMPLETED', SUCCESS, 7, 402), run('Test shard 4 of 4', 'CI', 'COMPLETED', SUCCESS, 8, 366), run('Package result', 'CI', 'COMPLETED', SUCCESS, 9, 845), run('Desktop result', 'CI', 'COMPLETED', SUCCESS, 10, 1_092),
  ],
}

const BODY = `## What changed

The thread store now writes on a worker thread. Main reads it and hands the worker every write in order, so a burst of provider updates no longer costs main a transaction per update.

- \`storeWorker.ts\` owns the write connection and the WAL checkpoint, which replaces \`walCheckpointer.ts\`.
- \`storeOverlay.ts\` answers reads for writes the worker has not committed yet.
- A worker that dies is restarted from the journal; nothing it acknowledged is lost.

## How it was tested

\`threadStoreWorker.test.ts\` covers the crash paths, and \`storeWriterEquivalence.ts\` holds the worker and the old writer to the same results over the owner-scale workload.`

/** The repository's other open pull requests, for the surface's list: this repository's own shape of work. */
const OTHERS = [
  { number: 1640, title: 'Answer a Codex form with nothing to fill in with Allow once or Deny', author: 'zach', headRefName: 'fix/codex-empty-form', minutes: 12, additions: 522, deletions: 37, changedFiles: 46, rollup: 'PENDING', reviewDecision: 'REVIEW_REQUIRED' },
  { number: 1638, title: 'Keep a thread\'s settings when it moves to another machine', author: 'drake', headRefName: 'feat/move-settings', minutes: 34, additions: 995, deletions: 33, changedFiles: 21, rollup: 'SUCCESS', reviewDecision: 'APPROVED' },
  { number: 1635, title: 'Count only file changes in the sidebar\'s changed count', author: 'zach', headRefName: 'fix/changed-count', minutes: 51, additions: 272, deletions: 7, changedFiles: 9, rollup: 'FAILURE', reviewDecision: 'REVIEW_REQUIRED' },
  { number: 1629, title: 'Mask a Codex secret in the permission card before it is shown', author: 'mira', headRefName: 'fix/mask-secret', minutes: 96, additions: 1_043, deletions: 33, changedFiles: 14, rollup: 'SUCCESS', reviewDecision: 'REVIEW_REQUIRED' },
  { number: 1624, title: 'Record how a Dynamo session ended so a restart can say why', author: 'drake', headRefName: 'feat/session-end', minutes: 182, additions: 233, deletions: 0, changedFiles: 5, rollup: null, isDraft: true, reviewDecision: 'REVIEW_REQUIRED' },
  { number: 1617, title: 'Put the to-do list under the threads and let it unroll from the window\'s corner', author: 'mira', headRefName: 'feat/to-do-corner', minutes: 410, additions: 5_274, deletions: 21, changedFiles: 63, rollup: 'SUCCESS', reviewDecision: 'CHANGES_REQUESTED' },
]

/** The scripted gh's record of the pull request at one moment of its life, written where the running gh reads it. */
export async function writePullRequestMoment(repository: EvidenceRepository, moment: PullRequestMoment): Promise<void> {
  const others = OTHERS.map(({ minutes, ...other }) => ({ ...other, url: `${GITHUB_URL}/pull/${other.number}`, state: 'OPEN', baseRefName: 'main', updatedAt: ago(minutes), body: '',
    files: repository.files.slice(0, Math.min(other.changedFiles, repository.files.length)).map(file => ({ ...file })) }))
  await writeFile(repository.ghState, JSON.stringify({ calls: [], pulls: [{
    number: EVIDENCE_PULL, title: EVIDENCE_PULL_TITLE, url: `${GITHUB_URL}/pull/${EVIDENCE_PULL}`,
    state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: EVIDENCE_BRANCH, body: BODY, checks: CHECKS[moment], author: 'zach', updatedAt: ago(2),
    rollup: moment === 'ready' ? 'SUCCESS' : moment === 'checks-failed' ? 'FAILURE' : 'PENDING', files: repository.files,
    additions: repository.files.reduce((sum, file) => sum + file.additions, 0), deletions: repository.files.reduce((sum, file) => sum + file.deletions, 0),
    reviewDecision: moment === 'ready' ? 'APPROVED' : 'REVIEW_REQUIRED',
    reviews: moment === 'ready' ? [{ state: 'APPROVED', url: `${GITHUB_URL}/pull/${EVIDENCE_PULL}#pullrequestreview-1`, author: { login: 'mira' } }] : [],
  }, ...others] }))
}
