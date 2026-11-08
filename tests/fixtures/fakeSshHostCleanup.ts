import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const FIXTURE = 'sotto-fake-ssh-host'

/** A start of the fake host, as its descriptor names it. */
export interface FakeSshHostStart { readonly pid: number; readonly instance: string }

/**
 * Asks the fake host (`fakeSshHost.mjs`) that the descriptor in `dataDirectory` names to stop itself, when `ours` says
 * that start is the test's. The request names the start's instance and the host stops only for its own, so nothing
 * is signalled by PID. By cleanup a host the test saw may have gone, and Windows hands a freed PID straight to the next
 * process, which on a shared runner is often a Git the other test worker is running; a signal sent there ends that Git
 * with exit code 1 and nothing on stderr (#1002). A host that does not answer is left alone.
 */
export async function stopFakeSshHost(dataDirectory: string, ours: (start: FakeSshHostStart) => boolean): Promise<void> {
  try {
    const descriptor = JSON.parse(await readFile(join(dataDirectory, 'host-listener.json'), 'utf8')) as { fixture?: string; pid?: number; instance?: string; port?: number }
    if (descriptor.fixture !== FIXTURE || typeof descriptor.pid !== 'number' || typeof descriptor.instance !== 'string' || !ours({ pid: descriptor.pid, instance: descriptor.instance })) return
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/stop?instance=${encodeURIComponent(descriptor.instance)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) })
    await response.arrayBuffer()
  } catch { /* No descriptor, or no host answering at it: nothing of this test's is left to stop there. */ }
}

/** Stops each fake host still serving one of the test's data folders, when the test saw its PID. */
export async function stopFakeSshHosts(pids: readonly number[], dataDirectories: readonly string[]): Promise<void> {
  const seen = new Set(pids)
  for (const data of dataDirectories) await stopFakeSshHost(data, start => seen.has(start.pid))
}
