import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PasteInvocation } from './pasteCommand'
import type { PasteProcessAdapter } from './outputService'
import { PASTE_PROCESS_TIMEOUT_MS } from './outputService'

export const HYPRLAND_KEY_HOLD_MS = 50
export const MODIFIER_RELEASE_POLL_MS = 25
export const MODIFIER_RELEASE_WAIT_MS = 300

// is_key_down reads physical state. repl returns the Lua result; eval only returns "ok".
export const MODIFIERS_HELD_QUERY = 'return hl.is_key_down("Super_L") or hl.is_key_down("Super_R") or hl.is_key_down("Control_L") or hl.is_key_down("Control_R") or hl.is_key_down("Shift_L") or hl.is_key_down("Shift_R") or hl.is_key_down("Alt_L") or hl.is_key_down("Alt_R")'

export function buildLinuxPasteInvocation(): PasteInvocation {
  return { executable: 'hyprctl', args: ['activewindow', '-j'] }
}

export function hyprlandPasteChord(activeWindow: unknown): { mods: 'CTRL' | 'SHIFT'; key: 'V' | 'Insert' } {
  const tags = activeWindow && typeof activeWindow === 'object' && 'tags' in activeWindow
    ? activeWindow.tags : undefined
  const terminal = Array.isArray(tags) && tags.some(tag => tag === 'terminal' || tag === 'terminal*')
  return terminal ? { mods: 'SHIFT', key: 'Insert' } : { mods: 'CTRL', key: 'V' }
}

export function buildHyprlandKeyInvocation(
  chord: ReturnType<typeof hyprlandPasteChord>, state: 'down' | 'up',
): PasteInvocation {
  return {
    executable: 'hyprctl',
    args: ['dispatch', `hl.dsp.send_key_state({ mods = "${chord.mods}", key = "${chord.key}", state = "${state}" })`],
  }
}

const execute = promisify(execFile)
export async function runHyprctl(invocation: PasteInvocation): Promise<string> {
  const { stdout } = await execute(invocation.executable, [...invocation.args], {
    shell: false, encoding: 'utf8', timeout: PASTE_PROCESS_TIMEOUT_MS, maxBuffer: 256 * 1024,
  })
  return stdout.trim()
}

export function createHyprlandPasteAdapter(
  run: (invocation: PasteInvocation) => Promise<string> = runHyprctl,
  delay: (milliseconds: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): PasteProcessAdapter {
  return {
    async run(invocation): Promise<boolean> {
      try {
        if (JSON.parse(await run({ executable: 'hyprctl', args: ['locked', '-j'] })).locked !== false) return false
        for (let waited = 0; ; waited += MODIFIER_RELEASE_POLL_MS) {
          const held = await run({ executable: 'hyprctl', args: ['repl', MODIFIERS_HELD_QUERY] })
          if (held === 'false') break
          if (held !== 'true' || waited >= MODIFIER_RELEASE_WAIT_MS) return false
          await delay(MODIFIER_RELEASE_POLL_MS)
        }
        // Query after Sotto's paste delay and modifier release, as close to dispatch as possible.
        const chord = hyprlandPasteChord(JSON.parse(await run(invocation)))
        let pressed = false
        let released = false
        try {
          pressed = await run(buildHyprlandKeyInvocation(chord, 'down')) === 'ok'
          await delay(HYPRLAND_KEY_HOLD_MS)
        } finally {
          // A lost down acknowledgement may still have sent the key. Always attempt its release.
          released = await run(buildHyprlandKeyInvocation(chord, 'up')) === 'ok'
        }
        return pressed && released
      } catch {
        return false
      }
    },
  }
}
