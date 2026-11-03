// @vitest-environment node
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { remoteShellCommand, sshTerminalArguments } from '../../../src/main/hosts/sshTerminal'

describe('a shell over SSH (ADR-0183)', () => {
  const host = { target: 'zach@forge' }

  it('asks for a terminal, ends a dead connection in about a minute and leaves a typed ~ to the shell', () => {
    const args = sshTerminalArguments(host, ['/home/zach/repo'])
    expect(args[0]).toBe('-tt')
    expect(args).toEqual(expect.arrayContaining(['ServerAliveInterval=15', 'ServerAliveCountMax=4', 'BatchMode=no', 'RemoteCommand=none', 'ControlMaster=no']))
    expect(args.slice(args.indexOf('-e'), args.indexOf('-e') + 2)).toEqual(['-e', 'none'])
  })

  it('keeps the target behind -- and the remote command last, so neither can read as an option', () => {
    const args = sshTerminalArguments({ target: 'zach@forge', sshPort: 2222, identityFile: '/keys/forge' }, ['/repo'])
    const end = args.indexOf('--')
    expect(args[end + 1]).toBe('zach@forge')
    expect(args).toHaveLength(end + 3)
    expect(args.slice(0, end)).toEqual(expect.arrayContaining(['-p', '2222', '-i', '/keys/forge', 'IdentitiesOnly=yes']))
  })

  it('names no key or port the saved host did not', () => {
    const args = sshTerminalArguments(host, [])
    expect(args).not.toContain('-i')
    expect(args).not.toContain('-p')
  })

  it('carries a folder as base64, one word to every login shell, whatever its name holds', () => {
    const folder = `/home/zach/it's "a" $(rm -rf x) folder`
    const command = remoteShellCommand([folder])
    expect(command).toContain(Buffer.from(folder, 'utf8').toString('base64'))
    expect(command).not.toContain('rm -rf')
    expect(command.startsWith(`sh -c '`) && command.endsWith(`'`)).toBe(true)
    expect(command.slice(`sh -c '`.length, -1)).not.toContain(`'`)
  })

  it.skipIf(process.platform === 'win32')('starts in the first folder that opens, in the account\'s own shell, and stays home when none does', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-ssh-terminal-')))
    try {
      const folder = join(root, `it's a "folder"`)
      await mkdir(folder)
      const run = (folders: string[]): string => {
        const body = remoteShellCommand(folders).slice(`sh -c '`.length, -1).replace('exec "${SHELL:-/bin/sh}" -l', 'printf "%s|%s|%s" "$PWD" "$COLORTERM" "$TERM_PROGRAM"')
        return execFileSync('sh', ['-c', body], { cwd: root, encoding: 'utf8' })
      }
      expect(run([join(root, 'gone'), folder])).toBe(`${folder}|truecolor|Sotto`)
      expect(run([join(root, 'gone')])).toBe(`${root}|truecolor|Sotto`)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('runs PowerShell for a folder written the Windows way, its name encoded, with no sh to find', () => {
    const command = remoteShellCommand([`C:\\Users\\zach\\it's here`, 'D:\\work'])
    expect(command.startsWith('powershell -NoLogo -NoExit -EncodedCommand ')).toBe(true)
    const script = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le')
    // The last Set-Location wins, so the first folder asked for runs last.
    expect(script.indexOf('D:\\work')).toBeLessThan(script.indexOf('C:\\Users'))
    expect(script).toContain(`'C:\\Users\\zach\\it''s here'`)
  })
})
