import { access } from 'node:fs/promises'
import { win32 as win32Path } from 'node:path'

interface ShellDependencies {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  executableExists?: (path: string) => Promise<boolean>
}
interface ResolvedShell { readonly path: string; readonly discovered: boolean }

/** One shell rule for Terminal mode, Tools and drawers; only a discovered shell needs revalidation. */
export class TerminalShell {
  private cached: ResolvedShell | null = null
  private lookup: Promise<ResolvedShell> | null = null
  constructor(private readonly dependencies: ShellDependencies) {}

  async resolve(): Promise<string> {
    if (this.cached && (!this.cached.discovered || await this.exists(this.cached.path))) return this.cached.path
    this.cached = null
    const found = await (this.lookup ??= this.find().finally(() => { this.lookup = null }))
    this.cached = found
    return found.path
  }

  private exists(path: string): Promise<boolean> {
    const check = this.dependencies.executableExists ?? (async (target: string) => { try { await access(target); return true } catch { return false } })
    return check(path)
  }

  private async find(): Promise<ResolvedShell> {
    const platform = this.dependencies.platform ?? process.platform
    const env = this.dependencies.env ?? process.env
    if (platform !== 'win32') return { path: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), discovered: false }
    for (const entry of (env.PATH ?? env.Path ?? '').split(win32Path.delimiter).filter(Boolean)) {
      const candidate = win32Path.join(entry, 'pwsh.exe')
      if (await this.exists(candidate)) return { path: candidate, discovered: true }
    }
    return { path: win32Path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), discovered: false }
  }
}
