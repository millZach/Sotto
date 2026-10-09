// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installerOutput } from '../../../src/main/agents/installerDetail'
import { byHandFor, detectClientInstall, miseBinary, ProviderClients, updateActionFor, type RunLike, type RunOptions } from '../../../src/main/agents/providerClients'

/**
 * #480: a client mise installed is updated with `mise upgrade <tool>`, run through the mise binary itself, and Grok Build
 * under mise also gets its package's install step. The layouts are forge's on September 29, 2026: Claude Code and Codex
 * in `~/.local/share/mise/installs/<tool>/<version>` behind a `latest` link, and Grok Build's npm package there with its
 * program in `~/.grok/bin`, where the package's install step puts it.
 */
const roots: string[] = []
const root = async (): Promise<string> => { const directory = await mkdtemp(join(tmpdir(), 'sotto-mise-')); roots.push(directory); return directory }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const answer = (version: string): Response => new Response(JSON.stringify({ version }), { status: 200 })

/** A mise data folder with the tools forge has, each with mise's own record of its name. */
async function miseData(): Promise<{ data: string; installs: string; home: string }> {
  const home = await root()
  const data = join(home, '.local', 'share', 'mise')
  const installs = join(data, 'installs')
  const tool = async (folder: string, short: string, version: string, files: string[]): Promise<void> => {
    await mkdir(join(installs, folder, version), { recursive: true })
    await writeFile(join(installs, folder, '.mise.backend.toml'), `short = "${short}"\nfull = "${short}"\nexplicit_backend = false\n`)
    for (const file of files) { await mkdir(join(installs, folder, version, file, '..'), { recursive: true }); await writeFile(join(installs, folder, version, file), '') }
  }
  await tool('claude', 'claude', '2.1.281', ['claude'])
  await tool('codex', 'codex', '0.155.1', [join('bin', 'codex')])
  await tool('npm-xai-official-grok', 'npm:@xai-official/grok', '1.0.41', [join('node_modules', '@xai-official', 'grok', 'bin', 'postinstall.js')])
  await mkdir(join(home, '.grok', 'bin'), { recursive: true })
  return { data, installs, home }
}

describe('which clients mise installed', () => {
  it('reads Claude Code and Codex from mise’s installs folder, by the name mise recorded for each', async () => {
    const { data, installs } = await miseData()
    const environment = { MISE_DATA_DIR: data }
    expect(await detectClientInstall('claude', join(installs, 'claude', 'latest', 'claude'), environment)).toEqual({ channel: 'mise', miseTool: 'claude' })
    expect(await detectClientInstall('codex', join(installs, 'codex', '0.155.1', 'bin', 'codex'), environment)).toEqual({ channel: 'mise', miseTool: 'codex' })
  })

  it('finds mise’s installs under another data folder by the folder names alone', async () => {
    const elsewhere = await root()
    const path = join(elsewhere, 'mise', 'installs', 'codex', '0.155.1', 'bin', 'codex')
    expect(await detectClientInstall('codex', path, {})).toEqual({ channel: 'mise', miseTool: 'codex' })
  })

  it('names an npm tool mise wrote no record for from the folder’s known name, and never passes one that reads as an option', async () => {
    const { data, installs } = await miseData()
    await rm(join(installs, 'npm-xai-official-grok', '.mise.backend.toml'))
    await mkdir(join(installs, 'npm-openai-codex', '0.158.0', 'bin'), { recursive: true })
    expect(await detectClientInstall('codex', join(installs, 'npm-openai-codex', '0.158.0', 'bin', 'codex'), { MISE_DATA_DIR: data }))
      .toEqual({ channel: 'mise', miseTool: 'npm:@openai/codex' })
    await mkdir(join(installs, 'odd', '1.0.0'), { recursive: true })
    await writeFile(join(installs, 'odd', '.mise.backend.toml'), 'short = "--yes"\n')
    // A folder mise left no usable record in, and that Sotto does not know, is named by nobody: the client is by hand.
    expect(await detectClientInstall('codex', join(installs, 'odd', '1.0.0', 'codex'), { MISE_DATA_DIR: data })).toEqual({ channel: 'unknown' })
  })

  it('reads Grok Build in ~/.grok/bin as mise’s when mise holds its package and npm does not', async () => {
    const { data, home } = await miseData()
    const environment = { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') }
    expect(await detectClientInstall('grok', join(home, '.grok', 'bin', 'grok'), environment)).toEqual({ channel: 'mise', miseTool: 'npm:@xai-official/grok' })
  })

  it('leaves Grok Build to npm when npm holds its package, and to its own updater when nobody does', async () => {
    const { data, home } = await miseData()
    const prefix = await root()
    await mkdir(join(prefix, 'node_modules', '@xai-official', 'grok'), { recursive: true })
    await writeFile(join(prefix, 'node_modules', '@xai-official', 'grok', 'package.json'), '{}')
    const grok = join(home, '.grok', 'bin', 'grok')
    expect((await detectClientInstall('grok', grok, { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok'), npm_config_prefix: prefix })).channel).toBe('npm')
    const bare = await root()
    expect((await detectClientInstall('grok', grok, { MISE_DATA_DIR: join(bare, 'none'), GROK_HOME: join(home, '.grok') })).channel).toBe('self-update')
  })
})

describe('what an update of a mise install runs', () => {
  it('upgrades the one tool through mise itself, and gives the same command to run by hand', async () => {
    const action = await updateActionFor('codex', { channel: 'mise', miseTool: 'codex' }, '/x/codex', async () => undefined, async () => '/usr/bin/mise')
    // Run from the home folder, so mise reads the global config and not a project's own.
    expect(action).toEqual({ command: 'mise upgrade codex', byHand: ['mise upgrade codex'], executable: '/usr/bin/mise', args: ['upgrade', 'codex'], cwd: homedir() })
  })

  it('adds Grok Build’s install step after the upgrade, and names both, with the package folder, to run by hand', async () => {
    const action = await updateActionFor('grok', { channel: 'mise', miseTool: 'npm:@xai-official/grok' }, '/x/grok', async () => undefined, async () => '/usr/bin/mise')
    expect(action).toMatchObject({ executable: '/usr/bin/mise', args: ['upgrade', 'npm:@xai-official/grok'],
      installStep: { mise: '/usr/bin/mise', tool: 'npm:@xai-official/grok', packageName: '@xai-official/grok' } })
    // The commands checked on forge on September 29, 2026.
    expect(byHandFor('grok', { channel: 'mise', miseTool: 'npm:@xai-official/grok' })).toEqual(['mise upgrade npm:@xai-official/grok',
      'cd "$(mise where npm:@xai-official/grok)/node_modules/@xai-official/grok"', 'node bin/postinstall.js'])
  })

  it('offers no press without mise, and still names the command to run by hand', async () => {
    const { data, installs } = await miseData()
    const clients = new ProviderClients({ fetchImpl: async () => answer('0.158.0'), misePath: async () => undefined })
    const reading = await clients.check('codex', '0.155.1', join(installs, 'codex', 'latest', 'bin', 'codex'), { MISE_DATA_DIR: data })
    expect(reading).toMatchObject({ channel: 'mise', behind: true, canInstall: false, command: 'mise upgrade codex', byHand: ['mise upgrade codex'] })
    expect(reading.steps).toBeUndefined()
  })

  it('reads a mise install as one step to install, and Grok Build as two', async () => {
    const { data, installs, home } = await miseData()
    const clients = new ProviderClients({ fetchImpl: async url => answer(url.includes('claude-code') ? '2.1.284' : '1.0.43'), misePath: async () => '/usr/bin/mise' })
    expect(await clients.check('claude', '2.1.281', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data }))
      .toMatchObject({ channel: 'mise', canInstall: true, steps: 1, command: 'mise upgrade claude' })
    expect(await clients.check('grok', '1.0.41', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') }))
      .toMatchObject({ channel: 'mise', canInstall: true, steps: 2, command: 'mise upgrade npm:@xai-official/grok' })
  })
})

describe('running an update of a mise install', () => {
  /** A stand-in for mise and Node: records each run and answers `mise where` with the folder mise installed in. */
  function stand(installs: string, fail?: 'upgrade' | 'install-step'): { run: RunLike; ran: { executable: string; args: readonly string[]; asNode?: boolean; cwd?: string }[] } {
    const ran: { executable: string; args: readonly string[]; asNode?: boolean; cwd?: string }[] = []
    const run: RunLike = async (executable, args, asNode, options?: RunOptions) => {
      ran.push({ executable, args, ...(asNode ? { asNode } : {}), ...(options?.cwd ? { cwd: options.cwd } : {}) })
      if (args[0] === 'upgrade') return fail === 'upgrade'
        ? { ok: false, detail: 'mise ERROR connection reset by peer', printed: 'mise ERROR Failed to install npm:@xai-official/grok@1.0.43\nmise ERROR connection reset by peer' }
        : { ok: true, stdout: '' }
      if (args[0] === 'where') return { ok: true, stdout: `${join(installs, 'npm-xai-official-grok', '1.0.41')}\n` }
      return fail === 'install-step' ? { ok: false, detail: "EACCES: permission denied, rename '…'", printed: "Error: EACCES: permission denied, rename '…'" } : { ok: true }
    }
    return { run, ran }
  }

  it('runs the upgrade, then Grok Build’s install step on this Node in the package folder, and tells each step as it starts', async () => {
    const { data, installs, home } = await miseData()
    const { run, ran } = stand(installs)
    const clients = new ProviderClients({ run, misePath: async () => '/usr/bin/mise', nodePath: '/usr/bin/node' })
    const steps: number[] = []
    const result = await clients.install('grok', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') }, step => steps.push(step))
    expect(result.ok).toBe(true)
    expect(steps).toEqual([1, 2])
    const folder = join(installs, 'npm-xai-official-grok', '1.0.41', 'node_modules', '@xai-official', 'grok')
    expect(ran).toEqual([
      { executable: '/usr/bin/mise', args: ['upgrade', 'npm:@xai-official/grok'], cwd: homedir() },
      { executable: '/usr/bin/mise', args: ['where', 'npm:@xai-official/grok'], cwd: homedir() },
      { executable: '/usr/bin/node', args: [join(folder, 'bin', 'postinstall.js')], asNode: true, cwd: folder },
    ])
  })

  it('runs Codex’s upgrade alone', async () => {
    const { data, installs } = await miseData()
    const { run, ran } = stand(installs)
    const steps: number[] = []
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise' })
      .install('codex', join(installs, 'codex', 'latest', 'bin', 'codex'), { MISE_DATA_DIR: data }, step => steps.push(step))
    expect(result.ok).toBe(true)
    expect(steps).toEqual([1])
    expect(ran).toEqual([{ executable: '/usr/bin/mise', args: ['upgrade', 'codex'], cwd: homedir() }])
  })

  it('reports a dropped download as the first step, and runs nothing after it', async () => {
    const { data, installs, home } = await miseData()
    const { run, ran } = stand(installs, 'upgrade')
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise' })
      .install('grok', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') })
    expect(result).toMatchObject({ ok: false, step: 1, failure: 'download', printed: expect.stringContaining('connection reset by peer') })
    expect(ran).toHaveLength(1)
  })

  it('reports the install step apart from the upgrade when it does not finish', async () => {
    const { data, installs, home } = await miseData()
    const { run } = stand(installs, 'install-step')
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise' })
      .install('grok', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') })
    expect(result).toMatchObject({ ok: false, step: 2, failure: 'install-step', detail: "EACCES: permission denied, rename '…'" })
  })

  it('does not run an install step the package mise installed does not have', async () => {
    const { data, installs, home } = await miseData()
    await rm(join(installs, 'npm-xai-official-grok', '1.0.41', 'node_modules'), { recursive: true })
    const { run, ran } = stand(installs)
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise' })
      .install('grok', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') })
    expect(result).toMatchObject({ ok: false, step: 2, failure: 'install-step' })
    expect(ran.map(item => item.args[0])).toEqual(['upgrade', 'where'])
  })
})

describe('the mise binary', () => {
  it('is a file whose real name is mise and not a script; anything else is passed over', async () => {
    const folder = await root()
    const real = join(folder, process.platform === 'win32' ? 'mise.exe' : 'mise')
    await writeFile(real, '\u007fELF', { mode: 0o755 })
    expect(await miseBinary(real)).toBe(real)
    const script = join(folder, 'scripts', 'mise')
    await mkdir(join(folder, 'scripts'))
    await writeFile(script, '#!/bin/sh\nexec something-else "$@"\n', { mode: 0o755 })
    expect(await miseBinary(script)).toBeUndefined()
    const other = join(folder, 'claude')
    await writeFile(other, '\u007fELF', { mode: 0o755 })
    expect(await miseBinary(other)).toBeUndefined()
  })

  describe("POSIX file symlinks; Windows may require additional privileges", () => {
    it.skipIf(process.platform === 'win32')('follows a link to the binary, and names the binary rather than the link', async () => {
      const folder = await root()
      const real = join(folder, 'mise')
      await writeFile(real, '\u007fELF', { mode: 0o755 })
      await mkdir(join(folder, 'bin'))
      await symlink(real, join(folder, 'bin', 'mise'))
      expect(await miseBinary(join(folder, 'bin', 'mise'))).toBe(real)
    })
  })
})

describe('what mise printed', () => {
  it('keeps the last lines, without home folders', () => {
    const output = ['mise ERROR Failed to install aqua:openai/codex@0.158.0', 'mise ERROR writing /home/zach/.local/share/mise/downloads/codex', 'mise ERROR connection reset by peer'].join('\n')
    expect(installerOutput(output)).toBe('mise ERROR Failed to install aqua:openai/codex@0.158.0\nmise ERROR writing …\nmise ERROR connection reset by peer')
    expect(installerOutput(Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'))?.split('\n')).toHaveLength(8)
    expect(installerOutput(' \n ')).toBeUndefined()
  })

  it('takes out this machine’s own home folder and account name wherever the home folder is', () => {
    const home = homedir(), user = userInfo().username
    const said = installerOutput(`mise ERROR writing ${join(home, '.cache', 'mise')}\nmise ERROR in /data/${user}/tools`)
    expect(said).not.toContain(home)
    expect(said?.split(/[\\/]/u)).not.toContain(user)
  })
})
