// Stands in for an installed host/index.js: it takes the data folder's lock, listens on loopback, writes
// its listener descriptor (recording a launch script start the way the real host does) and answers the
// administration flags the launch script uses.
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import console from 'node:console'
const args = process.argv.slice(2)
const data = args[args.indexOf('--data') + 1]
const descriptorPath = path.join(data, 'host-listener.json')
const lockPath = path.join(data, 'host-listener.lock')
const hostId = '11111111-1111-4111-8111-111111111111'
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
async function lock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const handle = await fs.open(lockPath, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: String(Math.random()) })); await handle.close(); return true }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    try { if (alive(JSON.parse(await fs.readFile(lockPath, 'utf8')).pid)) return false } catch { return false }
    await fs.rm(lockPath, { force: true })
  }
  return false
}
async function main() {
  if (args.includes('--pairing-code')) {
    const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'))
    console.log(JSON.stringify({ v: 1, hostId: descriptor.hostId, code: 'ABC123', expiresAt: new Date(Date.now() + 60000).toISOString() })); return
  }
  if (args.includes('--revoke-client')) { console.log(JSON.stringify({ v: 1, hostId, revoked: true })); return }
  await fs.mkdir(data, { recursive: true })
  if (!(await lock())) { process.exitCode = 1; return }
  // Holding the lock before listening leaves a window in which a second launch finds the folder taken.
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_HOST_START_DELAY_MS ?? 0)))
  const port = Number(args[args.indexOf('--port') + 1])
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ v: 1, status: 'ready', hostId, pid: process.pid, port: server.address().port })) })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const descriptor = { v: 1, hostId, pid: process.pid, port: server.address().port, adminToken: 'remote-only-secret',
    ...(process.env.SOTTO_HOST_STARTED_BY === 'launch-script' ? { startedBy: 'launch-script' } : {}) }
  await fs.writeFile(descriptorPath + '.tmp', JSON.stringify(descriptor)); await fs.rename(descriptorPath + '.tmp', descriptorPath)
  process.on('SIGTERM', () => server.close(async () => { await fs.rm(lockPath, { force: true }); process.exit(0) }))
}
main().catch(() => { process.exitCode = 1 })
