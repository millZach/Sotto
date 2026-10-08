import { z } from 'zod'
import { repositoryKey, type GitHubAsk, type GitHubRepository } from './github'
import type { GitCommandOptions, RunGitCommand } from './gitStatus'

/** Heads asked about in one query: 50 took GitHub about ten seconds, its processing limit, so T3 settled on 25 (#16760). */
export const HEADS_PER_QUERY = 25
/** How long lookups gather before their query goes: short for a read the user is waiting on, longer for the timer's (T3's figures). */
export const HEAD_GATHER_MS: Readonly<Record<GitHubAsk, number>> = { user: 50, background: 500 }
/** Pull requests asked for per head, newest first, as `gh pr list --limit 20` asked. */
const PULL_REQUESTS_PER_HEAD = 20
const NODE_SELECTION = 'number title url state isDraft updatedAt headRefName isCrossRepository headRepositoryOwner { login }'

const nodeSchema = z.object({
  number: z.number().int().positive(), title: z.string(), url: z.string(), state: z.string(), isDraft: z.boolean().nullable().optional(),
  updatedAt: z.string().nullable().optional(), headRefName: z.string(), isCrossRepository: z.boolean().nullable().optional(),
  headRepositoryOwner: z.object({ login: z.string().nullable().optional() }).nullable().optional(),
})
const answerSchema = z.object({ data: z.object({
  repository: z.record(z.string(), z.object({ nodes: z.array(nodeSchema.nullable()) }).nullable()).nullable(),
}) })

/** One pull request whose head branch has the name asked about, in any repository; the caller decides which are its own. */
export interface HeadPullRequest {
  readonly number: number; readonly title: string; readonly url: string; readonly state: 'open' | 'closed' | 'merged'; readonly draft: boolean
  readonly updatedAt: string | null; readonly headOwner: string | null; readonly crossRepository: boolean
}

/**
 * The query for up to 25 heads of one repository: one aliased `pullRequests` connection per head, each head passed as
 * a variable rather than written into the document (T3's `buildPullRequestsByHeadQuery`). Every lookup asks for all
 * three states, so they are written in rather than passed.
 */
export function pullRequestsByHeadQuery(count: number): string {
  const declarations = ['$owner: String!', '$name: String!', ...Array.from({ length: count }, (_, index) => `$h${index}: String!`)]
  const selections = Array.from({ length: count }, (_, index) =>
    `    h${index}: pullRequests(headRefName: $h${index}, states: [OPEN, CLOSED, MERGED], first: ${PULL_REQUESTS_PER_HEAD}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${NODE_SELECTION} } }`)
  return `query PullRequestsByHead(${declarations.join(', ')}) {\n  repository(owner: $owner, name: $name) {\n${selections.join('\n')}\n  }\n}`
}

interface Lookup { readonly head: string; ask: GitHubAsk; readonly cwds: Set<string>; readonly done: Promise<HeadPullRequest[]>; resolve(value: HeadPullRequest[]): void; reject(error: unknown): void }
interface Gathering { readonly repository: GitHubRepository; readonly lookups: Map<string, Lookup>; ask: GitHubAsk; timer: ReturnType<typeof setTimeout>; dueAt: number }

export interface PullRequestHeadsOptions {
  readonly run: RunGitCommand
  readonly env?: Readonly<Record<string, string>>
  readonly gatherMs?: Readonly<Record<GitHubAsk, number>>
  /** Whether a folder is being removed, so the query runs elsewhere if another lookup's folder will do. */
  readonly held?: (cwd: string) => boolean
  /** Records the gh process against each folder whose lookup it answers, so a removal waits for it. */
  readonly track?: (cwds: readonly string[], work: Promise<unknown>) => void
}

/**
 * Pull requests by head branch, asked about in batches (#820). Lookups of one repository that arrive within a short
 * window share one `gh api graphql` query, 25 heads at most a query, and a lookup of a repository and head already
 * waiting or in flight is shared rather than asked twice.
 */
export class PullRequestHeads {
  private readonly gathering = new Map<string, Gathering>()
  /** Lookups waiting or in flight, by repository and head, so a second caller shares the first one's answer. */
  private readonly pending = new Map<string, Lookup>()
  private readonly gatherMs: Readonly<Record<GitHubAsk, number>>
  constructor(private readonly options: PullRequestHeadsOptions) { this.gatherMs = options.gatherMs ?? HEAD_GATHER_MS }

  lookup(cwd: string, repository: GitHubRepository, head: string, ask: GitHubAsk): Promise<HeadPullRequest[]> {
    const repo = repositoryKey(repository)
    const key = `${repo}\0${head}`
    const gathering = this.gathering.get(repo)
    const waiting = gathering?.lookups.get(head)
    if (waiting && gathering) {
      // Still gathering: the user's ask makes the whole query the user's, and it goes sooner.
      waiting.cwds.add(cwd)
      if (ask === 'user' && waiting.ask === 'background') { waiting.ask = 'user'; this.hurry(repo, gathering) }
      return waiting.done
    }
    const sent = this.pending.get(key)
    // In flight already: shared, unless it went as the timer's and this is the user's, which may be answered differently.
    if (sent && (sent.ask === 'user' || ask === 'background')) return sent.done
    let resolve!: (value: HeadPullRequest[]) => void, reject!: (error: unknown) => void
    const done = new Promise<HeadPullRequest[]>((accept, refuse) => { resolve = accept; reject = refuse })
    const lookup: Lookup = { head, ask, cwds: new Set([cwd]), done, resolve, reject }
    this.pending.set(key, lookup)
    void done.then(() => undefined, () => undefined).then(() => { if (this.pending.get(key) === lookup) this.pending.delete(key) })
    let current = gathering
    if (!current) {
      current = { repository, lookups: new Map(), ask, dueAt: Date.now() + this.gatherMs[ask], timer: setTimeout(() => this.flush(repo), this.gatherMs[ask]) }
      this.gathering.set(repo, current)
    }
    current.lookups.set(head, lookup)
    if (ask === 'user' && current.ask === 'background') this.hurry(repo, current)
    return done
  }

  private hurry(repo: string, gathering: Gathering): void {
    gathering.ask = 'user'
    const dueAt = Date.now() + this.gatherMs.user
    if (dueAt >= gathering.dueAt) return
    clearTimeout(gathering.timer)
    gathering.dueAt = dueAt
    gathering.timer = setTimeout(() => this.flush(repo), this.gatherMs.user)
  }

  private flush(repo: string): void {
    const gathering = this.gathering.get(repo)
    if (!gathering) return
    this.gathering.delete(repo)
    const lookups = [...gathering.lookups.values()]
    for (let start = 0; start < lookups.length; start += HEADS_PER_QUERY) void this.ask(gathering.repository, lookups.slice(start, start + HEADS_PER_QUERY))
  }

  private async ask(repository: GitHubRepository, lookups: readonly Lookup[]): Promise<void> {
    const cwds = [...new Set(lookups.flatMap(lookup => [...lookup.cwds]))]
    const cwd = cwds.find(folder => !this.options.held?.(folder)) ?? cwds[0]!
    const args = ['api', 'graphql', ...repository.host === 'github.com' ? [] : ['--hostname', repository.host],
      '-f', `query=${pullRequestsByHeadQuery(lookups.length)}`, '-f', `owner=${repository.owner}`, '-f', `name=${repository.name}`,
      ...lookups.flatMap((lookup, index) => ['-f', `h${index}=${lookup.head}`])]
    const options: GitCommandOptions = this.options.env ? { env: this.options.env } : {}
    const work = this.options.run(cwd, 'gh', args, options)
    this.options.track?.(cwds, work)
    let answer: z.infer<typeof answerSchema>
    try { answer = answerSchema.parse(JSON.parse(await work)) }
    catch (error) { for (const lookup of lookups) lookup.reject(error); return }
    lookups.forEach((lookup, index) => {
      const nodes = answer.data.repository?.[`h${index}`]?.nodes ?? []
      lookup.resolve(nodes.flatMap((node): HeadPullRequest[] => {
        if (!node || node.headRefName !== lookup.head) return []
        const state = node.state.toLowerCase()
        if (state !== 'open' && state !== 'closed' && state !== 'merged') return []
        return [{ number: node.number, title: node.title, url: node.url, state, draft: node.isDraft === true, updatedAt: node.updatedAt ?? null,
          headOwner: node.headRepositoryOwner?.login ?? null, crossRepository: node.isCrossRepository === true }]
      }))
    })
  }
}
