// Stands in for a provider client's own sign-in on a host (ADR-0037), printing what the real one prints into a pipe:
// Codex's and Grok Build's device-code sign-ins, which finish by themselves once the code is entered on the page, Claude
// Code's subscription sign-in, which waits for the code the page shows to be pasted back, and Cursor's `agent login`, which
// prints a page and no code and finishes by itself once the user has signed in there (ADR-0125).
//
//   node fakeSignInCli.mjs <provider> <the client's own arguments…>
//
// FAKE_SIGN_IN_DIR is a folder of plain files the test drives it with: `<provider>.approved` stands for the user entering
// the code on the page, `<provider>.denied` for refusing it there. On success it writes `<provider>.signed-in`, which the
// test's scripted provider reads to connect. It records its arguments in `<provider>.args.json`, never a code.
// FAKE_SIGN_IN_PAGE, when set, is printed in place of the provider's own page. FAKE_SIGN_IN_SPLIT, when set, is where
// the output is cut in two with a pause between, as a pipe can hand a reader a line in pieces.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [provider, ...args] = process.argv.slice(2)
const directory = process.env.FAKE_SIGN_IN_DIR
if (!directory || !provider) { process.stderr.write('The fake sign-in needs FAKE_SIGN_IN_DIR and a provider.\n'); process.exit(2) }
const file = name => join(directory, `${provider}.${name}`)
writeFileSync(file('args.json'), JSON.stringify(args))
const grey = text => `\u001b[90m${text}\u001b[0m`, blue = text => `\u001b[94m${text}\u001b[0m`
const signedIn = () => { writeFileSync(file('signed-in'), ''); }
const page = process.env.FAKE_SIGN_IN_PAGE
const split = process.env.FAKE_SIGN_IN_SPLIT
let printing = Promise.resolve()
const say = text => {
  const at = split ? text.indexOf(split) : -1
  printing = printing.then(async () => {
    if (at < 0) { process.stdout.write(text); return }
    process.stdout.write(text.slice(0, at + split.length))
    await new Promise(resolve => setTimeout(resolve, 300))
    process.stdout.write(text.slice(at + split.length))
  })
}

if (provider === 'claude') {
  say('Opening browser to sign in…\n')
  say(`If the browser didn't open, visit: ${page ?? 'https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&state=fixture-state'}\n`)
  say('Paste code here if prompted > ')
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    const [code, state] = line.trim().split('#')
    if (!code || !state) { process.stderr.write('Invalid code. Please make sure the full code was copied.\n'); return }
    if (code === 'good-code' && state === 'fixture-state') { signedIn(); process.stdout.write('Login successful.\n'); process.exit(0) }
    process.stderr.write('Login failed: Invalid authorization code\n'); process.exit(1)
  })
} else if (provider === 'cursor') {
  // As Cursor 2026.10.22-27dcf5f prints it into a pipe with NO_OPEN_BROWSER set.
  say('\nCursor Agent\n\nPress any key to sign in...\n')
  say(`Open this link to sign in: ${page ?? 'https://cursor.com/loginDeepControl?challenge=fixture&uuid=fixture&mode=login'}\n`)
  setInterval(() => {
    if (existsSync(file('approved'))) { signedIn(); process.stdout.write('Login successful!\n'); process.exit(0) }
    if (existsSync(file('denied'))) { process.stderr.write('Login failed\n'); process.exit(1) }
  }, 50)
} else {
  const code = provider === 'codex' ? 'WDJB-MJHTQ' : 'K7PX-2QRM'
  if (provider === 'codex') {
    say(`\nWelcome to Codex [v${grey('0.158.0')}]\n${grey("OpenAI's command-line coding agent")}\n\n`)
    say('Follow these steps to sign in with ChatGPT using device code authorization:\n\n')
    say(`1. Open this link in your browser and sign in to your account\n   ${blue(page ?? 'https://auth.openai.com/codex/device')}\n\n`)
    say(`2. Enter this one-time code ${grey('(expires in 15 minutes)')}\n   ${blue(code)}\n\n`)
  } else {
    say(`\nTo sign in, open this URL in your browser:\n\n  ${page ?? `https://accounts.x.ai/oauth2/device?user_code=${code}`}\n\n`)
    say(`Confirm this code in your browser:\n\n  ${code}\n\nWaiting for authorization...\n`)
  }
  setInterval(() => {
    if (existsSync(file('approved'))) { signedIn(); process.stdout.write('Successfully logged in\n'); process.exit(0) }
    if (existsSync(file('denied'))) { process.stderr.write('Error: device authorization was denied\n'); process.exit(1) }
  }, 50)
}
