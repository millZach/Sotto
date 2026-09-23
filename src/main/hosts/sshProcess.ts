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

export interface OpenSshVersion { readonly major: number; readonly minor: number; readonly text: string }
/** SSH_ASKPASS_REQUIRE, which every prompt depends on, arrived in OpenSSH 8.4 (ADR-0025). */
export const MINIMUM_OPENSSH = { major: 8, minor: 4 } as const
/**
 * The version `ssh -V` prints ("OpenSSH_9.6p1 Ubuntu-3ubuntu13.19, OpenSSL ..." or
 * "OpenSSH_for_Windows_9.5p2, LibreSSL ..."), or undefined when it names none.
 */
export function openSshVersion(output: string): OpenSshVersion | undefined {
  const match = /OpenSSH(?:_for_Windows)?_(\d{1,3})\.(\d{1,3})(p\d{1,3})?/u.exec(output)
  return match ? { major: Number(match[1]), minor: Number(match[2]), text: `${match[1]}.${match[2]}${match[3] ?? ''}` } : undefined
}
export function tooOld(version: OpenSshVersion): boolean {
  return version.major < MINIMUM_OPENSSH.major || (version.major === MINIMUM_OPENSSH.major && version.minor < MINIMUM_OPENSSH.minor)
}

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
