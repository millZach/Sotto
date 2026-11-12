// A stand-in for gh, for the Plugins end-to-end runs, that reaches nothing. `gh auth status` answers from the file
// FAKE_GH_SIGN_IN names: `{"login":"example-user"}` for a gh signed in as that account or `{}` for one signed in
// nowhere. With FAKE_GH_POSTS set, `gh api --method POST … --input -`, and the same with PATCH, appends its arguments
// and what it was handed on standard input to that file, one JSON line each, and answers as GitHub does for the thing
// it made or changed. With FAKE_GH_ISSUE set, `gh api --method GET … --jq …` answers with that text, as gh does when it
// is asked about one issue. Any other gh command ends with an error, as a gh with no network would.
import { appendFileSync, readFileSync } from 'node:fs'

function refuse(why) {
  process.stderr.write(`${why}\n`)
  process.exit(2)
}

const args = process.argv.slice(2)
const posts = process.env.FAKE_GH_POSTS
if (args[0] === 'api' && posts && args[1] === '--method' && (args[2] === 'POST' || args[2] === 'PATCH') && args.at(-2) === '--input' && args.at(-1) === '-') {
  appendFileSync(posts, `${JSON.stringify({ args, stdin: readFileSync(0, 'utf8') })}\n`)
  process.stdout.write(JSON.stringify({ html_url: args[2] === 'POST' ? 'https://github.com/example-owner/example-repo/issues/12#issuecomment-1' : 'https://github.com/example-owner/example-repo/issues/12' }))
  process.exit(0)
}
const issue = process.env.FAKE_GH_ISSUE
if (args[0] === 'api' && issue && args[1] === '--method' && args[2] === 'GET' && args.at(-2) === '--jq') {
  process.stdout.write(issue)
  process.exit(0)
}
if (args[0] !== 'auth' || args[1] !== 'status') refuse('fakeGhSignIn answers gh auth status, a POST or PATCH when FAKE_GH_POSTS is set, and a read of one issue when FAKE_GH_ISSUE is set')
const file = process.env.FAKE_GH_SIGN_IN
if (!file) refuse('FAKE_GH_SIGN_IN is not set')
const { login } = JSON.parse(readFileSync(file, 'utf8'))
process.stdout.write(JSON.stringify({ hosts: login ? { 'github.com': [{ active: true, login, state: 'success' }] } : {} }))
