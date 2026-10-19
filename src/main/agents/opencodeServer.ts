import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { compareClientVersions } from './clientVersions'
import { withCliPath } from './cliLookup'
import { acceptOpenCode, opencodeCandidates, resetOpenCodeLookup, type OpenCodeLookupOptions } from './opencodeLookup'

/**
 * OpenCode's floor: the oldest client Sotto connects (ADR-0042, ADR-0087). 2.0.31 is the client this adapter's routes,
 * events and process facts were checked against on October 16, 2026. OpenCode 1 has another server and is refused at
 * connect. Move it only after checking a newer client against the adapter contract.
 */
export const OPENCODE_CLI_VERSION = '2.0.31'
/** The connection changed, or OpenCode did not answer in time: what was asked may or may not have happened. */
export class OpenCodeUncertain extends Error {}
/** A client Sotto will not drive: OpenCode 1, or an OpenCode 2 older than the floor. */
export class OpenCodeUnsupported extends Error {}
/** A client older than the version Sotto checked, carrying the version it reported. */
export class OpenCodeTooOld extends OpenCodeUnsupported { constructor(message: string, readonly version: string) { super(message) } }

/**
 * Sotto's own OpenCode folders (ADR-0087): every OpenCode process Sotto starts keeps its data, config, state and cache
 * here, never in the user's own OpenCode folders, which OpenCode 2 would migrate for good on first open.
 */
export interface OpenCodeFolders {
  readonly data: string; readonly config: string; readonly state: string; readonly cache: string
  /** Sotto's own: where each server it starts is written down while it runs (`opencodeServerLedger`). */
  readonly servers: string
}
export function opencodeFolders(base: string): OpenCodeFolders {
  return { data: join(base, 'data'), config: join(base, 'config'), state: join(base, 'state'), cache: join(base, 'cache'), servers: join(base, 'servers') }
}
export async function ensureOpenCodeFolders(folders: OpenCodeFolders): Promise<void> {
  await Promise.all(Object.values(folders).map(folder => mkdir(folder, { recursive: true })))
}
/** OpenCode's database in a data folder; while it is missing, the next server to start runs its migrations. */
export function opencodeDatabase(folders: OpenCodeFolders): string { return join(folders.data, 'opencode', 'opencode.db') }

/** What every Sotto server is told on top of its own config: no share links, and no update of its own (ADR-0087). */
export const OPENCODE_CONFIG_CONTENT = JSON.stringify({ share: 'disabled', update: 'disable' })
const safeEnvironment = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'home', 'user', 'logname', 'username', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata', 'allusersprofile', 'comspec', 'lang', 'lc_all', 'lc_ctype', 'tz', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir'])
/**
 * The environment an OpenCode process gets: the shared allow-list and nothing else, so no provider's key reaches it and
 * a thread runs on the sign-ins OpenCode keeps in Sotto's own folder. The XDG folders are always Sotto's; the user's own
 * are never passed through. The password is this process's alone, so OpenCode never makes up and prints one.
 */
export function opencodeEnvironment(environment: NodeJS.ProcessEnv, folders: OpenCodeFolders, password: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => safeEnvironment.has(key.toLowerCase())))
  return { ...env, XDG_DATA_HOME: folders.data, XDG_CONFIG_HOME: folders.config, XDG_STATE_HOME: folders.state, XDG_CACHE_HOME: folders.cache,
    OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT, OPENCODE_DISABLE_AUTOUPDATE: '1' }
}
/** A fresh secret for one server, never written down or logged. */
export function opencodePassword(): string { return randomBytes(32).toString('base64url') }

/**
 * The OpenCode a connect last chose and started, which presence and the update check ask about too while it is still
 * there, so an update is checked for the client in use and not an OpenCode 1 found ahead of it. Kept for the home and
 * platform it was found for.
 */
let chosenOpenCode: { readonly executable: string; readonly home: string | undefined; readonly platform: NodeJS.Platform | undefined } | undefined
/** Writes down the OpenCode connect started, or forgets it when connect found none to start. */
export function rememberOpenCodeChoice(executable: string | undefined, lookup: OpenCodeLookupOptions = {}): void {
  chosenOpenCode = executable ? { executable, home: lookup.home, platform: lookup.platform } : undefined
}
/**
 * Where OpenCode is (`opencodeLookup`): the OpenCode connect last chose while it is still there, or else the first the
 * lookup finds, whatever its version. Presence and the update check ask this; connect asks `chooseOpenCode`.
 */
export async function findOpenCodeExecutable(environment: NodeJS.ProcessEnv = process.env, lookup: OpenCodeLookupOptions = {}): Promise<string | undefined> {
  const chosen = chosenOpenCode
  // What the chosen path leads to now, which is another build when an update left the stand-in there.
  const kept = chosen && chosen.home === lookup.home && chosen.platform === lookup.platform
    ? await acceptOpenCode(chosen.executable, lookup.platform, lookup.arch) : undefined
  if (kept) return kept
  for await (const executable of opencodeCandidates(environment, lookup)) return executable
  return undefined
}
/** How long the first OpenCode found has to say its version, and all the others together after it. */
export const OPENCODE_VERSION_TIMEOUT_MS = 10_000
export interface OpenCodeChoice { readonly executable: string; readonly said: string | undefined }
/**
 * The OpenCode connect uses: the first the lookup finds that reports an OpenCode 2 Sotto drives, so an OpenCode 1 met
 * first (WinGet's, Chocolatey's, nixpkgs') does not hide an OpenCode 2 installed elsewhere. The others are asked only
 * when the first is refused, and only while `abandoned` says the connect still wants an answer, sharing one version
 * read's time between them. When none will do, the first and what it said, which connect refuses in its words.
 */
export async function chooseOpenCode(read: (executable: string, timeoutMs: number) => Promise<string | undefined>, environment: NodeJS.ProcessEnv = process.env,
  lookup: OpenCodeLookupOptions = {}, abandoned: () => boolean = () => false): Promise<OpenCodeChoice | undefined> {
  let first: OpenCodeChoice | undefined
  let deadline: number | undefined
  for await (const executable of opencodeCandidates(environment, lookup)) {
    if (abandoned()) break
    const timeoutMs = deadline === undefined ? OPENCODE_VERSION_TIMEOUT_MS : deadline - Date.now()
    if (timeoutMs <= 0) break
    const said = await read(executable, timeoutMs).catch(() => undefined)
    if (!opencodeVersionRefusal(said ?? '')) return { executable, said }
    first ??= { executable, said }
    deadline ??= Date.now() + OPENCODE_VERSION_TIMEOUT_MS
  }
  return first
}
/** Forgets which OpenCode connect chose and the last reading of Windows' PATH, so a test starts clean. */
export function resetOpenCodeChoice(): void { chosenOpenCode = undefined; resetOpenCodeLookup() }

/** A version line as each OpenCode prints it: `opencode v2.0.31` from 2, the bare `1.19.3` from 1. */
export function parseOpenCodeVersion(text: string): { version: string; generation: number } | undefined {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?=\s|$)/u.exec(text.trim())
  if (!match) return undefined
  return { version: `${match[1]}.${match[2]}.${match[3]}`, generation: Number(match[1]) }
}
/** Why Sotto will not drive this version, in the words connect shows, or undefined when it will. */
export function opencodeVersionRefusal(version: string): OpenCodeUnsupported | undefined {
  const parsed = parseOpenCodeVersion(version)
  if (!parsed) return new OpenCodeUnsupported('OpenCode did not say which version it is, so Sotto cannot tell whether it is OpenCode 2.')
  if (parsed.generation < 2) return new OpenCodeUnsupported(`This is OpenCode ${parsed.version}, and Sotto works with OpenCode 2 only. Install it from opencode.ai/v2/install, which replaces OpenCode 1 in ~/.opencode/bin, where Sotto looks first; opencode.ai/install and npm's opencode-ai give OpenCode 1.`)
  // A later generation is another server again: Sotto drives the one it was checked against and no other (ADR-0087).
  if (parsed.generation > 2) return new OpenCodeUnsupported(`This is OpenCode ${parsed.version}, and Sotto works with OpenCode 2 only. Install OpenCode 2 from opencode.ai/v2/install or npm's @opencode/cli@2, then connect again.`)
  if (compareClientVersions(parsed.version, OPENCODE_CLI_VERSION) < 0) return new OpenCodeTooOld(`OpenCode ${OPENCODE_CLI_VERSION} or newer is required, and this client is ${parsed.version}.`, parsed.version)
  return undefined
}

/** Ask the client its version without starting a server. Its output is read for the version line and nothing else. */
export function readOpenCodeVersion(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = OPENCODE_VERSION_TIMEOUT_MS): Promise<string | undefined> {
  return new Promise(resolve => {
    let output = ''
    let settled = false
    const finish = (value: string | undefined): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const child = spawn(executable, [...args, '--version'], { env: withCliPath(env, executable), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { child.kill(); finish(undefined) }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { if (output.length < 4_096) output += chunk })
    child.once('error', () => finish(undefined))
    child.once('close', () => finish(output.split(/\r?\n/u).find(line => parseOpenCodeVersion(line)) ?? (output.trim() || undefined)))
  })
}

/**
 * The first server on a data folder without a database starts alone (ADR-0087): several OpenCode servers migrating one
 * new database at once lose a race over its tables, and one of them fails to start. Every start on that folder waits
 * while another runs its migrations; once the database is there, they start side by side.
 */
const migrating = new Map<string, Promise<void>>()
export async function withFirstServerLock<T>(folders: OpenCodeFolders, start: () => Promise<T>): Promise<T> {
  for (let held = migrating.get(folders.data); held; held = migrating.get(folders.data)) await held.catch(() => undefined)
  if (existsSync(opencodeDatabase(folders))) return start()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  migrating.set(folders.data, gate)
  try { return await start() } finally { if (migrating.get(folders.data) === gate) migrating.delete(folders.data); release() }
}

/** Stable event names an OpenCode server's life is logged by. Nothing it prints is ever logged (AGENTS.md). */
export type OpenCodeServerEvent = 'opencode-server-started' | 'opencode-server-ready' | 'opencode-server-exited' | 'opencode-server-stopped' | 'opencode-server-failed'
  | 'opencode-server-left-ended'

/** The line a server prints once it listens, read only when it is whole: an address cut across two reads is not its address. */
const READY = /server listening on[ \t]+(https?:\/\/\S+)\r?\n/iu
/**
 * The address a server said it listens on, if it is on this computer: it was told to listen on 127.0.0.1, and its
 * password goes nowhere else. Undefined for anything else.
 */
export function loopbackServerUrl(said: string): string | undefined {
  let url: URL
  try { url = new URL(said) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return undefined
  return `${url.protocol}//${url.host}`
}
/** Readiness is read from the first lines a server prints; anything past this is never held. */
const READY_SCAN_BYTES = 64 * 1024

export interface OpenCodeServerLaunch {
  readonly executable: string
  /** Arguments before `serve`, used by the scripted provider. */
  readonly args?: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly log?: ((event: OpenCodeServerEvent) => void) | undefined
  /** Where the server is written down while it runs, so one a crash leaves is ended at the next connect. */
  readonly ledger?: string | undefined
}

/**
 * One `opencode serve --hostname=127.0.0.1 --port=0` (ADR-0038, ADR-0087), started with its own password. It is ready
 * once it prints the address it listens on; the address is all Sotto reads from its output, and nothing it prints is
 * kept or logged, since OpenCode prints a generated password when it is given none. It stops with its whole process
 * tree, because a running tool's processes outlive a server stopped alone on Windows.
 */
export class OpenCodeServer {
  readonly closed: Promise<void>
  private exited = false
  private stopping: Promise<void> | undefined
  private constructor(private readonly child: ChildProcess, readonly url: string, private readonly log: OpenCodeServerLaunch['log'], closed: Promise<void>,
    private readonly startedAt: number, private readonly forget: () => Promise<void>) {
    this.closed = closed
    void closed.then(() => { this.exited = true })
  }
  get pid(): number | undefined { return this.child.pid }
  get running(): boolean { return !this.exited }

  static start(launch: OpenCodeServerLaunch): Promise<OpenCodeServer> {
    return new Promise((resolve, reject) => {
      // Before the spawn, so every process the server starts is newer than this.
      const startedAt = Date.now()
      const child = spawn(launch.executable, [...(launch.args ?? []), 'serve', '--hostname=127.0.0.1', '--port=0'], {
        cwd: launch.cwd, env: withCliPath(launch.env, launch.executable), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        // A process group of its own elsewhere, so stopping it reaches every tool it started.
        detached: process.platform !== 'win32',
      })
      launch.log?.('opencode-server-started')
      const closed = new Promise<void>(done => child.once('close', () => done()))
      // Written down before anything else can happen to it, and taken off once it and what it left are gone.
      const { ledger } = launch, pid = child.pid
      const recorded = ledger && pid !== undefined ? recordOpenCodeServer(ledger, { pid, startedAt, owner: process.pid })
        .then(async () => {
          // Then the start the system itself reports for it, which is what a later sweep reads (ADR-0087). Only while the
          // server has not exited: until Node reaps it, its PID cannot be anyone else's.
          const started = await systemProcessStart(pid)
          if (started !== undefined && !ended(child)) await recordOpenCodeServer(ledger, { pid, startedAt, started, owner: process.pid })
        }).catch(() => undefined) : Promise.resolve()
      const forget = (): Promise<void> => recorded.then(() => ledger && pid !== undefined ? rm(serverRecordPath(ledger, pid), { force: true }) : undefined).catch(() => undefined)
      let scanned = '', ready = false
      const fail = (error: Error): void => {
        if (ready) return
        ready = true; clearTimeout(timer)
        launch.log?.('opencode-server-failed')
        void killTree(child, closed, startedAt).then(forget, forget)
        reject(error)
      }
      const timer = setTimeout(() => fail(new OpenCodeUncertain('OpenCode did not start in time.')), launch.timeoutMs)
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (chunk: string) => {
        if (ready) return
        scanned = (scanned + chunk).slice(-READY_SCAN_BYTES)
        const match = READY.exec(scanned)
        if (!match) return
        const url = loopbackServerUrl(match[1]!)
        if (!url) { fail(new OpenCodeUnsupported('OpenCode said it was listening somewhere other than this computer, so Sotto sent it nothing. Connect again to retry.')); return }
        ready = true; clearTimeout(timer); scanned = ''
        const server = new OpenCodeServer(child, url, launch.log, closed, startedAt, forget)
        void closed.then(() => { if (!server.stopping) launch.log?.('opencode-server-exited') })
        resolve(server)
      })
      // Drained and dropped: a server's diagnostics are not Sotto's to read, and a full pipe would stall it.
      child.stderr!.on('data', () => undefined)
      child.once('error', () => fail(new OpenCodeUncertain('OpenCode could not be started.')))
      void closed.then(() => fail(new OpenCodeUncertain('OpenCode stopped before it was ready.')))
    })
  }

  /**
   * Stop the server and everything it started. Resolves once the server and what it left are gone. A server that already
   * exited on its own still has its tools to end: they outlive their leader (ADR-0087).
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.log?.('opencode-server-stopped')
    this.stopping = killTree(this.child, this.closed, this.startedAt).then(this.forget, this.forget)
    return this.stopping
  }
}

/** One row of the process table, as Windows keeps it: who started each process, when, and with what command line if it says. */
export interface ProcessRow { readonly pid: number; readonly parent: number; readonly created: number; readonly command?: string }
/**
 * Process creation times are stamped on the system's coarse clock, which may read a little behind the precise one Node
 * reads, so a process started just after another can look a few milliseconds older.
 */
const CLOCK_SLACK_MS = 50
/**
 * The processes a server that has exited leaves behind: those whose parent chain leads to its PID, which Windows still
 * records in each one's parent after the server is gone (ADR-0087). Each must be newer than its parent, so a process
 * left by an earlier owner of the PID, or started by a later one, is never named, and nor is Sotto itself.
 */
export function orphanedDescendants(rows: readonly ProcessRow[], root: number, startedAt: number): number[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    if (row.pid === row.parent || row.pid === process.pid) continue
    const list = children.get(row.parent); if (list) list.push(row); else children.set(row.parent, [row])
  }
  // A process holding the server's PID now took it after the server ended: what it started is its own.
  const reused = rows.find(row => row.pid === root)
  const found = new Set<number>()
  const walk = (pid: number, after: number, before: number): void => {
    for (const row of children.get(pid) ?? []) {
      if (row.created < after - CLOCK_SLACK_MS || row.created >= before || found.has(row.pid)) continue
      found.add(row.pid)
      walk(row.pid, row.created, Number.POSITIVE_INFINITY)
    }
  }
  walk(root, startedAt, reused ? reused.created : Number.POSITIVE_INFINITY)
  return [...found]
}

const PROCESS_QUERY = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), ($_.CommandLine -replace '[\\r\\n]', ' ') } }"
/** The process table, read once through PowerShell's CIM query; empty when it cannot be read. Windows only. */
function processTable(): Promise<ProcessRow[]> {
  return new Promise(resolve => {
    let output = ''
    const reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { reader.kill(); resolve([]) }, 15_000); timer.unref()
    reader.stdout.setEncoding('utf8')
    reader.stdout.on('data', (chunk: string) => { output += chunk })
    reader.once('error', () => { clearTimeout(timer); resolve([]) })
    reader.once('close', () => {
      clearTimeout(timer)
      resolve(output.split(/\r?\n/u).flatMap(line => {
        const [pid, parent, created] = line.trim().split(' ', 3).map(Number)
        const command = line.trim().split(' ').slice(3).join(' ')
        return Number.isInteger(pid) && Number.isInteger(parent) && Number.isFinite(created) ? [{ pid: pid!, parent: parent!, created: created!, ...(command ? { command } : {}) }] : []
      }))
    })
  })
}

/** End what an exited server left running, on Windows, where nothing else reaches it once its leader is gone. */
async function endOrphans(root: number, startedAt: number, rows?: readonly ProcessRow[]): Promise<void> {
  for (const pid of orphanedDescendants(rows ?? await processTable(), root, startedAt)) {
    try { process.kill(pid) } catch { /* Ended meanwhile. */ }
  }
}

/** `taskkill /T /F` on one process and its tree; true when taskkill says it ended them. */
function taskkillTree(pid: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
    killer.once('error', () => resolve(false)); killer.once('close', code => resolve(code === 0))
  })
}

/** Whether a child process has exited. */
const ended = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

/**
 * End a process and its descendants: `taskkill /T /F` on Windows, its process group elsewhere. A leader that already
 * exited has no tree for taskkill to walk, so on Windows its descendants are found by their recorded parents; elsewhere
 * its process group outlives it and still reaches them.
 */
async function killTree(child: ChildProcess, closed: Promise<void>, startedAt: number): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    let whole = false
    if (!ended(child)) {
      whole = await taskkillTree(pid)
      // taskkill can miss a process that is already ending; the child itself is the last resort.
      const late = setTimeout(() => { try { child.kill() } catch { /* Gone. */ } }, 2_000); late.unref()
      await closed; clearTimeout(late)
    } else await closed
    // The leader was gone before taskkill could walk its tree, or ended while it did.
    if (!whole) await endOrphans(pid, startedAt)
    return
  }
  const signal = (name: NodeJS.Signals): void => {
    try { process.kill(-pid, name) } catch { if (!ended(child)) { try { child.kill(name) } catch { /* Gone. */ } } }
  }
  signal('SIGTERM')
  const hard = setTimeout(() => signal('SIGKILL'), 1_000); hard.unref()
  await closed; clearTimeout(hard)
  // Children that ignored SIGTERM, or outlived a leader that exited on its own, are still in its group: the hard stop reaches them.
  signal('SIGKILL')
}

/**
 * A server Sotto started, as it is written down while it runs (ADR-0087): its PID, when Sotto started it by Sotto's clock,
 * on macOS and Linux when the system says it started, and the Sotto process that did. A crash leaves the record behind,
 * and the next connect ends the server it names, if it is still that server, and what it left.
 */
export interface OpenCodeServerRecord { readonly pid: number; readonly startedAt: number; readonly started?: number | undefined; readonly owner: number }
const serverRecordSchema = z.object({ pid: z.number().int().positive(), startedAt: z.number().finite(), started: z.number().finite().optional(), owner: z.number().int().positive() })
/** Where each server Sotto starts on these folders is written down while it runs: one file per server, named by its PID. */
export function opencodeServerLedger(folders: OpenCodeFolders): string { return folders.servers }
const serverRecordPath = (ledger: string, pid: number): string => join(ledger, `${pid}.json`)
let recordWrites = 0
/**
 * Write a server down, or write it down again. The record is written whole beside its place, named for the Sotto process
 * writing it, and then renamed into place, so a sweep running meanwhile reads the old record or the new one and never
 * half of either. Windows refuses the rename while a sweep has the record open; after a few tries the record is written
 * in place, which a sweep leaves alone while it is young (`RECORD_SETTLE_MS`).
 */
export async function recordOpenCodeServer(ledger: string, record: OpenCodeServerRecord): Promise<void> {
  await mkdir(ledger, { recursive: true })
  const file = serverRecordPath(ledger, record.pid), whole = `${file}.${process.pid}.${++recordWrites}.tmp`, text = JSON.stringify(record)
  await writeFile(whole, text)
  for (let attempt = 1; ; attempt++) {
    try { await rename(whole, file); return } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') { await rm(whole, { force: true }).catch(() => undefined); throw error }
      if (attempt >= 10) break
      await pause(20)
    }
  }
  try { await writeFile(file, text) } finally { await rm(whole, { force: true }).catch(() => undefined) }
}
/** A record younger than this that cannot be read may be an older Sotto's, still writing it in place. */
const RECORD_SETTLE_MS = 5_000

const isRunning = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }
/**
 * How far a process's start may sit from the moment Sotto wrote down starting it: a little before, for the coarse clocks
 * process start times are kept on, and a little after, for a slow spawn. Windows stamps a process on the clock Node
 * reads, so this is all it needs. Linux's `ps` adds ticks since boot to a boot time kept in whole seconds and drops the
 * fraction again, so it reads up to two seconds behind the clock, and a wall-clock step moves what it reads. Room before
 * costs nothing: a process holding the PID that truly started before the server did would be the server itself, since
 * the server held the PID from then on. A record written before `ps` answered relies on it.
 */
const START_BEFORE_MS = 2_500
const START_AFTER_MS = 10_000
/**
 * How far `ps` may read from the start it reported when Sotto wrote the server down: the second it rounds to, once more if
 * the boot time it adds to is rounded the other way. A clock that steps after the record moves `ps` off it, and then
 * Sotto's own clock is the other rule a server may match by.
 */
const SAME_START_MS = 1_000
/** The process seen holding a recorded server's PID: when it started, and its command line when the system says. */
export interface ObservedProcess { readonly started: number; readonly command?: string | undefined }
/** Whether a command line is OpenCode's server as Sotto starts one. A command line the system will not show is not. */
function isServerCommand(command: string | undefined): boolean {
  return !!command && /(?:^|\s)serve(?:\s|$)/u.test(command) && command.includes('--hostname=127.0.0.1') && command.includes('--port=0')
}
/**
 * Whether the process holding a recorded server's PID is that server: its command line is OpenCode's server as Sotto
 * starts one, and it started when Sotto wrote down starting it, by Sotto's clock or within a second of the start `ps`
 * reported for it then. A command line the system will not show is not proof.
 */
export function isRecordedServer(record: OpenCodeServerRecord, seen: ObservedProcess | undefined): boolean {
  if (!seen || !isServerCommand(seen.command)) return false
  // Like with like: the start the system reported then, against what it reports now.
  if (record.started !== undefined && Math.abs(seen.started - record.started) <= SAME_START_MS) return true
  return seen.started >= record.startedAt - START_BEFORE_MS && seen.started <= record.startedAt + START_AFTER_MS
}
/** One line of `ps -o lstart= -o args=` in the C locale: the start time, to the second, and the command line. */
export function parseProcessStart(line: string): ObservedProcess | undefined {
  const match = /^\s*([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*?)\s*$/u.exec(line)
  if (!match) return undefined
  const started = Date.parse(match[1]!.replace(/\s+/gu, ' '))
  return Number.isFinite(started) ? { started, command: match[2] } : undefined
}
/** When a process started and what it runs, from `ps`, which macOS and Linux both have. Undefined once it has gone. */
function processStart(pid: number): Promise<ObservedProcess | undefined> {
  return new Promise(resolve => {
    let output = ''
    const reader = spawn('ps', ['-o', 'lstart=', '-o', 'args=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { reader.kill(); resolve(undefined) }, 10_000); timer.unref()
    reader.stdout.setEncoding('utf8')
    reader.stdout.on('data', (chunk: string) => { if (output.length < 65_536) output += chunk })
    reader.once('error', () => { clearTimeout(timer); resolve(undefined) })
    reader.once('close', () => { clearTimeout(timer); resolve(parseProcessStart(output.split(/\r?\n/u)[0] ?? '')) })
  })
}
/** When the system says a process started, on macOS and Linux, as `ps` reads it; undefined on Windows or once it has gone. */
export async function systemProcessStart(pid: number): Promise<number | undefined> {
  return process.platform === 'win32' ? undefined : (await processStart(pid))?.started
}
const pause = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms).unref() })
async function gone(pid: number, withinMs: number): Promise<boolean> {
  for (const until = Date.now() + withinMs; isRunning(pid) && Date.now() < until;) await pause(50)
  return !isRunning(pid)
}

/** End one server a crash left, and what it started, if the process that has its PID is still that server. */
async function endRecordedServer(record: OpenCodeServerRecord, rows: readonly ProcessRow[]): Promise<boolean> {
  if (process.platform === 'win32') {
    const row = rows.find(candidate => candidate.pid === record.pid)
    if (row && isRecordedServer(record, { started: row.created, command: row.command })) {
      await taskkillTree(record.pid)
      return gone(record.pid, 2_000)
    }
    // The server is gone, as Node's job object ends it with Sotto on Windows; a tool it started may not be. A process
    // holding its PID now is someone else's, and so is anything that process started.
    await endOrphans(record.pid, record.startedAt, rows)
    return false
  }
  // Elsewhere the server leads a process group of its own, which holds every tool it started. A group whose leader has
  // gone is left alone: with no leader, nothing shows the group is still the server's.
  if (!isRecordedServer(record, await processStart(record.pid))) return false
  const signal = (name: NodeJS.Signals): void => { try { process.kill(-record.pid, name) } catch { /* Gone. */ } }
  signal('SIGTERM')
  if (!await gone(record.pid, 1_000)) signal('SIGKILL')
  // Children that ignored the first signal are still in its group.
  signal('SIGKILL')
  return gone(record.pid, 2_000)
}

/**
 * End the servers a Sotto that has gone left running on these folders (ADR-0087), with what they started, and take their
 * records off. A record whose Sotto is still running is left for it, and a process that only has a recorded PID now,
 * started at another time or running something else, is never touched.
 */
export async function endServersLeftBehind(ledger: string, log?: (event: OpenCodeServerEvent) => void): Promise<void> {
  let names: string[]
  try { names = await readdir(ledger) } catch { return }
  // A record a Sotto that has gone was still writing when it went; one a running Sotto is writing is its own.
  for (const name of names) {
    const writer = /^\d+\.json\.(\d+)\.\d+\.tmp$/u.exec(name)?.[1]
    if (writer && !isRunning(Number(writer))) await rm(join(ledger, name), { force: true }).catch(() => undefined)
  }
  const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
    const file = join(ledger, name)
    try { return { file, record: serverRecordSchema.parse(JSON.parse(await readFile(file, 'utf8'))) } } catch { return { file, record: undefined } }
  }))
  // A record that cannot be read is cleared only once nothing can still be writing it.
  const unread = (await Promise.all(records.filter(({ record }) => !record).map(async ({ file }) => {
    const written = await stat(file).then(({ mtimeMs }) => mtimeMs, () => undefined)
    return written === undefined || written > Date.now() - RECORD_SETTLE_MS ? [] : [file]
  }))).flat()
  const left = records.flatMap(({ file, record }) => record && !isRunning(record.owner) ? [{ file, record }] : [])
  if (!left.length && !unread.length) return
  const rows = process.platform === 'win32' ? await processTable() : []
  for (const { file, record } of left) {
    if (await endRecordedServer(record, rows)) log?.('opencode-server-left-ended')
    await rm(file, { force: true }).catch(() => undefined)
  }
  for (const file of unread) {
    // Named by its server's PID: while that PID runs OpenCode's server, the record may be all that shows it is Sotto's.
    const pid = Number(/(\d+)\.json$/u.exec(file)?.[1])
    const command = process.platform === 'win32' ? rows.find(row => row.pid === pid)?.command : (await processStart(pid))?.command
    if (!isServerCommand(command)) await rm(file, { force: true }).catch(() => undefined)
  }
}
