// @vitest-environment node
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installGuiPath, mergePath, pathLine, pathLooksTruncated, readLoginShellPath, staticPathCandidates } from '../../../src/main/app/guiPath'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

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

  it('keeps the system PATH first and adds each directory once', () => {
    expect(mergePath('/usr/bin:/bin', ['/opt/homebrew/bin', '/usr/bin', '/Users/tomas/.local/bin'])).toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/tomas/.local/bin')
    expect(pathLine('welcome\n/opt/homebrew/bin:/usr/bin:/bin\n')).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(pathLine('not a path')).toBeNull()
  })

  it('adds directories that exist and a login PATH only when the process PATH is truncated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-gui-path-'))
    roots.push(root)
    const home = join(root, 'home')
    const localBin = join(home, '.local', 'bin')
    const grokBin = join(home, '.grok', 'bin')
    await writeFile(join(root, 'skip'), '')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(localBin, { recursive: true })
    await mkdir(grokBin, { recursive: true })
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
    await installGuiPath(env, {
      platform: 'linux', home, loginPath: async () => `${join(root, 'from-login')}:${localBin}`,
    })
    const entries = env.PATH?.split(':') ?? []
    expect(entries.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    expect(entries).toContain(localBin)
    expect(entries).toContain(grokBin)
    expect(entries).not.toContain(join(root, 'from-login'))
    const already: NodeJS.ProcessEnv = { PATH: `${localBin}:/usr/bin:/bin` }
    let asked = false
    await installGuiPath(already, { platform: 'linux', home, loginPath: async () => { asked = true; return '/opt/extra' } })
    expect(asked).toBe(false)
    expect(already.PATH?.startsWith(`${localBin}:/usr/bin:/bin`)).toBe(true)
    expect(already.PATH).toContain(grokBin)
  })

  it('reads PATH from a login shell and gives up when that shell does not finish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-login-path-'))
    roots.push(root)
    const shell = join(root, 'shell')
    await writeFile(shell, '#!/bin/sh\nprintf \'%s\\n\' "hello"\nprintf \'%s\' "/opt/homebrew/bin:/usr/bin:/bin"\n')
    await chmod(shell, 0o755)
    expect(await readLoginShellPath(shell, 2_000)).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    const hung = join(root, 'hung')
    await writeFile(hung, `#!${process.execPath}\nsetTimeout(() => {}, 30000)\n`)
    await chmod(hung, 0o755)
    expect(await readLoginShellPath(hung, 200)).toBeNull()
  })
})
