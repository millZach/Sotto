// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installGuiPath, loginShellCommand, mergePath, nvmDefaultBin, pathLine, pathLooksTruncated, readShellPath, staticPathCandidates } from '../../../src/main/app/guiPath'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** Pretends exactly these POSIX directories exist, so the merge logic runs the same on the Windows runner. */
const only = (...dirs: string[]) => async (candidates: readonly string[]) => candidates.filter(dir => dirs.includes(dir))

describe('GUI process PATH', () => {
  it('treats the macOS Dock PATH as truncated and a login PATH as complete', () => {
    const home = '/Users/tomas'
    expect(pathLooksTruncated('/usr/bin:/bin:/usr/sbin:/sbin', home, 'darwin')).toBe(true)
    expect(pathLooksTruncated(`/usr/bin:/bin:${home}/.local/bin`, home, 'darwin')).toBe(false)
    expect(pathLooksTruncated('/usr/bin:/bin:/opt/homebrew/bin', home, 'darwin')).toBe(false)
    expect(pathLooksTruncated('C:\\Windows\\System32', home, 'win32')).toBe(false)
    expect(staticPathCandidates(home, 'darwin')).toContain('/opt/homebrew/bin')
    expect(staticPathCandidates(home, 'darwin')).toContain(`${home}/.local/bin`)
  })

  it('puts leading directories before the current PATH, trailing ones after, and each directory once', () => {
    expect(mergePath('/usr/bin:/bin', ['/opt/homebrew/bin', '/usr/bin', '/Users/tomas/.local/bin'])).toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/tomas/.local/bin')
    expect(mergePath('/usr/bin:/bin', [], ['/opt/homebrew/bin', '/usr/bin', '/Users/tomas/.local/bin'])).toBe('/opt/homebrew/bin:/usr/bin:/Users/tomas/.local/bin:/bin')
    expect(pathLine('welcome\n/opt/homebrew/bin:/usr/bin:/bin\n')).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(pathLine('not a path')).toBeNull()
  })

  it('puts the login PATH ahead of the system folders on a Dock launch, as Terminal does', async () => {
    const home = '/Users/tomas'
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
    await installGuiPath(env, {
      platform: 'darwin', home, nvmBin: async () => null,
      loginPath: async () => '/opt/homebrew/bin:/usr/bin:/bin:/missing/bin',
      existing: only('/opt/homebrew/bin', '/usr/bin', '/bin', `${home}/.local/bin`),
    })
    expect(env.PATH).toBe(`/opt/homebrew/bin:/usr/bin:/bin:${home}/.local/bin:/usr/sbin:/sbin`)
  })

  it('still puts Homebrew first when the login shell cannot be read', async () => {
    const home = '/Users/tomas'
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
    await installGuiPath(env, {
      platform: 'darwin', home, nvmBin: async () => `${home}/.nvm/versions/node/v22.3.0/bin`,
      loginPath: async () => null,
      existing: only('/opt/homebrew/bin', `${home}/.nvm/versions/node/v22.3.0/bin`),
    })
    expect(env.PATH).toBe(`/opt/homebrew/bin:${home}/.nvm/versions/node/v22.3.0/bin:/usr/bin:/bin`)
  })

  it('keeps a full PATH in its order, adds missing folders after it and never asks the login shell', async () => {
    const home = '/home/tomas'
    const env: NodeJS.ProcessEnv = { PATH: `${home}/.local/bin:/usr/bin:/bin` }
    let asked = false
    await installGuiPath(env, {
      platform: 'linux', home, nvmBin: async () => null,
      loginPath: async () => { asked = true; return '/opt/extra' },
      existing: only(`${home}/.local/bin`, `${home}/.grok/bin`),
    })
    expect(asked).toBe(false)
    expect(env.PATH).toBe(`${home}/.local/bin:/usr/bin:/bin:${home}/.grok/bin`)
  })

  it('leaves a Windows PATH alone', async () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    await installGuiPath(env, { platform: 'win32', home: 'C:\\Users\\tomas' })
    expect(env).toEqual({ Path: 'C:\\Windows' })
  })

  it('launches only an absolute login shell, interactively', () => {
    expect(loginShellCommand('/bin/zsh')).toEqual({ command: '/bin/zsh', args: ['-ilc', 'printf %s "$PATH"'] })
    expect(loginShellCommand('zsh')).toBeNull()
    expect(loginShellCommand('/usr/bin/false')).toBeNull()
    expect(loginShellCommand('/sbin/nologin')).toBeNull()
  })
})

describe('nvm default Node', () => {
  async function nvm(aliases: Record<string, string>, versions: string[]): Promise<string> {
    const dir = await scratch('sotto-nvm-')
    for (const version of versions) await mkdir(join(dir, 'versions', 'node', version, 'bin'), { recursive: true })
    for (const [name, value] of Object.entries(aliases)) {
      await mkdir(join(dir, 'alias', ...name.split('/').slice(0, -1)), { recursive: true })
      await writeFile(join(dir, 'alias', ...name.split('/')), `${value}\n`)
    }
    return dir
  }
  const bin = (dir: string, version: string): string => posix.join(dir, 'versions', 'node', version, 'bin')
  const versions = ['v18.20.4', 'v22.3.0', 'v22.11.0', 'v24.2.0']

  it('resolves an exact version, a major, a minor and the newest installed Node', async () => {
    expect(await nvmDefaultBin(await nvm({ default: 'v22.3.0' }, versions))).toBe(bin(roots.at(-1)!, 'v22.3.0'))
    expect(await nvmDefaultBin(await nvm({ default: '22' }, versions))).toBe(bin(roots.at(-1)!, 'v22.11.0'))
    expect(await nvmDefaultBin(await nvm({ default: 'v22.3' }, versions))).toBe(bin(roots.at(-1)!, 'v22.3.0'))
    expect(await nvmDefaultBin(await nvm({ default: 'node' }, versions))).toBe(bin(roots.at(-1)!, 'v24.2.0'))
    expect(await nvmDefaultBin(await nvm({ default: 'stable' }, versions))).toBe(bin(roots.at(-1)!, 'v24.2.0'))
  })

  it('follows lts and named aliases to the version they name', async () => {
    expect(await nvmDefaultBin(await nvm({ default: 'lts/jod', 'lts/jod': 'v22.11.0' }, versions))).toBe(bin(roots.at(-1)!, 'v22.11.0'))
    expect(await nvmDefaultBin(await nvm({ default: 'work', work: '18' }, versions))).toBe(bin(roots.at(-1)!, 'v18.20.4'))
  })

  // nvm's `lts/*` alias is a file named `*`, which Windows cannot create; nvm does not run there either.
  it.skipIf(process.platform === 'win32')('follows default -> lts/* to the newest LTS nvm recorded', async () => {
    expect(await nvmDefaultBin(await nvm({ default: 'lts/*', 'lts/*': 'lts/jod', 'lts/jod': 'v22.11.0' }, versions))).toBe(bin(roots.at(-1)!, 'v22.11.0'))
  })

  it('finds nothing for an uninstalled version, a system alias, a loop or no alias at all', async () => {
    expect(await nvmDefaultBin(await nvm({ default: '20' }, versions))).toBeNull()
    expect(await nvmDefaultBin(await nvm({ default: 'system' }, versions))).toBeNull()
    expect(await nvmDefaultBin(await nvm({ default: 'a', a: 'b', b: 'a' }, versions))).toBeNull()
    expect(await nvmDefaultBin(await nvm({ default: '../../etc' }, versions))).toBeNull()
    expect(await nvmDefaultBin(await nvm({}, versions))).toBeNull()
    expect(await nvmDefaultBin(join(await scratch('sotto-no-nvm-'), 'missing'))).toBeNull()
  })
})

describe('reading the login shell PATH', () => {
  /** A Node script stands in for the shell, run by the test's own Node so no shebang is needed on Windows. */
  async function shell(source: string): Promise<{ command: string; args: string[] }> {
    const script = join(await scratch('sotto-login-path-'), 'shell.js')
    await writeFile(script, source)
    return { command: process.execPath, args: [script] }
  }
  const env = { ...process.env }

  it('reads the last PATH line the shell prints', async () => {
    expect(await readShellPath(await shell(`process.stdout.write('hello\\n/opt/homebrew/bin:/usr/bin:/bin')`), 5_000, env)).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(await readShellPath(await shell(`process.stdout.write('/usr/bin'); process.exitCode = 1`), 5_000, env)).toBeNull()
  })

  it('gives up when the shell does not finish', async () => {
    const started = Date.now()
    expect(await readShellPath(await shell('setTimeout(() => {}, 30000)'), 300, env)).toBeNull()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('does not wait for a background process the shell left holding its output', async () => {
    const started = Date.now()
    // The shell prints PATH and exits, but its child inherits stdout and keeps it open, as gitstatusd or tmux would.
    const source = [
      `const { spawn } = require('node:child_process')`,
      `spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'ignore'] })`,
      `process.stdout.write('/opt/homebrew/bin:/usr/bin:/bin', () => process.exit(0))`,
    ].join('\n')
    expect(await readShellPath(await shell(source), 6_000, env)).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
