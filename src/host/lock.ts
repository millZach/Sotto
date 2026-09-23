import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, open, readFile, rename, unlink } from 'node:fs/promises'

/** Refused startup because another host holds, or may hold, the data folder. The message is safe to print. */
export class HostLockError extends Error {}

/**
 * What a host writes into `host-listener.lock`: its process, a nonce so two leases for one pid differ, and
 * the machine's boot identity when it can be read, so a pid reused after a reboot is not taken for the old
 * holder. Leases written before the boot identity existed have no `boot`, and are judged by pid alone.
 */
export interface HostLease { pid: number; nonce: string; boot?: string }

export interface HostLockOptions {
  /** This machine's boot identity, or undefined when it cannot be read; see readBootId. */
  boot?: string | undefined
  log?: (event: string) => void
  /** A test seam: runs after a lock is judged stale and before it is moved aside, where a second host may win the race. */
  beforeReclaim?: () => Promise<void>
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/**
 * Whether a process is running. This is the rule the launch script's own check must match (#242):
 * `process.kill(pid, 0)` succeeding means running; failing with EPERM also means running, because the pid
 * exists and only belongs to another account; any other failure (ESRCH) means no such process. Judging EPERM
 * as gone would let a host reclaim a folder from a live process it may not signal.
 */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return code(error) === 'EPERM' }
}

/**
 * Whether the host a lease names may still hold the folder. A lease from an earlier boot of this machine
 * cannot: every process it knew ended with that boot, so whatever runs under its pid now is something else.
 * Otherwise the pid decides, by processAlive's rule.
 */
export function leaseHolderAlive(lease: HostLease, boot: string | undefined): boolean {
  if (lease.boot !== undefined && boot !== undefined && lease.boot !== boot) return false
  return processAlive(lease.pid)
}

const run = (file: string, args: readonly string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => { if (error) reject(error); else resolve(stdout) })
})

/**
 * The identity of the machine's current boot, from a source that never changes within a boot and never
 * depends on the wall clock: Linux's boot_id, macOS's boot session UUID, and Windows' boot counter. Returns
 * undefined where none can be read, which leaves the pid alone to decide.
 */
export async function readBootId(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  try {
    let value: string | undefined
    if (platform === 'linux') value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    else if (platform === 'darwin') value = (await run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])).trim()
    else if (platform === 'win32') {
      const output = await run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters', '/v', 'BootId'])
      value = /BootId\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(output)?.[1]?.toLowerCase()
    }
    return value ? `${platform}:${value}` : undefined
  } catch { return undefined }
}

function parseLease(text: string): HostLease {
  const value = JSON.parse(text) as Partial<HostLease>
  if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) throw new Error('invalid')
  return { pid: value.pid as number, nonce: typeof value.nonce === 'string' ? value.nonce : '', ...(typeof value.boot === 'string' ? { boot: value.boot } : {}) }
}

/**
 * Puts `content` at `path` only if nothing is there, and never leaves a half-written lock where another host
 * could read it: the content is written and synced beside the lock, then hard-linked into place, which fails
 * rather than replacing a lock that appeared meanwhile. A folder whose file system has no hard links falls
 * back to creating the lock exclusively and writing into it.
 */
async function placeExclusive(path: string, content: string): Promise<void> {
  const draft = `${path}.${randomUUID()}.new`
  const file = await open(draft, 'wx', 0o600)
  try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await file.close() }
  try { await link(draft, path) }
  catch (error) {
    if (code(error) === 'EEXIST') throw error
    const lock = await open(path, 'wx', 0o600)
    try { await lock.writeFile(content, 'utf8'); await lock.sync() } finally { await lock.close() }
  } finally { await unlink(draft).catch(() => undefined) }
}

const heldMessage = (pid: number): string =>
  `Another host (process ${pid}) is using this data folder, so this host did not start. Nothing in the folder was changed. Stop that host, or wait for it to stop, then start again. To run both, give this one its own data folder.`

/**
 * Takes the data folder's lock for `lease`. A lock left behind by a host that no longer runs (a crash, a
 * reboot) is reclaimed, so a reconnect after either needs no hand cleanup; a lock whose holder still runs, or
 * one that cannot be read, is refused without being changed.
 *
 * Reclaiming is atomic. Two hosts starting together after a crash both see the same dead lease, so the one
 * that removes it must be sure it removes that lease and not the other host's fresh one. It moves the lock to
 * a name only it uses, reads what it moved, and goes on only if that is still the dead lease; anything else
 * belongs to a host that just won, so it puts that lock back and refuses as it would for any live holder.
 * Two hosts can never both own the folder this way. With three or more starting in the same instant, a third
 * could take the empty folder in the moment before the winner's lock is put back; that is logged as
 * `host-lock-restore-failed`, and the launch script's wait for a live holder keeps starts from stacking up so.
 */
export async function acquireHostLock(path: string, lease: HostLease, options: HostLockOptions = {}): Promise<void> {
  const content = JSON.stringify(lease)
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await placeExclusive(path, content); return }
    catch (error) { if (code(error) !== 'EEXIST') throw new HostLockError('This host data folder could not be locked, so this host did not start. Nothing in the folder was changed. Check that the folder can be written, then start again.', { cause: error }) }
    let seen: string, holder: HostLease
    try { seen = await readFile(path, 'utf8'); holder = parseLease(seen) }
    catch (error) {
      if (code(error) === 'ENOENT') continue
      throw new HostLockError('The host-listener.lock in this data folder could not be read, so this host did not start. Nothing in the folder was changed. If no host uses the folder, remove that file and start again.', { cause: error })
    }
    if (leaseHolderAlive(holder, options.boot)) throw new HostLockError(heldMessage(holder.pid))
    await options.beforeReclaim?.()
    const aside = `${path}.${randomUUID()}.stale`
    try { await rename(path, aside) }
    catch (error) {
      if (code(error) === 'ENOENT') continue
      throw new HostLockError('A lock left by a host that has stopped could not be moved aside, so this host did not start. Nothing in the folder was changed. Remove host-listener.lock from the data folder and start again.', { cause: error })
    }
    const moved = await readFile(aside, 'utf8').catch(() => undefined)
    if (moved === seen) {
      await unlink(aside).catch(() => undefined)
      options.log?.('host-lock-reclaimed')
      continue
    }
    // Another host reclaimed the dead lease first and this move took its live lock. Put it back and step aside.
    // Linking restores the very file, so the winner's own release still finds its lease; neither step replaces a lock.
    let restored = false
    try { await link(aside, path); restored = true }
    catch (error) { if (code(error) !== 'EEXIST' && moved !== undefined) restored = await placeExclusive(path, moved).then(() => true, () => false) }
    if (restored) await unlink(aside).catch(() => undefined)
    else options.log?.('host-lock-restore-failed')
    let winner: number | undefined
    try { winner = parseLease(moved ?? '').pid } catch { winner = undefined }
    throw new HostLockError(winner === undefined
      ? 'Another host took this data folder while this one was starting, so this host did not start. Nothing in the folder was changed. Stop that host, or wait for it to stop, then start again.'
      : heldMessage(winner))
  }
  throw new HostLockError('Other hosts kept taking and releasing this data folder, so this host did not start. Nothing in the folder was changed. Wait a moment, then start again.')
}

/** Removes the lock only if it is still this host's lease, so a stop never removes a lock another host took. */
export async function releaseHostLock(path: string, lease: HostLease): Promise<void> {
  try { if (await readFile(path, 'utf8') === JSON.stringify(lease)) await unlink(path) }
  catch (error) { if (code(error) !== 'ENOENT') throw error }
}
