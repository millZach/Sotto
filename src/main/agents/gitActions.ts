import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { gitActionPhases, gitActionStages, type GitActionPhase, type GitActionResult, type GitActionToast, type GitPullResult, type GitStackedAction } from '../../shared/gitActions'
import type { GitStatus } from '../../shared/gitStatus'
import { diffExcerpt } from '../llm/diffExcerpt'
import { COMMIT_DIFF_MAX_CHARACTERS, COMMIT_SUBJECT_MAX_CHARACTERS, type CommitMaterial } from '../llm/commitMessage'
import type { PullRequestMaterial, PullRequestText } from '../llm/pullRequestText'
import { runGitStatusCommand, type GitStatusSource, type RunGitCommand } from './gitStatus'

/** What the host tells the client as a stacked action runs, in T3's shape. */
export type GitActionEvent =
  | { readonly kind: 'action_started'; readonly phases: readonly GitActionPhase[]; readonly stages: readonly string[] }
  | { readonly kind: 'phase_started'; readonly phase: GitActionPhase; readonly stage: string }
  | { readonly kind: 'hook_started'; readonly hookName: string }
  | { readonly kind: 'hook_output'; readonly hookName: string | null; readonly text: string }
  | { readonly kind: 'hook_finished'; readonly hookName: string }

export interface GitActionInput {
  readonly threadId: string
  readonly cwd: string
  readonly action: GitStackedAction
  readonly commitMessage?: string | undefined
  readonly featureBranch?: boolean | undefined
  /** The files to commit; absent, everything. An empty list is refused before anything runs. */
  readonly filePaths?: readonly string[] | undefined
  /** The client's word that pushing from the default branch was confirmed, the way T3's dialog asks. */
  readonly allowDefaultBranch?: boolean | undefined
  readonly onProgress?: ((event: GitActionEvent) => void) | undefined
}

export interface GitActionsDependencies {
  readonly run?: RunGitCommand
  readonly status: GitStatusSource
  /** The thread's own provider writes the message (ADR-0026); null leaves the commit with a stand-in subject. */
  readonly writeCommitMessage: (threadId: string, material: CommitMaterial) => Promise<string | null>
  readonly writePullRequestText: (threadId: string, material: PullRequestMaterial) => Promise<PullRequestText | null>
  /** The Follow pull request templates setting, read for each pull request; absent, the template is followed. */
  readonly followPullRequestTemplates?: () => boolean | Promise<boolean>
  readonly now?: () => number
}

/** Said in T3's words, so a reader of both apps meets the same refusal. */
export class GitActionRefusal extends Error {}

const COMMIT_TIMEOUT_MS = 10 * 60_000
const PUSH_TIMEOUT_MS = 10 * 60_000
const PULL_TIMEOUT_MS = 30_000
const RECENT_SUBJECTS = 20
const AGENTS_FILE_MAX_BYTES = 20_000
const TEMPLATE_MAX_BYTES = 8_000
const RANGE_LOG_MAX = 20_000
const RANGE_STAT_MAX = 20_000
const RANGE_PATCH_MAX = 60_000
const FEATURE_BRANCH_MAX = 64
const STAND_IN_SUBJECT = 'Update project files'

const openPullRequestSchema = z.array(z.object({ number: z.number().int().positive(), title: z.string(), url: z.string(), baseRefName: z.string(), headRefName: z.string(), state: z.string() }))
const repositorySchema = z.object({ defaultBranchRef: z.object({ name: z.string() }).nullable() })

/** T3's branch fragment: lowercase, quotes gone, anything odd a dash, 64 characters, a `feature/` namespace unless one is given. */
export function featureBranchName(fragment: string): string {
  let name = fragment.trim().toLowerCase().replace(/["'“”‘’`]/gu, '').replace(/[^a-z0-9/_-]+/gu, '-').replace(/-{2,}/gu, '-').replace(/^[-/]+|[-/]+$/gu, '')
  if (!name) name = 'update'
  if (!name.includes('/')) name = `feature/${name}`
  return name.length > FEATURE_BRANCH_MAX ? name.slice(0, FEATURE_BRANCH_MAX).replace(/[-/]+$/u, '') : name
}

/**
 * The Git actions a thread runs on its working copy the way T3 Code runs them (ADR-0027): the stacked
 * commit, push and pull request; a fast-forward pull; a branch switch or creation; initializing a
 * repository; publishing one to GitHub. It never forces, rebases, merges or resolves a conflict, and it
 * never answers a prompt: every refusal is said in T3's words and leaves the folder as it was.
 */
export class GitActions {
  private readonly run: RunGitCommand
  private readonly now: () => number
  /** One action per folder at a time, whichever thread asked, and whether it is Automatically pull's. */
  private readonly busy = new Map<string, 'action' | 'automatic-pull'>()
  constructor(private readonly dependencies: GitActionsDependencies) {
    this.run = dependencies.run ?? runGitStatusCommand
    this.now = dependencies.now ?? (() => Date.now())
  }
  private git(cwd: string, args: readonly string[], options?: Parameters<RunGitCommand>[3]): Promise<string> { return this.run(cwd, 'git', args, options) }
  private gh(cwd: string, args: readonly string[], options?: Parameters<RunGitCommand>[3]): Promise<string> { return this.run(cwd, 'gh', args, options) }
  private status(cwd: string): Promise<GitStatus> { return this.dependencies.status.read(cwd, { remote: true }) }

  private async exclusive<T>(cwd: string, work: () => Promise<T>, holder: 'action' | 'automatic-pull' = 'action'): Promise<T> {
    const held = this.busy.get(cwd)
    // An automatic pull runs with nothing on screen, so its refusal says what is holding the folder.
    if (held === 'automatic-pull') throw new GitActionRefusal('Sotto is pulling this folder. Try again in a moment.')
    if (held) throw new GitActionRefusal('Git action in progress.')
    this.busy.set(cwd, holder)
    try { return await work() } finally { this.busy.delete(cwd); this.dependencies.status.invalidate() }
  }

  /** T3's `runStackedAction`: branch, commit, push and pull request steps in that order, each reported as it starts. */
  runStackedAction(input: GitActionInput): Promise<GitActionResult> {
    return this.exclusive(input.cwd, async () => {
      const { cwd, action } = input
      const progress = input.onProgress ?? (() => undefined)
      const status = await this.status(cwd)
      if (!status.isRepository) throw new GitActionRefusal('This folder is not a Git repository. Initialize Git first.')
      const wantsCommit = action === 'commit' || action === 'commit_push' || action === 'commit_push_pr'
      const wantsPr = action === 'create_pr' || action === 'commit_push_pr'
      const wantsPush = action === 'push' || action === 'commit_push' || action === 'commit_push_pr' || (action === 'create_pr' && (!status.upstream || status.ahead > 0))
      const featureBranch = input.featureBranch === true
      if (featureBranch && !wantsCommit && !wantsPush) throw new GitActionRefusal('A feature branch is cut only for an action that commits or pushes.')
      if (input.filePaths !== undefined && input.filePaths.length === 0) throw new GitActionRefusal('Choose at least one file to commit.')
      if (action === 'create_pr' && status.dirty) throw new GitActionRefusal('Commit local changes before creating a PR.')
      if (!status.branch && wantsPush && !featureBranch) throw new GitActionRefusal('Cannot push from detached HEAD.')
      if (!status.branch && wantsPr) throw new GitActionRefusal('Cannot create a pull request from detached HEAD.')
      if (status.isDefaultBranch && (wantsPush || wantsPr) && !featureBranch && input.allowDefaultBranch !== true) throw new GitActionRefusal(`Confirm ${wantsPr ? 'creating a pull request' : 'pushing'} from the default branch first, or commit on a new branch.`)
      const pushTarget = await this.pushRemote(cwd, status.branch)
      const phases = gitActionPhases(action, featureBranch)
      progress({ kind: 'action_started', phases, stages: gitActionStages({ action, hasMessage: Boolean(input.commitMessage?.trim()), hasChanges: status.dirty, ...(pushTarget ? { pushTarget } : {}), featureBranch, pushBeforePr: action === 'create_pr' && wantsPush }) })
      const result: GitActionResult = { action, branch: { status: 'skipped_not_requested' }, commit: { status: 'skipped_not_requested' }, push: { status: 'skipped_not_requested' }, pr: { status: 'skipped_not_requested' }, toast: { title: 'Done', cta: { kind: 'none' } } }
      let branch = status.branch
      // "Check out feature branch & continue" on a push from the default branch: the branch is cut from HEAD and named
      // after its last commit, since there is no new commit to name it after.
      if (featureBranch && !wantsCommit) {
        const subject = (await this.git(cwd, ['log', '-1', '--format=%s']).catch(() => '')).trim()
        if (!subject) throw new GitActionRefusal('Cannot create a feature branch because there are no commits to push.')
        progress({ kind: 'phase_started', phase: 'branch', stage: 'Preparing feature ref...' })
        const name = await this.uniqueBranch(cwd, featureBranchName(subject))
        await this.git(cwd, ['branch', name])
        await this.git(cwd, ['checkout', name, '--'], { timeoutMs: 10_000 })
        branch = name
        result.branch = { status: 'created', name }
      }
      if (wantsCommit) {
        // A merge, cherry-pick or rebase half done is the user's to finish: staging afresh here would drop its state.
        for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']) {
          if (await this.git(cwd, ['rev-parse', '-q', '--verify', marker]).then(() => true, () => false)) throw new GitActionRefusal('A merge or rebase is in progress. Finish or abort it in a terminal before committing here.')
        }
        const staged = await this.stage(cwd, input.filePaths)
        if (!staged) {
          if (featureBranch) throw new GitActionRefusal('Cannot create a feature branch because there are no changes to commit.')
          result.commit = { status: 'skipped_no_changes' }
        } else {
          const message = await this.commitMessage(input, cwd, progress)
          if (featureBranch) {
            progress({ kind: 'phase_started', phase: 'branch', stage: 'Preparing feature ref...' })
            const name = await this.uniqueBranch(cwd, featureBranchName(message.subject))
            await this.git(cwd, ['branch', name])
            await this.git(cwd, ['checkout', name, '--'], { timeoutMs: 10_000 })
            branch = name
            result.branch = { status: 'created', name }
          }
          progress({ kind: 'phase_started', phase: 'commit', stage: 'Committing...' })
          const sha = await this.commit(cwd, message, progress)
          result.commit = { status: 'created', sha, subject: message.subject }
        }
      }
      if (wantsPush) {
        progress({ kind: 'phase_started', phase: 'push', stage: pushTarget ? `Pushing to ${pushTarget}...` : 'Pushing...' })
        result.push = await this.push(cwd, branch)
      }
      if (wantsPr) {
        progress({ kind: 'phase_started', phase: 'pr', stage: 'Preparing PR...' })
        result.pr = await this.pullRequest(input.threadId, cwd, branch!, progress)
      }
      result.toast = await this.toast(cwd, result, branch, status.isDefaultBranch)
      return result
    })
  }

  /** `git reset` then `git add -A`, or only the chosen paths, the way T3 stages; true when something is staged. */
  private async stage(cwd: string, filePaths: readonly string[] | undefined): Promise<boolean> {
    await this.git(cwd, ['reset', '-q']).catch(() => undefined)
    if (filePaths) await this.git(cwd, ['--literal-pathspecs', 'add', '-A', '--', ...filePaths])
    else await this.git(cwd, ['add', '-A'])
    return (await this.git(cwd, ['diff', '--cached', '--name-status'])).trim().length > 0
  }

  private async commitMessage(input: GitActionInput, cwd: string, progress: (event: GitActionEvent) => void): Promise<{ subject: string; body: string }> {
    const given = input.commitMessage?.trim()
    if (given) return splitMessage(given)
    progress({ kind: 'phase_started', phase: 'commit', stage: 'Generating commit message...' })
    const nameStatus = (await this.git(cwd, ['diff', '--cached', '--name-status'])).trim().slice(0, 8_000)
    const patch = await this.git(cwd, ['diff', '--no-ext-diff', '--cached', '--patch', '--minimal']).catch(() => '')
    const subjects = (await this.git(cwd, ['log', '-n', String(RECENT_SUBJECTS), '--no-merges', '--pretty=format:%s']).catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean)
    const agentsFile = await readFile(join(cwd, 'AGENTS.md'), 'utf8').then(text => text.slice(0, AGENTS_FILE_MAX_BYTES), () => null)
    const written = await this.dependencies.writeCommitMessage(input.threadId, { ...diffExcerpt(patch, COMMIT_DIFF_MAX_CHARACTERS), conventions: { nameStatus, subjects, agentsFile } })
    return splitMessage(written?.trim() || STAND_IN_SUBJECT)
  }

  /** `git commit` with its hooks, each line of what they print passed on, and the hooks named through Git's trace. */
  private async commit(cwd: string, message: { subject: string; body: string }, progress: (event: GitActionEvent) => void): Promise<string> {
    // The trace file holds Git's own process events (the hook names and their timing), never the message:
    // the message goes in on standard input, so no argument list and no file on disk carries it.
    const traceDir = await mkdtemp(join(tmpdir(), 'sotto-git-trace-'))
    const trace = join(traceDir, 'trace.jsonl')
    let hook: string | null = null, seen = 0, reading: Promise<void> | undefined
    const readTrace = (): Promise<void> => { reading ??= readTraceNow().finally(() => { reading = undefined }); return reading }
    const readTraceNow = async (): Promise<void> => {
      const text = await readFile(trace, 'utf8').catch(() => '')
      const lines = text.split('\n')
      for (const raw of lines.slice(seen, lines.length - 1)) {
        seen++
        let event: { event?: string; child_class?: string; argv?: string[] }
        try { event = JSON.parse(raw) } catch { continue }
        if (event.child_class !== 'hook') continue
        const name = hookNameOf(event.argv ?? [])
        if (event.event === 'child_start') { hook = name; progress({ kind: 'hook_started', hookName: name }) }
        else if (event.event === 'child_exit') { progress({ kind: 'hook_finished', hookName: name }); if (hook === name) hook = null }
      }
    }
    const ticker = setInterval(() => { void readTrace() }, 200)
    ticker.unref?.()
    try {
      await this.git(cwd, ['commit', '-F', '-'], {
        timeoutMs: COMMIT_TIMEOUT_MS, env: { GIT_TRACE2_EVENT: trace }, stdin: message.body ? `${message.subject}\n\n${message.body}\n` : `${message.subject}\n`,
        onLine: text => { const line = text.trim().slice(0, 500); if (line) progress({ kind: 'hook_output', hookName: hook, text: line }) },
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      throw new GitActionRefusal(`Commit failed. ${detail.split('\n').slice(-3).join(' ').slice(0, 600)}`.trim())
    } finally {
      clearInterval(ticker)
      await readTrace()
      await rm(traceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
    }
    if (hook) progress({ kind: 'hook_finished', hookName: hook })
    return (await this.git(cwd, ['rev-parse', 'HEAD'])).trim()
  }

  private async uniqueBranch(cwd: string, wanted: string): Promise<string> {
    const taken = new Set((await this.git(cwd, ['branch', '--list', '--no-column', '--format=%(refname:short)']).catch(() => '')).split('\n').map(line => line.trim().toLowerCase()).filter(Boolean))
    if (!taken.has(wanted.toLowerCase())) return wanted
    for (let suffix = 2; ; suffix++) { const candidate = `${wanted}-${suffix}`; if (!taken.has(candidate.toLowerCase())) return candidate }
  }

  /** `branch.<b>.pushRemote`, then `remote.pushDefault`, then `origin`, then the first remote, as T3 chooses. */
  private async pushRemote(cwd: string, branch: string | null): Promise<string | null> {
    const remotes = (await this.git(cwd, ['remote']).catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean)
    const configured = [branch ? await this.git(cwd, ['config', '--get', `branch.${branch}.pushRemote`]).catch(() => '') : '', await this.git(cwd, ['config', '--get', 'remote.pushDefault']).catch(() => '')]
      .map(value => value.trim()).find(value => value && remotes.includes(value))
    return configured ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? null)
  }

  private async push(cwd: string, branch: string | null): Promise<GitActionResult['push']> {
    if (!branch) throw new GitActionRefusal('Cannot push from detached HEAD.')
    const status = await this.dependencies.status.read(cwd, { remote: false })
    const remote = await this.pushRemote(cwd, branch)
    const publish = branch.replace(/^[^/]+\//u, match => (remote && match === `${remote}/` ? '' : match))
    if (status.ahead === 0 && status.behind === 0 && status.upstream) return { status: 'skipped_up_to_date' }
    if (!remote) throw new GitActionRefusal('Cannot push because no git remote is configured for this repository.')
    const upstream = status.upstream ? parseUpstream(status.upstream) : null
    try {
      if (!upstream) {
        if (status.ahead === 0 && await this.git(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${publish}`]).then(() => true, () => false)) return { status: 'skipped_up_to_date' }
        await this.git(cwd, ['push', '-u', remote, `HEAD:refs/heads/${publish}`], { timeoutMs: PUSH_TIMEOUT_MS })
        return { status: 'pushed', branch: publish, upstream: `${remote}/${publish}`, setUpstream: true }
      }
      const configuredElsewhere = remote !== upstream.remote && (await this.git(cwd, ['config', '--get', `branch.${branch}.pushRemote`]).catch(() => '')).trim() === remote
        || remote !== upstream.remote && (await this.git(cwd, ['config', '--get', 'remote.pushDefault']).catch(() => '')).trim() === remote
      if (configuredElsewhere) {
        // A triangular workflow: fetched from one remote, pushed to another. Git's own push would go there, so this one does too.
        await this.git(cwd, ['push', '-u', remote, `HEAD:refs/heads/${publish}`], { timeoutMs: PUSH_TIMEOUT_MS })
        return { status: 'pushed', branch: publish, upstream: `${remote}/${publish}`, setUpstream: true }
      }
      // Only a branch with the upstream's own name, or one named after the remote ref itself, is the same branch.
      // `fix/main` tracking `origin/main` is a topic branch, and its push publishes it under its own name.
      const sameBranch = upstream.branch === branch || branch === `${upstream.remote}/${upstream.branch}`
      if (!sameBranch) {
        // A branch cut from `origin/main` tracks main; pushing publishes it under its own name and moves the upstream there.
        if (!(await this.git(cwd, ['config', '--get', `branch.${branch}.gh-merge-base`]).catch(() => '')).trim()) await this.git(cwd, ['config', `branch.${branch}.gh-merge-base`, upstream.branch]).catch(() => undefined)
        await this.git(cwd, ['push', '-u', remote, `HEAD:refs/heads/${publish}`], { timeoutMs: PUSH_TIMEOUT_MS })
        return { status: 'pushed', branch: publish, upstream: `${remote}/${publish}`, setUpstream: true }
      }
      await this.git(cwd, ['push', upstream.remote, `HEAD:refs/heads/${upstream.branch}`], { timeoutMs: PUSH_TIMEOUT_MS })
      return { status: 'pushed', branch: upstream.branch, upstream: status.upstream! }
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      if (/non-fast-forward|fetch first/iu.test(detail)) throw new GitActionRefusal('Branch is behind upstream. Pull/rebase before pushing.')
      throw new GitActionRefusal(`Push failed. ${safeRemote(detail).split('\n').slice(-2).join(' ').slice(0, 600)}`.trim())
    }
  }

  private async openPullRequest(cwd: string, branch: string): Promise<{ number: number; title: string; url: string; base: string } | null> {
    const raw = await this.gh(cwd, ['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'number,title,url,baseRefName,headRefName,state'])
    const found = openPullRequestSchema.parse(JSON.parse(raw)).find(item => item.headRefName === branch)
    return found ? { number: found.number, title: found.title, url: found.url, base: found.baseRefName } : null
  }

  /** T3's base order: the recorded merge base, the upstream when it is another branch, GitHub's default, `origin/HEAD`, `main`. */
  private async baseBranch(cwd: string, branch: string): Promise<string> {
    const recorded = (await this.git(cwd, ['config', '--get', `branch.${branch}.gh-merge-base`]).catch(() => '')).trim()
    if (recorded) return recorded
    const status = await this.dependencies.status.read(cwd, { remote: false })
    const upstream = status.upstream ? parseUpstream(status.upstream) : null
    if (upstream && upstream.branch !== branch) return upstream.branch
    const viewed = await this.gh(cwd, ['repo', 'view', '--json', 'defaultBranchRef']).then(raw => repositorySchema.parse(JSON.parse(raw)).defaultBranchRef?.name ?? '', () => '')
    if (viewed) return viewed
    return status.defaultBranch ?? 'main'
  }

  private async pullRequest(threadId: string, cwd: string, branch: string, progress: (event: GitActionEvent) => void): Promise<GitActionResult['pr']> {
    const status = await this.dependencies.status.read(cwd, { remote: false })
    if (!status.upstream) throw new GitActionRefusal('Current branch has not been pushed. Push before creating a PR.')
    let existing: Awaited<ReturnType<GitActions['openPullRequest']>>
    try { existing = await this.openPullRequest(cwd, branch) }
    catch (error) { throw new GitActionRefusal(`Could not reach GitHub. Check gh authentication and network access. ${safeRemote(error instanceof Error ? error.message : '').slice(-300)}`.trim()) }
    if (existing) return { status: 'opened_existing', url: existing.url, number: existing.number, base: existing.base, head: branch, title: existing.title }
    const base = await this.baseBranch(cwd, branch)
    progress({ kind: 'phase_started', phase: 'pr', stage: 'Generating PR content...' })
    const remote = parseUpstream(status.upstream).remote
    const range = await this.git(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${base}^{commit}`]).then(sha => sha.trim() || base, () => base)
    const subjects = (await this.git(cwd, ['log', '--oneline', '--no-merges', `${range}..HEAD`]).catch(() => '')).slice(0, RANGE_LOG_MAX).split('\n').map(line => line.replace(/^\S+\s+/u, '').trim()).filter(Boolean).reverse()
    const stat = (await this.git(cwd, ['diff', '--stat', `${range}..HEAD`]).catch(() => '')).slice(0, RANGE_STAT_MAX)
    const patch = (await this.git(cwd, ['diff', '--no-ext-diff', '--patch', '--minimal', `${range}..HEAD`]).catch(() => '')).slice(0, RANGE_PATCH_MAX)
    // Follow pull request templates off: the template is not read at all, and the body is Sotto's own sections.
    const follow = await (async () => this.dependencies.followPullRequestTemplates?.() ?? true)().catch(() => true)
    const template = follow ? await this.pullRequestTemplate(cwd, range) : null
    const written = await this.dependencies.writePullRequestText(threadId, { subjects, diff: diffExcerpt(patch, RANGE_PATCH_MAX).text, stat, template })
    const title = written?.title ?? subjects.at(-1) ?? STAND_IN_SUBJECT
    const body = written?.body ?? (template ?? subjects.map(subject => `- ${subject}`).join('\n'))
    progress({ kind: 'phase_started', phase: 'pr', stage: 'Creating pull request...' })
    let creationError: Error | undefined
    // The body goes in on standard input, so it is never an argument and never a file on disk.
    await this.gh(cwd, ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', '-'], { timeoutMs: 120_000, stdin: body })
      .catch(error => { creationError = error instanceof Error ? error : new Error(String(error)) })
    // The write is never repeated. A lost acknowledgement is settled by asking what GitHub now lists: a
    // pull request that is there was created, whatever the reply said; one that is not is the refusal.
    const created = await this.openPullRequest(cwd, branch).catch(() => null)
    if (creationError && !created) throw new GitActionRefusal(`Could not create the pull request. ${safeRemote(creationError.message).slice(-400)}`.trim())
    return { status: 'created', head: branch, base, title: created?.title ?? title, ...(created ? { url: created.url, number: created.number } : {}) }
  }

  /** The repository's one pull request template at the base, where exactly one exists (T3's rule). */
  private async pullRequestTemplate(cwd: string, ref: string): Promise<string | null> {
    const single = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md']
    const listing = (await this.git(cwd, ['ls-tree', '-r', '-z', '--full-tree', ref, '--', ...single, '.github/PULL_REQUEST_TEMPLATE', 'PULL_REQUEST_TEMPLATE', 'docs/PULL_REQUEST_TEMPLATE']).catch(() => '')).split('\0').filter(Boolean)
    const entries = listing.map(line => { const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/u.exec(line); return match ? { oid: match[1]!, path: match[2]! } : null }).filter((entry): entry is { oid: string; path: string } => entry !== null)
    const file = single.map(path => entries.find(entry => entry.path === path)).find(Boolean)
    const chosen = file ?? (() => { const inside = entries.filter(entry => /PULL_REQUEST_TEMPLATE\/[^/]+\.md$/iu.test(entry.path)); return inside.length === 1 ? inside[0] : undefined })()
    if (!chosen) return null
    const text = await this.git(cwd, ['cat-file', 'blob', chosen.oid]).catch(() => '')
    return text ? text.slice(0, TEMPLATE_MAX_BYTES) : null
  }

  private async toast(cwd: string, result: GitActionResult, branch: string | null, isDefaultBranch: boolean): Promise<GitActionToast> {
    const short = (sha: string) => sha.slice(0, 7)
    if (result.pr.status === 'created' || result.pr.status === 'opened_existing') {
      const title = result.pr.number ? `${result.pr.status === 'created' ? 'Created' : 'Opened'} PR #${result.pr.number}` : 'Created the pull request'
      return { title, ...(result.pr.title ? { description: cut(result.pr.title) } : {}), cta: result.pr.url ? { kind: 'open_pr', label: 'View PR', url: result.pr.url } : { kind: 'none' } }
    }
    if (result.push.status === 'pushed') {
      const title = result.commit.sha ? `Pushed ${short(result.commit.sha)} to ${result.push.upstream ?? result.push.branch ?? 'the remote'}` : `Pushed to ${result.push.upstream ?? result.push.branch ?? 'the remote'}`
      const description = result.commit.subject ? { description: cut(result.commit.subject) } : {}
      if (!isDefaultBranch && branch) {
        const open = await this.openPullRequest(cwd, branch).catch(() => null)
        if (open) return { title, ...description, cta: { kind: 'open_pr', label: 'View PR', url: open.url } }
        return { title, ...description, cta: { kind: 'run_action', label: 'Create PR', action: 'create_pr' } }
      }
      return { title, ...description, cta: { kind: 'none' } }
    }
    if (result.commit.status === 'created' && result.commit.sha) return { title: `Committed ${short(result.commit.sha)}`, ...(result.commit.subject ? { description: cut(result.commit.subject) } : {}), cta: result.action === 'commit' ? { kind: 'run_action', label: 'Push', action: 'push' } : { kind: 'none' } }
    if (result.push.status === 'skipped_up_to_date') return { title: 'Already up to date', description: 'Nothing to push.', cta: { kind: 'none' } }
    if (result.commit.status === 'skipped_no_changes') return { title: 'Nothing to commit', description: 'The working tree is clean.', cta: { kind: 'none' } }
    return { title: 'Done', cta: { kind: 'none' } }
  }

  /**
   * `git pull --ff-only`: a diverged branch is refused in T3's words and nothing is merged or rebased by Sotto.
   * `automatic` marks Automatically pull's own pull, so an action pressed meanwhile is told what holds the folder.
   */
  pull(cwd: string, options: { automatic?: boolean } = {}): Promise<GitPullResult> {
    return this.exclusive(cwd, async () => {
      const status = await this.status(cwd)
      if (!status.isRepository) throw new GitActionRefusal('This folder is not a Git repository.')
      if (!status.branch) throw new GitActionRefusal('Cannot pull from detached HEAD.')
      if (!status.upstream) throw new GitActionRefusal('Current branch has no upstream configured. Push with upstream first.')
      const before = (await this.git(cwd, ['rev-parse', 'HEAD'])).trim()
      try { await this.git(cwd, ['pull', '--ff-only'], { timeoutMs: PULL_TIMEOUT_MS }) }
      catch (error) {
        const detail = error instanceof Error ? error.message : ''
        if (/not possible to fast-forward|diverg|Not possible to fast-forward/iu.test(detail)) throw new GitActionRefusal('Branch has diverged from upstream. Rebase/merge first.')
        throw new GitActionRefusal(`Pull failed. ${safeRemote(detail).split('\n').slice(-2).join(' ').slice(0, 600)}`.trim())
      }
      const after = (await this.git(cwd, ['rev-parse', 'HEAD'])).trim()
      return { status: before === after ? 'skipped_up_to_date' : 'pulled', branch: status.branch, upstream: status.upstream }
    }, options.automatic ? 'automatic-pull' : 'action')
  }

  /**
   * T3's `switchRef`: a local branch is checked out; a remote ref with no tracking branch gets one; an
   * existing tracking branch is used. No dirty check of Sotto's own: Git refuses when work would be lost,
   * and that refusal is what the user sees.
   */
  switchBranch(cwd: string, ref: string, options: { readonly create?: boolean } = {}): Promise<{ branch: string | null }> {
    return this.exclusive(cwd, async () => {
      if (!ref.trim() || ref.startsWith('-')) throw new GitActionRefusal('Enter a valid branch name.')
      await this.git(cwd, ['check-ref-format', '--branch', ref]).catch(() => { throw new GitActionRefusal('Enter a valid branch name.') })
      const exists = (candidate: string) => this.git(cwd, ['show-ref', '--verify', '--quiet', candidate]).then(() => true, () => false)
      try {
        if (options.create) {
          if (await exists(`refs/heads/${ref}`)) throw new GitActionRefusal(`The branch ${ref} already exists. Switch to it instead.`)
          await this.git(cwd, ['branch', ref], { timeoutMs: 10_000 })
          await this.git(cwd, ['checkout', ref, '--'], { timeoutMs: 10_000 })
        } else if (await exists(`refs/heads/${ref}`)) await this.git(cwd, ['checkout', ref, '--'], { timeoutMs: 10_000 })
        else if (await exists(`refs/remotes/${ref}`)) {
          const tracking = (await this.git(cwd, ['for-each-ref', '--format=%(refname:short)\t%(upstream:short)', 'refs/heads']).catch(() => '')).split('\n')
            .map(line => line.split('\t')).find(([, upstream]) => upstream === ref)?.[0]
          if (tracking) await this.git(cwd, ['checkout', tracking, '--'], { timeoutMs: 10_000 })
          else await this.git(cwd, ['checkout', '--track', ref, '--'], { timeoutMs: 10_000 })
        } else await this.git(cwd, ['checkout', ref, '--'], { timeoutMs: 10_000 })
      } catch (error) {
        if (error instanceof GitActionRefusal) throw error
        throw new GitActionRefusal(`Failed to switch ref. ${(error instanceof Error ? error.message : '').split('\n').slice(-2).join(' ').slice(0, 600)}`.trim())
      }
      const branch = (await this.git(cwd, ['branch', '--show-current'])).trim()
      return { branch: branch || null }
    })
  }

  /** `git init` for a folder that is not a repository yet. */
  init(cwd: string): Promise<void> {
    return this.exclusive(cwd, async () => {
      const status = await this.dependencies.status.read(cwd, { remote: false })
      if (status.isRepository) throw new GitActionRefusal('This folder is already a Git repository.')
      await this.git(cwd, ['init', '-q'], { timeoutMs: 10_000 }).catch(error => { throw new GitActionRefusal(`Git initialization failed. ${(error instanceof Error ? error.message : '').slice(0, 400)}`.trim()) })
    })
  }

  /** Publish a repository to GitHub through `gh`, adding `origin` and pushing the current branch. GitHub only (ADR-0027). */
  publish(cwd: string, options: { readonly repository: string; readonly visibility: 'private' | 'public' }): Promise<{ url: string }> {
    return this.exclusive(cwd, async () => {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/u.test(options.repository)) throw new GitActionRefusal('Name the repository as owner/name.')
      const status = await this.dependencies.status.read(cwd, { remote: false })
      if (!status.isRepository) throw new GitActionRefusal('Initialize Git before publishing.')
      if (status.hasRemote) throw new GitActionRefusal('This repository already has an origin remote.')
      const hasCommit = await this.git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false)
      const args = ['repo', 'create', options.repository, `--${options.visibility}`, '--source', '.', '--remote', 'origin', ...(hasCommit ? ['--push'] : [])]
      let output = ''
      try { output = await this.gh(cwd, args, { timeoutMs: 120_000 }) }
      catch (error) {
        // A reply that never came back is settled by the remote gh adds when it succeeds.
        const origin = (await this.git(cwd, ['remote', 'get-url', 'origin']).catch(() => '')).trim()
        if (!origin) throw new GitActionRefusal(`Publish failed. ${safeRemote(error instanceof Error ? error.message : '').slice(-400)}`.trim())
      }
      const url = /https:\/\/\S+/u.exec(output)?.[0] ?? `https://github.com/${options.repository}`
      return { url }
    })
  }
}

function splitMessage(message: string): { subject: string; body: string } {
  const [first, ...rest] = message.split('\n')
  const subject = (first ?? '').trim().replace(/\.+$/u, '').slice(0, COMMIT_SUBJECT_MAX_CHARACTERS).trim() || STAND_IN_SUBJECT
  return { subject, body: rest.join('\n').trim() }
}
function parseUpstream(upstream: string): { remote: string; branch: string } {
  const slash = upstream.indexOf('/')
  return slash === -1 ? { remote: 'origin', branch: upstream } : { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) }
}
function hookNameOf(argv: readonly string[]): string {
  const script = argv.find(argument => /hooks[\\/][^\\/]+$/u.test(argument)) ?? argv[0] ?? 'hook'
  return script.split(/[\\/]/u).pop() ?? 'hook'
}
const cut = (text: string): string => text.length > 72 ? `${text.slice(0, 69)}...` : text
const safeRemote = (text: string): string => text.replace(/((?:https?|ssh):\/\/)[^\s/@]+@/giu, '$1')
