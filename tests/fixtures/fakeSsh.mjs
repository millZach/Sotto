import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const mode = process.env.FAKE_SSH_MODE ?? 'started'
const hostId = '11111111-1111-4111-8111-111111111111'
const hostPid = 4242
const remotePort = 4317
const command = args.at(-1) ?? ''
const marker = /SOTTO_SSH_[0-9a-f-]+:/u.exec(command)?.[0]
const tunnel = args.includes('-N')
const record = event => { if (process.env.FAKE_SSH_RECORD) appendFileSync(process.env.FAKE_SSH_RECORD, JSON.stringify(event) + '\n') }
record({ type: 'spawn', args, tunnel })
let server, input = '', prompted = false, ready = false
const emit = value => process.stdout.write(marker + JSON.stringify(value) + '\n')
const health = () => ({ v: 1, status: 'ready', hostId: mode === 'wrong-host' && tunnel ? randomUUID() : hostId, pid: hostPid, port: remotePort })
const start = () => {
  if (ready) return; ready = true
  if (mode === 'refused') { process.stderr.write('Permission denied (publickey).\n'); process.exitCode = 255; process.stdin.destroy(); return }
  if (mode === 'timeout') return
  if (mode === 'missing') { emit({ type: 'error', reason: 'archive-missing' }); return }
  if (tunnel) {
    if (mode === 'port-taken') { process.stderr.write('bind [127.0.0.1]:4317: Address already in use\n'); return }
    const forward = args[args.indexOf('-L') + 1]
    const localPort = Number(forward.split(':')[1])
    server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(health())) })
    server.listen(localPort, '127.0.0.1', () => record({ type: 'forward-ready', localPort }))
  } else {
    emit({ type: 'starting' }); emit({ type: 'ready', ...health(), owned: mode !== 'discovered' })
  }
}
const stop = () => { record({ type: 'exit', tunnel }); server?.close(); process.exit(0) }
process.on('SIGTERM', stop); process.on('SIGINT', stop)
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk.replace(/\r/gu, '\n')
  let at
  while ((at = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, at); input = input.slice(at + 1)
    if (prompted) {
      prompted = false
      record({ type: 'answered', kind: mode }) // Never records answer contents.
      if (mode === 'host-key' && line !== 'yes') { process.stderr.write('Host key verification failed.\n'); return }
      start(); continue
    }
    if (!marker || !line.startsWith(marker)) continue
    const request = JSON.parse(line.slice(marker.length))
    if (request.type === 'close') { stop() }
    if (request.type === 'stop-host') { record({ type: 'host-stopped', owned: mode !== 'discovered' }); emit({ type: 'host-stopped', id: request.id, stopped: mode !== 'discovered', hostId }); stop() }
    if (request.type === 'pairing-code') { record({ type: 'pairing-requested' }); emit({ type: 'pairing-code', id: request.id, hostId, code: 'ABC123', expiresAt: new Date(Date.now() + 60_000).toISOString() }) }
  }
})
process.stdin.on('end', stop)
if (mode === 'password' || mode === 'host-key' || mode === 'passphrase') {
  prompted = true
  const prompt = mode === 'host-key' ? "The authenticity of host 'forge' cannot be established.\nED25519 key fingerprint is SHA256:fixture.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "
    : mode === 'passphrase' ? "Enter passphrase for key '/test/key': " : "user@forge's password: "
  const cut = Math.floor(prompt.length / 2)
  process.stderr.write(prompt.slice(0, cut)); setTimeout(() => process.stderr.write(prompt.slice(cut)), 5)
} else start()
