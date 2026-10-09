// @vitest-environment node
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findCli, loginShellPath, resetCliLookup, withCliPath, type CliLookupOptions } from '../../../src/main/agents/cliLookup'
import { findClaudeExecutable } from '../../../src/main/agents/subscriptionClaude'
import { findExecutable as findCodexExecutable } from '../../../src/main/agents/subscriptionCodex'
import { findGrokExecutable } from '../../../src/main/agents/grokRpc'
import { findDevinExecutable } from '../../../src/main/agents/devinRpc'
import type { ProviderId } from '../../../src/shared/agents'

/**
 * The CLI lookup over a fake home directory (ADR-0036). The platform is given, so the Linux and macOS layouts are
 * checked on the Windows runner too; only the file name and the POSIX-only places follow it.
 */
let root: string, home: string, empty: string
beforeEach(async () => {
  resetCliLookup()
  // The real path: Codex answers with the binary's real path, and macOS keeps its temporary folder behind a link.
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-cli-lookup-')))
  home = join(root, 'home'); empty = join(root, 'empty')
  await mkdir(home, { recursive: true }); await mkdir(empty, { recursive: true })
})
afterEach(async () => { resetCliLookup(); await rm(root, { recursive: true, force: true }) })

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])
const MZ = Buffer.from([0x4d, 0x5a, 0x90, 0])
async function file(path: string, contents: Buffer | string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  await chmod(path, 0o755)
  return path
}
const native = (path: string): Promise<string> => file(path, ELF)
/** What forge's `~/.local/bin` holds: a bash wrapper that runs the tool through mise. */
const wrapper = (path: string, tool: string): Promise<string> => file(path, `#!/bin/bash\nmise use -g --quiet "${tool}" || exit 1\nexec mise x "${tool}" -- "${tool}" "$@"\n`)
/** A symbolic link, or null where this account may not make one (Windows without Developer Mode). */
async function link(target: string, path: string): Promise<string | null> {
  await mkdir(dirname(path), { recursive: true })
  try { await symlink(target, path); return path } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return null; throw error }
}

const linux = (environment: NodeJS.ProcessEnv = {}, loginPath?: string): CliLookupOptions & { environment: NodeJS.ProcessEnv } => ({
  environment: { PATH: empty, ...environment }, home, platform: 'linux', loginShellPath: async () => loginPath,
})
/** Each provider through the finder its adapter uses, so the provider's own rules (Codex's native binary) apply. */
async function find(provider: ProviderId, options: ReturnType<typeof linux>): Promise<string | undefined> {
  const { environment, ...lookup } = options
  switch (provider) {
    case 'claude': return (await findClaudeExecutable(environment, undefined, lookup)) ?? undefined
    case 'codex': return (await findCodexExecutable(options)) ?? undefined
    case 'grok': return findGrokExecutable(environment, lookup)
    case 'devin': return findDevinExecutable(environment, lookup)
  }
}
const PROVIDERS: ProviderId[] = ['claude', 'codex', 'grok', 'devin']

/** Every place a version manager or installer keeps a command, as the folder under the fake home and what points there. */
const LAYOUTS: { name: string; folder: (tool: string) => string; environment?: (tool: string) => NodeJS.ProcessEnv; login?: (tool: string) => string }[] = [
  { name: 'the login shell\'s PATH', folder: () => join('opt', 'login-bin'), login: () => join(home, 'opt', 'login-bin') },
  { name: '~/.local/bin', folder: () => join('.local', 'bin') },
  { name: 'mise installs/<tool>/latest/bin', folder: tool => join('.local', 'share', 'mise', 'installs', tool, 'latest', 'bin') },
  { name: 'mise installs/<tool>/latest (an aqua download)', folder: tool => join('.local', 'share', 'mise', 'installs', tool, 'latest') },
  { name: 'mise installs/npm-<package>/latest/node_modules/.bin', folder: tool => join('.local', 'share', 'mise', 'installs', `npm-vendor-${tool}`, 'latest', 'node_modules', '.bin') },
  { name: 'mise under MISE_DATA_DIR', folder: tool => join('mise-data', 'installs', tool, 'latest', 'bin'), environment: () => ({ MISE_DATA_DIR: join(home, 'mise-data') }) },
  { name: 'asdf, newest version', folder: () => join('.asdf', 'installs', 'nodejs', '22.11.0', 'bin') },
  { name: 'nvm, newest version', folder: () => join('.nvm', 'versions', 'node', 'v24.1.0', 'bin') },
  { name: 'fnm default alias', folder: () => join('.local', 'share', 'fnm', 'aliases', 'default', 'bin') },
  { name: 'Volta package', folder: tool => join('.volta', 'tools', 'image', 'packages', '@vendor', tool, 'bin') },
  { name: 'Homebrew (HOMEBREW_PREFIX)', folder: () => join('brew', 'bin'), environment: () => ({ HOMEBREW_PREFIX: join(home, 'brew') }) },
  { name: 'npm global prefix (npm_config_prefix)', folder: () => join('npm-prefix', 'bin'), environment: () => ({ npm_config_prefix: join(home, 'npm-prefix') }) },
  { name: 'npm global prefix (.npmrc)', folder: () => join('.npm-packages', 'bin') },
]

describe('the CLI lookup', () => {
  for (const layout of LAYOUTS) {
    it.each(PROVIDERS)(`finds %s under ${layout.name} when PATH has nothing`, async provider => {
      if (layout.name.includes('.npmrc')) await writeFile(join(home, '.npmrc'), 'prefix=~/.npm-packages\n')
      const installed = await native(join(home, layout.folder(provider), provider))
      const options = linux(layout.environment?.(provider), layout.login?.(provider))
      expect(await find(provider, options)).toBe(installed)
    })
  }

  it.each(PROVIDERS)('prefers %s on PATH to the login shell, ~/.local/bin and every version manager', async provider => {
    const onPath = await native(join(root, 'on-path', provider))
    await native(join(root, 'login', provider))
    await native(join(home, '.local', 'bin', provider))
    await native(join(home, '.local', 'share', 'mise', 'installs', provider, 'latest', 'bin', provider))
    await native(join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin', provider))
    const loginShell = vi.fn(async () => join(root, 'login'))
    expect(await find(provider, { ...linux({ PATH: [empty, join(root, 'on-path')].join(delimiter) }), loginShellPath: loginShell })).toBe(onPath)
    // Found on PATH, the login shell is never started.
    expect(loginShell).not.toHaveBeenCalled()
  })

  it('tries the login shell before ~/.local/bin, and ~/.local/bin before the version managers', async () => {
    const login = await native(join(root, 'login', 'codex'))
    const local = await native(join(home, '.local', 'bin', 'codex'))
    await native(join(home, '.local', 'share', 'mise', 'installs', 'codex', 'latest', 'bin', 'codex'))
    expect(await find('codex', linux({}, join(root, 'login')))).toBe(login)
    resetCliLookup()
    expect(await find('codex', linux())).toBe(local)
  })

  it('takes the newest nvm version first', async () => {
    await native(join(home, '.nvm', 'versions', 'node', 'v9.11.2', 'bin', 'claude'))
    const newest = await native(join(home, '.nvm', 'versions', 'node', 'v22.3.0', 'bin', 'claude'))
    expect(await find('claude', linux())).toBe(newest)
  })

  it('never searches the mise or asdf shim folders, even on PATH', async () => {
    // A shim folder's `codex` is mise itself; whatever the file holds, the folder is passed over.
    const miseShims = join(home, '.local', 'share', 'mise', 'shims')
    const asdfShims = join(home, '.asdf', 'shims')
    for (const shims of [miseShims, asdfShims]) for (const provider of PROVIDERS) await native(join(shims, provider))
    const installs = await Promise.all(PROVIDERS.map(provider => native(join(home, '.local', 'share', 'mise', 'installs', provider, 'latest', 'bin', provider))))
    for (const [index, provider] of PROVIDERS.entries()) {
      resetCliLookup()
      expect(await find(provider, linux({ PATH: [miseShims, asdfShims].join(delimiter) }, miseShims))).toBe(installs[index])
    }
  })

  it('rejects a command whose real path is the mise binary, wherever it is found', async ({ skip }) => {
    const mise = await native(join(root, 'usr', 'bin', 'mise'))
    const shims = await Promise.all(PROVIDERS.map(provider => link(mise, join(root, 'somewhere', provider))))
    if (shims.some(shim => shim === null)) skip('This account cannot make symbolic links.')
    const installs = await Promise.all(PROVIDERS.map(provider => native(join(home, '.local', 'share', 'mise', 'installs', provider, 'latest', 'bin', provider))))
    for (const [index, provider] of PROVIDERS.entries()) {
      resetCliLookup()
      expect(await find(provider, linux({ PATH: join(root, 'somewhere') }))).toBe(installs[index])
    }
  })

  it.each(PROVIDERS)('passes over a %s wrapper that runs the command through mise, for the install it would run', async provider => {
    // forge on September 28: ~/.local/bin/<tool> runs `mise use -g` and then `mise x`, and is on the login shell's
    // PATH too. The install under mise's `latest` is what the wrapper would have started.
    const miseWrapper = await wrapper(join(home, '.local', 'bin', provider), provider)
    const install = await native(join(home, '.local', 'share', 'mise', 'installs', provider, 'latest', ...(provider === 'claude' ? [] : ['bin']), provider))
    expect(await find(provider, linux({}, dirname(miseWrapper)))).toBe(install)
  })

  it('passes over an asdf exec wrapper and a mise exec wrapper, but takes a script that runs Node', async () => {
    const asdf = await file(join(root, 'asdf-wrapper', 'claude'), '#!/usr/bin/env bash\nexec asdf exec claude "$@"\n')
    const exec = await file(join(root, 'exec-wrapper', 'claude'), '#!/bin/sh\nexec /usr/bin/mise exec claude -- claude "$@"\n')
    const script = await file(join(root, 'npm-bin', 'claude'), '#!/usr/bin/env node\n// The misery of x is not a manager.\nrequire("./cli.js")\n')
    for (const wrapped of [asdf, exec]) {
      resetCliLookup()
      expect(await find('claude', linux({ PATH: dirname(wrapped) }))).toBeUndefined()
    }
    resetCliLookup()
    expect(await find('claude', linux({ PATH: dirname(script) }))).toBe(script)
  })

  it('follows a found Codex link to its native binary, and takes the one inside an npm package', async ({ skip }) => {
    const binary = await native(join(home, '.local', 'share', 'mise', 'installs', 'codex', '0.155.1', 'bin', 'codex'))
    if (!await link(binary, join(home, '.codex', 'bin', 'codex'))) skip('This account cannot make symbolic links.')
    expect(await find('codex', linux())).toBe(binary)
    await rm(join(home, '.codex'), { recursive: true })
    resetCliLookup()
    // npm's POSIX prefix: `bin/codex` is the JavaScript entry point, the binary is in the package's vendor folder.
    await file(join(home, 'npm-prefix', 'bin', 'codex'), '#!/usr/bin/env node\n')
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    const vendored = await native(join(home, 'npm-prefix', 'lib', 'node_modules', '@openai', 'codex', 'vendor', `${arch}-unknown-linux-musl`, 'bin', 'codex'))
    expect(await find('codex', linux({ npm_config_prefix: join(home, 'npm-prefix') }))).toBe(vendored)
  })

  it('takes Codex from an npm package a manager installed under node_modules/.bin, and looks above no other folder', async () => {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    const modules = join(home, '.local', 'share', 'mise', 'installs', 'npm-openai-codex', 'latest', 'node_modules')
    await file(join(modules, '.bin', 'codex'), '#!/usr/bin/env node\n')
    const vendored = await native(join(modules, '@openai', 'codex', 'vendor', `${arch}-unknown-linux-musl`, 'bin', 'codex'))
    // A PATH folder that is not a prefix's `bin` is never looked above.
    await native(join(root, 'lib', 'node_modules', '@openai', 'codex', 'vendor', `${arch}-unknown-linux-musl`, 'bin', 'codex'))
    expect(await find('codex', linux({ PATH: join(root, 'tools') }))).toBe(vendored)
  })

  it('finds Grok Build in its own ~/.grok/bin before PATH', async () => {
    await native(join(root, 'on-path', 'grok'))
    const own = await native(join(home, '.grok', 'bin', 'grok'))
    expect(await find('grok', linux({ PATH: join(root, 'on-path') }))).toBe(own)
  })

  it('answers nothing when a provider is installed nowhere Sotto looks', async () => {
    for (const provider of PROVIDERS) expect(await find(provider, linux())).toBeUndefined()
  })
})

describe('the CLI lookup on Windows', () => {
  const windows = (environment: NodeJS.ProcessEnv): CliLookupOptions & { environment: NodeJS.ProcessEnv } => ({ environment: { PATH: empty, ...environment }, home, platform: 'win32' })

  it('finds each client by its .exe name and passes over npm\'s .cmd shims', async () => {
    const appData = join(root, 'AppData', 'Roaming')
    await file(join(appData, 'npm', 'codex.cmd'), '@echo off\r\n')
    await file(join(appData, 'npm', 'claude.cmd'), '@echo off\r\n')
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    const codex = await file(join(appData, 'npm', 'node_modules', '@openai', 'codex', 'vendor', `${arch}-pc-windows-msvc`, 'bin', 'codex.exe'), MZ)
    const claude = await file(join(home, '.local', 'bin', 'claude.exe'), MZ)
    const grok = await file(join(home, '.grok', 'bin', 'grok.exe'), MZ)
    const devin = await file(join(appData, 'npm', 'devin.exe'), MZ)
    const environment = { APPDATA: appData }
    const options = windows(environment)
    expect(await findCodexExecutable(options)).toBe(codex)
    expect(await findClaudeExecutable(options.environment, undefined, { home, platform: 'win32' })).toBe(claude)
    expect(await findGrokExecutable(options.environment, { home, platform: 'win32' })).toBe(grok)
    expect(await findDevinExecutable(options.environment, { home, platform: 'win32' })).toBe(devin)
  })

  it('never looks for the Codex npm package above a PATH folder', async () => {
    // A PATH folder just below a drive root, such as C:\tools: its parent's `lib` is one any account may create.
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    await file(join(root, 'lib', 'node_modules', '@openai', 'codex', 'vendor', `${arch}-pc-windows-msvc`, 'bin', 'codex.exe'), MZ)
    const appData = join(root, 'AppData', 'Roaming')
    const codex = await file(join(appData, 'npm', 'node_modules', '@openai', 'codex', 'vendor', `${arch}-pc-windows-msvc`, 'bin', 'codex.exe'), MZ)
    expect(await findCodexExecutable(windows({ PATH: join(root, 'tools'), APPDATA: appData }))).toBe(codex)
  })

  it('accepts only a Windows executable as Codex and never asks a login shell', async () => {
    const loginShell = vi.fn(async () => join(root, 'login'))
    await native(join(root, 'login', 'codex.exe'))
    await native(join(root, 'on-path', 'codex.exe'))
    const binary = await file(join(home, '.local', 'bin', 'codex.exe'), MZ)
    expect(await findCodexExecutable({ ...windows({ PATH: join(root, 'on-path') }), loginShellPath: loginShell })).toBe(binary)
    expect(loginShell).not.toHaveBeenCalled()
  })
})

describe('the PATH a found client runs with', () => {
  it('puts the client\'s folder and Node\'s ahead of the inherited PATH and the login shell\'s other folders after it', async () => {
    // Grok Build through mise's npm backend runs `#!/usr/bin/env node`, and the host's PATH has no Node.
    const mise = join(home, '.local', 'share', 'mise', 'installs')
    const grok = await file(join(mise, 'npm-xai-official-grok', 'latest', 'node_modules', '.bin', 'grok'), '#!/usr/bin/env node\n')
    const node = await native(join(mise, 'node', 'latest', 'bin', 'node'))
    const inherited = [join(root, 'usr', 'local', 'bin'), join(root, 'usr', 'bin')].join(delimiter)
    const options = linux({ PATH: inherited }, [join(root, 'usr', 'bin'), join(home, '.cargo', 'bin')].join(delimiter))
    expect(await find('grok', options)).toBe(grok)
    const environment = withCliPath({ PATH: inherited, HOME: home }, grok)
    expect(environment.PATH!.split(delimiter)).toEqual([dirname(grok), dirname(node), join(root, 'usr', 'local', 'bin'), join(root, 'usr', 'bin'), join(home, '.cargo', 'bin')])
    // Only PATH changes: nothing the adapter's allow-list dropped comes back.
    expect(Object.keys(environment).sort()).toEqual(['HOME', 'PATH'])
  })

  it('leaves the PATH alone for Codex found on it through a link to a binary elsewhere', async ({ skip }) => {
    const binary = await native(join(home, '.local', 'share', 'mise', 'installs', 'codex', 'latest', 'bin', 'codex'))
    if (!await link(binary, join(root, 'on-path', 'codex'))) skip('This account cannot make symbolic links.')
    const loginShell = vi.fn(async () => undefined)
    expect(await findCodexExecutable({ ...linux({ PATH: join(root, 'on-path') }), loginShellPath: loginShell })).toBe(binary)
    expect(withCliPath({ PATH: join(root, 'on-path') }, binary)).toEqual({ PATH: join(root, 'on-path') })
    expect(loginShell).not.toHaveBeenCalled()
  })

  it('keeps Windows\' own spelling of Path', async () => {
    const claude = await file(join(home, '.local', 'bin', 'claude.exe'), MZ)
    expect(await findClaudeExecutable({ Path: empty }, undefined, { home, platform: 'win32' })).toBe(claude)
    expect(withCliPath({ Path: empty }, claude)).toEqual({ Path: [dirname(claude), empty].join(delimiter) })
  })

  it('leaves the PATH alone for a client found on it, and for one the lookup did not find', async () => {
    const onPath = await native(join(root, 'on-path', 'claude'))
    expect(await find('claude', linux({ PATH: join(root, 'on-path') }))).toBe(onPath)
    expect(withCliPath({ PATH: join(root, 'on-path') }, onPath)).toEqual({ PATH: join(root, 'on-path') })
    expect(withCliPath({ PATH: 'bin' }, join(root, 'given', 'claude'))).toEqual({ PATH: 'bin' })
  })
})

describe.skipIf(process.platform === 'win32')("the login shell's PATH (POSIX login shells; Windows has no login-shell profile)", () => {
  it('is read past anything the profile prints, and a missing shell answers nothing', async () => {
    await writeFile(join(home, '.profile'), 'echo "Welcome to forge"\nPATH="$HOME/from-profile:$PATH"\nexport PATH\n')
    const path = await loginShellPath({ SHELL: '/bin/sh', HOME: home, PATH: '/usr/bin:/bin' })
    expect(path?.split(':')[0]).toBe(join(home, 'from-profile'))
    expect(await loginShellPath({ SHELL: join(root, 'no-such-shell'), HOME: home, PATH: '/usr/bin:/bin' })).toBeUndefined()
  })

  it('is read while a process the profile started still holds the output open', async () => {
    // ssh-agent or keychain started from a profile inherits stdout and outlives the shell, so the pipe stays open
    // past the five seconds the shell is given; the PATH printed before then is still the answer.
    await writeFile(join(home, '.profile'), 'PATH="$HOME/from-profile:$PATH"\nexport PATH\nsleep 8 &\n')
    const path = await loginShellPath({ SHELL: '/bin/sh', HOME: home, PATH: '/usr/bin:/bin' })
    expect(path?.split(':')[0]).toBe(join(home, 'from-profile'))
  })

  it('finds a client the login shell puts on PATH', async () => {
    await writeFile(join(home, '.profile'), 'PATH="$HOME/tools:$PATH"\nexport PATH\n')
    const claude = await native(join(home, 'tools', 'claude'))
    expect(await findCli({ name: 'claude' }, { environment: { SHELL: '/bin/sh', HOME: home, PATH: '/usr/bin:/bin' }, home, platform: process.platform })).toBe(claude)
  })
})
