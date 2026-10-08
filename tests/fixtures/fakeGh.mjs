// A stand-in for the GitHub CLI that the host runs through the gh test seam (SOTTO_E2E_GH_SCRIPT). It answers the
// reads the Git status (one batched GraphQL query), the Git action and the Pull request surface (one GraphQL query)
// make, "creates" a pull request by writing it to FAKE_GH_STATE, a JSON file the spec owns, and acts on it the way GitHub would (merge, ready, close, auto-merge), so a
// journey pushes to an owned bare remote and opens, reads and merges its pull request without GitHub. It answers
// babysitting's two reads too (ADR-0061): the batched fingerprint and one pull request's detail, from the same records,
// with a pull request's `head` naming its head commit.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const statePath = process.env.FAKE_GH_STATE
const state = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return { pulls: [], calls: [] } } }
const save = data => writeFileSync(statePath, JSON.stringify(data, null, 2))
const flag = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const record = (data, entry) => { data.calls = [...(data.calls ?? []), entry] }
const repository = 'https://github.com/sotto-fixture/owned'
const data = state()
record(data, args.join(' '))
/** The pull request a selector names: a number, `#74`, or its URL. */
const find = selector => {
  const number = Number(/(?:^#?|\/pull\/)(\d+)/u.exec(selector ?? '')?.[1])
  return data.pulls.find(pull => pull.number === number)
}
const fail = message => { save(data); process.stderr.write(`${message}\n`); process.exit(1) }
const view = pull => ({
  number: pull.number, title: pull.title, url: pull.url, body: pull.body ?? '', state: pull.state, isDraft: pull.isDraft ?? false, mergeable: pull.mergeable ?? 'MERGEABLE',
  // GitHub answers an empty decision where the repository requires no review.
  reviewDecision: pull.reviewDecision ?? '', baseRefName: pull.baseRefName, headRefName: pull.headRefName, isCrossRepository: false,
  headRepositoryOwner: { login: 'sotto-fixture' }, autoMergeRequest: pull.autoMergeRequest ?? null, mergedAt: pull.mergedAt ?? null,
  statusCheckRollup: pull.checks ?? [{ __typename: 'CheckRun', name: 'Owned build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `${repository}/actions/runs/1` }],
})

/** The `-f`/`-F` variables of a `gh api graphql` call, by name. */
const variables = () => {
  const found = {}
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== '-f' && args[index] !== '-F') continue
    const pair = args[index + 1], split = pair.indexOf('=')
    found[pair.slice(0, split)] = pair.slice(split + 1)
  }
  return found
}
const RATE_LIMIT = { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z' }
/** A check run's one state, as GitHub counts check runs by state: its conclusion once it finished, else its status. */
const checkState = check => check.status === 'COMPLETED' ? check.conclusion : check.status
const babysitFingerprint = pull => {
  const counts = new Map()
  for (const check of view(pull).statusCheckRollup) counts.set(checkState(check), (counts.get(checkState(check)) ?? 0) + 1)
  return {
    number: pull.number, title: pull.title, url: pull.url, state: pull.state, mergeable: pull.mergeable ?? 'MERGEABLE', headRefOid: pull.head ?? 'head-1',
    baseRefName: pull.baseRefName, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] }, reviewThreads: { totalCount: 0 },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: [...counts].map(([state, count]) => ({ state, count })), statusContextCountsByState: [] } } } }] },
  }
}

if (args[0] === 'api' && args[1] === 'graphql' && args.some(argument => argument.startsWith('query=query BabysitFingerprint'))) {
  const repository = {}
  for (const [key, value] of Object.entries(variables())) if (/^p\d+$/u.test(key)) {
    const pull = data.pulls.find(item => item.number === Number(value))
    repository[key] = pull ? babysitFingerprint(pull) : null
  }
  save(data)
  process.stdout.write(JSON.stringify({ data: { rateLimit: RATE_LIMIT, viewer: { login: 'sotto-fixture' }, repository } }) + '\n')
} else if (args[0] === 'api' && args[1] === 'graphql' && args.some(argument => argument.startsWith('query=query BabysitDetail'))) {
  const asked = variables()
  const pull = data.pulls.find(item => item.number === Number(asked.number))
  save(data)
  const head = pull?.head ?? 'head-1'
  const checks = pull ? view(pull).statusCheckRollup.map(({ workflowName, ...check }) => ({ ...check, isRequired: false,
    checkSuite: workflowName ? { workflowRun: { workflow: { name: workflowName } } } : null })) : []
  process.stdout.write(JSON.stringify({ data: { rateLimit: RATE_LIMIT, repository: { pullRequest: pull ? {
    headRefOid: head,
    ...asked.checks === 'true' ? { commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { nodes: checks } } } }] } } : {},
    ...asked.remarks === 'true' ? { comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } } : {},
  } : null } } }) + '\n')
} else if (args[0] === 'pr' && args[1] === 'list') {
  const head = flag('--head'), wanted = flag('--state') ?? 'open'
  const pulls = data.pulls.filter(pull => pull.headRefName === head && (wanted === 'all' || pull.state.toLowerCase() === wanted))
  save(data)
  process.stdout.write(JSON.stringify(pulls.map(pull => ({ ...pull, isDraft: pull.isDraft ?? false, updatedAt: '2026-09-23T00:00:00Z', headRepositoryOwner: { login: 'sotto-fixture' }, isCrossRepository: false }))) + '\n')
} else if (args[0] === 'api' && args[1] === 'graphql' && args.some(argument => argument.startsWith('query=query PullRequestsByHead'))) {
  // The status reader's batched lookup: each aliased head (`h0=feat/greeting`) gets the pull requests with that head.
  const repository = {}
  for (const argument of args) {
    const match = /^(h\d+)=(.*)$/su.exec(argument)
    if (match) repository[match[1]] = { nodes: data.pulls.filter(pull => pull.headRefName === match[2]).map(pull => ({ number: pull.number, title: pull.title, url: pull.url,
      state: pull.state, isDraft: pull.isDraft ?? false, updatedAt: '2026-09-23T00:00:00Z', headRefName: pull.headRefName, isCrossRepository: false, headRepositoryOwner: { login: 'sotto-fixture' } })) }
  }
  save(data)
  process.stdout.write(JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z' }, viewer: { login: 'sotto-fixture' }, repository } }) + '\n')
} else if (args[0] === 'api' && args[1] === 'graphql' && args.some(argument => argument.startsWith('query=query PullRequestDetail'))) {
  // The Pull request surface's one read: the pull request with its checks, reviews and distance from its base.
  const number = Number(args.find(argument => argument.startsWith('number='))?.slice('number='.length))
  const pull = data.pulls.find(item => item.number === number)
  if (!pull) fail(`GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)`)
  save(data)
  const viewed = view(pull)
  const contexts = viewed.statusCheckRollup.map(({ workflowName, ...check }) => ({ ...check, checkSuite: workflowName ? { workflowRun: { workflow: { name: workflowName } } } : null }))
  delete viewed.statusCheckRollup
  process.stdout.write(JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z' }, viewer: { login: 'sotto-fixture' }, repository: {
    mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true,
    pullRequest: { ...viewed, viewerCanUpdateBranch: true, baseRef: { compare: { behindBy: pull.behindBy ?? 0 } }, latestOpinionatedReviews: { nodes: pull.reviews ?? [] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] } },
  } } }) + '\n')
} else if (args[0] === 'repo' && args[1] === 'view') {
  save(data)
  process.stdout.write(JSON.stringify({ defaultBranchRef: { name: 'main' } }) + '\n')
} else if (args[0] === 'pr' && args[1] === 'create') {
  let body
  try { body = readFileSync(0, 'utf8') } catch { body = '' }
  const number = data.pulls.length + 74
  const pull = { number, title: flag('--title') ?? '', url: `${repository}/pull/${number}`, state: 'OPEN', baseRefName: flag('--base') ?? 'main', headRefName: flag('--head') ?? '', body }
  data.pulls.push(pull)
  save(data)
  process.stdout.write(pull.url + '\n')
} else if (args[0] === 'pr' && ['merge', 'ready', 'close', 'reopen', 'update-branch'].includes(args[1])) {
  const pull = find(args[2])
  if (!pull) fail('no pull requests found')
  const method = ['--merge', '--squash', '--rebase'].find(option => args.includes(option))?.slice(2)
  if (args[1] === 'merge' && args.includes('--disable-auto')) pull.autoMergeRequest = null
  else if (args[1] === 'merge' && args.includes('--auto')) pull.autoMergeRequest = { mergeMethod: method?.toUpperCase() }
  else if (args[1] === 'merge') {
    if (pull.state !== 'OPEN') fail('GraphQL: Pull request is not mergeable (mergePullRequest)')
    Object.assign(pull, { state: 'MERGED', mergedAt: '2026-09-23T00:00:00Z', mergedWith: method })
  } else if (args[1] === 'ready') {
    // GitHub refuses to change a closed pull request's draft state.
    if (pull.state !== 'OPEN') fail(`GraphQL: Pull request is closed (${args.includes('--undo') ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview'})`)
    pull.isDraft = args.includes('--undo')
  }
  else if (args[1] === 'close') pull.state = 'CLOSED'
  else if (args[1] === 'reopen') pull.state = 'OPEN'
  else pull.behindBy = 0
  save(data)
} else if (args[0] === 'pr' && args[1] === 'checkout') {
  const pull = find(args[2])
  if (!pull) fail('no pull requests found')
  save(data)
  // gh checks the head branch out, tracking it; the owned remote already has it.
  try { execFileSync('git', ['fetch', '-q', 'origin', pull.headRefName], { stdio: 'pipe' }); execFileSync('git', ['checkout', '-q', pull.headRefName], { stdio: 'pipe' }) }
  catch (error) { process.stderr.write(String(error.stderr ?? error.message)); process.exit(1) }
} else {
  save(data)
  process.stderr.write(`fake gh: unsupported command ${args.join(' ')}\n`)
  process.exit(1)
}
