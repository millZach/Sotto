import { statSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SottoPlatform } from '../../shared/platform'

/** Watch the nearest existing parent, so installing into a new config tree works too. */
export class ShellWidgetMonitor {
  readonly path: string
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private present: boolean | null = null
  private running = false

  constructor(private readonly platform: SottoPlatform, configHome: string | undefined, home: string, private readonly changed: (present: boolean) => void) {
    this.path = join(configHome || join(home, '.config'), 'omarchy', 'plugins', 'sotto.dictation')
  }

  start(): void {
    if (this.platform !== 'linux' || this.timer !== null) return
    this.running = true
    this.refresh()
    // Also recover when a watched ancestor is removed or a watch is exhausted.
    this.timer = setInterval(() => this.refresh(), 1_000)
    this.timer.unref()
  }

  private refresh(): void {
    if (!this.running) return
    const present = this.isDirectory(this.path)
    if (present !== this.present) { this.present = present; this.changed(present) }
    this.watcher?.close()
    this.watcher = null
    let parent = dirname(this.path)
    while (!this.isDirectory(parent) && dirname(parent) !== parent) parent = dirname(parent)
    try {
      const watcher = watch(parent, () => this.refresh())
      this.watcher = watcher
      watcher.on('error', () => {
        watcher.close()
        if (this.watcher === watcher) this.watcher = null
      })
    } catch { /* The periodic check recovers a missing or unwatched folder. */ }
  }

  private isDirectory(path: string): boolean {
    try { return statSync(path).isDirectory() } catch { return false }
  }

  dispose(): void {
    this.running = false
    this.watcher?.close()
    this.watcher = null
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}
