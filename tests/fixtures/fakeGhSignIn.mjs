// A stand-in for `gh auth status`, for the Plugins page's end-to-end run: it answers from the file FAKE_GH_SIGN_IN
// names, `{"login":"example-user"}` for a gh signed in as that account or `{}` for one signed in nowhere, and reaches
// nothing. Any other gh command ends with an error, as a gh with no network would.
import { readFileSync } from 'node:fs'

function refuse(why) {
  process.stderr.write(`${why}\n`)
  process.exit(2)
}

const args = process.argv.slice(2)
if (args[0] !== 'auth' || args[1] !== 'status') refuse('fakeGhSignIn answers gh auth status only')
const file = process.env.FAKE_GH_SIGN_IN
if (!file) refuse('FAKE_GH_SIGN_IN is not set')
const { login } = JSON.parse(readFileSync(file, 'utf8'))
process.stdout.write(JSON.stringify({ hosts: login ? { 'github.com': [{ active: true, login, state: 'success' }] } : {} }))
