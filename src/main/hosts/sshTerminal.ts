import { Buffer } from 'node:buffer'
import { CONTROL_OPTIONS } from './sshProcess'

/** A saved host, as a shell over SSH reaches it. */
export interface SshTerminalHost {
  readonly target: string
  readonly identityFile?: string | undefined
  readonly sshPort?: number | undefined
}

/**
 * How long a shell over SSH waits on a silent connection: four misses, 15 seconds apart, so a dead connection ends the
 * shell in about a minute rather than hanging it, and a laptop that wakes on the same connection carries on (ADR-0183).
 */
const KEEPALIVE_SECONDS = 15
const KEEPALIVES = 4

const windowsFolder = (folder: string): boolean => /^[A-Za-z]:[\\/]/u.test(folder)
const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

/**
 * What the account's own login shell runs. Each folder travels as base64 and the whole is one single-quoted word for
 * `sh`, so bash, zsh and fish all read it alike and nothing in a folder's name can be read as shell. A `cd` that fails
 * moves on to the next folder, and then the shell starts wherever it is. A folder written the Windows way has no `sh`.
 */
export function remoteShellCommand(folders: readonly string[]): string {
  if (folders.some(windowsFolder)) {
    const script = [...folders.map(folder => `if (Test-Path -LiteralPath '${folder.replaceAll("'", "''")}') { Set-Location -LiteralPath '${folder.replaceAll("'", "''")}' }`)].reverse().join('; ')
    return `powershell -NoLogo -NoExit -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
  }
  const moves = folders.map(folder => `cd -- "$(printf %s ${base64(folder)} | base64 -d)" 2>/dev/null`).join(' || ')
  return `sh -c '${moves ? `${moves}; ` : ''}export COLORTERM=truecolor TERM_PROGRAM=Sotto; exec "\${SHELL:-/bin/sh}" -l'`
}

/**
 * The arguments of a shell over SSH (ADR-0183). OpenSSH keeps the user's configuration and asks for anything it needs in
 * the terminal itself, so unlike the launcher's ssh this one has no askpass. `RemoteCommand` would refuse a command given
 * here, `-e none` leaves a typed `~` to the shell, and multiplexing is off as on every ssh Sotto starts. The target comes
 * after `--`, from a saved host, never from the window.
 */
export function sshTerminalArguments(host: SshTerminalHost, folders: readonly string[]): string[] {
  return ['-tt', '-o', 'BatchMode=no', '-o', 'ConnectTimeout=15', '-o', `ServerAliveInterval=${KEEPALIVE_SECONDS}`, '-o', `ServerAliveCountMax=${KEEPALIVES}`,
    '-o', 'RemoteCommand=none', '-e', 'none', ...CONTROL_OPTIONS,
    ...(host.identityFile ? ['-i', host.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
    ...(host.sshPort ? ['-p', String(host.sshPort)] : []),
    '--', host.target, remoteShellCommand(folders)]
}
