import { statSync, watch, type FSWatcher, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SottoPlatform } from '../../shared/platform'

/** Watch the nearest existing parent, so installing into a new config tree works too. */
export class ShellWidgetMonitor {
  readonly path: string
  private watcher: FSWatcher | null = null
  private watched: { path: string; identity: Stats } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private present: boolean | null = null
  private stateFileLive = false
  private suppressed: boolean | null = null
  private running = false

  constructor(private readonly platform: SottoPlatform, home: string, private readonly changed: (present: boolean) => void) {
    // Omarchy's PluginRegistry uses HOME directly, regardless of XDG_CONFIG_HOME.
    this.path = join(home, '.config', 'omarchy', 'plugins', 'sotto.dictation')
  }

  start(): void {
    if (this.platform !== 'linux' || this.timer !== null) return
    this.running = true
    this.refresh()
    // Also recover when a watched ancestor is removed or a watch is exhausted.
    this.timer = setInterval(() => this.refresh(), 1_000)
    this.timer.unref()
  }

  setStateFileLive(live: boolean): void {
    this.stateFileLive = live
    if (this.running) this.refresh()
  }

  private updateSuppression(): void {
    if (this.platform !== 'linux') return
    const suppressed = this.running && this.present === true && this.stateFileLive
    if (suppressed !== this.suppressed) {
      this.suppressed = suppressed
      this.changed(suppressed)
    }
  }

  private refresh(): void {
    if (!this.running) return
    const present = this.isDirectory(this.path)
    this.present = present
    this.updateSuppression()
    if (!this.running) return
    let parent = dirname(this.path)
    while (!this.isDirectory(parent) && dirname(parent) !== parent) parent = dirname(parent)
    try {
      const identity = statSync(parent)
      if (this.watcher && this.watched?.path === parent &&
        this.watched.identity.dev === identity.dev && this.watched.identity.ino === identity.ino) return
      this.watcher?.close()
      this.watcher = null
      this.watched = null
      const watcher = watch(parent, () => this.refresh())
      this.watcher = watcher
      this.watched = { path: parent, identity }
      watcher.on('error', () => {
        watcher.close()
        if (this.watcher === watcher) { this.watcher = null; this.watched = null }
      })
    } catch { /* The periodic check recovers a missing or unwatched folder. */ }
  }

  private isDirectory(path: string): boolean {
    try { return statSync(path).isDirectory() } catch { return false }
  }

  dispose(): void {
    this.running = false
    this.stateFileLive = false
    this.updateSuppression()
    this.watcher?.close()
    this.watcher = null
    this.watched = null
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}
