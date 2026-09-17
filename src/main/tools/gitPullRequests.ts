import { z } from 'zod'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { prActionSchema, prDraftRequestSchema, prReviewRequestSchema, type PrDraft, type PrReview, type PullRequest } from '../../shared/gitPullRequests'
import type { FilesService } from '../files/service'
import { diffExcerpt } from '../llm/diffExcerpt'
import type { PullRequestMaterial, PullRequestText } from '../llm/pullRequestText'
import { fail, parse, ToolOperations, workspace } from './common'

export type GitPrCommand = (cwd: string, command: 'git' | 'gh', args: string[], stdin?: string) => Promise<string>
export type PullRequestDraftWriter = (material: PullRequestMaterial) => Promise<PullRequestText | null>
const repositorySchema = z.object({ nameWithOwner: z.string(), url: z.string().url(), defaultBranchRef: z.object({ name: z.string() }).nullable() })
const rawPrSchema = z.object({ number: z.number(), title: z.string(), url: z.string().url(), state: z.string(), baseRefName: z.string(), headRefName: z.string(), isDraft: z.boolean(), headRepository: z.object({ name: z.string() }).nullable(), headRepositoryOwner: z.object({ login: z.string() }).nullable(), reviewDecision: z.string().nullable().optional(), statusCheckRollup: z.array(z.object({ name: z.string().optional(), context: z.string().optional(), status: z.string().optional(), state: z.string().optional(), conclusion: z.string().nullable().optional(), detailsUrl: z.string().nullable().optional(), targetUrl: z.string().nullable().optional() })).nullable().optional() })
const githubRemote = (remote: string): string | null => {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote)
  return match ? `https://${match[1]}/${match[2]}` : null
}
const safeRemote = (remote: string): string => remote.replace(/((?:https?|ssh):\/\/)[^\s/@]+@/gi, '$1')
interface Dependencies { files: FilesService; mutations: Set<string>; canMutate?(threadId: string): Promise<boolean> | boolean; command?: GitPrCommand
  /** Sotto's own writing of the form. Absent, or resolving to null, leaves the form as the user found it. */
  draftText?(material: PullRequestMaterial): Promise<PullRequestText | null> }
const NO_DRAFT: PrDraft = { title: null, body: null }
export class GitPullRequestsService extends ToolOperations {
  private readonly children = new Set<ReturnType<typeof execFile>>()
  constructor(private readonly dependencies: Dependencies) { super() }
  private command(cwd: string, command: 'git' | 'gh', args: string[], stdin?: string): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Tool closed'))
    if (this.dependencies.command) return this.dependencies.command(cwd, command, args, stdin)
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GCM_INTERACTIVE: 'never' }
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key) && key !== 'GIT_TERMINAL_PROMPT') delete env[key as keyof typeof env]
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, { cwd, env, windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        this.children.delete(child)
        if (error) reject(new Error(error.code === 'ENOENT' ? `${command} is not installed or is not on PATH.` : stderr.trim() || error.message)); else resolve(stdout.trim())
      })
      this.children.add(child); child.stdin?.on('error', () => { /* Process exit reports a failed command. */ }); child.stdin?.end(stdin)
    })
  }
  private async findPr(cwd: string, repository: string, branch: string): Promise<PullRequest | null> {
    const raw = await this.command(cwd, 'gh', ['pr', 'list', '--repo', repository, '--head', branch, '--state', 'all', '--limit', '100', '--json', 'number,title,url,state,baseRefName,headRefName,isDraft,headRepository,headRepositoryOwner,reviewDecision,statusCheckRollup'])
    const identity = new URL(repository).pathname.slice(1).toLowerCase()
    const pr = z.array(rawPrSchema).parse(JSON.parse(raw)).sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number).find(pr => pr.headRefName === branch && `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`.toLowerCase() === identity)
    return pr ? { number: pr.number, title: pr.title, url: pr.url, state: pr.state, base: pr.baseRefName, head: pr.headRefName, draft: pr.isDraft, review: pr.reviewDecision || 'No review decision', checks: (pr.statusCheckRollup ?? []).map(check => ({ name: check.name || check.context || 'Check', status: check.conclusion || check.state || check.status || 'UNKNOWN', url: check.detailsUrl || check.targetUrl || null })) } : null
  }
  review(payload: unknown) { return this.run(async () => {
    const request = parse(prReviewRequestSchema, payload)
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const git = (...args: string[]) => this.command(owner.workingDirectory, 'git', args)
    const branch = await git('symbolic-ref', '--short', '-q', 'HEAD').catch(() => null)
    const head = await git('rev-parse', '--verify', 'HEAD').catch(() => '')
    const remotes = (await git('remote').catch(() => fail('not-repository', 'This working folder is not an available Git repository.'))).split('\n').filter(Boolean)
    const preferred = branch ? await git('config', '--get', `branch.${branch}.pushRemote`).catch(() => '') || await git('config', '--get', 'remote.pushDefault').catch(() => '') || await git('config', '--get', `branch.${branch}.remote`).catch(() => '') : ''
    const remote = request.remote ?? (remotes.includes(preferred) ? preferred : remotes.includes('origin') ? 'origin' : remotes[0] ?? null)
    if (remote && !remotes.includes(remote)) return fail('workspace-changed', 'This remote no longer exists. Refresh the pull request.')
    const urls = remote ? (await git('remote', 'get-url', '--push', '--all', remote)).split('\n') : []
    if (urls.length > 1) return fail('blocked', 'This remote has multiple push destinations. Choose a remote with one destination.')
    const remoteUrl = urls[0] ?? ''
    const title = await git('log', '-1', '--pretty=%s').catch(() => '')
    const body = await git('log', '-1', '--pretty=%b').catch(() => '')
    let repository: string | null = null, base = '', pullRequest: PullRequest | null = null, error: string | null = null
    const repositoryUrl = githubRemote(remoteUrl)
    if (repositoryUrl) {
      try {
        const repo = repositorySchema.parse(JSON.parse(await this.command(owner.workingDirectory, 'gh', ['repo', 'view', repositoryUrl, '--json', 'nameWithOwner,url,defaultBranchRef'])))
        repository = repo.url; base = repo.defaultBranchRef?.name ?? ''
        if (branch) pullRequest = await this.findPr(owner.workingDirectory, repository, branch)
      } catch (cause) { error = `Could not refresh GitHub. Check gh authentication and network access. ${safeRemote((cause as Error).message).slice(-900)}` }
    } else error = remote ? 'Pull requests require a GitHub remote. This branch can still be pushed.' : 'Add a Git remote before publishing this branch.'
    const revision = createHash('sha256').update(JSON.stringify([owner.workspaceId, branch, head, remote, remoteUrl, repository])).digest('hex')
    await workspace(this.dependencies.files, request.threadId, owner.workspaceId)
    return { workspace: owner, branch, head, remotes, remote, remoteUrl: safeRemote(remoteUrl), revision, title, body, repository, base, pullRequest, error } as PrReview
  }) }
  /** Where the branch left its base, tried against the base the form holds, then its remote copy. */
  private async mergeBase(cwd: string, base: string | undefined, remote: string | undefined): Promise<string | null> {
    const named = base ? [base, ...(remote ? [`${remote}/${base}`] : []), `origin/${base}`] : []
    for (const candidate of [...named, 'origin/HEAD']) {
      const start = await this.command(cwd, 'git', ['merge-base', '--', candidate, 'HEAD']).catch(() => '')
      if (start) return start
    }
    return null
  }
  /**
   * The drafted title and body for the form. Reading only: it runs no `gh` and
   * changes nothing, and every way of having no text - no writer, no key,
   * generation off, a detached head, no commits on the branch, a failed request
   * - is the same quiet `{ title: null, body: null }`, never an error.
   */
  draft(payload: unknown) { return this.run(async () => {
    const request = parse(prDraftRequestSchema, payload)
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const write = this.dependencies.draftText
    if (!write) return NO_DRAFT
    const git = (...args: string[]) => this.command(owner.workingDirectory, 'git', args)
    const branch = await git('symbolic-ref', '--short', '-q', 'HEAD').catch(() => null)
    if (!branch) return NO_DRAFT
    const start = await this.mergeBase(owner.workingDirectory, request.base, request.remote)
    if (!start) return NO_DRAFT
    const subjects = (await git('log', '--no-merges', '--reverse', '--format=%s', `${start}..HEAD`).catch(() => ''))
      .split('\n').map(subject => subject.trim()).filter(Boolean)
    if (subjects.length === 0) return NO_DRAFT
    const excerpt = diffExcerpt(await git('diff', '--no-color', '--no-ext-diff', '--unified=3', start, 'HEAD').catch(() => ''))
    const written = await write({ subjects, diff: excerpt.text }).catch(() => null)
    return written ? { title: written.title, body: written.body } : NO_DRAFT
  }) }
  act(payload: unknown) { return this.run(async () => {
    const request = parse(prActionSchema, payload)
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const root = await realpath(owner.workingDirectory)
    if (this.dependencies.mutations.has(root)) return fail('busy', 'Another Git action is running in this working copy.')
    this.dependencies.mutations.add(root)
    try {
      if (this.dependencies.canMutate && !await this.dependencies.canMutate(request.threadId)) return fail('blocked', 'Wait for active or pending thread work before publishing Git work.')
      const reviewed = await this.review({ threadId: request.threadId, workspaceId: request.workspaceId, remote: request.remote })
      if (!reviewed.ok) return fail(reviewed.error.code, reviewed.error.message)
      const review = reviewed.value
      if (review.revision !== request.revision) return fail('workspace-changed', 'The branch, commit or remote changed. Review the target again before publishing.')
      if (!review.branch || !review.head) return fail('blocked', 'Commit work on a named branch before publishing.')
      await workspace(this.dependencies.files, request.threadId, request.workspaceId)
      const pushUrl = await this.command(root, 'git', ['remote', 'get-url', '--push', '--all', request.remote])
      const destinationRevision = createHash('sha256').update(JSON.stringify([owner.workspaceId, review.branch, review.head, review.remote, pushUrl, review.repository])).digest('hex')
      if (destinationRevision !== review.revision) return fail('workspace-changed', 'The push destination changed. Review the target again before publishing.')
      if (request.action === 'push') {
        await this.command(root, 'git', ['push', '--', pushUrl, `${review.head}:refs/heads/${review.branch}`]).catch(error => fail('blocked', `Push failed: ${safeRemote((error as Error).message).slice(-1500)} Refresh before retrying.`))
        return { message: 'Branch pushed.', pullRequest: null }
      }
      if (review.error || !review.repository) return fail('unavailable', review.error ?? 'Choose a GitHub remote before creating a pull request.')
      if (review.pullRequest) return { message: 'Opened the existing pull request.', pullRequest: review.pullRequest }
      if (!request.base?.trim() || !request.title?.trim()) return fail('invalid-request', 'Review the base branch and title before creating a pull request.')
      await this.command(root, 'git', ['check-ref-format', '--branch', request.base]).catch(() => fail('invalid-request', 'Enter a valid base branch.'))
      if (request.base === review.branch) return fail('blocked', 'Choose a base branch different from the working branch.')
      const published = await this.command(root, 'git', ['ls-remote', '--heads', '--', pushUrl, `refs/heads/${review.branch}`]).catch(error => fail('unavailable', `Could not confirm the published branch. ${safeRemote((error as Error).message).slice(-1000)}`))
      if (published.split(/\s/)[0] !== review.head) return fail('blocked', 'Push the reviewed commit before creating this pull request.')
      await workspace(this.dependencies.files, request.threadId, request.workspaceId)
      const currentHead = await this.command(root, 'git', ['rev-parse', 'HEAD'])
      const currentBranch = await this.command(root, 'git', ['symbolic-ref', '--short', 'HEAD'])
      if (currentHead !== review.head || currentBranch !== review.branch) return fail('workspace-changed', 'The working branch moved. Refresh before creating a pull request.')
      let creationError: unknown
      try {
        await this.command(root, 'gh', ['pr', 'create', '--repo', review.repository, '--head', review.branch, '--base', request.base, '--title', request.title.trim(), '--body-file', '-'], request.body ?? '')
      } catch (error) { creationError = error }
      // Always reconcile a create, including a lost acknowledgement; never repeat the write automatically.
      const pullRequest = await this.findPr(root, review.repository, review.branch).catch(() => null)
      if (!pullRequest) return fail('unavailable', `Pull request creation was not confirmed. Refresh before trying again. ${creationError instanceof Error ? safeRemote(creationError.message).slice(-900) : ''}`)
      return { message: creationError ? 'Found the created pull request after reconnecting.' : 'Pull request created.', pullRequest }
    } finally { this.dependencies.mutations.delete(root) }
  }) }
  dispose(): void { this.disposed = true; for (const child of this.children) child.kill(); this.children.clear() }
}
