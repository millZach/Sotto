// A stand-in for OpenSSH that the launcher spawns with plain pipes. It asks its questions through
// SSH_ASKPASS the way OpenSSH does, and either scripts the remote side by mode or, in `run` mode, runs
// the remote command on this machine against a fake host installation under FAKE_SSH_ROOT.
// A mode may end in `+tailscale`: the launch command is then held the way Tailscale SSH's `check` mode
// holds it, with Tailscale's banner on stderr, until a file named `approved` appears under FAKE_SSH_ROOT;
// `+tailscale-timeout` ends the held connection the way OpenSSH's own read timeout does. `+tailscale-forward`
// holds the port forward instead, and `+tailscale-request` every command but the launch; both run with the live
// keepalive, so OpenSSH ends the wait after FAKE_SSH_HOLD_MS unless it is approved first. FAKE_SSH_MODE_FILE,
// when set, names a file holding the mode, read by every ssh, so one app run can meet several.
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer as createNetServer } from 'node:net'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const [mode, tailscale] = (process.env.FAKE_SSH_MODE_FILE && existsSync(process.env.FAKE_SSH_MODE_FILE)
  ? readFileSync(process.env.FAKE_SSH_MODE_FILE, 'utf8').trim() : process.env.FAKE_SSH_MODE ?? 'started').split('+')
const recordPath = process.env.FAKE_SSH_RECORD
const record = event => { if (recordPath) appendFileSync(recordPath, JSON.stringify(event) + '\n') }
const hostId = '11111111-1111-4111-8111-111111111111'
const hostPid = 4242
const remotePort = 4317
const withValue = new Set(['-o', '-i', '-p', '-L', '-e', '-l', '-F'])
let target = '', command = ''
for (let index = 0; index < args.length; index++) {
  if (withValue.has(args[index])) { index++; continue }
  if (args[index].startsWith('-')) continue
  target = args[index]; command = args.slice(index + 1).join(' '); break
}
const option = name => { for (let index = 0; index < args.length - 1; index++) if (args[index] === '-o' && args[index + 1].startsWith(name + '=')) return args[index + 1].slice(name.length + 1) }
const resolveOnly = args.includes('-G'), tunnel = args.includes('-N')
if (args.includes('-V')) {
  // `ssh -V` prints its version on stderr and exits; FAKE_SSH_VERSION stands in for an older OpenSSH.
  record({ type: 'version' })
  process.stderr.write(`${process.env.FAKE_SSH_VERSION || 'OpenSSH_9.6p1'} Ubuntu-3ubuntu13.19, OpenSSL 3.0.13 30 Jan 2024\n`, () => process.exit(0))
  await new Promise(() => undefined)
}

/** Splits a command the way a POSIX shell reads single-quoted words, which is all the launcher sends. */
function words(text) {
  const out = []; let current = null
  for (let index = 0; index < text.length;) {
    const character = text[index]
    if (character === "'") { const end = text.indexOf("'", index + 1); current = (current ?? '') + text.slice(index + 1, end); index = end + 1 }
    else if (character === '\\') { current = (current ?? '') + text[index + 1]; index += 2 }
    else if (character === ' ') { if (current !== null) out.push(current); current = null; index++ }
    else { current = (current ?? '') + character; index++ }
  }
  if (current !== null) out.push(current)
  return out
}
const quote = value => `'${value.replace(/'/gu, "'\\''")}'`
const remote = words(command)
const configuration = remote[3] === 'sotto-launch' ? JSON.parse(remote[4]) : undefined
// Bytes, not text: the receive script takes an archive on stdin where every other command takes the launch script.
const readAll = stream => new Promise(resolve => { const chunks = []; stream.on('data', chunk => { chunks.push(chunk) }); stream.on('end', () => resolve(Buffer.concat(chunks))); stream.on('error', () => resolve(Buffer.concat(chunks))) })
const exit = code => { process.exitCode = code }

/**
 * OpenSSH runs SSH_ASKPASS with the prompt as its one argument, and SSH_ASKPASS_PROMPT=none for a notice
 * that takes no answer.
 */
function askpass(prompt, hint = '') {
  return new Promise(resolve => {
    const program = process.env.SSH_ASKPASS
    if (process.env.SSH_ASKPASS_REQUIRE !== 'force' || !program) { resolve(null); return }
    const env = { ...process.env, SSH_ASKPASS_PROMPT: hint }
    const child = spawn(program, [prompt], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env })
    let output = ''
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk })
    child.on('error', () => resolve(null))
    child.on('close', code => resolve(code === 0 ? output.replace(/\r?\n$/u, '') : null))
  })
}
/** A question whose helper ssh kills before the user answers: it reaches the desktop, then the helper goes away. */
function abandonedQuestion(prompt) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port: Number(process.env.SOTTO_ASKPASS_PORT) })
    socket.on('connect', () => { socket.write(JSON.stringify({ token: process.env.SOTTO_ASKPASS_TOKEN, prompt, hint: '' }) + '\n'); setTimeout(() => socket.destroy(), 100) })
    socket.on('error', () => undefined)
    socket.on('close', () => resolve())
  })
}

/**
 * Tailscale SSH in `check` mode: its banner, then nothing until the user approves in a browser. Once
 * approved, later connections pass, as they do within Tailscale's check period.
 */
async function tailscaleCheck() {
  const approved = join(process.env.FAKE_SSH_ROOT ?? dirname(recordPath ?? '.'), 'approved')
  const held = tailscale === 'tailscale-forward' ? tunnel : tailscale === 'tailscale-request' ? !tunnel && configuration !== undefined && configuration.op !== 'launch' : configuration?.op === 'launch'
  if (!tailscale || !held || existsSync(approved)) return true
  record({ type: 'tailscale-held' })
  process.stderr.write('# Tailscale SSH requires an additional check.\r\n# To authenticate, visit: https://login.tailscale.com/a/l1fixture2b3c\r\n')
  if (tailscale === 'tailscale-timeout') {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_SSH_HOLD_MS ?? 200)))
    process.stderr.write('Connection to 100.106.126.4 port 22 timed out\r\n'); exit(255); return false
  }
  const until = tailscale === 'tailscale' ? Infinity : Date.now() + Number(process.env.FAKE_SSH_HOLD_MS ?? 200)
  while (!existsSync(approved)) {
    if (Date.now() > until) { process.stderr.write('Connection to 100.106.126.4 port 22 timed out\r\n'); exit(255); return false }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  record({ type: 'tailscale-approved' })
  process.stderr.write('# Authentication checked with Tailscale SSH.\r\n')
  return true
}

async function authenticate() {
  if (mode === 'port-timeout') { process.stderr.write('Connection to 100.106.126.4 port 22 timed out\r\n'); exit(255); return false }
  const knownHosts = recordPath ? join(dirname(recordPath), 'known_hosts') : undefined
  if (mode === 'host-key' && knownHosts && !existsSync(knownHosts)) {
    if (option('LogLevel') === 'DEBUG1') process.stderr.write('debug1: Server host key: ssh-ed25519 SHA256:fixtureKey\n')
    const answer = await askpass("The authenticity of host 'forge (192.0.2.1)' can't be established.\nED25519 key fingerprint is SHA256:fixtureKey.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ")
    record({ type: 'answered', kind: 'host-key' })
    if (answer !== 'yes') { process.stderr.write('Host key verification failed.\n'); exit(255); return false }
    writeFileSync(knownHosts, 'forge ssh-ed25519 fixture\n')
  }
  if (mode === 'notice') {
    // A security key's touch notice. OpenSSH carries on while it shows, and never reads what the helper prints.
    const answer = await askpass('Confirm user presence for key ED25519-SK SHA256:fixtureKey', 'none')
    record({ type: 'notice', ended: answer !== null })
  }
  if (mode === 'withdraw' && configuration?.op === 'launch') { await abandonedQuestion("user@forge's password: "); record({ type: 'abandoned' }) }
  if (mode === 'password' || mode === 'passphrase' || mode === 'withdraw') {
    for (let tries = 0; tries < 3; tries++) {
      const kind = mode === 'passphrase' ? 'passphrase' : 'password'
      const answer = await askpass(kind === 'password' ? "user@forge's password: " : "Enter passphrase for key '/test/key': ")
      const accepted = answer === 'test-secret'
      record({ type: 'answered', kind, accepted }) // Never records what was answered.
      if (accepted) return true
      if (answer === null) break
    }
    process.stderr.write('user@forge: Permission denied (publickey,password).\n'); exit(255); return false
  }
  if (mode === 'refused') { process.stderr.write('user@forge: Permission denied (publickey).\n'); exit(255); return false }
  if (mode === 'unreachable') { process.stderr.write('ssh: connect to host forge port 22: Connection refused\n'); exit(255); return false }
  return tailscaleCheck()
}

const health = () => ({ v: 1, status: 'ready', hostId: mode === 'wrong-host' && tunnel ? randomUUID() : hostId, pid: hostPid, port: remotePort })
function forward() {
  if (mode === 'port-taken') { process.stderr.write('bind [127.0.0.1]:4317: Address already in use\nCould not request local forwarding.\n'); exit(255); return }
  const spec = args[args.indexOf('-L') + 1].split(':')
  const localPort = Number(spec[1]), destination = Number(spec[3])
  const server = mode === 'run'
    ? createNetServer(socket => { const upstream = connect(destination, '127.0.0.1'); socket.pipe(upstream).pipe(socket); socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy()) })
    : createHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(health()))
      // The network goes away once the launcher has seen the forward work.
      if (mode === 'drop') response.on('finish', () => setTimeout(() => { process.stderr.write('client_loop: send disconnect: Connection reset\n'); process.exit(255) }, 50))
    })
  server.listen(localPort, '127.0.0.1', () => record({ type: 'forward-ready', localPort }))
}

const say = value => process.stdout.write(JSON.stringify(value) + '\n')
async function runRemotely(script) {
  const root = process.env.FAKE_SSH_ROOT
  const local = { ...configuration, installPath: join(root, configuration.installPath), dataDirectory: join(root, configuration.dataDirectory) }
  // A POSIX machine runs the probe for real; Windows has no sh, so it runs the launch script, or the receive script the
  // probe would run with -e, directly.
  const inline = remote[6]
  const child = process.platform === 'win32'
    ? spawn(process.execPath, inline ? ['-e', inline, JSON.stringify(local)] : ['--input-type=commonjs', '-', JSON.stringify(local)], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
    : spawn('sh', ['-c', remote.map((word, index) => quote(index === 4 ? JSON.stringify(local) : word)).join(' ')], { stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin.on('error', () => undefined)
  child.stdin.end(script)
  exit(await new Promise(resolve => child.on('close', code => resolve(code ?? 255))))
}
async function control(script) {
  if (mode === 'timeout') { setInterval(() => undefined, 1000); return }
  if (mode === 'node-missing') { process.stderr.write('sh: 1: exec: node: not found\n'); exit(127); return }
  if (mode === 'node-old') { say({ type: 'error', reason: 'node-too-old', version: '18.19.0' }); return }
  if (mode === 'node-new') { say({ type: 'signed-in' }); say({ type: 'error', reason: 'node-too-new', version: '26.1.0' }); return }
  if (mode === 'missing') { say({ type: 'error', reason: 'archive-missing' }); return }
  if (mode === 'run') { await runRemotely(script); return }
  const operation = configuration?.op
  if (operation === 'launch') {
    // Output a login profile prints, a line cut short and an event this launcher does not know are all read past.
    if (mode === 'noisy') process.stdout.write('Welcome to forge!\n{"type":"pairing-co\n{"type":"progress","percent":50}\n')
    if (mode !== 'discovered') say({ type: 'starting' })
    // A host that takes this long to start after SSH has signed in.
    const starting = Number(process.env.FAKE_SSH_START_MS ?? 0)
    if (starting > 0) await new Promise(resolve => setTimeout(resolve, starting))
    say({ type: 'ready', ...health(), owned: mode !== 'discovered' })
  }
  if (operation === 'pairing-code') { record({ type: 'pairing-requested' }); say({ type: 'pairing-code', hostId, code: 'ABC123', expiresAt: new Date(Date.now() + 60_000).toISOString() }) }
  if (operation === 'desktop-answers') { record({ type: 'desktop-answers-requested' }); say({ type: 'desktop-answers', hostId }) }
  // The launch script's own refusal, and a revoke that ends with no answer at all.
  if (operation === 'revoke-client' && mode === 'revoke-refused') { say({ type: 'failed' }); return }
  if (operation === 'revoke-client' && mode === 'revoke-silent') { exit(1); return }
  if (operation === 'revoke-client') { record({ type: 'revoke-requested' }); say({ type: 'revoked', hostId, revoked: true }) }
  if (operation === 'stop-host') { record({ type: 'host-stopped', owned: mode !== 'discovered' }); say({ type: 'host-stopped', stopped: mode !== 'discovered', hostId }) }
}

const script = !tunnel && !resolveOnly ? await readAll(process.stdin) : ''
record({ type: 'spawn', args, target, tunnel, resolve: resolveOnly, op: configuration?.op, ...(configuration?.start === false ? { start: false } : {}), ...(configuration?.removeBoot === true ? { removeBoot: true } : {}), stdinSha256: createHash('sha256').update(script).digest('hex'),
  askpass: process.env.SSH_ASKPASS_REQUIRE === 'force' && !!process.env.SSH_ASKPASS })
if (resolveOnly) process.stdout.write(`host ${target}\nhostname forge.example.net\nuser user\nport 2222\nidentityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/id_rsa\n`)
else if (await authenticate()) { if (tunnel) forward(); else await control(script) }
