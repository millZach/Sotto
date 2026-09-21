import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import console from 'node:console'
const args = process.argv.slice(2)
const data = args[args.indexOf('--data') + 1]
const descriptorPath = path.join(data, 'host-listener.json')
const hostId = '11111111-1111-4111-8111-111111111111'
async function main() {
  if (args.includes('--pairing-code')) {
    const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'))
    console.log(JSON.stringify({ v: 1, hostId: descriptor.hostId, code: 'ABC123', expiresAt: new Date(Date.now() + 60000).toISOString() })); return
  }
  if (args.includes('--revoke-client')) { console.log(JSON.stringify({ v: 1, hostId, revoked: true })); return }
  await fs.mkdir(data, { recursive: true })
  const port = Number(args[args.indexOf('--port') + 1])
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ v: 1, status: 'ready', hostId, pid: process.pid, port: server.address().port })) })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const descriptor = { v: 1, hostId, pid: process.pid, port: server.address().port, adminToken: 'remote-only-secret' }
  await fs.writeFile(descriptorPath + '.tmp', JSON.stringify(descriptor)); await fs.rename(descriptorPath + '.tmp', descriptorPath)
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
main().catch(() => { process.exitCode = 1 })
