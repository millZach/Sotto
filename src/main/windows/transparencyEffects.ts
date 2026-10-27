import { execFile } from 'node:child_process'

/**
 * Windows' "Transparency effects" switch (Settings → Personalization → Colors), which Glass honours (ADR-0149): with it
 * off, Windows draws Acrylic as a flat colour, so the room keeps Glass's own backdrop instead. Electron does not expose
 * the switch, so it is read from the registry with Windows' own `reg.exe`, once at start and again when the system's
 * colours change. Anything unreadable counts as on, as a fresh Windows install has it.
 */
export const PERSONALIZE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'

/** `EnableTransparency    REG_DWORD    0x0` is off; any other value, or none, is on. */
export function transparencyEffectsFrom(output: string): boolean {
  const match = /EnableTransparency\s+REG_DWORD\s+0x([0-9a-f]+)/iu.exec(output)
  return match === null || Number.parseInt(match[1]!, 16) !== 0
}

type ExecFile = (file: string, args: readonly string[], callback: (error: Error | null, stdout: string) => void) => void

const runReg: ExecFile = (file, args, callback) => {
  execFile(file, [...args], { windowsHide: true, timeout: 5_000 }, (error, stdout) => callback(error, String(stdout)))
}

export function readTransparencyEffects(run: ExecFile = runReg): Promise<boolean> {
  return new Promise(resolve => {
    run('reg', ['query', PERSONALIZE_KEY, '/v', 'EnableTransparency'], (error, stdout) => resolve(error === null ? transparencyEffectsFrom(stdout) : true))
  })
}
