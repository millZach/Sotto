import { closeSync, openSync, readSync, readFileSync, statSync, watch, type FSWatcher, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SottoPlatform } from '../../shared/platform'
import type { SettingsRepository } from '../storage/settingsRepository'
import { OMARCHY_THEME_ID, parseOmarchyTheme, type OmarchyTheme } from '../../shared/themes/omarchy'

export type OmarchyThemeEvent = 'omarchy-theme-missing' | 'omarchy-theme-invalid' | 'omarchy-theme-watch-failed'

/** Watch folders, rather than the file inode Omarchy discards on every theme switch. */
export class OmarchyThemeMonitor {
  readonly path: string
  private readonly current: string
  private watchers: Array<{ watcher: FSWatcher; path: string; identity: Stats }> = []
  private timer: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private last = ''
  private theme: OmarchyTheme | null = null
  private running = false

  constructor(
    private readonly platform: SottoPlatform, home: string,
    private readonly changed: () => void, private readonly log: (event: OmarchyThemeEvent) => void,
  ) {
    this.current = join(home, '.local/state/omarchy/current')
    this.path = join(this.current, 'theme/sotto.json')
  }

  get(): OmarchyTheme | null { return this.theme }

  /** Initial read happens before settings defaults are chosen; other platforms do no I/O. */
  load(): OmarchyTheme | null {
    if (this.platform === 'linux') this.read()
    return this.theme
  }

  start(): void {
    if (this.platform !== 'linux' || this.running) return
    this.running = true
    this.refresh()
    // Recover a removed ancestor or an exhausted watch, and installs made after startup.
    this.timer = setInterval(() => this.refresh(), 1000)
    this.timer.unref()
  }

  private schedule(): void {
    if (!this.running) return
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => { this.debounce = null; this.refresh() }, 60)
    this.debounce.unref()
  }

  private refresh(): void {
    if (!this.running) return
    this.read()
    let parent = this.current
    while (!this.isDirectory(parent) && dirname(parent) !== parent) parent = dirname(parent)
    const paths = [...new Set([parent, ...(this.isDirectory(dirname(this.path)) ? [dirname(this.path)] : [])])]
    const old = this.watchers
    this.watchers = []
    for (const path of paths) {
      try {
        const identity = statSync(path)
        const existing = old.find(entry => entry.path === path && entry.identity.dev === identity.dev && entry.identity.ino === identity.ino)
        if (existing) { this.watchers.push(existing); old.splice(old.indexOf(existing), 1); continue }
        const watcher = watch(path, () => this.schedule())
        const entry = { watcher, path, identity }
        this.watchers.push(entry)
        watcher.on('error', () => {
          watcher.close()
          this.watchers = this.watchers.filter(candidate => candidate !== entry)
          this.log('omarchy-theme-watch-failed')
        })
      } catch { this.log('omarchy-theme-watch-failed') }
    }
    for (const entry of old) entry.watcher.close()
  }

  private read(): void {
    let next: OmarchyTheme | null = null
    let fingerprint: string
    let failed: OmarchyThemeEvent | null = null
    try {
      // One bounded read; no watcher or parse error can put file contents into a log.
      const fd = openSync(this.path, 'r')
      let content: string
      try {
        const bytes = Buffer.alloc(64 * 1024 + 1)
        const count = readSync(fd, bytes)
        if (count > 64 * 1024) throw new Error('Theme too large')
        content = bytes.subarray(0, count).toString('utf8')
      } finally { closeSync(fd) }
      let sourceName = 'Current Omarchy theme'
      try {
        const namePath = join(this.current, 'theme.name')
        if (statSync(namePath).size <= 80) {
          const slug = readFileSync(namePath, 'utf8').trim()
          if (/^[a-z0-9][a-z0-9-]{0,63}$/u.test(slug)) sourceName = slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
        }
      } catch { /* The palette still works without the optional name file. */ }
      fingerprint = `${sourceName}\n${content}`
      if (fingerprint === this.last) return
      next = parseOmarchyTheme(JSON.parse(content), sourceName)
    } catch (error) {
      failed = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'omarchy-theme-missing' : 'omarchy-theme-invalid'
      fingerprint = failed
    }
    if (fingerprint === this.last) return
    this.last = fingerprint
    if (failed) this.log(failed)
    const changed = JSON.stringify(this.theme) !== JSON.stringify(next)
    this.theme = next
    if (changed && this.running) this.changed()
  }

  private isDirectory(path: string): boolean { try { return statSync(path).isDirectory() } catch { return false } }

  dispose(): void {
    this.running = false
    for (const entry of this.watchers) entry.watcher.close()
    this.watchers = []
    if (this.timer !== null) clearInterval(this.timer)
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.timer = null
    this.debounce = null
  }
}

/** A new Omarchy install starts following both halves; an existing choice always wins. */
export async function initializeOmarchySelection(platform: SottoPlatform, theme: OmarchyTheme | null, settings: Pick<SettingsRepository, 'exists' | 'update'>): Promise<void> {
  if (platform === 'linux' && theme && !await settings.exists()) {
    await settings.update({ appearance: 'system', lightTheme: OMARCHY_THEME_ID, darkTheme: OMARCHY_THEME_ID })
  }
}
