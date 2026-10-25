/**
 * A saved host's SSH settings and how they are read. The headless host builds this module (its launch script quotes with
 * it), so it has no Lingui macros; the checks that refuse in the interface language are in `sshHostValidation.ts`.
 */
export interface SshHostConfiguration {
  readonly target: string
  readonly identityFile?: string
  /** Extracted release directory, containing host/index.js. */
  readonly installPath: string
  readonly dataDirectory?: string
  readonly remotePort?: number
  readonly sshPort?: number
}
export interface ValidatedSshHostConfiguration {
  readonly target: string
  readonly identityFile?: string
  readonly installPath: string
  readonly dataDirectory: string
  readonly remotePort: number
  readonly sshPort?: number
}

/** Where the user's SSH configuration says a target goes, read from `ssh -G`. */
export interface SshRoute {
  readonly hostname: string
  readonly user?: string
  readonly port?: number
  readonly identityFiles: readonly string[]
}
/**
 * Reads `ssh -G` output: one lowercase key and its value per line, the first value winning as it does in
 * OpenSSH. A target the configuration does not rename keeps its own name.
 */
export function parseSshResolution(target: string, stdout: string): SshRoute {
  const values = new Map<string, string>(), identityFiles: string[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(\S+)\s+(.+)$/u.exec(line.trim())
    if (!match) continue
    const key = match[1]!.toLowerCase(), value = match[2]!.trim()
    if (key === 'identityfile') identityFiles.push(value)
    else if (!values.has(key)) values.set(key, value)
  }
  const port = Number(values.get('port'))
  const user = values.get('user')
  return { hostname: values.get('hostname') || target.split('@').at(-1)!,
    ...(user ? { user } : {}), ...(Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}), identityFiles }
}

/** OpenSSH passes its remote command through the account's shell even though local spawn has no shell. */
export const quoteRemoteArgument = (value: string): string => `'${value.replace(/'/gu, "'\\''")}'`
