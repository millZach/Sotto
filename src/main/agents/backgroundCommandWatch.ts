import { randomUUID } from 'node:crypto'
import { BACKGROUND_WORK_LABELS, MAX_BACKGROUND_WORK, MAX_MONITOR_LABEL, type AgentBackgroundWork } from '../../shared/agentMonitoring'
import type { ChildProcessRow } from './detachedRunScan'

/** How long after a turn ends the first look waits, and how often it looks again while it finds anything. */
const FIRST_LOOK_MS = 3_000
const LOOK_EVERY_MS = 15_000

const words = (text: string): string | undefined => text.split(/\r?\n/u)[0]!.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_MONITOR_LABEL) || undefined

/**
 * The words a Hermes background command is named by, from its process (#2637, Zach's choice on November 16, 2026). Hermes
 * 0.19.0 starts it as `[shell, "-lic", "set +m; <command>"]` (`tools/process_registry.py`, `spawn_local`); that script is
 * the command as Hermes was asked to run it, before the shell expands anything, as the thread's own step shows it, and is
 * named in full. macOS lists it without quotes, so it is also found in the joined line. Once the shell has replaced
 * itself with the command, its arguments hold expanded values, which may be a key or a token, so only the program's
 * name is shown then.
 */
export function hermesCommandWords(argv: readonly string[]): string {
  const at = argv.indexOf('-lic'), script = at >= 1 ? argv[at + 1] : undefined
  if (script?.startsWith('set +m; ')) return words(script.slice('set +m; '.length)) ?? BACKGROUND_WORK_LABELS.command
  const joined = argv.join(' '), marker = joined.indexOf(' -lic set +m; ')
  if (marker >= 0) return words(joined.slice(marker + ' -lic set +m; '.length)) ?? BACKGROUND_WORK_LABELS.command
  const program = argv[0]?.replace(/\\/gu, '/').split('/').pop()?.replace(/\.exe$/iu, '')
  return (program && words(program)) ?? BACKGROUND_WORK_LABELS.command
}

/**
 * One of a Hermes thread's background commands (#2637): a child of the thread's own Hermes process that carries the
 * thread's ACP session as `HERMES_SESSION_KEY`, which Hermes 0.19.0 gives every command it runs and not its MCP servers
 * (`tools/mcp_tool.py`, `_build_safe_env`). A command run in the foreground has ended with its turn, so once a turn has
 * ended any such child is one left in the background. The mark outlasts the shell replacing itself with the command.
 */
export function hermesBackgroundCommand(session: string | undefined): (row: ChildProcessRow) => string | undefined {
  return row => session !== undefined && row.marks.some(mark => mark.name === 'HERMES_SESSION_KEY' && mark.value === session) ? hermesCommandWords(row.argv) : undefined
}

interface Watched { readonly id: string; readonly label: string; readonly startedAt: string | undefined }
export interface BackgroundCommandWatchOptions {
  /** The provider process's children, as the system lists them. */
  readonly children: (parentPid: number) => Promise<readonly ChildProcessRow[]>
  /** The command a child runs in the background, or undefined for a child that is not one. */
  readonly command: (row: ChildProcessRow) => string | undefined
  /** Called when what runs has changed. */
  readonly changed: () => void
  /**
   * Whether a look may take a child it does not know yet: not while a turn runs, whose own commands carry the same mark
   * and are not background work. A look then only keeps or lets go of what it knew.
   */
  readonly admitting: () => boolean
}

/**
 * The background commands of one thread whose provider never says they ended (#2637, ADR-0023: "find its process"):
 * the provider process's own children that it started as background commands, for as long as each still runs. Looked
 * for a few seconds after each turn ends, then again while any is found. Counted as `command` work only, with no row and
 * no Stop, as Zach chose on November 16, 2026. Observation only: a look that fails keeps what was known.
 */
export class BackgroundCommandWatch {
  private readonly known = new Map<string, Watched>()
  /** Each look's number; one that comes back after a newer one started is out of date and is dropped. */
  private looks = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private parentPid: number | undefined
  private stopped = false

  constructor(private readonly options: BackgroundCommandWatchOptions) {}

  /** Whether any still runs: the provider's process must not be let go under it. */
  get holds(): boolean { return this.known.size > 0 }

  get working(): AgentBackgroundWork[] {
    return [...this.known.values()].map(({ id, label, startedAt }) => ({ id, label, type: 'command' as const, ...(startedAt ? { startedAt } : {}) }))
  }

  /** A turn ended on this provider process: look for what it left running. */
  turnEnded(parentPid: number | undefined): void {
    if (this.stopped || !this.follow(parentPid)) return
    this.schedule(FIRST_LOOK_MS)
  }

  /** Look now, so a turn's end can be told with what it left running. Never fails, and gives up after `withinMs`. */
  async lookNow(parentPid: number | undefined, withinMs: number): Promise<void> {
    if (this.stopped || !this.follow(parentPid)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // Asked as a turn ends, before the adapter has told it ended: what runs now was left by that turn.
    await Promise.race([this.look(true), new Promise<void>(done => { timer = setTimeout(done, withinMs) })])
    clearTimeout(timer)
  }

  private follow(parentPid: number | undefined): boolean {
    if (parentPid === undefined) return false
    if (this.parentPid !== parentPid) { this.parentPid = parentPid; this.forget() }
    return true
  }

  /** The provider process is gone, and nothing it ran is the thread's any more. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.forget()
  }

  private forget(): void { if (this.known.size) { this.known.clear(); this.options.changed() } }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.look() }, delay)
    this.timer.unref?.()
  }

  private async look(admit = this.options.admitting()): Promise<void> {
    const parentPid = this.parentPid, look = ++this.looks
    if (this.stopped || parentPid === undefined) return
    let rows: readonly ChildProcessRow[]
    try { rows = await this.options.children(parentPid) } catch { if (look === this.looks && this.holds) this.schedule(LOOK_EVERY_MS); return }
    if (this.stopped || this.parentPid !== parentPid || look !== this.looks) return
    const found = new Map<string, Watched>()
    for (const row of rows) {
      const label = this.options.command(row)
      if (label === undefined || found.size >= MAX_BACKGROUND_WORK) continue
      // The same process keeps its ID from look to look; a number taken over by another start is another process.
      const key = `${row.pid}:${row.startedAt ?? ''}`
      if (!admit && !this.known.has(key)) continue
      found.set(key, this.known.get(key) ?? { id: randomUUID(), label, startedAt: row.startedAt === undefined ? undefined : new Date(row.startedAt).toISOString() })
    }
    const same = found.size === this.known.size && [...found.keys()].every(key => this.known.has(key))
    this.known.clear(); for (const [key, value] of found) this.known.set(key, value)
    if (!same) this.options.changed()
    if (this.holds) this.schedule(LOOK_EVERY_MS)
  }
}
