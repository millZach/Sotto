import { execFile } from 'node:child_process'
import { lstatSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { CompositorDictationCommand } from './dictationCommand'
import { assertDictationDirectories, validateDictationRuntime } from './dictationRuntime'

/** Separate hotkey clients share a cooldown; a key release never claims it. */
export async function notifyDictationUnavailable(command: CompositorDictationCommand): Promise<void> {
  if (command !== 'start' && command !== 'toggle') return
  try {
    const directories = validateDictationRuntime(process.env.XDG_RUNTIME_DIR)
    const runtime = directories.at(-1)!
    const stamp = join(runtime.path, 'sotto-dictation-notice')
    // An abstract Linux socket serializes clients and disappears even on SIGKILL.
    // Its runtime identity scopes the lock to this user and desktop session.
    const lock = createServer(socket => socket.destroy())
    try {
      await new Promise<void>((resolve, reject) => {
        lock.on('error', reject)
        lock.listen(`\0sotto-dictation-notice-${runtime.stat.uid}-${runtime.stat.dev}-${runtime.stat.ino}`, resolve)
      })
      assertDictationDirectories(directories)
      try {
        const previous = lstatSync(stamp)
        if (!previous.isFile() || previous.uid !== process.getuid?.() || Date.now() - previous.mtimeMs < 5_000) return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
      }
      writeFileSync(stamp, '', { mode: 0o600 })
      execFile('notify-send', [
        // libnotify separates the application icon from the optional content image.
        '--app-name', 'Sotto', '--app-icon', 'sotto', '--icon', 'sotto', '--expire-time', '5000',
        'Sotto isn\'t open.', command === 'start' ? 'Open Sotto, then press F9 again.' : 'Open Sotto, then try again.',
      ], { shell: false, timeout: 1_000 }, () => { /* The CLI error still explains failure if notifications are unavailable. */ })
    } finally {
      if (lock.listening) await new Promise<void>(resolve => lock.close(() => resolve()))
    }
  } catch { /* A notification must never replace the command's failure status. */ }
}
