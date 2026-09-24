// A stand-in for the GitHub CLI that the host runs through the gh test seam (SOTTO_E2E_GH_SCRIPT). It answers the
// reads the Git status, the Git action and the Pull request surface make, "creates" a pull request by writing it to
// FAKE_GH_STATE, a JSON file the spec owns, and acts on it the way GitHub would (merge, ready, close, auto-merge), so a
// journey pushes to an owned bare remote and opens, reads and merges its pull request without GitHub.
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
  reviewDecision: pull.reviewDecision ?? 'REVIEW_REQUIRED', baseRefName: pull.baseRefName, headRefName: pull.headRefName, isCrossRepository: false,
  headRepositoryOwner: { login: 'sotto-fixture' }, autoMergeRequest: pull.autoMergeRequest ?? null, mergedAt: pull.mergedAt ?? null,
  statusCheckRollup: pull.checks ?? [{ __typename: 'CheckRun', name: 'Owned build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `${repository}/actions/runs/1` }],
})

if (args[0] === 'pr' && args[1] === 'list') {
  const head = flag('--head'), wanted = flag('--state') ?? 'open'
  const pulls = data.pulls.filter(pull => pull.headRefName === head && (wanted === 'all' || pull.state.toLowerCase() === wanted))
  save(data)
  process.stdout.write(JSON.stringify(pulls.map(pull => ({ ...pull, isDraft: pull.isDraft ?? false, updatedAt: '2026-09-23T00:00:00Z' }))) + '\n')
} else if (args[0] === 'pr' && args[1] === 'view') {
  const pull = find(args[2])
  if (!pull) fail('GraphQL: Could not resolve to a PullRequest with the number of 0. (repository.pullRequest)')
  save(data)
  process.stdout.write(JSON.stringify(view(pull)) + '\n')
} else if (args[0] === 'api' && args[1] === 'graphql') {
  const number = Number(args.find(argument => argument.startsWith('number='))?.slice('number='.length))
  const pull = data.pulls.find(item => item.number === number)
  save(data)
  process.stdout.write(JSON.stringify({ data: { repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true,
    pullRequest: pull ? { viewerCanUpdateBranch: true, baseRef: { compare: { behindBy: pull.behindBy ?? 0 } } } : null } } }) + '\n')
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
