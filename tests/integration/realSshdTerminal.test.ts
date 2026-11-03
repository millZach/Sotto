// @vitest-environment node
/**
 * A shell over SSH against a real OpenSSH server (ADR-0183): the real ssh client under the real node-pty, through the
 * terminal service, into a throwaway sshd on a loopback port. Opt-in through SOTTO_REAL_SSHD=1, because it needs a POSIX
 * machine with openssh-server; the Linux CI job sets it (docs/ci.md). Nothing here touches the account's own ~/.ssh.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { banner, freePort } from '../fixtures/loopbackSshd'
import { FilesService } from '../../src/main/files/service'
import { hostedTerminals } from '../../src/main/hosts/hostedTerminals'
import { TerminalService } from '../../src/main/tools/terminal'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { TerminalEvent } from '../../src/shared/terminal'
import type { ToolsResult } from '../../src/shared/tools'

const enabled = process.env.SOTTO_REAL_SSHD === '1'
if (!enabled && process.env.SOTTO_REAL_SSHD_REQUIRED === '1') throw new Error('The real-sshd terminal journey would be skipped: set SOTTO_REAL_SSHD=1.')
const PASSPHRASE = 'synthetic-real-sshd-terminal-passphrase'
const FORGE = '22222222-2222-4222-8222-222222222222'
const THREAD = hostEntityKey(FORGE, 'thread')
const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
let root: string, sshd: ChildProcess | undefined, sshdLog = ''

describe.skipIf(!enabled)('a shell over SSH against a real OpenSSH server (requires SOTTO_REAL_SSHD=1)', () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-real-sshd-terminal-')))
    const keygen = process.env.SOTTO_SSH_KEYGEN ?? 'ssh-keygen'
    execFileSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'sotto-terminal-host', '-f', join(root, 'host_key')])
    execFileSync(keygen, ['-q', '-t', 'ed25519', '-N', PASSPHRASE, '-C', 'sotto-terminal-client', '-f', join(root, 'client_key')])
    await writeFile(join(root, 'authorized_keys'), await readFile(join(root, 'client_key.pub')), { mode: 0o600 })
    const port = await freePort()
    await writeFile(join(root, 'sshd_config'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(root, 'host_key')}`, `PidFile ${join(root, 'sshd.pid')}`,
      `AuthorizedKeysFile ${join(root, 'authorized_keys')}`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes',
      'PermitTTY yes', `AllowUsers ${userInfo().username}`, 'LogLevel VERBOSE', ''].join('\n'))
    await writeFile(join(root, 'ssh_config'), ['Host localhost', `  Port ${port}`, `  UserKnownHostsFile ${join(root, 'known_hosts')}`, '  GlobalKnownHostsFile /dev/null', '  UpdateHostKeys no', '  AddKeysToAgent no', ''].join('\n'))
    sshd = spawn(process.env.SOTTO_SSHD ?? '/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] })
    sshd.stderr!.setEncoding('utf8')
    sshd.stderr!.on('data', (chunk: string) => { sshdLog = (sshdLog + chunk).slice(-32_768) })
    const deadline = Date.now() + 10_000
    while (!(await banner(port))) {
      if (sshd.exitCode !== null || Date.now() > deadline) throw new Error('sshd did not start:\n' + sshdLog)
      await new Promise(done => setTimeout(done, 100))
    }
  }, 60_000)
  afterAll(async () => {
    sshd?.kill('SIGTERM')
    if (root?.includes('sotto-real-sshd-terminal-')) await rm(root, { recursive: true, force: true })
  })

  it('asks in the terminal, starts in the project folder, carries typing and size, and ends with the connection', { timeout: 120_000 }, async () => {
    const folder = join(root, `a "project's" folder`)
    await mkdir(folder)
    const output: string[] = []
    const events: TerminalEvent[] = []
    const env = { ...process.env }
    delete env.SSH_AUTH_SOCK; delete env.SSH_ASKPASS
    const service = new TerminalService({
      files: new FilesService({ resolveBinding: () => null, copyPath: () => undefined, reveal: () => undefined } as never),
      directory: join(root, 'desktop-data'), env, platform: process.platform,
      hosted: hostedTerminals({
        folders: () => ({ hostId: FORGE, projectId: hostEntityKey(FORGE, 'project'), projectFolder: folder, workingDirectory: join(root, 'gone') }),
        host: () => ({ target: `${userInfo().username}@localhost`, identityFile: join(root, 'client_key') }),
        ssh: { file: 'ssh', args: ['-F', join(root, 'ssh_config')] },
      }),
      emit: event => { events.push(event); if (event.type === 'output') output.push(event.data) },
    })
    await mkdir(join(root, 'desktop-data'), { recursive: true })
    const printed = (): string => output.join('')
    const until = (text: string): Promise<void> => vi.waitFor(() => { if (!printed().includes(text)) throw new Error(`waiting for ${text}, have: ${printed().slice(-400)}\nsshd: ${sshdLog.slice(-400)}`) }, { timeout: 30_000, interval: 100 })
    try {
      const { workspace } = unwrap(await service.list({ threadId: THREAD, place: 'drawer' }))
      const { session } = unwrap(await service.create({ threadId: THREAD, workspaceId: workspace.workspaceId, place: 'drawer', cols: 100, rows: 30 }))
      const request = { threadId: THREAD, workspaceId: workspace.workspaceId, sessionId: session.id }
      // OpenSSH asks its own questions on the terminal it was given: the unknown host, then the key's passphrase.
      await until('continue connecting')
      unwrap(await service.write({ ...request, data: 'yes\r' }))
      await until('Enter passphrase')
      unwrap(await service.write({ ...request, data: `${PASSPHRASE}\r` }))
      // The marker is printed in two parts, so the echo of the command itself never matches.
      unwrap(await service.write({ ...request, data: 'printf "%s:%s\\n" "MARK""ER" "$PWD"; stty size\r' }))
      await until(`MARKER:${folder}`)
      await until('30 100')
      unwrap(await service.resize({ ...request, cols: 90, rows: 20 }))
      await new Promise(done => setTimeout(done, 300))
      unwrap(await service.write({ ...request, data: 'stty size\r' }))
      await until('20 90')
      // A shell that exits by itself passes on its own code; only a lost connection is 255.
      unwrap(await service.write({ ...request, data: 'exit 7\r' }))
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'session', session: expect.objectContaining({ id: session.id, status: 'exited', exitCode: 7 }) }), { timeout: 15_000 })

      const second = unwrap(await service.reopen(request)).session
      output.length = 0
      await until('Enter passphrase')
      unwrap(await service.write({ ...request, sessionId: second.id, data: `${PASSPHRASE}\r` }))
      unwrap(await service.write({ ...request, sessionId: second.id, data: 'printf "%s\\n" "UP""AGAIN"\r' }))
      await until('UPAGAIN')
      // Killing the shell's own sshd drops this connection without a goodbye.
      unwrap(await service.write({ ...request, sessionId: second.id, data: 'kill -9 $PPID\r' }))
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'session', session: expect.objectContaining({ id: second.id, status: 'exited', exitCode: 255 }) }), { timeout: 30_000 })
    } finally { service.dispose() }
  })
})
