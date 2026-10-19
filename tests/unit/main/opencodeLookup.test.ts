// @vitest-environment node
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findCli, findClis, resetCliLookup, withCliPath } from '../../../src/main/agents/cliLookup'
import { acceptOpenCode, isOpenCodeStandIn, opencodeMorePlaces, opencodeProgramPackages, parseRegistryPath, type OpenCodeLookupOptions } from '../../../src/main/agents/opencodeLookup'
import { chooseOpenCode, findOpenCodeExecutable, OPENCODE_VERSION_TIMEOUT_MS, rememberOpenCodeChoice, resetOpenCodeChoice } from '../../../src/main/agents/opencodeServer'
import { detectClientInstall } from '../../../src/main/agents/providerClients'

/**
 * Where Sotto finds OpenCode 2 (ADR-0087) over fake folders. The platform and processor are given, so the Windows,
 * macOS and Linux layouts are all checked on every runner. Nothing here reads the real registry or the real PATH, but
 * the shared order searches Homebrew's and the system's own folders by their real paths, so the macOS and Linux cases
 * are skipped on a computer that has OpenCode in one of them.
 */
let root: string, home: string, empty: string
beforeEach(async () => {
  resetCliLookup(); resetOpenCodeChoice()
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-opencode-lookup-')))
  home = join(root, 'home'); empty = join(root, 'empty')
  await mkdir(home, { recursive: true }); await mkdir(empty, { recursive: true })
})
afterEach(async () => { resetCliLookup(); resetOpenCodeChoice(); await rm(root, { recursive: true, force: true }) })

const MZ = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0])
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])
/** What `@opencode/cli@2.0.32` ships in `bin/opencode.exe` until its install script runs. */
const STAND_IN = 'echo "Error: @opencode/cli\'s postinstall script was not run." >&2\necho "" >&2\necho "This occurs when installation scripts are disabled." >&2\necho "Run the package manager\'s install again with scripts enabled." >&2\nexit 1\n'
/** npm's `.cmd` launcher for `@opencode/cli`, byte for byte. */
const NPM_CMD = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*\r\n'

async function file(path: string, contents: Buffer | string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  await chmod(path, 0o755)
  return path
}
const nothing = { MISE_DATA_DIR: '' }
/** No mise, no login shell, no registry and nothing on PATH, whatever the developer's machine has. */
function options(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv = {}, extra: Partial<OpenCodeLookupOptions> = {}): { environment: NodeJS.ProcessEnv; lookup: OpenCodeLookupOptions } {
  return {
    environment: { PATH: empty, MISE_DATA_DIR: join(root, 'no-mise'), ...environment },
    lookup: { home, platform, arch: 'x64', loginShellPath: async () => undefined, registryPath: async () => [], ...extra },
  }
}
async function find(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv = {}, extra: Partial<OpenCodeLookupOptions> = {}): Promise<string | undefined> {
  const { environment: env, lookup } = options(platform, environment, extra)
  return findOpenCodeExecutable(env, lookup)
}
const channel = async (executable: string | undefined) => detectClientInstall('opencode', executable, { MISE_DATA_DIR: join(root, 'no-mise') })

describe('finding OpenCode 2 on Windows', () => {
  it('follows npm\'s .cmd launcher to the program it starts, and never starts the launcher', async () => {
    const npm = join(home, 'AppData', 'Roaming', 'npm')
    await file(join(npm, 'opencode.cmd'), NPM_CMD)
    await file(join(npm, 'opencode'), '#!/bin/sh\nexec "$basedir/node_modules/@opencode/cli/bin/opencode.exe"   "$@"\n')
    const program = await file(join(npm, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'), MZ)
    await writeFile(join(npm, 'node_modules', '@opencode', 'cli', 'package.json'), '{}')
    const found = await find('win32', { APPDATA: join(home, 'AppData', 'Roaming') })
    expect(found).toBe(program)
    expect(await channel(found)).toEqual({ channel: 'npm' })
  })

  it('passes over the stand-in an install without scripts leaves, for the program package npm nested inside it', async () => {
    const npm = join(home, 'AppData', 'Roaming', 'npm')
    await file(join(npm, 'opencode.cmd'), NPM_CMD)
    const cli = join(npm, 'node_modules', '@opencode', 'cli')
    await file(join(cli, 'bin', 'opencode.exe'), STAND_IN); await writeFile(join(cli, 'package.json'), '{}')
    await file(join(cli, 'node_modules', '@opencode', 'cli-windows-x64-baseline', 'bin', 'opencode.exe'), MZ)
    const program = await file(join(cli, 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe'), MZ)
    const found = await find('win32', { APPDATA: join(home, 'AppData', 'Roaming') })
    expect(found).toBe(program)
    expect(await channel(found)).toEqual({ channel: 'npm' })
  })

  it('takes the ARM64 program package on Windows ARM, and the x64 one only when it is all there is', async () => {
    const cli = join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@opencode', 'cli')
    await file(join(cli, 'bin', 'opencode.exe'), STAND_IN)
    const x64 = await file(join(cli, 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe'), MZ)
    const environment = { APPDATA: join(home, 'AppData', 'Roaming') }
    expect(await find('win32', environment, { arch: 'arm64' })).toBe(x64)
    resetCliLookup()
    const arm = await file(join(cli, 'node_modules', '@opencode', 'cli-windows-arm64', 'bin', 'opencode.exe'), MZ)
    expect(await find('win32', environment, { arch: 'arm64' })).toBe(arm)
  })

  it('follows the install script\'s opencode2.cmd, and finds the opencode2 name', async () => {
    const folder = join(root, 'tools')
    await file(join(folder, 'opencode2.cmd'), '@echo off\r\n"%~dp0..\\opencode-2\\opencode.exe" %*\r\n')
    const program = await file(join(root, 'opencode-2', 'opencode.exe'), MZ)
    expect(await find('win32', { PATH: folder })).toBe(program)
    resetCliLookup()
    const named = await file(join(root, 'named', 'opencode2.exe'), MZ)
    expect(await find('win32', { PATH: join(root, 'named') })).toBe(named)
  })

  it('never takes a launcher whose program is missing, a stand-in, or not a program at all', async () => {
    const folder = join(root, 'tools')
    await file(join(folder, 'opencode.cmd'), '@echo off\r\n"%~dp0missing\\opencode.exe" %*\r\n')
    await file(join(folder, 'opencode2.cmd'), '@echo off\r\n"%~dp0script\\opencode.exe" %*\r\n')
    await file(join(folder, 'script', 'opencode.exe'), '#!/bin/sh\necho hello\n')
    await file(join(folder, 'opencode2.exe'), STAND_IN)
    expect(await find('win32', { PATH: folder })).toBeUndefined()
  })

  it('passes over bun\'s Windows launcher for the program in bun\'s global packages', async () => {
    const bun = join(home, '.bun')
    await file(join(bun, 'bin', 'opencode.exe'), MZ)
    await file(join(bun, 'bin', 'opencode.bunx'), 'bun\'s own record of the package')
    const cli = join(bun, 'install', 'global', 'node_modules', '@opencode', 'cli')
    await file(join(cli, 'bin', 'opencode.exe'), STAND_IN)
    const program = await file(join(cli, 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe'), MZ)
    const found = await find('win32', { PATH: join(bun, 'bin') })
    expect(found).toBe(program)
    expect(await channel(found)).toEqual({ channel: 'unknown' })
  })

  it('never follows a launcher to a network path', async () => {
    const folder = join(root, 'tools')
    await file(join(folder, 'opencode.cmd'), '@echo off\r\n"\\\\server\\share\\opencode.exe" %*\r\n')
    await file(join(folder, 'opencode2.exe'), MZ)
    await file(join(folder, 'opencode2.shim'), 'path = "\\\\server\\share\\opencode.exe"\r\n')
    expect(await find('win32', { PATH: folder })).toBeUndefined()
  })

  it('follows a scoop shim to its app, which scoop updates', async () => {
    const scoop = join(home, 'scoop')
    const program = await file(join(scoop, 'apps', 'opencode2', 'current', 'opencode.exe'), MZ)
    await file(join(scoop, 'shims', 'opencode.exe'), MZ)
    await file(join(scoop, 'shims', 'opencode.shim'), `path = "${program}"\r\n`)
    const found = await find('win32')
    expect(found).toBe(program)
    expect(await channel(found)).toEqual({ channel: 'unknown', byHand: ['scoop update opencode2'] })
    resetCliLookup()
    // Under $SCOOP, and with scoop's own app folder when it has no shim.
    const own = await file(join(root, 'tools', 'scoop', 'apps', 'opencode2', 'current', 'opencode.exe'), MZ)
    await rm(scoop, { recursive: true })
    expect(await find('win32', { SCOOP: join(root, 'tools', 'scoop') })).toBe(own)
  })

  it('finds a client installed after Sotto started, on Windows\' own PATH', async () => {
    const folder = join(root, 'Programs', 'OpenCode')
    const program = await file(join(folder, 'opencode.exe'), MZ)
    expect(await find('win32')).toBeUndefined()
    resetCliLookup()
    expect(await find('win32', {}, { registryPath: async () => [folder] })).toBe(program)
  })

  it('finds pnpm\'s copy in its store when the stand-in is all its launcher reaches, and leaves it to pnpm', async () => {
    const pnpm = join(home, 'AppData', 'Local', 'pnpm')
    await file(join(pnpm, 'opencode.cmd'), '@SETLOCAL\r\n@"%~dp0\\global\\5\\node_modules\\@opencode\\cli\\bin\\opencode.exe" %*\r\n')
    await file(join(pnpm, 'global', '5', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'), STAND_IN)
    const program = await file(join(pnpm, 'global', '5', 'node_modules', '.pnpm', '@opencode+cli-windows-x64@2.0.32', 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe'), MZ)
    const found = await find('win32', { LOCALAPPDATA: join(home, 'AppData', 'Local') })
    expect(found).toBe(program)
    expect(await channel(found)).toEqual({ channel: 'unknown' })
  })

  it('leaves a copy under bun\'s or pnpm\'s own folder to that tool wherever its variable puts it', async () => {
    const bun = join(root, 'tools', 'bun-custom')
    const cli = join(bun, 'install', 'global', 'node_modules', '@opencode', 'cli')
    const program = await file(join(cli, 'bin', 'opencode.exe'), MZ); await writeFile(join(cli, 'package.json'), '{}')
    const found = await find('win32', { BUN_INSTALL: bun })
    expect(found).toBe(program)
    expect(await detectClientInstall('opencode', found, { MISE_DATA_DIR: join(root, 'no-mise'), BUN_INSTALL: bun })).toEqual({ channel: 'unknown' })
    expect(await detectClientInstall('opencode', found, { MISE_DATA_DIR: join(root, 'no-mise'), PNPM_HOME: join(root, 'tools') })).toEqual({ channel: 'unknown' })
  })

  it('finds yarn\'s global copy, and leaves it to yarn', async () => {
    const local = join(home, 'AppData', 'Local')
    const cli = join(local, 'Yarn', 'Data', 'global', 'node_modules', '@opencode', 'cli')
    const program = await file(join(cli, 'bin', 'opencode.exe'), MZ); await writeFile(join(cli, 'package.json'), '{}')
    const found = await find('win32', { LOCALAPPDATA: local })
    expect(found).toBe(program)
    expect(await channel(found)).toEqual({ channel: 'unknown' })
  })

  it('lists the places after the shared order: Windows\' PATH, bun, pnpm, yarn, scoop, WinGet, then Chocolatey', async () => {
    await mkdir(join(home, 'AppData', 'Local', 'pnpm', 'global', '5'), { recursive: true })
    const local = join(home, 'AppData', 'Local')
    const places = await opencodeMorePlaces({ LOCALAPPDATA: local, ProgramData: join(root, 'ProgramData'), ProgramFiles: join(root, 'Program Files') }, home, 'win32', async () => [join(root, 'new')])
    expect(places).toEqual([
      join(root, 'new'),
      join(home, '.bun', 'bin'), join(home, '.bun', 'install', 'global', 'node_modules'),
      join(local, 'pnpm'), join(local, 'pnpm', 'global', '5', 'node_modules'),
      join(local, 'Yarn', 'bin'), join(local, 'Yarn', 'Data', 'global', 'node_modules'),
      join(home, 'scoop', 'shims'), join(home, 'scoop', 'apps', 'opencode2', 'current'),
      join(root, 'ProgramData', 'scoop', 'shims'), join(root, 'ProgramData', 'scoop', 'apps', 'opencode2', 'current'),
      join(local, 'Microsoft', 'WinGet', 'Links'), join(root, 'Program Files', 'WinGet', 'Links'),
      join(root, 'ProgramData', 'chocolatey', 'bin'),
    ])
  })

  it('reads Windows\' PATH from reg.exe\'s answer, expanding its variables and dropping what it cannot', () => {
    const user = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.opencode\\bin;%APPDATA%\\npm;;%NOT_SET%\\bin;\\\\server\\share\\bin;"C:\\Quoted Folder"\r\n\r\n'
    const machine = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_SZ    C:\\Windows\\system32;relative\\folder\r\n'
    const folders = parseRegistryPath([user, machine], { userprofile: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })
    expect(folders).toEqual(['C:\\Users\\me\\.opencode\\bin', 'C:\\Users\\me\\AppData\\Roaming\\npm', 'C:\\Quoted Folder', 'C:\\Windows\\system32'])
  })

  it('expands Windows\' PATH with the variables the registry holds now, which an installer may have set since Sotto started', () => {
    const user = '\r\nHKEY_CURRENT_USER\\Environment\r\n    PNPM_HOME    REG_EXPAND_SZ    %LOCALAPPDATA%\\pnpm\r\n    TOOLS    REG_SZ    D:\\New Tools\r\n    Path    REG_EXPAND_SZ    %PNPM_HOME%;%TOOLS%\\bin\r\n'
    const machine = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    TOOLS    REG_SZ    C:\\Machine Tools\r\n    Path    REG_EXPAND_SZ    %TOOLS%\\sbin\r\n'
    // Sotto started before PNPM_HOME was set, and with an older TOOLS: the account's registry value wins over both.
    const folders = parseRegistryPath([user, machine], { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', TOOLS: 'C:\\Old Tools' })
    expect(folders).toEqual(['C:\\Users\\me\\AppData\\Local\\pnpm', 'D:\\New Tools\\bin', 'D:\\New Tools\\sbin'])
  })
})

/** The system folders the shared order searches before the places these fixtures sit in. */
const systemOpenCode = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/usr/bin']
  .some(folder => existsSync(join(folder, 'opencode')) || existsSync(join(folder, 'opencode2')))

describe.skipIf(systemOpenCode)('finding OpenCode 2 on macOS and Linux', () => {
  it('finds bun\'s global copy through its program package, and leaves it to bun', async () => {
    const cli = join(home, '.bun', 'install', 'global', 'node_modules', '@opencode', 'cli')
    await file(join(cli, 'bin', 'opencode.exe'), STAND_IN)
    const program = await file(join(cli, 'node_modules', '@opencode', 'cli-linux-x64', 'bin', 'opencode'), ELF)
    const found = await find('linux')
    expect(found).toBe(program)
    expect(await channel(found)).toEqual({ channel: 'unknown' })
    // bun's own link to the stand-in is followed to the same package.
    resetCliLookup()
    try { await mkdir(join(home, '.bun', 'bin'), { recursive: true }); await symlink(join(cli, 'bin', 'opencode.exe'), join(home, '.bun', 'bin', 'opencode')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error }
    expect(await find('linux')).toBe(program)
  })

  it('finds the program package npm hoisted beside the stand-in, under the prefix\'s lib', async () => {
    const prefix = join(root, 'npm-prefix')
    const scope = join(prefix, 'lib', 'node_modules', '@opencode')
    await file(join(scope, 'cli', 'bin', 'opencode.exe'), STAND_IN); await writeFile(join(scope, 'cli', 'package.json'), '{}')
    const program = await file(join(scope, 'cli-darwin-arm64', 'bin', 'opencode'), ELF)
    await mkdir(join(prefix, 'bin'), { recursive: true })
    const found = await find('darwin', { npm_config_prefix: prefix }, { arch: 'arm64' })
    expect(found).toBe(program)
    expect(await channel(found)).toEqual({ channel: 'npm' })
  })

  it('follows pnpm\'s sh launcher to pnpm\'s store, and never takes the launcher', async () => {
    const pnpm = join(home, '.local', 'share', 'pnpm')
    await file(join(pnpm, 'opencode'), '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nexec "$basedir/global/5/node_modules/@opencode/cli/bin/opencode.exe" "$@"\n')
    await file(join(pnpm, 'global', '5', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'), STAND_IN)
    const program = await file(join(pnpm, 'global', '5', 'node_modules', '.pnpm', '@opencode+cli-linux-x64@2.0.32', 'node_modules', '@opencode', 'cli-linux-x64', 'bin', 'opencode'), ELF)
    const found = await find('linux')
    expect(found).toBe(program)
    expect(await channel(found)).toEqual({ channel: 'unknown' })
  })

  it('takes a musl program package when it is the only one', async () => {
    const cli = join(home, '.bun', 'install', 'global', 'node_modules', '@opencode', 'cli')
    await file(join(cli, 'bin', 'opencode.exe'), STAND_IN)
    const program = await file(join(cli, 'node_modules', '@opencode', 'cli-linux-x64-musl', 'bin', 'opencode'), ELF)
    expect(await find('linux')).toBe(program)
    expect(opencodeProgramPackages('linux', 'arm64')).toEqual(['cli-linux-arm64', 'cli-linux-arm64-baseline', 'cli-linux-arm64-musl', 'cli-linux-arm64-baseline-musl'])
    expect(opencodeProgramPackages('darwin', 'arm64')).toEqual(['cli-darwin-arm64', 'cli-darwin-arm64-baseline'])
    expect(opencodeProgramPackages('win32', 'arm64')).toEqual(['cli-windows-arm64', 'cli-windows-arm64-baseline', 'cli-windows-x64', 'cli-windows-x64-baseline'])
  })

  it('finds the nix profile\'s copy and the opencode2 name', async () => {
    const program = await file(join(home, '.nix-profile', 'bin', 'opencode2'), ELF)
    expect(await find('linux')).toBe(program)
  })

  it('lists the places after the shared order: bun, pnpm, yarn, the nix profiles, then the system folders', async () => {
    expect(await opencodeMorePlaces({ USER: 'me' }, home, 'linux', async () => { throw new Error('Not on Windows') })).toEqual([
      join(home, '.bun', 'bin'), join(home, '.bun', 'install', 'global', 'node_modules'),
      join(home, 'Library', 'pnpm'), join(home, '.local', 'share', 'pnpm'),
      join(home, '.yarn', 'bin'), join(home, '.config', 'yarn', 'global', 'node_modules'),
      join(home, '.nix-profile', 'bin'), '/etc/profiles/per-user/me/bin', '/run/current-system/sw/bin', '/nix/var/nix/profiles/default/bin',
      '/usr/bin', '/usr/local/bin',
    ])
  })

  it('knows the stand-in by what it says, and only a small file can be it', async () => {
    expect(await isOpenCodeStandIn(await file(join(root, 'stand-in'), STAND_IN))).toBe(true)
    expect(await isOpenCodeStandIn(await file(join(root, 'big'), STAND_IN + ' '.repeat(8 * 1024)))).toBe(false)
    expect(await isOpenCodeStandIn(await file(join(root, 'program'), ELF))).toBe(false)
    expect(await acceptOpenCode(join(root, 'stand-in'), 'linux', 'x64')).toBeUndefined()
  })
})

describe('choosing OpenCode 2 over an OpenCode 1 met first', () => {
  /** WinGet's OpenCode 1 on PATH ahead of scoop's OpenCode 2. */
  async function twoClients(): Promise<{ old: string; current: string; env: ReturnType<typeof options> }> {
    const old = await file(join(root, 'WinGet', 'Links', 'opencode.exe'), MZ)
    const scoop = join(home, 'scoop')
    const current = await file(join(scoop, 'apps', 'opencode2', 'current', 'opencode.exe'), MZ)
    await file(join(scoop, 'shims', 'opencode2.exe'), MZ)
    await file(join(scoop, 'shims', 'opencode2.shim'), `path = "${current}"\r\n`)
    return { old, current, env: options('win32', { PATH: join(root, 'WinGet', 'Links') }) }
  }

  it('asks each client found until one is an OpenCode 2 Sotto drives, the first for a full read and the rest for one between them', async () => {
    const { old, current, env } = await twoClients()
    const asked: { executable: string; timeoutMs: number }[] = []
    const read = async (executable: string, timeoutMs: number) => { asked.push({ executable, timeoutMs }); return executable === old ? '1.19.1' : 'opencode v2.0.32' }
    expect(await chooseOpenCode(read, env.environment, env.lookup)).toEqual({ executable: current, said: 'opencode v2.0.32' })
    expect(asked.map(entry => entry.executable)).toEqual([old, current])
    expect(asked[0]!.timeoutMs).toBe(OPENCODE_VERSION_TIMEOUT_MS)
    expect(asked[1]!.timeoutMs).toBeGreaterThan(0)
    expect(asked[1]!.timeoutMs).toBeLessThanOrEqual(OPENCODE_VERSION_TIMEOUT_MS)
  })

  it('stops asking once the connect that asked is gone', async () => {
    const { old, env } = await twoClients()
    const asked: string[] = []
    let gone = false
    const read = async (executable: string) => { asked.push(executable); gone = true; return '1.19.1' }
    expect(await chooseOpenCode(read, env.environment, env.lookup, () => gone)).toEqual({ executable: old, said: '1.19.1' })
    expect(asked).toEqual([old])
  })

  it('answers presence and the update check with the client connect chose while it is there, for the home it was found in', async () => {
    const { old, current, env } = await twoClients()
    expect(await findOpenCodeExecutable(env.environment, env.lookup)).toBe(old)
    rememberOpenCodeChoice(current, env.lookup)
    expect(await findOpenCodeExecutable(env.environment, env.lookup)).toBe(current)
    expect(await findOpenCodeExecutable(env.environment, { ...env.lookup, home: empty })).toBe(old)
    rememberOpenCodeChoice(undefined)
    expect(await findOpenCodeExecutable(env.environment, env.lookup)).toBe(old)
    rememberOpenCodeChoice(current, env.lookup)
    await rm(current)
    expect(await findOpenCodeExecutable(env.environment, env.lookup)).toBe(old)
  })

  it('offers the next build of a program package when the first will not run here', async () => {
    const cli = join(home, '.bun', 'install', 'global', 'node_modules', '@opencode', 'cli')
    await file(join(cli, 'bin', 'opencode.exe'), STAND_IN)
    const plain = await file(join(cli, 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe'), MZ)
    const baseline = await file(join(cli, 'node_modules', '@opencode', 'cli-windows-x64-baseline', 'bin', 'opencode.exe'), MZ)
    // A hoisted plain build still comes before the nested baseline one: the build matters more than where it sits.
    const hoisted = await file(join(dirname(cli), 'cli-windows-x64', 'bin', 'opencode.exe'), MZ)
    const env = options('win32')
    const asked: string[] = []
    const read = async (executable: string) => { asked.push(executable); return executable === baseline ? 'opencode v2.0.32' : undefined }
    expect(await chooseOpenCode(read, env.environment, env.lookup)).toEqual({ executable: baseline, said: 'opencode v2.0.32' })
    expect(asked).toEqual([plain, hoisted, baseline])
  })

  it('starts a later build with its own folder on PATH, as it does the first', async () => {
    const cli = join(home, '.bun', 'install', 'global', 'node_modules', '@opencode', 'cli')
    await file(join(cli, 'bin', 'opencode.exe'), STAND_IN)
    await file(join(cli, 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe'), MZ)
    const baseline = await file(join(cli, 'node_modules', '@opencode', 'cli-windows-x64-baseline', 'bin', 'opencode.exe'), MZ)
    const env = options('win32')
    const chosen = await chooseOpenCode(async executable => executable === baseline ? 'opencode v2.0.32' : undefined, env.environment, env.lookup)
    expect(chosen?.executable).toBe(baseline)
    expect(withCliPath({ PATH: empty }, baseline).PATH!.split(delimiter)[0]).toBe(dirname(baseline))
  })

  it('offers the program packages after a program the install script copied, when that copy will not run here', async () => {
    const cli = join(home, '.bun', 'install', 'global', 'node_modules', '@opencode', 'cli')
    const copied = await file(join(cli, 'bin', 'opencode.exe'), MZ)
    const baseline = await file(join(cli, 'node_modules', '@opencode', 'cli-windows-x64-baseline', 'bin', 'opencode.exe'), MZ)
    const env = options('win32')
    const asked: string[] = []
    const read = async (executable: string) => { asked.push(executable); return executable === baseline ? 'opencode v2.0.32' : undefined }
    expect(await chooseOpenCode(read, env.environment, env.lookup)).toEqual({ executable: baseline, said: 'opencode v2.0.32' })
    expect(asked).toEqual([copied, baseline])
    // Presence still takes the copy, and asks nothing further.
    expect(await findOpenCodeExecutable(env.environment, env.lookup)).toBe(copied)
  })

  it('keeps asking past any number of refused clients while there is time', async () => {
    const folders = Array.from({ length: 10 }, (_, index) => join(root, `old-${index}`))
    await Promise.all(folders.slice(0, 9).map(folder => file(join(folder, 'opencode.exe'), MZ)))
    const current = await file(join(folders[9]!, 'opencode.exe'), MZ)
    const env = options('win32', { PATH: folders.join(delimiter) })
    const chosen = await chooseOpenCode(async executable => executable === current ? 'opencode v2.0.32' : '1.19.1', env.environment, env.lookup)
    expect(chosen).toEqual({ executable: current, said: 'opencode v2.0.32' })
  })

  it('answers with the build a remembered client leads to now, when an update left the stand-in in its place', async () => {
    const cli = join(home, '.bun', 'install', 'global', 'node_modules', '@opencode', 'cli')
    const copied = await file(join(cli, 'bin', 'opencode.exe'), MZ)
    const plain = await file(join(cli, 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe'), MZ)
    const env = options('win32')
    rememberOpenCodeChoice(copied, env.lookup)
    await writeFile(copied, STAND_IN)
    expect(await findOpenCodeExecutable(env.environment, env.lookup)).toBe(plain)
  })

  it('asks only the first when it will do', async () => {
    const { old, env } = await twoClients()
    const asked: string[] = []
    expect(await chooseOpenCode(async executable => { asked.push(executable); return 'opencode v2.0.40' }, env.environment, env.lookup)).toEqual({ executable: old, said: 'opencode v2.0.40' })
    expect(asked).toEqual([old])
  })

  it('refuses with the first client\'s answer when none is an OpenCode 2 Sotto drives', async () => {
    const { old, env } = await twoClients()
    const said = (executable: string) => executable === old ? '1.19.1' : 'opencode v2.0.30'
    expect(await chooseOpenCode(async executable => said(executable), env.environment, env.lookup)).toEqual({ executable: old, said: '1.19.1' })
    expect(await chooseOpenCode(async () => { throw new Error('did not start') }, env.environment, env.lookup)).toEqual({ executable: old, said: undefined })
    const none = options('win32', {}, { home: empty })
    expect(await chooseOpenCode(async () => '2.0.32', none.environment, none.lookup)).toBeUndefined()
  })
})

describe('the shared lookup the other providers use', () => {
  it('hands over every client in order, and findCli still answers with the first', async () => {
    const first = await file(join(root, 'a', 'tool'), ELF)
    const second = await file(join(root, 'b', 'tool'), ELF)
    const lookup = { home, platform: 'linux' as const, loginShellPath: async () => undefined, environment: { PATH: [join(root, 'a'), join(root, 'b')].join(delimiter), ...nothing } }
    const all: string[] = []
    for await (const found of findClis({ name: 'tool', last: async () => [join(root, 'c')] }, lookup)) all.push(found)
    expect(all).toEqual([first, second])
    let lastRead = false
    expect(await findCli({ name: 'tool', last: async () => { lastRead = true; return [] } }, lookup)).toBe(first)
    expect(lastRead).toBe(false)
  })
})
