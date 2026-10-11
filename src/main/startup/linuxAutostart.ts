import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { LINUX_LOGIN_ITEMS, type LoginItemAdapter } from './startupService'

export type LinuxAutostartEvent = 'linux-autostart-read-failed' | 'linux-autostart-write-failed'

/** Desktop Entry Exec quoting has two escape layers and reserves percent for field codes. */
function desktopExec(executable: string): string {
  if (!isAbsolute(executable) || /[\r\n\0]/u.test(executable)) throw new Error('Sotto could not save its sign-in command. Reinstall the package and try again.')
  const escaped = executable.replaceAll('%', '%%').replace(/[\\"`$]/gu, '\\$&').replaceAll('\\', '\\\\')
  return `"${escaped}"`
}

export function linuxAutostart(options: {
  readonly isPackaged: boolean
  readonly executable: string
  readonly configHome?: string | undefined
  readonly home?: string | undefined
  readonly log?: (event: LinuxAutostartEvent) => void
}): LoginItemAdapter {
  if (!options.isPackaged) return LINUX_LOGIN_ITEMS
  const config = options.configHome && isAbsolute(options.configHome) ? options.configHome : join(options.home ?? homedir(), '.config')
  const folder = join(config, 'autostart')
  const file = join(folder, 'sotto.desktop')
  const command = desktopExec(options.executable)
  // TryExec is a Desktop Entry string, not an Exec command or field-code template.
  const tryExec = options.executable.replaceAll('\\', '\\\\').replaceAll('\t', '\\t')
  const contents = `[Desktop Entry]\nType=Application\nName=Sotto\nX-Sotto-Autostart=true\nExec=${command}\nTryExec=${tryExec}\nIcon=sotto\nTerminal=false\nCategories=Utility;\n`
  let supported = true
  const unavailable = (event: LinuxAutostartEvent) => {
    supported = false
    options.log?.(event)
  }
  const readEntry = (): string | null => {
    if (!supported) return null
    try {
      const saved = readFileSync(file, 'utf8')
      // Another app or desktop tool owns its own entry and any explicit disable.
      if (!/^Name=Sotto\s*$/mu.test(saved) || !/^X-Sotto-Autostart=true\s*$/mu.test(saved)
        || /^Hidden=true\s*$/mu.test(saved) || /^X-GNOME-Autostart-enabled=false\s*$/mu.test(saved)) supported = false
      return saved
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable('linux-autostart-read-failed')
      return null
    }
  }
  return {
    get supported() { return supported },
    reconcileOnSet: true,
    getLoginItemSettings: () => {
      const saved = readEntry()
      return { openAtLogin: supported && saved !== null && /^Exec=.+$/mu.test(saved) }
    },
    setLoginItemSettings: ({ openAtLogin }) => {
      // Recheck ownership before a mutation, including direct adapter calls.
      const saved = readEntry()
      if (!supported) return
      if (openAtLogin && saved === contents) return
      try {
        if (!openAtLogin) { rmSync(file, { force: true }); return }
        mkdirSync(folder, { recursive: true })
        const temporary = `${file}.${process.pid}.tmp`
        try {
          writeFileSync(temporary, contents, { mode: 0o600 })
          renameSync(temporary, file)
        } finally { rmSync(temporary, { force: true }) }
      } catch { unavailable('linux-autostart-write-failed') }
    },
  }
}
