import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompositorDictationCommand } from './dictationCommand'
import { assertDictationDirectories, validateDictationRuntime } from './dictationRuntime'

/** Separate hotkey clients share a cooldown; a key release never claims it. */
export function notifyDictationUnavailable(command: CompositorDictationCommand): void {
  if (command !== 'start' && command !== 'toggle') return
  try {
    const directories = validateDictationRuntime(process.env.XDG_RUNTIME_DIR)
    const runtime = directories.at(-1)!.path
    const stamp = join(runtime, 'sotto-dictation-notice')
    const lock = `${stamp}.lock`
    // Serialize the stamp check and write across simultaneous key-down clients.
    mkdirSync(lock, { mode: 0o700 })
    try {
      assertDictationDirectories(directories)
      try {
        const previous = lstatSync(stamp)
        if (!previous.isFile() || previous.uid !== process.getuid?.() || Date.now() - previous.mtimeMs < 5_000) return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
      }
      writeFileSync(stamp, '', { mode: 0o600 })
      execFile('notify-send', [
        '--app-name', 'Sotto', '--icon', 'sotto', '--expire-time', '5000',
        'Sotto isn\'t open.', command === 'start' ? 'Open Sotto, then press F9 again.' : 'Open Sotto, then try again.',
      ], { shell: false, timeout: 1_000 }, () => { /* The CLI error still explains failure if notifications are unavailable. */ })
    } finally { rmdirSync(lock) }
  } catch { /* A notification must never replace the command's failure status. */ }
}
