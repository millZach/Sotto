// @vitest-environment node

import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectClientInstall, ProviderClients, byHandFor, opencodeManager, type RunLike } from '../../../src/main/agents/providerClients'
import { opencodeFolders, opencodeVersionRefusal, OpenCodeTooOld } from '../../../src/main/agents/opencodeServer'
import { root } from '../../fixtures/providerClientInstallFixture'

const answer = (version: string): Response => new Response(JSON.stringify({ version }), { status: 200 })
// No mise install in a fixture, whatever the developer's machine has.
const noMise = async () => ({ MISE_DATA_DIR: join(await root('sotto-opencode-mise-'), 'mise') })
/** The prefix npm reads a `<x>/lib/node_modules` package under: `<x>` here, but `<x>\lib` on Windows. */
const libPrefix = (x: string): string => process.platform === 'win32' ? join(x, 'lib') : x
/** npm's launcher for a global package: a link to its program outside Windows, where npm writes a script instead. */
const npmLauncher = async (launcher: string, program: string): Promise<void> => {
  if (process.platform === 'win32') return
  await mkdir(dirname(program), { recursive: true }); await writeFile(program, '')
  await mkdir(dirname(launcher), { recursive: true }); await symlink(program, launcher)
}

describe('which OpenCode Sotto finds, and which it refuses', () => {
  it('drives OpenCode 2 from 2.0.31 and refuses OpenCode 1 or an older 2 in words that say what to install', () => {
    expect(opencodeVersionRefusal('opencode v2.0.31')).toBeUndefined()
    expect(opencodeVersionRefusal('opencode v2.1.0')).toBeUndefined()
    expect(opencodeVersionRefusal('1.19.3')?.message).toBe('This is OpenCode 1.19.3, and Sotto works with OpenCode 2 only. Install it from opencode.ai/v2/install, which replaces OpenCode 1 in ~/.opencode/bin, where Sotto looks first; opencode.ai/install and npm\'s opencode-ai give OpenCode 1.')
    const old = opencodeVersionRefusal('opencode v2.0.30')
    expect(old).toBeInstanceOf(OpenCodeTooOld)
    expect(old?.message).toBe('OpenCode 2.0.31 or newer is required, and this client is 2.0.30.')
  })
})

describe('the channel that installed OpenCode updates it (ADR-0042, ADR-0087)', () => {
  it('checks an npm install against @opencode/cli and updates it through Sotto’s npm runner', async () => {
    const prefix = await root('sotto-opencode-npm-')
    const cli = join(prefix, 'node_modules', '@opencode', 'cli')
    await mkdir(join(cli, 'bin'), { recursive: true }); await writeFile(join(cli, 'package.json'), '{}')
    const executable = join(cli, 'bin', 'opencode.exe')
    const asked: string[] = []
    // Windows' layout, where the package sits in the prefix's own node_modules.
    const clients = new ProviderClients({ fetchImpl: async url => { asked.push(url); return answer('2.0.40') }, npmPath: async () => join(prefix, 'npm-cli.js'), platform: 'win32' })
    expect(await detectClientInstall('opencode', executable, await noMise(), 'win32')).toEqual({ channel: 'npm', npmPrefix: prefix })
    // The program package npm hoists beside it stands for it, and one with no @opencode/cli beside it is nobody's to update.
    const hoisted = join(prefix, 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe')
    expect(await detectClientInstall('opencode', hoisted, await noMise(), 'win32')).toEqual({ channel: 'npm', npmPrefix: prefix })
    const alone = join(await root('sotto-opencode-alone-'), 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe')
    expect(await detectClientInstall('opencode', alone, await noMise(), 'win32')).toEqual({ channel: 'unknown' })
    const reading = await clients.check('opencode', '2.0.31', executable, await noMise())
    expect(asked).toEqual(['https://registry.npmjs.org/%40opencode/cli/latest'])
    expect(reading).toMatchObject({ id: 'opencode', installed: '2.0.31', published: '2.0.40', behind: true, channel: 'npm', canInstall: true,
      command: 'npm install -g --allow-scripts=@opencode/cli @opencode/cli@latest' })
  })

  it('lets the install script’s copy in ~/.opencode/bin update itself with opencode upgrade, on Sotto’s own OpenCode folders', async () => {
    const executable = join(homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
    const environment = { ...await noMise(), XDG_CONFIG_HOME: join(homedir(), 'users-own-config'), ANTHROPIC_API_KEY: 'fixture-secret' }
    expect(await detectClientInstall('opencode', executable, environment)).toEqual({ channel: 'self-update' })
    const ran: { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = []
    const run: RunLike = async (file, args, _asNode, options) => { ran.push({ executable: file, args, env: options?.environment }); return { ok: true } }
    const folders = opencodeFolders(join(await root('sotto-opencode-own-'), 'opencode'))
    const clients = new ProviderClients({ fetchImpl: async () => answer('2.0.40'), run, opencodeFolders: folders })
    expect(await clients.check('opencode', '2.0.31', executable, environment)).toMatchObject({ channel: 'self-update', canInstall: true, command: 'opencode upgrade', byHand: ['opencode upgrade'] })
    expect((await clients.install('opencode', executable, environment)).ok).toBe(true)
    expect(ran).toHaveLength(1)
    expect(ran[0]!.executable).toBe(executable)
    expect(ran[0]!.args).toEqual(['upgrade'])
    // OpenCode's updater reads its config folder: Sotto's, never the user's, and no other provider's key goes with it.
    expect(ran[0]!.env).toMatchObject({ XDG_CONFIG_HOME: folders.config, XDG_DATA_HOME: folders.data, OPENCODE_DISABLE_AUTOUPDATE: '1' })
    expect(ran[0]!.env?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it.each([
    ['a Homebrew core formula', ['opt', 'homebrew', 'Cellar', 'opencode', '2.0.31', 'bin', 'opencode'], 'brew upgrade opencode'],
    ['the tap’s OpenCode 2', ['usr', 'local', 'Cellar', 'opencode-v2', '2.0.31', 'bin', 'opencode'], 'brew upgrade opencode-v2'],
    ['a scoop app', ['Users', 'me', 'scoop', 'apps', 'opencode2', 'current', 'opencode.exe'], 'scoop update opencode2'],
  ])('names the command for %s and never runs it', async (_kind, parts, command) => {
    const executable = join(await root('sotto-opencode-manager-'), ...parts)
    expect(await detectClientInstall('opencode', executable, await noMise())).toEqual({ channel: 'unknown', byHand: [command] })
    const ran: string[] = []
    const clients = new ProviderClients({ fetchImpl: async () => answer('2.0.40'), run: async file => { ran.push(file); return { ok: true } } })
    const reading = await clients.check('opencode', '2.0.31', executable, await noMise())
    expect(reading).toMatchObject({ behind: true, channel: 'unknown', canInstall: false, command, byHand: [command] })
    expect((await clients.install('opencode', executable, await noMise())).ok).toBe(false)
    expect(ran).toEqual([])
  })

  it('reads a scoop shim’s app from the .shim beside it', async () => {
    const shims = join(await root('sotto-opencode-scoop-'), 'scoop', 'shims')
    await mkdir(shims, { recursive: true })
    await writeFile(join(shims, 'opencode.shim'), 'path = "C:\\Users\\me\\scoop\\apps\\opencode-v2\\current\\opencode.exe"\n')
    expect(await opencodeManager(join(shims, 'opencode.exe'))).toEqual(['scoop update opencode-v2'])
  })

  it('names pacman’s package when its record holds the program', async () => {
    const records = await root('sotto-opencode-pacman-')
    await mkdir(join(records, 'opencode-2.0.31-1'), { recursive: true })
    await writeFile(join(records, 'opencode-2.0.31-1', 'files'), '%FILES%\nusr/\nusr/bin/\nusr/bin/opencode\n')
    expect(await opencodeManager('/usr/bin/opencode', 'linux', records)).toEqual(['sudo pacman -Syu opencode'])
    expect(await opencodeManager('/usr/bin/opencode', 'linux', await root('sotto-opencode-no-pacman-'))).toBeUndefined()
  })

  it('treats npm’s copy under a manager’s Node as npm’s', async () => {
    const executable = join(await root('sotto-opencode-brew-node-'), 'opt', 'homebrew', 'lib', 'node_modules', '@opencode', 'cli', 'bin', 'opencode')
    expect(await opencodeManager(executable)).toBeUndefined()
    expect(byHandFor('opencode', { channel: 'npm' })).toEqual(['npm install -g --allow-scripts=@opencode/cli @opencode/cli@latest'])
  })

  it('updates npm’s copy under Homebrew’s Node through npm, and leaves Homebrew’s own copy and other clients as they were', async () => {
    const brew = join(await root('sotto-opencode-brew-npm-'), 'opt', 'homebrew')
    const cli = join(brew, 'lib', 'node_modules', '@opencode', 'cli')
    await mkdir(join(cli, 'bin'), { recursive: true }); await writeFile(join(cli, 'package.json'), '{}')
    await mkdir(join(brew, 'bin'), { recursive: true })
    await npmLauncher(join(brew, 'bin', 'opencode'), join(cli, 'bin', 'opencode'))
    // The package's own program, and npm's launcher in Homebrew's bin beside the package it starts.
    expect(await detectClientInstall('opencode', join(cli, 'bin', 'opencode'), await noMise())).toEqual({ channel: 'npm', npmPrefix: libPrefix(brew) })
    expect(await detectClientInstall('opencode', join(brew, 'bin', 'opencode'), await noMise())).toEqual({ channel: 'npm', npmPrefix: libPrefix(brew) })
    const clients = new ProviderClients({ fetchImpl: async () => answer('2.0.40'), npmPath: async () => join(brew, 'npm-cli.js') })
    expect(await clients.check('opencode', '2.0.31', join(cli, 'bin', 'opencode'), await noMise())).toMatchObject({ channel: 'npm', canInstall: true })
    // A Homebrew prefix with no npm package is Homebrew's, and its command stays one to run by hand.
    const bare = join(await root('sotto-opencode-brew-bare-'), 'opt', 'homebrew', 'bin', 'opencode')
    expect(await detectClientInstall('opencode', bare, await noMise())).toEqual({ channel: 'unknown', byHand: ['brew upgrade opencode'] })
    // Every other client under Homebrew is still Homebrew's to update.
    const codex = join(brew, 'lib', 'node_modules', '@openai', 'codex')
    await mkdir(join(codex, 'bin'), { recursive: true }); await writeFile(join(codex, 'package.json'), '{}')
    expect(await detectClientInstall('codex', join(codex, 'bin', 'codex.js'), await noMise())).toEqual({ channel: 'unknown' })
    expect(await detectClientInstall('codex', join(brew, 'bin', 'codex'), await noMise())).toEqual({ channel: 'unknown' })
  })

  it.each([
    ['bun', ['.bun', 'install', 'global', 'node_modules', '@opencode', 'cli']],
    ['pnpm', ['AppData', 'Local', 'pnpm', 'global', '5', 'node_modules', '@opencode', 'cli']],
    ['pnpm’s store', ['.local', 'share', 'pnpm', 'global', '5', '.pnpm', '@opencode+cli@2.0.31', 'node_modules', '@opencode', 'cli']],
    ['Volta', ['.volta', 'tools', 'image', 'packages', '@opencode', 'cli', 'lib', 'node_modules', '@opencode', 'cli']],
  ])('leaves a copy %s installed as that tool’s to update, and never runs npm over it', async (_tool, parts) => {
    const cli = join(await root('sotto-opencode-other-manager-'), ...parts)
    await mkdir(join(cli, 'bin'), { recursive: true }); await writeFile(join(cli, 'package.json'), '{}')
    const executable = join(cli, 'bin', 'opencode')
    expect(await detectClientInstall('opencode', executable, await noMise())).toEqual({ channel: 'unknown' })
    const ran: string[] = []
    const clients = new ProviderClients({ fetchImpl: async () => answer('2.0.40'), run: async file => { ran.push(file); return { ok: true } }, npmPath: async () => join(cli, 'npm-cli.js') })
    expect(await clients.check('opencode', '2.0.31', executable, await noMise())).toMatchObject({ channel: 'unknown', canInstall: false })
    expect((await clients.install('opencode', executable, await noMise())).ok).toBe(false)
    expect(ran).toEqual([])
  })

  it('never lets a global @opencode/cli claim the install script’s copy or one in a folder npm did not install', async () => {
    const prefix = await root('sotto-opencode-global-npm-')
    const cli = join(prefix, 'lib', 'node_modules', '@opencode', 'cli')
    await mkdir(cli, { recursive: true }); await writeFile(join(cli, 'package.json'), '{}')
    const environment = { ...await noMise(), npm_config_prefix: prefix }
    const own = join(homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
    expect(await detectClientInstall('opencode', own, environment)).toEqual({ channel: 'self-update' })
    const system = join(await root('sotto-opencode-system-'), 'usr', 'bin', 'opencode')
    expect(await detectClientInstall('opencode', system, environment)).toEqual({ channel: 'unknown' })
    // npm's own launcher beside that global package is still npm's.
    await npmLauncher(join(prefix, 'bin', 'opencode'), join(cli, 'bin', 'opencode'))
    expect(await detectClientInstall('opencode', join(prefix, 'bin', 'opencode'), environment)).toEqual({ channel: 'npm', npmPrefix: libPrefix(prefix) })
  })
})
