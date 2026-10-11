import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { CodexProcess } from './codexProcess'
import { WatcherProfileRefusal } from './watcherProfile'

export const WATCHER_SANDBOX_UNAVAILABLE = "Codex's read-only sandbox isn't working on this computer, so Watcher didn't start. Nothing was sent."
const marker = 'SOTTO_READ_ONLY_PROBE'
export const CODEX_SANDBOX_WRITE_DENIED = 'SOTTO_PROBE_WRITE_DENIED'
// Catch the native denial: app-server otherwise turns a denied command into an RPC error with no result.
export const codexSandboxWriteProbe = (file: './write.txt' | 'sentinel.txt'): string => `try { Set-Content -LiteralPath '${file}' -Value 'SOTTO_UNASKED_WRITE' -ErrorAction Stop; Write-Output 'SOTTO_PROBE_WRITE_ALLOWED' } catch { if (($_.Exception -is [System.UnauthorizedAccessException]) -and $_.Exception.HResult -eq -2147024891) { Write-Output '${CODEX_SANDBOX_WRITE_DENIED}' } else { Write-Output 'SOTTO_PROBE_WRITE_INCONCLUSIVE' } }`
const resultSchema = z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() })

/** Exercise this app-server's sandbox before it can receive a model turn. Never retain native output. */
export async function probeWatcherCodexSandbox(server: Pick<CodexProcess, 'rpc'>, project: string): Promise<void> {
  let folder: string | undefined
  let refused = false
  try {
    folder = await mkdtemp(join(project, '.sotto-sandbox-probe-'))
    await writeFile(join(folder, 'read.txt'), marker)
    const execute = async (command: string) => {
      let result: z.infer<typeof resultSchema> | undefined
      await server.rpc('command/exec', { command: ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        cwd: folder, sandboxPolicy: { type: 'readOnly' }, timeoutMs: 10_000 }, value => { result = resultSchema.parse(value) })
      if (!result) throw new Error('sandbox-probe-unconfirmed')
      return result
    }
    const read = await execute("Get-Content -LiteralPath './read.txt' -Raw -ErrorAction Stop")
    if (read.exitCode !== 0 || read.stdout.trim() !== marker) throw new Error('sandbox-probe-read-failed')
    // Set-Content works in Constrained Language mode. A forbidden .NET call would not test filesystem enforcement.
    const write = await execute(codexSandboxWriteProbe('./write.txt'))
    const absent = await readFile(join(folder, 'write.txt')).then(() => false, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    })
    if (write.exitCode !== 0 || write.stdout.trim() !== CODEX_SANDBOX_WRITE_DENIED || !absent) throw new Error('sandbox-probe-write-not-refused')
  } catch {
    refused = true
  } finally {
    // Only our two known probe files are removed; never recursively remove anything in the project.
    if (folder) {
      try { await rm(join(folder, 'write.txt'), { force: true }); await rm(join(folder, 'read.txt'), { force: true }); await rmdir(folder) }
      catch { refused = true }
    }
  }
  if (refused) throw new WatcherProfileRefusal(WATCHER_SANDBOX_UNAVAILABLE)
}
