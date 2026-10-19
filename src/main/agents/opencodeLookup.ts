import { spawn } from 'node:child_process'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, win32 } from 'node:path'
import { executableFile, findClis, newestFirst, type CliLookupOptions } from './cliLookup'

/**
 * Where Sotto looks for OpenCode 2 (ADR-0087): the shared CLI lookup (ADR-0036) with `~/.opencode/bin` first, taught
 * every way OpenCode 2 is installed, so it is found however it got there.
 *
 * - Both names, `opencode` and the `opencode2` every OpenCode 2 installer also gives it.
 * - A launcher is followed to the program it starts and never started itself: npm's, pnpm's and yarn's `.cmd` and
 *   `sh` launchers, and scoop's shims, which name their program in a `.shim` file beside them.
 * - npm's `@opencode/cli` package holds a stand-in program until its install script copies the real one over it.
 *   pnpm and bun skip that script by default, so the stand-in is never the client: the lookup goes on to the program
 *   package for this computer (`@opencode/cli-<os>-<arch>`), nested inside the package, beside it, or in pnpm's store.
 * - After the shared order: Windows' own PATH as it is now (an install made after Sotto started is on it), then bun,
 *   pnpm, yarn, scoop, WinGet, Chocolatey, the nix profiles, `/usr/bin` and `/usr/local/bin`.
 *
 * Several OpenCodes can be on one computer, and winget, Chocolatey and nixpkgs give OpenCode 1: the candidates come
 * in order and connect takes the first that reports a supported OpenCode 2 (`chooseOpenCode`). Nothing here logs, and
 * nothing it reads is started: a path can name the user.
 */
export interface OpenCodeLookupOptions extends Omit<CliLookupOptions, 'environment'> {
  /** The folders on Windows' own PATH, the account's and the machine's, as they are now. Read from the registry by default. */
  readonly registryPath?: () => Promise<readonly string[]>
  /** The processor a program package is chosen for. This process's by default. */
  readonly arch?: string
}

/** The stand-in `@opencode/cli` ships until its install script runs: a short shell script that says so. */
const STAND_IN_SAYS = '@opencode/cli\'s postinstall script was not run'
const STAND_IN_MAX_BYTES = 4 * 1024
/** How much of a launcher is read for the program it starts. npm's is 150 bytes, pnpm's under 1 KiB. */
const LAUNCHER_MAX_BYTES = 8 * 1024
const NAMES = /^opencode2?(?:\.exe)?$/iu

/** The program packages for this computer, best first: plain, then baseline, then musl; x64 last on Windows ARM. */
export function opencodeProgramPackages(platform: NodeJS.Platform, arch: string): string[] {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux'
  const own = arch === 'arm64' ? 'arm64' : 'x64'
  const processors = platform === 'win32' && own === 'arm64' ? [own, 'x64'] : [own]
  const variants = platform === 'linux' ? ['', '-baseline', '-musl', '-baseline-musl'] : ['', '-baseline']
  return processors.flatMap(processor => variants.map(variant => `cli-${os}-${processor}${variant}`))
}

/** The `@opencode/cli` package folder a path is the program of (`<package>/bin/opencode.exe`), if it is one. */
function cliPackageOf(path: string): string | undefined {
  const parts = path.split(/[\\/]/u).map(part => part.toLowerCase())
  const at = parts.length - 5
  if (at < 0 || !NAMES.test(parts[at + 4]!)) return undefined
  return parts[at] === 'node_modules' && parts[at + 1] === '@opencode' && parts[at + 2] === 'cli' && parts[at + 3] === 'bin' ? dirname(dirname(path)) : undefined
}

/**
 * Where a package's program packages can be, best package first: inside it (npm), beside it (hoisted, or pnpm's store
 * link), or in pnpm's store.
 */
async function programsFor(cliPackage: string, platform: NodeJS.Platform, arch: string): Promise<string[]> {
  const program = platform === 'win32' ? 'opencode.exe' : 'opencode'
  const scope = dirname(cliPackage)
  const store = join(dirname(scope), '.pnpm')
  const stored = await readdir(store).catch(() => [] as string[])
  return opencodeProgramPackages(platform, arch).flatMap(target => [
    join(cliPackage, 'node_modules', '@opencode', target, 'bin', program),
    join(scope, target, 'bin', program),
    ...newestFirst(stored.filter(entry => entry.startsWith(`@opencode+${target}@`))).map(entry => join(store, entry, 'node_modules', '@opencode', target, 'bin', program)),
  ])
}

async function head(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}

/** Whether a file is `@opencode/cli`'s stand-in, which only says its install script did not run. */
export async function isOpenCodeStandIn(file: string): Promise<boolean> {
  try {
    if ((await stat(file)).size > STAND_IN_MAX_BYTES) return false
    return (await head(file, STAND_IN_MAX_BYTES)).toString('utf8').includes(STAND_IN_SAYS)
  } catch { return false }
}

/** A program Sotto can start: executable, not a manager's shim or wrapper, not the stand-in, and on Windows a real `.exe`. */
async function program(file: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const executable = await executableFile(file, platform)
  if (!executable) return undefined
  try {
    if (platform === 'win32' && !(await head(executable, 2)).equals(Buffer.from('MZ'))) return undefined
  } catch { return undefined }
  return await isOpenCodeStandIn(executable) ? undefined : executable
}

/** Windows' own way of naming a variable in a path, expanded from the environment, or undefined when one is unknown. */
function expandWindows(value: string, environment: NodeJS.ProcessEnv): string | undefined {
  let unknown = false
  const expanded = value.replace(/%([^%]+)%/gu, (_whole, name: string) => {
    const found = variable(environment, name)
    if (found === undefined) unknown = true
    return found ?? ''
  })
  return unknown ? undefined : expanded
}
function variable(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}
const absolute = (value: string | undefined): string | undefined => value && isAbsolute(value) ? value : undefined
/**
 * A program a launcher names, if Sotto may follow it there: named `opencode` or `opencode2`, and on this computer. A
 * network path is never opened, since opening one can sign in to the server it names.
 */
const followable = (target: string | undefined): target is string => Boolean(target) && !/^[\\/]{2}/u.test(target!) && NAMES.test(basename(target!))

/**
 * The programs a launcher starts, read and never run. npm's `.cmd` starts `"%dp0%\node_modules\@opencode\cli\bin\opencode.exe"`,
 * the install script's `opencode2.cmd` starts `"%~dp0opencode.exe"`, the `sh` launchers start `"$basedir/..."`, and a scoop
 * shim names its program on the `path = ` line of the `.shim` beside it. bun's Windows launcher names its program in a `.bunx`
 * beside it, in a form of bun's own, and is passed over: bun's global packages are searched for the program itself.
 * Undefined when the file is not a launcher.
 */
async function launched(candidate: string, platform: NodeJS.Platform): Promise<string[] | undefined> {
  const windows = platform === 'win32'
  const folder = dirname(candidate)
  if (windows && /\.cmd$/iu.test(candidate)) {
    const text = await launcherText(candidate)
    if (text === undefined) return []
    return [...text.matchAll(/"([^"\r\n]+)"/gu)].map(([, quoted]) => {
      const relative = /^%~?dp0%?(.*)$/iu.exec(quoted!)
      return relative ? join(folder, ...relative[1]!.split(/[\\/]+/u)) : isAbsolute(quoted!) && !quoted!.includes('%') ? quoted! : undefined
    }).filter(followable)
  }
  if (windows) {
    if (await stat(candidate.replace(/\.exe$/iu, '.bunx')).then(() => true, () => false)) return []
    const shim = await launcherText(candidate.replace(/\.exe$/iu, '.shim'))
    if (shim === undefined) return undefined
    const target = /^\s*path\s*=\s*"?([^"\r\n]+?)"?\s*$/mu.exec(shim)?.[1]
    return target && isAbsolute(target) && /\.exe$/iu.test(target) && followable(target) ? [target] : []
  }
  const text = await launcherText(candidate)
  if (!text?.startsWith('#!') || !text.includes('$basedir/')) return undefined
  const targets = [...text.matchAll(/"\$basedir\/([^"\r\n]+)"/gu)].map(([, relative]) => join(folder, ...relative!.split('/'))).filter(followable)
  return targets.length ? targets : undefined
}
async function launcherText(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > LAUNCHER_MAX_BYTES) return undefined
    return (await head(file, LAUNCHER_MAX_BYTES)).toString('utf8')
  } catch { return undefined }
}

/**
 * The programs a candidate is or leads to, best first: the program itself, the one its launcher starts, or, for the
 * stand-in, each program package there for this computer, so a build this processor cannot run (the plain one without
 * AVX2, glibc's on musl) is followed by the next.
 */
async function* programsOf(candidate: string, platform: NodeJS.Platform, arch: string): AsyncGenerator<string, void, undefined> {
  for (const file of await launched(candidate, platform) ?? [candidate]) {
    const found = await program(file, platform)
    if (found) { yield found; continue }
    const cliPackage = cliPackageOf(file) ?? cliPackageOf(await realpath(file).catch(() => file))
    if (!cliPackage) continue
    for (const inside of await programsFor(cliPackage, platform, arch)) {
      const packaged = await program(inside, platform)
      if (packaged) yield packaged
    }
  }
}
/** Whether a candidate is OpenCode, and the path to start it by: the first of `programsOf`. */
export async function acceptOpenCode(candidate: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): Promise<string | undefined> {
  for await (const found of programsOf(candidate, platform, arch)) return found
  return undefined
}

/** The folders a package manager's global packages may sit in, for a folder the lookup searches. */
function packageRoots(folder: string, windows: boolean): string[] {
  const name = basename(folder).toLowerCase()
  if (name === 'node_modules') return [folder]
  // npm puts the packages beside a Windows prefix's commands. Elsewhere only a folder named `bin` or `.bin` is looked
  // above, as Codex's lookup does: a PATH folder just below a drive root must not reach a folder any account may create.
  if (windows) return [join(folder, 'node_modules')]
  if (name === 'bin') return [join(dirname(folder), 'lib', 'node_modules')]
  if (name === '.bin' && basename(dirname(folder)).toLowerCase() === 'node_modules') return [dirname(folder)]
  return []
}

/** The other names to try in a folder after `opencode`: `opencode2`, the launchers, and `@opencode/cli` beside it. */
function alsoIn(windows: boolean) {
  return (folder: string): string[] => [
    join(folder, windows ? 'opencode2.exe' : 'opencode2'),
    ...windows ? [join(folder, 'opencode.cmd'), join(folder, 'opencode2.cmd')] : [],
    ...packageRoots(folder, windows).map(root => join(root, '@opencode', 'cli', 'bin', 'opencode.exe')),
  ]
}

/** The places after the shared order, in the order they are tried. */
export async function opencodeMorePlaces(environment: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform,
  registryPath: () => Promise<readonly string[]>): Promise<string[]> {
  const windows = platform === 'win32'
  const own = (name: string): string | undefined => absolute(variable(environment, name))
  const folders: string[] = windows ? [...await registryPath().catch(() => [] as readonly string[])] : []
  const bun = own('BUN_INSTALL') ?? join(home, '.bun')
  folders.push(join(bun, 'bin'), join(bun, 'install', 'global', 'node_modules'))
  const local = own('LOCALAPPDATA')
  const pnpmHomes = [own('PNPM_HOME'), ...windows ? [local && join(local, 'pnpm')]
    : [join(home, 'Library', 'pnpm'), join(own('XDG_DATA_HOME') ?? join(home, '.local', 'share'), 'pnpm')]]
  for (const pnpm of [...new Set(pnpmHomes.filter((value): value is string => Boolean(value)))]) {
    folders.push(pnpm)
    for (const layout of newestFirst(await readdir(join(pnpm, 'global')).catch(() => [] as string[]))) folders.push(join(pnpm, 'global', layout, 'node_modules'))
  }
  if (windows) {
    if (local) folders.push(join(local, 'Yarn', 'bin'), join(local, 'Yarn', 'Data', 'global', 'node_modules'))
    const programData = own('ProgramData')
    for (const scoop of [own('SCOOP') ?? join(home, 'scoop'), own('SCOOP_GLOBAL') ?? (programData && join(programData, 'scoop'))]) {
      if (scoop) folders.push(join(scoop, 'shims'), join(scoop, 'apps', 'opencode2', 'current'))
    }
    if (local) folders.push(join(local, 'Microsoft', 'WinGet', 'Links'))
    const programFiles = own('ProgramFiles')
    if (programFiles) folders.push(join(programFiles, 'WinGet', 'Links'))
    const chocolatey = own('ChocolateyInstall') ?? (programData && join(programData, 'chocolatey'))
    if (chocolatey) folders.push(join(chocolatey, 'bin'))
    return folders
  }
  folders.push(join(home, '.yarn', 'bin'), join(own('XDG_CONFIG_HOME') ?? join(home, '.config'), 'yarn', 'global', 'node_modules'))
  const user = variable(environment, 'USER')
  folders.push(join(home, '.nix-profile', 'bin'), ...user && /^[\w.-]+$/u.test(user) ? [`/etc/profiles/per-user/${user}/bin`] : [],
    '/run/current-system/sw/bin', '/nix/var/nix/profiles/default/bin', '/usr/bin', '/usr/local/bin')
  return folders
}

/**
 * Every OpenCode the lookup finds, in order, each file once however many paths lead to it. A caller that stops early
 * never searches further.
 */
export async function* opencodeCandidates(environment: NodeJS.ProcessEnv = process.env, lookup: OpenCodeLookupOptions = {}): AsyncGenerator<string, void, undefined> {
  const platform = lookup.platform ?? process.platform
  const windows = platform === 'win32'
  const home = lookup.home ?? homedir()
  const arch = lookup.arch ?? process.arch
  const registryPath = lookup.registryPath ?? (() => windowsPath(environment))
  const also = alsoIn(windows)
  const seen = new Set<string>()
  const shared: CliLookupOptions = { environment, home, platform, ...lookup.loginShellPath ? { loginShellPath: lookup.loginShellPath } : {} }
  /** The rest of what each accepted candidate leads to, handed over after it only if the caller asks for more. */
  const rest = new Map<string, AsyncGenerator<string, void, undefined>>()
  const fresh = async (executable: string): Promise<boolean> => {
    const real = await realpath(executable).catch(() => executable)
    const key = windows ? real.toLowerCase() : real
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
  for await (const executable of findClis({
    name: 'opencode',
    first: [join(home, '.opencode', 'bin')],
    last: () => opencodeMorePlaces(environment, home, platform, registryPath),
    within: folder => also(folder),
    accept: async candidate => {
      const programs = programsOf(candidate, platform, arch)
      const first = await programs.next()
      if (first.done) return undefined
      rest.set(first.value, programs)
      return first.value
    },
  }, shared)) {
    const more = rest.get(executable)
    rest.delete(executable)
    if (await fresh(executable)) yield executable
    if (more) for await (const next of more) if (await fresh(next)) yield next
  }
}

const REGISTRY_TIMEOUT_MS = 5_000
const REGISTRY_MAX_BYTES = 64 * 1024
/** How long one reading of Windows' PATH answers for: long enough for one connect, short enough that the next sees a new install. */
const REGISTRY_FRESH_MS = 15_000
const PATH_KEYS = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']
let registryReading: { readonly at: number; readonly folders: Promise<readonly string[]> } | undefined

/**
 * The folders on the account's PATH and the machine's, as the registry holds them now. Sotto's own PATH is the one it
 * was started with, so a client installed since is on these and not on it. Read with `reg.exe` and no shell, five
 * seconds and 64 KiB at most for each, and shared by lookups within fifteen seconds of each other. `reg.exe` writes in
 * the console's code page, so a folder written into PATH with letters outside it is missed; one named through a variable
 * such as `%USERPROFILE%`, the usual way, is expanded from Sotto's own environment and found.
 */
export function windowsPath(environment: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<readonly string[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  if (registryReading && now - registryReading.at < REGISTRY_FRESH_MS) return registryReading.folders
  const root = absolute(variable(environment, 'SystemRoot')) ?? absolute(variable(environment, 'windir'))
  const folders = root ? Promise.all(PATH_KEYS.map(key => readRegistryPath(join(root, 'System32', 'reg.exe'), key)))
    .then(values => parseRegistryPath(values.filter((value): value is string => value !== undefined), environment)) : Promise.resolve([])
  registryReading = { at: now, folders }
  return folders
}
/** A `reg query` answer's PATH value, `%VAR%` expanded, split into folders. Exported for its test. */
export function parseRegistryPath(answers: readonly string[], environment: NodeJS.ProcessEnv): string[] {
  return answers.flatMap(answer => {
    const value = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/imu.exec(answer)?.[1] ?? ''
    return value.split(';').map(entry => expandWindows(entry.trim().replace(/^"|"$/gu, ''), environment))
      .filter((entry): entry is string => Boolean(entry) && win32.isAbsolute(entry!) && !/^[\\/]{2}/u.test(entry!))
  })
}
function readRegistryPath(reg: string, key: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(reg, ['query', key, '/v', 'Path'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false })
    } catch { resolve(undefined); return }
    let output = ''
    let settled = false
    const finish = (value: string | undefined): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => { child.kill(); finish(undefined) }, REGISTRY_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > REGISTRY_MAX_BYTES) { child.kill(); finish(undefined) }
    })
    child.once('error', () => finish(undefined))
    child.once('close', code => finish(code === 0 ? output : undefined))
  })
}

/** Forgets the last reading of Windows' PATH, so a test starts clean. */
export function resetOpenCodeLookup(): void { registryReading = undefined }
