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
  /** A test seam: runs after a lock is judged stale and before this host takes its turn to clear it, where other hosts may win the race. */
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

const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** How long a host waits between looks while another host has the turn to clear a stale lock, and how many looks it takes. */
const TURN_WAIT_MS = 50
const TURN_LOOKS = 60

type Removal = { outcome: 'removed' | 'gone' } | { outcome: 'changed' | 'lost'; now: string | undefined }

/**
 * Removes the file at `path` only if it still holds `seen`. It reads the file first and leaves anything else
 * alone. Then it moves the file to a name only this host uses and checks what it moved, so a second remover
 * acting in the same moment cannot make it remove the wrong file; if the move took something else after all,
 * that is linked back into place ('changed'), or reported 'lost' when another file took the place meanwhile.
 */
async function removeIfStill(path: string, seen: string): Promise<Removal> {
  let now: string
  try { now = await readFile(path, 'utf8') }
  catch (error) { if (code(error) === 'ENOENT') return { outcome: 'gone' }; throw error }
  if (now !== seen) return { outcome: 'changed', now }
  const aside = `${path}.${randomUUID()}.stale`
  try { await rename(path, aside) }
  catch (error) { if (code(error) === 'ENOENT') return { outcome: 'gone' }; throw error }
  const moved = await readFile(aside, 'utf8').catch(() => undefined)
  if (moved === seen) { await unlink(aside).catch(() => undefined); return { outcome: 'removed' } }
  // Linking restores the very file, so its owner's own release still finds its lease; neither step replaces a file.
  let restored = false
  try { await link(aside, path); restored = true }
  catch (error) { if (code(error) !== 'EEXIST' && moved !== undefined) restored = await placeExclusive(path, moved).then(() => true, () => false) }
  if (restored) await unlink(aside).catch(() => undefined)
  return { outcome: restored ? 'changed' : 'lost', now: moved }
}

/**
 * Takes this host's turn to clear a stale lock: `host-listener.lock.reclaim`, placed the same exclusive way as
 * the lock and holding this host's lease. Only a host holding the turn removes a lock it did not write, so no
 * two hosts clear at once. A turn lasts one read and one removal, so a host that finds it taken waits; a turn
 * left by a host that stopped in the middle of one is removed the same careful way as a stale lock.
 */
async function takeReclaimTurn(turn: string, content: string, boot: string | undefined, log?: (event: string) => void): Promise<void> {
  for (let look = 0; look < TURN_LOOKS; look++) {
    try { await placeExclusive(turn, content); return }
    catch (error) { if (code(error) !== 'EEXIST') throw new HostLockError('This host data folder could not be locked, so this host did not start. Nothing in the folder was changed. Check that the folder can be written, then start again.', { cause: error }) }
    let seen: string, holder: HostLease
    try { seen = await readFile(turn, 'utf8'); holder = parseLease(seen) }
    catch (error) { if (code(error) !== 'ENOENT') await delay(TURN_WAIT_MS); continue }
    if (leaseHolderAlive(holder, boot)) { await delay(TURN_WAIT_MS); continue }
    const removal = await removeIfStill(turn, seen).catch(() => undefined)
    if (removal?.outcome === 'lost') log?.('host-lock-restore-failed')
  }
  throw new HostLockError('Another host kept its turn to clear this data folder\'s lock, so this host did not start. Nothing in the folder was changed. Wait a moment, then start again. If no host is starting, remove host-listener.lock.reclaim from the data folder first.')
}

/**
 * Takes the data folder's lock for `lease`. A lock left behind by a host that no longer runs (a crash, a
 * reboot) is reclaimed, so a reconnect after either needs no hand cleanup; a lock whose holder still runs, or
 * one that cannot be read, is refused without being changed.
 *
 * Reclaiming is atomic. Hosts starting together after a crash all see the same dead lease, so the one that
 * removes it must be sure it removes that lease and not another host's fresh one. Hosts take turns to clear a
 * stale lock (takeReclaimTurn), and in its turn a host reads the lock again and removes it only if it still
 * holds the dead lease. Only turn holders remove a lock they did not write, and a dead holder never releases
 * its own, so the lock cannot change between that read and the removal: a live lock is never moved, however
 * many hosts start at once. The removal also moves the lock aside and checks what it moved. That matters only
 * if two hosts ever hold the turn together, which needs a host to stop in the middle of its own turn and
 * several more to start in that same moment; a live lock moved then is put back, and one that cannot be put
 * back is logged as `host-lock-restore-failed` and refused in words that say another host may have the folder.
 */
export async function acquireHostLock(path: string, lease: HostLease, options: HostLockOptions = {}): Promise<void> {
  const content = JSON.stringify(lease)
  const turn = `${path}.reclaim`
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
    await takeReclaimTurn(turn, content, options.boot, options.log)
    let removal: Removal
    try { removal = await removeIfStill(path, seen) }
    catch (error) {
      throw new HostLockError('A lock left by a host that has stopped could not be removed, so this host did not start. Nothing in the folder was changed. Remove host-listener.lock from the data folder and start again.', { cause: error })
    } finally { await releaseHostLock(turn, lease).catch(() => undefined) }
    if (removal.outcome === 'removed') options.log?.('host-lock-reclaimed')
    if (removal.outcome === 'lost') {
      options.log?.('host-lock-restore-failed')
      throw new HostLockError('Another host took this data folder while this one was starting, and its lock could not be put back, so a third host may have opened the folder too. This host did not start. Stop every host that uses this data folder, then start one of them again.')
    }
    // 'changed' or 'gone': another host cleared the dead lease first. Look again; a live new holder is refused above.
  }
  throw new HostLockError('Other hosts kept taking and releasing this data folder, so this host did not start. Nothing in the folder was changed. Wait a moment, then start again.')
}

/** Removes the lock only if it is still this host's lease, so a stop never removes a lock another host took. */
export async function releaseHostLock(path: string, lease: HostLease): Promise<void> {
  try { if (await readFile(path, 'utf8') === JSON.stringify(lease)) await unlink(path) }
  catch (error) { if (code(error) !== 'ENOENT') throw error }
}
