import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const FIXTURE = 'sotto-fake-ssh-host'

/**
 * Ends the fake hosts (`fakeSshHost.mjs`) a test saw start, each only while it still answers as itself. A test reads
 * those PIDs from a descriptor or a ready message, and by cleanup many of the hosts have gone: the launch script
 * stopped or replaced them, or the test checked they had exited. Windows hands a freed PID straight to the next
 * process, which on a shared runner is often a Git the other test worker is running, and a signal sent there ends it
 * with exit code 1 and nothing on stderr (#1002). So a PID is signalled only while the descriptor in one of the test's
 * data folders names it and the host listening at that descriptor's port answers with the same PID and start.
 */
export async function stopFakeSshHosts(pids: readonly number[], dataDirectories: readonly string[]): Promise<void> {
  const seen = new Set(pids)
  for (const data of dataDirectories) {
    try {
      const descriptor = JSON.parse(await readFile(join(data, 'host-listener.json'), 'utf8')) as { fixture?: string; pid?: number; instance?: string; port?: number }
      if (descriptor.fixture !== FIXTURE || typeof descriptor.pid !== 'number' || !seen.has(descriptor.pid) || typeof descriptor.instance !== 'string') continue
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/health`, { signal: AbortSignal.timeout(10_000) })
      const health = await response.json() as { fixture?: string; pid?: number; instance?: string }
      if (health.fixture === FIXTURE && health.pid === descriptor.pid && health.instance === descriptor.instance) process.kill(descriptor.pid, 'SIGTERM')
    } catch { /* No descriptor, or no host answering at it: nothing of this test's is left to signal there. */ }
  }
}
