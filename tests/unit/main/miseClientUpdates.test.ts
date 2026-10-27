// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
const miseCommand = (tool: string): string => process.platform === 'win32'
  ? `cmd /c "set MISE_MINIMUM_RELEASE_AGE=0s&& mise upgrade ${tool}"` : `MISE_MINIMUM_RELEASE_AGE=0s mise upgrade ${tool}`
/** The line that installs one published version by name, after `mise cache clear <tool>`. */
const miseInstall = (tool: string, version: string): string => process.platform === 'win32'
  ? `cmd /c "set MISE_MINIMUM_RELEASE_AGE=0s&& mise install ${tool}@${version}"` : `MISE_MINIMUM_RELEASE_AGE=0s mise install ${tool}@${version}`
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
  it('gives POSIX shells an override for the one command', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(byHandFor('claude', { channel: 'mise', miseTool: 'claude' }, platform))
        .toEqual(['MISE_MINIMUM_RELEASE_AGE=0s mise upgrade claude'])
    }
  })

  it('gives Windows shells an override in a child cmd, leaving the calling shell alone', () => {
    expect(byHandFor('claude', { channel: 'mise', miseTool: 'claude' }, 'win32'))
      .toEqual(['cmd /c "set MISE_MINIMUM_RELEASE_AGE=0s&& mise upgrade claude"'])
  })

  it('includes the flag in the manual command only when mise supports it', () => {
    expect(byHandFor('claude', { channel: 'mise', miseTool: 'claude' }, 'linux', true))
      .toEqual(['MISE_MINIMUM_RELEASE_AGE=0s mise upgrade claude --minimum-release-age 0s'])
    expect(byHandFor('claude', { channel: 'mise', miseTool: 'claude' }, 'win32', true))
      .toEqual(['cmd /c "set MISE_MINIMUM_RELEASE_AGE=0s&& mise upgrade claude --minimum-release-age 0s"'])
  })

  it('upgrades the one tool through mise itself, and gives the same command to run by hand', async () => {
    const action = await updateActionFor('codex', { channel: 'mise', miseTool: 'codex' }, '/x/codex', async () => undefined, async () => '/usr/bin/mise', async () => false)
    // Run from the home folder, so mise reads the global config and not a project's own.
    expect(action).toEqual({ command: miseCommand('codex'), byHand: [miseCommand('codex')], executable: '/usr/bin/mise', args: ['upgrade', 'codex'], env: { MISE_MINIMUM_RELEASE_AGE: '0s' }, cwd: homedir() })
  })

  it('adds Grok Build’s install step after the upgrade, and names both, with the package folder, to run by hand', async () => {
    const action = await updateActionFor('grok', { channel: 'mise', miseTool: 'npm:@xai-official/grok' }, '/x/grok', async () => undefined, async () => '/usr/bin/mise', async () => false)
    expect(action).toMatchObject({ executable: '/usr/bin/mise', args: ['upgrade', 'npm:@xai-official/grok'], env: { MISE_MINIMUM_RELEASE_AGE: '0s' },
      installStep: { mise: '/usr/bin/mise', tool: 'npm:@xai-official/grok', packageName: '@xai-official/grok' } })
    // Grok Build's package layout was checked on forge on September 29, 2026; explicit updates now skip the age delay.
    expect(byHandFor('grok', { channel: 'mise', miseTool: 'npm:@xai-official/grok' })).toEqual([miseCommand('npm:@xai-official/grok'),
      'cd "$(mise where npm:@xai-official/grok)/node_modules/@xai-official/grok"', 'node bin/postinstall.js'])
  })

  it('offers no press without mise, and still names the command to run by hand', async () => {
    const { data, installs } = await miseData()
    const clients = new ProviderClients({ fetchImpl: async () => answer('0.158.0'), misePath: async () => undefined })
    const reading = await clients.check('codex', '0.155.1', join(installs, 'codex', 'latest', 'bin', 'codex'), { MISE_DATA_DIR: data })
    expect(reading).toMatchObject({ channel: 'mise', behind: true, canInstall: false, command: miseInstall('codex', '0.158.0'),
      byHand: ['mise cache clear codex', miseInstall('codex', '0.158.0')] })
    expect(reading.steps).toBeUndefined()
  })

  it('reads a mise install as one step to install, and Grok Build as two', async () => {
    const { data, installs, home } = await miseData()
    const clients = new ProviderClients({ fetchImpl: async url => answer(url.includes('claude-code') ? '2.1.284' : '1.0.43'), misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
    expect(await clients.check('claude', '2.1.281', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data }))
      .toMatchObject({ channel: 'mise', canInstall: true, steps: 1, command: miseInstall('claude', '2.1.284') })
    expect(await clients.check('grok', '1.0.41', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') }))
      .toMatchObject({ channel: 'mise', canInstall: true, steps: 2, command: miseInstall('npm:@xai-official/grok', '1.0.43') })
  })
})

describe('running an update of a mise install', () => {
  it.skipIf(process.platform === 'win32')('passes the override to a real child process without changing the app environment', async () => {
    const { data, installs, home } = await miseData()
    const mise = join(home, 'mise'), output = join(home, 'child.json')
    await writeFile(mise, `#!/usr/bin/env node\nif (process.argv.includes('--help')) console.log('--minimum-release-age <duration>'); else require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ age: process.env.MISE_MINIMUM_RELEASE_AGE, args: process.argv.slice(2) }))\n`)
    await chmod(mise, 0o755)
    vi.stubEnv('MISE_MINIMUM_RELEASE_AGE', '7d')
    try {
      const result = await new ProviderClients({ misePath: async () => mise })
        .install('claude', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data })
      expect(result.ok).toBe(true)
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ age: '0s', args: ['upgrade', 'claude', '--minimum-release-age', '0s'] })
      expect(process.env.MISE_MINIMUM_RELEASE_AGE).toBe('7d')
    } finally { vi.unstubAllEnvs() }
  })

  it('keeps upgrading with older mise versions that reject the release-age flag', async () => {
    const { data, installs } = await miseData()
    let onDisk = '2.1.296'
    const run: RunLike = async (_executable, args) => {
      if (args.includes('--minimum-release-age')) return { ok: false, detail: "unexpected argument '--minimum-release-age' found" }
      onDisk = '2.1.299'
      return { ok: true }
    }
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
      .install('claude', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data })
    expect(result.ok).toBe(true)
    expect(onDisk).toBe('2.1.299')
  })

  it('overrides a per-tool delay when mise supports the release-age flag', async () => {
    const { data, installs } = await miseData()
    let onDisk = '2.1.296'
    const run: RunLike = async (_executable, args) => {
      // A per-tool age wins over the global environment variable; only the supported CLI flag overrides it.
      if (args.includes('--minimum-release-age') && args[args.indexOf('--minimum-release-age') + 1] === '0s') onDisk = '2.1.299'
      return { ok: true }
    }
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => true })
      .install('claude', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data })
    expect(result.ok).toBe(true)
    expect(onDisk).toBe('2.1.299')
  })

  it.each([
    ['claude', 'claude', '2.1.296', '2.1.299'],
    ['codex', 'codex', '0.155.1', '0.158.0'],
    ['grok', 'npm:@xai-official/grok', '1.0.41', '1.0.43'],
  ] as const)('installs a newly published %s client without waiting for mise’s release-age delay', async (provider, tool, installed, published) => {
    const { data, installs, home } = await miseData()
    let onDisk: string = installed
    const run: RunLike = async (_executable, args, _asNode, options) => {
      if (args[0] === 'where') return { ok: true, stdout: join(installs, 'npm-xai-official-grok', '1.0.41') }
      if (args[0] === 'upgrade') {
        expect(args[1]).toBe(tool)
        // mise exits successfully when its age rule holds a release back, but leaves the old client installed.
        if (options?.env?.MISE_MINIMUM_RELEASE_AGE === '0s') onDisk = published
        return { ok: true, stdout: onDisk === installed ? 'mise All tools are up to date' : '' }
      }
      return { ok: true }
    }
    const executable = provider === 'grok' ? join(home, '.grok', 'bin', 'grok') : join(installs, provider, 'latest', provider)
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
      .install(provider, executable, { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') })
    expect(result.ok).toBe(true)
    expect(onDisk).toBe(published)
  })

  /** A stand-in for mise and Node: records each run and answers `mise where` with the folder mise installed in. */
  function stand(installs: string, fail?: 'upgrade' | 'install-step'): { run: RunLike; ran: { executable: string; args: readonly string[]; asNode?: boolean; cwd?: string; env?: Readonly<NodeJS.ProcessEnv> }[] } {
    const ran: { executable: string; args: readonly string[]; asNode?: boolean; cwd?: string; env?: Readonly<NodeJS.ProcessEnv> }[] = []
    const run: RunLike = async (executable, args, asNode, options?: RunOptions) => {
      ran.push({ executable, args, ...(asNode ? { asNode } : {}), ...(options?.cwd ? { cwd: options.cwd } : {}), ...(options?.env ? { env: options.env } : {}) })
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
    const clients = new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false, nodePath: '/usr/bin/node' })
    const steps: number[] = []
    const result = await clients.install('grok', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') }, step => steps.push(step))
    expect(result.ok).toBe(true)
    expect(steps).toEqual([1, 2])
    const folder = join(installs, 'npm-xai-official-grok', '1.0.41', 'node_modules', '@xai-official', 'grok')
    expect(ran).toEqual([
      { executable: '/usr/bin/mise', args: ['upgrade', 'npm:@xai-official/grok'], env: { MISE_MINIMUM_RELEASE_AGE: '0s' }, cwd: homedir() },
      { executable: '/usr/bin/mise', args: ['where', 'npm:@xai-official/grok'], cwd: homedir() },
      { executable: '/usr/bin/node', args: [join(folder, 'bin', 'postinstall.js')], asNode: true, cwd: folder },
    ])
  })

  it('runs Codex’s upgrade alone', async () => {
    const { data, installs } = await miseData()
    const { run, ran } = stand(installs)
    const steps: number[] = []
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
      .install('codex', join(installs, 'codex', 'latest', 'bin', 'codex'), { MISE_DATA_DIR: data }, step => steps.push(step))
    expect(result.ok).toBe(true)
    expect(steps).toEqual([1])
    expect(ran).toEqual([{ executable: '/usr/bin/mise', args: ['upgrade', 'codex'], env: { MISE_MINIMUM_RELEASE_AGE: '0s' }, cwd: homedir() }])
  })

  it('reports a dropped download as the first step, and runs nothing after it', async () => {
    const { data, installs, home } = await miseData()
    const { run, ran } = stand(installs, 'upgrade')
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
      .install('grok', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') })
    expect(result).toMatchObject({ ok: false, step: 1, failure: 'download', printed: expect.stringContaining('connection reset by peer') })
    expect(ran).toHaveLength(1)
  })

  it('reports the install step apart from the upgrade when it does not finish', async () => {
    const { data, installs, home } = await miseData()
    const { run } = stand(installs, 'install-step')
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
      .install('grok', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') })
    expect(result).toMatchObject({ ok: false, step: 2, failure: 'install-step', detail: "EACCES: permission denied, rename '…'" })
  })

  it('does not run an install step the package mise installed does not have', async () => {
    const { data, installs, home } = await miseData()
    await rm(join(installs, 'npm-xai-official-grok', '1.0.41', 'node_modules'), { recursive: true })
    const { run, ran } = stand(installs)
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
      .install('grok', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') })
    expect(result).toMatchObject({ ok: false, step: 2, failure: 'install-step' })
    expect(ran.map(item => item.args[0])).toEqual(['upgrade', 'where'])
  })
})

/**
 * October 23, 2026 on forge: Claude Code 2.1.310 was on npm and GitHub, but mise's cached version list ended at 2.1.309,
 * so `mise upgrade claude` printed "All tools are up to date", exited 0 and installed nothing. Clearing the tool's cache
 * made `mise ls-remote` list 2.1.310, `mise upgrade` still resolved the newest version through another cache, and
 * `mise install claude@2.1.310` installed it. These stand-ins keep both caches stale until the tool's is cleared.
 */
describe('a mise version list that lags what is published', () => {
  /**
   * A mise whose lists are cached: `upgrade` sees only what it knew, `ls-remote` sees the release once its cache is cleared.
   * `install` fetches the one release it is named, as aqua does by its tag, unless the release is `missing` or the
   * download drops.
   */
  function staleMise(known: string, published: string, options: { readonly listsAfterClear?: boolean; readonly listFails?: boolean
    readonly missing?: boolean; readonly downloadDrops?: boolean } = {}) {
    const ran: string[][] = []
    let cleared = false, installed = known
    const run: RunLike = async (_executable, args, _asNode, runOptions) => {
      ran.push([...args])
      if (args[0] === 'cache' && args[1] === 'clear') { cleared = true; return { ok: true, stdout: `mise cache cleared for ${args[2]}` } }
      if (args[0] === 'ls-remote') {
        if (options.listFails) return { ok: false, detail: 'mise ERROR error sending request for url' }
        const versions = [known, ...cleared && options.listsAfterClear !== false ? [published] : []]
        // `ls-remote <tool> <prefix>` lists every version that starts with the prefix.
        return { ok: true, stdout: `${versions.filter(version => version.startsWith(args[2]!)).join('\n')}\n` }
      }
      if (args[0] === 'upgrade') return { ok: true, stdout: 'mise All tools are up to date' }
      if (args[0] === 'install') {
        expect(runOptions?.cwd).toBe(homedir())
        if (options.downloadDrops) return { ok: false, detail: 'mise ERROR error sending request for url', printed: 'mise ERROR error sending request for url' }
        if (options.missing) return { ok: false, detail: 'mise ERROR HTTP status client error (404 Not Found)', printed: 'mise ERROR HTTP status client error (404 Not Found)' }
        if (runOptions?.env?.MISE_MINIMUM_RELEASE_AGE === '0s') installed = args[1]!.slice(args[1]!.lastIndexOf('@') + 1)
        return { ok: true }
      }
      if (args[0] === 'where') return { ok: true, stdout: `${join(homedir(), 'mise', 'installs', 'npm-xai-official-grok', installed)}\n` }
      return { ok: true }
    }
    return { run, ran, installed: () => installed }
  }

  /** forge's mise installs: Claude Code, Codex and OpenCode through aqua, Grok Build through npm, Muse over http. */
  async function forgeMise(): Promise<{ data: string; installs: string; home: string }> {
    const found = await miseData()
    for (const [folder, short, version, file] of [['opencode', 'opencode', '1.19.3', 'opencode'], ['http-muse', 'http:muse', '1.4.11-R6667.1', 'muse']] as const) {
      await mkdir(join(found.installs, folder, version), { recursive: true })
      await writeFile(join(found.installs, folder, '.mise.backend.toml'), `short = "${short}"\n`)
      await writeFile(join(found.installs, folder, version, file), '')
    }
    return found
  }

  it.each([
    ['claude', 'claude', '2.1.309', '2.1.310', ['claude', 'latest', 'claude']],
    ['codex', 'codex', '0.163.0', '0.164.0', ['codex', 'latest', 'bin', 'codex']],
    ['opencode', 'opencode', '1.19.3', '1.19.4', ['opencode', 'latest', 'opencode']],
    ['muse', 'http:muse', '1.4.11-R6667.1', '1.4.12-R6909.1', ['http-muse', 'latest', 'muse']],
  ] as const)('clears mise’s cache of %s, checks its list has the published version, and installs that version by name', async (provider, tool, known, published, path) => {
    const { data, installs } = await forgeMise()
    const { run, ran, installed } = staleMise(known, published)
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => true })
      .install(provider, join(installs, ...path), { MISE_DATA_DIR: data }, undefined, published)
    expect(result.ok).toBe(true)
    expect(installed()).toBe(published)
    expect(ran).toEqual([
      ['cache', 'clear', tool],
      ['ls-remote', tool, published, '--minimum-release-age', '0s'],
      ['install', `${tool}@${published}`, '--minimum-release-age', '0s'],
    ])
  })

  it('installs Grok Build’s published version by name, and asks mise where that version is for its install step', async () => {
    const { data, home } = await forgeMise()
    const { run, ran, installed } = staleMise('1.0.67', '1.0.68')
    const steps: number[] = []
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false, nodePath: '/usr/bin/node' })
      .install('grok', join(home, '.grok', 'bin', 'grok'), { MISE_DATA_DIR: data, GROK_HOME: join(home, '.grok') }, step => steps.push(step), '1.0.68')
    expect(installed()).toBe('1.0.68')
    expect(steps).toEqual([1, 2])
    expect(ran).toEqual([['cache', 'clear', 'npm:@xai-official/grok'], ['ls-remote', 'npm:@xai-official/grok', '1.0.68'],
      ['install', 'npm:@xai-official/grok@1.0.68'], ['where', 'npm:@xai-official/grok@1.0.68']])
    // The stand-in's folder holds no package, so the install step reports; what matters is the version it was asked about.
    expect(result).toMatchObject({ ok: false, step: 2, failure: 'install-step' })
  })

  /**
   * October 27, 2026 on forge: GitHub's list of Codex releases timed out and mise's versions host stopped at
   * 0.164.0-alpha.12, so `mise ls-remote codex` ended at 0.163.0 with every cache cleared. `mise install codex@0.165.0`
   * fetched that one release by its tag and installed it.
   */
  it.each([
    ['claude', 'claude', '2.1.309', '2.1.310', ['claude', 'latest', 'claude']],
    ['codex', 'codex', '0.164.0', '0.165.0', ['codex', 'latest', 'bin', 'codex']],
    ['opencode', 'opencode', '1.19.3', '1.19.4', ['opencode', 'latest', 'opencode']],
    ['muse', 'http:muse', '1.4.11-R6667.1', '1.4.12-R6909.1', ['http-muse', 'latest', 'muse']],
  ] as const)('installs %s’s published version by name even when mise’s list never has it', async (provider, tool, known, published, path) => {
    const { data, installs } = await forgeMise()
    const { run, ran, installed } = staleMise(known, published, { listsAfterClear: false })
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => true })
      .install(provider, join(installs, ...path), { MISE_DATA_DIR: data }, undefined, published)
    expect(result.ok).toBe(true)
    expect(installed()).toBe(published)
    expect(ran.map(args => args.slice(0, 2))).toEqual([['cache', 'clear'], ['ls-remote', tool], ['install', `${tool}@${published}`]])
  })

  it('says mise does not list the version when its list lacks it and installing it anyway fails', async () => {
    const { data, installs } = await forgeMise()
    // mise lists 2.1.3100, which starts with the version asked for but is not it.
    const { run, ran, installed } = staleMise('2.1.309', '2.1.3100', { missing: true })
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
      .install('claude', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data }, undefined, '2.1.310')
    expect(result).toEqual({ ok: false, step: 1, failure: 'not-listed', printed: 'mise ERROR HTTP status client error (404 Not Found)',
      detail: 'mise does not list Claude Code 2.1.310 yet, and installing it anyway did not work. Nothing was changed. Try again later.' })
    expect(installed()).toBe('2.1.309')
    expect(ran.map(args => args[0])).toEqual(['cache', 'ls-remote', 'install'])
  })

  it('reads a dropped download as the download’s failure, whether or not mise lists the version', async () => {
    const { data, installs } = await forgeMise()
    for (const listsAfterClear of [true, false]) {
      const { run } = staleMise('2.1.309', '2.1.310', { listsAfterClear, downloadDrops: true })
      const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
        .install('claude', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data }, undefined, '2.1.310')
      expect(result, String(listsAfterClear)).toMatchObject({ ok: false, step: 1, failure: 'download' })
    }
  })

  it('reads a failed install of a version mise lists as the installer’s failure', async () => {
    const { data, installs } = await forgeMise()
    const { run } = staleMise('2.1.309', '2.1.310', { missing: true })
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
      .install('claude', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data }, undefined, '2.1.310')
    expect(result).toMatchObject({ ok: false, step: 1, failure: 'installer', detail: 'mise ERROR HTTP status client error (404 Not Found)' })
  })

  it('still installs when mise cannot read its list, and lets the install say how it went', async () => {
    const { data, installs } = await forgeMise()
    const { run, ran, installed } = staleMise('2.1.309', '2.1.310', { listFails: true })
    const result = await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
      .install('claude', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data }, undefined, '2.1.310')
    expect(result.ok).toBe(true)
    expect(installed()).toBe('2.1.310')
    expect(ran.map(args => args[0])).toEqual(['cache', 'ls-remote', 'install'])
  })

  it('upgrades as before when no published version is known, and never pins one that reads as an option', async () => {
    const { data, installs } = await forgeMise()
    for (const version of [undefined, '--yes', 'latest']) {
      const { run, ran } = staleMise('2.1.309', '2.1.310')
      await new ProviderClients({ run, misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
        .install('claude', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data }, undefined, version)
      expect(ran, String(version)).toEqual([['upgrade', 'claude']])
    }
  })

  it('names the cache clear and the install by version to run by hand, on POSIX and Windows', () => {
    const install = { channel: 'mise' as const, miseTool: 'claude' }
    expect(byHandFor('claude', install, 'linux', false, '2.1.310')).toEqual(['mise cache clear claude', 'MISE_MINIMUM_RELEASE_AGE=0s mise install claude@2.1.310'])
    expect(byHandFor('claude', install, 'win32', true, '2.1.310'))
      .toEqual(['mise cache clear claude', 'cmd /c "set MISE_MINIMUM_RELEASE_AGE=0s&& mise install claude@2.1.310 --minimum-release-age 0s"'])
    expect(byHandFor('grok', { channel: 'mise', miseTool: 'npm:@xai-official/grok' }, 'linux', false, '1.0.68')).toEqual(['mise cache clear npm:@xai-official/grok',
      'MISE_MINIMUM_RELEASE_AGE=0s mise install npm:@xai-official/grok@1.0.68', 'cd "$(mise where npm:@xai-official/grok@1.0.68)/node_modules/@xai-official/grok"', 'node bin/postinstall.js'])
  })

  it('reads a client behind what is published as an install of that version, and one up to date as an upgrade', async () => {
    const { data, installs } = await forgeMise()
    const clients = new ProviderClients({ fetchImpl: async () => answer('2.1.310'), misePath: async () => '/usr/bin/mise', miseReleaseAgeFlag: async () => false })
    expect(await clients.check('claude', '2.1.309', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data }))
      .toMatchObject({ behind: true, canInstall: true, command: miseInstall('claude', '2.1.310'), byHand: ['mise cache clear claude', miseInstall('claude', '2.1.310')] })
    expect(await clients.check('claude', '2.1.310', join(installs, 'claude', 'latest', 'claude'), { MISE_DATA_DIR: data }))
      .toMatchObject({ behind: false, canInstall: false, command: miseCommand('claude') })
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
