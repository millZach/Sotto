import type { IPtyForkOptions } from 'node-pty'

export interface SshProcess {
  write(text: string): void
  kill(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}
export type SpawnSsh = (file: string, args: string[], options: IPtyForkOptions) => SshProcess | Promise<SshProcess>

/** A local PTY lets OpenSSH read passwords and host-key answers from its real controlling terminal. */
export const spawnSsh: SpawnSsh = async (file, args, options) => {
  const pty = await import('node-pty')
  return pty.spawn(file, args, options)
}
