// A stand-in for the GitHub CLI that the host runs through the gh test seam (SOTTO_E2E_GH_SCRIPT). It answers the
// reads the Git status and the Git action make, and "creates" a pull request by writing it to FAKE_GH_STATE, a
// JSON file the spec owns, so a journey pushes to an owned bare remote and opens its pull request without GitHub.
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

if (args[0] === 'pr' && args[1] === 'list') {
  const head = flag('--head'), wanted = flag('--state') ?? 'open'
  const pulls = data.pulls.filter(pull => pull.headRefName === head && (wanted === 'all' || pull.state.toLowerCase() === wanted))
  save(data)
  process.stdout.write(JSON.stringify(pulls.map(pull => ({ ...pull, isDraft: false, updatedAt: '2026-09-23T00:00:00Z' }))) + '\n')
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
} else {
  save(data)
  process.stderr.write(`fake gh: unsupported command ${args.join(' ')}\n`)
  process.exit(1)
}
