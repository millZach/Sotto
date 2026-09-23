import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * Every ssh Sotto starts is an ordinary child process with pipes. Prompts reach the user through
 * SSH_ASKPASS (`sshAskpass.ts`), so nothing needs a terminal.
 */
export type SpawnSsh = (file: string, args: readonly string[], options: { readonly env: NodeJS.ProcessEnv; readonly stdin: 'pipe' | 'ignore' }) => ChildProcess

export const spawnSsh: SpawnSsh = (file, args, options) =>
  spawn(file, [...args], { env: options.env, stdio: [options.stdin, 'pipe', 'pipe'], shell: false, windowsHide: true })

/**
 * Multiplexing off on every spawn, whatever the user's configuration says, so the process Sotto watches
 * is the connection it depends on and a shared master cannot outlive or detach it (T3 Code's tunnel.ts).
 */
export const CONTROL_OPTIONS: readonly string[] = ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no']

/**
 * Windows' own OpenSSH, not whichever ssh comes first on PATH: Git Bash puts its own MSYS build there,
 * which the askpass helper was not built for. SSH_ASKPASS_REQUIRE needs OpenSSH 8.4 or later (ADR-0025).
 */
export function sshExecutable(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform !== 'win32') return 'ssh'
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const system = win32.join(root, 'System32', 'OpenSSH', 'ssh.exe')
  return existsSync(system) ? system : 'ssh.exe'
}
