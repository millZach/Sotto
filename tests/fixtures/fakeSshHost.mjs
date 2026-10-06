// Stands in for an installed host/index.js: it takes the data folder's lock, listens on loopback, writes
// its listener descriptor (recording a launch script's or a boot unit's start the way the real host does) and answers the
// administration flags the launch script uses.
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import console from 'node:console'
import { setTimeout as delay } from 'node:timers/promises'
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
    try { const lease = JSON.parse(await fs.readFile(lockPath, 'utf8')); if (!(lease.boot && process.env.FAKE_HOST_BOOT && lease.boot !== process.env.FAKE_HOST_BOOT) && alive(lease.pid)) return false } catch { return false }
    await fs.rm(lockPath, { force: true })
  }
  return false
}
async function publishDescriptor(descriptor) {
  const temporary = descriptorPath + '.tmp'
  await fs.writeFile(temporary, JSON.stringify(descriptor))
  // The launcher's reads can briefly deny atomic replacement on Windows. Keep the old file intact.
  const retries = [10, 20, 40, 80, 160]
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temporary, descriptorPath); return }
    catch (error) {
      const wait = retries[attempt]
      if (process.platform !== 'win32' || wait === undefined || !['EPERM', 'EBUSY'].includes(error.code)) throw error
      await delay(wait)
    }
  }
}
async function main() {
  if (args.includes('--pairing-code')) {
    const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'))
    console.log(JSON.stringify({ v: 1, hostId: descriptor.hostId, code: 'ABC123', expiresAt: new Date(Date.now() + 60000).toISOString() })); return
  }
  if (args.includes('--revoke-client')) { console.log(JSON.stringify({ v: 1, hostId, revoked: true })); return }
  await fs.mkdir(data, { recursive: true })
  // Another live host holds the folder: the host's own exit code for it, which a boot unit does not retry (ADR-0054).
  if (!(await lock())) { process.exitCode = 75; return }
  // Holding the lock before listening leaves a window in which a second launch finds the folder taken.
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_HOST_START_DELAY_MS ?? 0)))
  const port = Number(args[args.indexOf('--port') + 1])
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ v: 1, status: 'ready', hostId, pid: process.pid, port: server.address().port })) })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  // `entry` says which installed version is running, for the host update tests; the launch script ignores it.
  const descriptor = { v: 1, hostId, pid: process.pid, port: server.address().port, adminToken: 'remote-only-secret', entry: process.argv[1],
    ...(['launch-script', 'boot'].includes(process.env.SOTTO_HOST_STARTED_BY) ? { startedBy: process.env.SOTTO_HOST_STARTED_BY } : {}) }
  await publishDescriptor(descriptor)
  process.on('SIGTERM', () => server.close(async () => { await fs.rm(lockPath, { force: true }); process.exit(0) }))
}
main().catch(() => { process.exitCode = 1 })
