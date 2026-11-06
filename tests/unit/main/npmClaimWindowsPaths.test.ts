// @vitest-environment node
import { win32 } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Which npm package claims a Claude Code binary on Windows (#1920), with Windows paths on any machine: the detector reads
// node:path as win32, the home folder as C:\Users\Zach, and a file system that holds only the files each test writes.
const files = vi.hoisted(() => new Set<string>())
vi.mock('node:path', async () => {
  const { win32: windows } = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...windows, default: windows }
})
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => 'C:\\Users\\Zach' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const missing = (path: unknown) => Object.assign(new Error(`ENOENT: ${String(path)}`), { code: 'ENOENT' })
  return {
    ...actual,
    access: async (path: string) => { if (!files.has(path.toLowerCase())) throw missing(path) },
    realpath: async (path: string) => { throw missing(path) },
    readdir: async (path: string) => { throw missing(path) },
    readFile: async (path: string) => { throw missing(path) },
    stat: async (path: string) => { throw missing(path) },
  }
})
const { CLIENT_PACKAGES, detectClientInstall } = await import('../../../src/main/agents/providerClients')

const HOME = 'C:\\Users\\Zach', APPDATA = `${HOME}\\AppData\\Roaming`
const NATIVE = `${HOME}\\.local\\bin\\claude.exe`
/** No mise install, so only npm's layout decides. */
const NO_MISE = { MISE_DATA_DIR: `${HOME}\\no-mise` }
/** The environment Sotto reads on the laptop, with npm's prefix where a test puts it. */
const environment = (prefix?: string): NodeJS.ProcessEnv =>
  ({ APPDATA, LOCALAPPDATA: `${HOME}\\AppData\\Local`, ...prefix ? { npm_config_prefix: prefix } : {} })
/** A package npm installed under `<prefix>\node_modules`, the Windows layout. */
const leaveInstall = (prefix: string, packageName: string): void => {
  files.add(win32.join(prefix, 'node_modules', ...packageName.split('/'), 'package.json').toLowerCase())
}

describe('a Windows npm root claims only its own launcher (#1920)', () => {
  beforeEach(() => files.clear())

  it('leaves the native Claude Code to update itself, whatever prefix holds an old npm copy', async () => {
    for (const prefix of [`${APPDATA}\\npm`, HOME, `${HOME}\\.local`, `${HOME}\\lib`]) {
      files.clear(); leaveInstall(prefix, '@anthropic-ai/claude-code')
      expect(await detectClientInstall('claude', NATIVE, environment(prefix), 'win32'), prefix).toEqual({ channel: 'self-update' })
    }
  })

  it('reads npm\u2019s own launcher in its prefix as npm, under that prefix', async () => {
    const prefix = `${APPDATA}\\npm`
    leaveInstall(prefix, '@anthropic-ai/claude-code')
    for (const launcher of ['claude.cmd', 'claude.ps1', 'claude']) {
      expect(await detectClientInstall('claude', `${prefix}\\${launcher}`, environment(), 'win32'), launcher).toEqual({ channel: 'npm', npmPrefix: prefix })
    }
    const custom = `${HOME}\\tools`
    leaveInstall(custom, '@anthropic-ai/claude-code')
    expect(await detectClientInstall('claude', `${custom}\\claude.cmd`, environment(custom), 'win32')).toEqual({ channel: 'npm', npmPrefix: custom })
  })

  it('reads npm\u2019s own launcher as npm for every client npm installs, not only Claude Code', async () => {
    const prefix = `${APPDATA}\\npm`
    for (const [provider, packageName] of Object.entries(CLIENT_PACKAGES) as [Parameters<typeof detectClientInstall>[0], string][]) {
      files.clear(); leaveInstall(prefix, packageName)
      const command = provider === 'opencode' ? 'opencode' : provider === 'deepseek' ? 'dsh' : provider
      expect(await detectClientInstall(provider, `${prefix}\\${command}.cmd`, { ...environment(), ...NO_MISE }, 'win32'), provider)
        .toEqual({ channel: 'npm', npmPrefix: prefix })
    }
  })

  it('reads OpenCode\u2019s npm launcher as npm, and no other copy of it', async () => {
    const env = { ...environment(), ...NO_MISE }
    // npm's launcher in its prefix, and the package's own program, under %APPDATA%\npm and a prefix of `<x>\lib`.
    for (const prefix of [`${APPDATA}\\npm`, `${HOME}\\tools\\lib`]) {
      files.clear(); leaveInstall(prefix, '@opencode/cli')
      expect(await detectClientInstall('opencode', `${prefix}\\opencode.cmd`, env, 'win32'), prefix).toEqual({ channel: 'npm', npmPrefix: prefix })
      expect(await detectClientInstall('opencode', `${prefix}\\node_modules\\@opencode\\cli\\bin\\opencode.exe`, env, 'win32'), prefix)
        .toEqual({ channel: 'npm', npmPrefix: prefix })
    }
    // A `bin` beside `lib\node_modules` is a macOS or Linux layout: npm on Windows never puts a launcher there.
    expect(await detectClientInstall('opencode', `${HOME}\\tools\\bin\\opencode.exe`, env, 'win32')).toEqual({ channel: 'unknown' })
    // The install script's copy updates itself, whatever npm package sits in a global root.
    leaveInstall(`${APPDATA}\\npm`, '@opencode/cli')
    expect(await detectClientInstall('opencode', `${HOME}\\.opencode\\bin\\opencode.exe`, env, 'win32')).toEqual({ channel: 'self-update' })
  })

  it('still lets the npm package claim Grok Build\u2019s copy in ~\\.grok\\bin, which its install script puts there (ADR-0042)', async () => {
    leaveInstall(`${APPDATA}\\npm`, '@xai-official/grok')
    expect(await detectClientInstall('grok', `${HOME}\\.grok\\bin\\grok.exe`, environment(), 'win32')).toEqual({ channel: 'npm', npmPrefix: `${APPDATA}\\npm` })
  })
})
