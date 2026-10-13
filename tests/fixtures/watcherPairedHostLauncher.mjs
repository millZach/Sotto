// Owned throwaway forge host only. Never use this with an existing host's data directory.
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
async function main() {
  const root = resolve(process.argv[2]), build = process.argv[3]
  if (!root.includes('/tmp/sotto-watcher-hosts-') || !['current', 'older'].includes(build)) throw new Error('owned-live-folder-required')
  const directory = join(root, build, 'data')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ historyEnabled: false, threadTitles: false, babysitPullRequests: false }))
  await writeFile(join(directory, 'agents.json'), await readFile(join(root, 'initial-agents.json')))
  const load = createRequire(join(root, build, 'index.js'))
  const { startHeadlessHost } = load(join(root, build, 'index.js'))
  const host = await startHeadlessHost({ dataDirectory: directory, port: 0 })
  const seen = new Set(), original = host.service.watcherControl?.bind(host.service)
  let turns = 0
  if (original) host.service.watcherControl = async (packet, client, guard) => {
    if (['start', 'send'].includes(packet.operation.action) && !seen.has(packet.operation.id)) {
      if (turns >= 2) throw new Error('live-worker-turn-budget')
      seen.add(packet.operation.id); turns++
      await writeFile(join(root, build, 'turn-count.json'), JSON.stringify({ workerTurns: turns }))
    }
    return original(packet, client, guard)
  }
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Temporary Watcher desktop')
  await writeFile(join(directory, 'desktop-clients.json'), JSON.stringify([paired.clientId]))
  await writeFile(join(root, build, 'connection.json'), JSON.stringify({ ...paired, hostId: host.descriptor.hostId, port: host.descriptor.port, pid: process.pid }))
  const stop = () => { void host.close().then(() => process.exit(0), () => process.exit(1)) }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}
main().catch(() => { process.stderr.write('watcher-live-host-failed\n'); process.exitCode = 1 })
