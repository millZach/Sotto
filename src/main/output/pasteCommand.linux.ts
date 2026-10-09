import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PasteInvocation } from './pasteCommand'
import type { PasteProcessAdapter } from './outputService'
import { PASTE_PROCESS_TIMEOUT_MS } from './outputService'

export const HYPRLAND_KEY_HOLD_MS = 50
export const MODIFIER_RELEASE_POLL_MS = 25
export const MODIFIER_RELEASE_WAIT_MS = 300

const TERMINAL_CLASSES = new Set([
  'foot', 'foot-client', 'org.codeberg.dnkl.foot', 'alacritty', 'kitty',
  'ghostty', 'com.mitchellh.ghostty', 'wezterm', 'org.wezfurlong.wezterm',
  'konsole', 'org.kde.konsole', 'ptyxis', 'org.gnome.ptyxis', 'xterm',
])

export function sanitizeLinuxPasteText(text: string): string {
  // Strip terminal controls, retaining the user's lines and indentation.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f]/gu, '')
}

// is_key_down reads physical state. repl returns the Lua result; eval only returns "ok".
export const MODIFIERS_HELD_QUERY = 'return hl.is_key_down("Super_L") or hl.is_key_down("Super_R") or hl.is_key_down("Control_L") or hl.is_key_down("Control_R") or hl.is_key_down("Shift_L") or hl.is_key_down("Shift_R") or hl.is_key_down("Alt_L") or hl.is_key_down("Alt_R")'

export function buildLinuxPasteInvocation(): PasteInvocation {
  return { executable: 'hyprctl', args: ['activewindow', '-j'] }
}

export function hyprlandPasteChord(activeWindow: unknown): { mods: 'CTRL' | 'SHIFT'; key: 'V' | 'Insert' } {
  const tags = activeWindow && typeof activeWindow === 'object' && 'tags' in activeWindow
    ? activeWindow.tags : undefined
  const className = activeWindow && typeof activeWindow === 'object' && 'class' in activeWindow
    ? activeWindow.class : undefined
  const terminal = (Array.isArray(tags) && tags.some(tag => tag === 'terminal' || tag === 'terminal*'))
    || (typeof className === 'string' && TERMINAL_CLASSES.has(className.toLowerCase()))
  return terminal ? { mods: 'SHIFT', key: 'Insert' } : { mods: 'CTRL', key: 'V' }
}

export function buildHyprlandKeyInvocation(chord: ReturnType<typeof hyprlandPasteChord>): PasteInvocation {
  return {
    executable: 'hyprctl',
    args: ['eval', [
      `hl.dispatch(hl.dsp.send_key_state({ mods = "${chord.mods}", key = "${chord.key}", state = "down" }))`,
      'hl.timer(function()',
      `  hl.dispatch(hl.dsp.send_key_state({ mods = "${chord.mods}", key = "${chord.key}", state = "up" }))`,
      `end, { timeout = ${HYPRLAND_KEY_HOLD_MS}, type = "oneshot" })`,
    ].join('\n')],
  }
}

const execute = promisify(execFile)
export async function runHyprctl(invocation: PasteInvocation, timeoutMs = PASTE_PROCESS_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execute(invocation.executable, [...invocation.args], {
    shell: false, encoding: 'utf8', timeout: Math.max(1, Math.ceil(timeoutMs)), maxBuffer: 256 * 1024,
  })
  return stdout.trim()
}

export function createHyprlandPasteAdapter(
  run: (invocation: PasteInvocation, timeoutMs?: number) => Promise<string> = runHyprctl,
  delay: (milliseconds: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => number = () => performance.now(),
  copyToPrimary: () => Promise<void> = async () => { throw new Error('Primary selection unavailable') },
): PasteProcessAdapter {
  return {
    async run(invocation): Promise<boolean> {
      try {
        if (JSON.parse(await run({ executable: 'hyprctl', args: ['locked', '-j'] })).locked !== false) return false
        const deadline = now() + MODIFIER_RELEASE_WAIT_MS
        for (;;) {
          const remaining = deadline - now()
          if (remaining <= 0) return false
          let timeout: ReturnType<typeof setTimeout> | undefined
          let held: string
          try {
            held = await Promise.race([
              run({ executable: 'hyprctl', args: ['repl', MODIFIERS_HELD_QUERY] }, remaining),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Modifier query deadline')), remaining)
              }),
            ])
          } finally {
            clearTimeout(timeout)
          }
          // A late release cannot authorize paste, even if its timer has not run yet.
          if (now() >= deadline) return false
          if (held === 'false') break
          if (held !== 'true') return false
          await delay(Math.min(MODIFIER_RELEASE_POLL_MS, deadline - now()))
        }
        // Query after Sotto's paste delay and modifier release, as close to dispatch as possible.
        const activeWindow: unknown = JSON.parse(await run(invocation))
        const address = activeWindow && typeof activeWindow === 'object' && 'address' in activeWindow
          ? activeWindow.address : undefined
        if (typeof address !== 'string' || address.trim() === '') return false
        const chord = hyprlandPasteChord(activeWindow)
        if (chord.mods === 'SHIFT') await copyToPrimary()
        // Modifier polling and target lookup can outlast the initial lock check.
        // The compositor owns the release timer even if this request loses its reply.
        // Keep the lock recheck immediately before the single down/up request.
        if (JSON.parse(await run({ executable: 'hyprctl', args: ['locked', '-j'] })).locked !== false) return false
        return await run(buildHyprlandKeyInvocation(chord)) === 'ok'
      } catch {
        return false
      }
    },
  }
}
