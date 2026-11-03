// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilesService } from '../../../src/main/files/service'
import { hostedTerminals, type HostThreadFolders } from '../../../src/main/hosts/hostedTerminals'
import { TerminalService, type HostedTerminals } from '../../../src/main/tools/terminal'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { TerminalEvent } from '../../../src/shared/terminal'
import type { ToolsResult } from '../../../src/shared/tools'

const FORGE = '22222222-2222-4222-8222-222222222222'
const THREAD = hostEntityKey(FORGE, 'thread')
const FOLDERS: HostThreadFolders = { hostId: FORGE, projectId: hostEntityKey(FORGE, 'project'), workingDirectory: '/data/worktrees/thread', projectFolder: '/home/zach/repo' }
const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(options: { hosted?: HostedTerminals | null; folders?: () => HostThreadFolders | undefined; host?: () => { target: string } | undefined } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-hosted-terminal-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const resolveBinding = vi.fn(() => null)
  const files = new FilesService({ resolveBinding, copyPath: vi.fn(), reveal: vi.fn() })
  const events: TerminalEvent[] = []
  const processes: { exit(code: number): void; pty: IPty }[] = []
  const spawn = vi.fn<(file: string, args: string[], options: { cwd?: string | undefined }) => IPty>(() => {
    let exitListener: (exit: { exitCode: number }) => void = () => {}
    const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: () => ({ dispose: () => undefined }), onExit: (listener: typeof exitListener) => { exitListener = listener; return { dispose: () => undefined } } } as unknown as IPty
    processes.push({ pty, exit: code => exitListener({ exitCode: code }) })
    return pty
  })
  const hosted = options.hosted === null ? undefined : options.hosted ?? hostedTerminals({ folders: options.folders ?? (() => FOLDERS), host: options.host ?? (() => ({ target: 'zach@forge' })), ssh: { file: 'ssh' } })
  const acquireStart = vi.fn(async () => () => undefined)
  const service = new TerminalService({ files, directory, spawn: spawn as never, platform: 'linux', env: {}, emit: event => events.push(event), acquireStart, runCommandEnabled: true, hosted })
  cleanup.push(async () => service.dispose())
  return { service, spawn, events, processes, acquireStart, resolveBinding }
}

describe('the terminal of a thread on a paired host (ADR-0183)', () => {
  it('runs ssh from this computer, naming only what main worked out, and touches no folder here', async () => {
    const f = await fixture()
    const { workspace } = unwrap(await f.service.list({ threadId: THREAD, place: 'drawer' }))
    const snapshot = unwrap(await f.service.create({ threadId: THREAD, workspaceId: workspace.workspaceId, place: 'drawer', cols: 100, rows: 30 }))
    const [file, args, options] = f.spawn.mock.calls[0]!
    expect(file).toBe('ssh')
    expect(args[0]).toBe('-tt')
    expect(args[args.indexOf('--') + 1]).toBe('zach@forge')
    expect(options.cwd).toBe(homedir())
    expect(snapshot.session).toMatchObject({ shell: 'ssh', title: 'shell', place: 'drawer', status: 'running', cols: 100, rows: 30 })
    expect(f.acquireStart).not.toHaveBeenCalled()
    expect(f.resolveBinding).not.toHaveBeenCalled()
  })

  it.each([['drawer', 'project folder', ['/home/zach/repo', '/data/worktrees/thread']], ['tools', 'working copy', ['/data/worktrees/thread', '/home/zach/repo']]] as const)('starts a %s shell in the %s, and falls back to the other', async (place, _where, order) => {
    const launch = hostedTerminals({ folders: () => FOLDERS, host: () => ({ target: 'forge' }), ssh: { file: 'ssh', args: ['stand-in.mjs'] } })
    const { args, file } = launch.launch(launch.workspace(THREAD), place)
    expect(file).toBe('ssh')
    expect(args[0]).toBe('stand-in.mjs')
    const words = args.at(-1)!.match(/printf %s (\S+) \|/gu)!.map(word => Buffer.from(word.split(' ')[2]!, 'base64').toString('utf8'))
    expect(words).toEqual([...order])
  })

  it('types, resizes and ends a live shell without asking the host, so a dropped socket does not stop it', async () => {
    let folders: HostThreadFolders | undefined = FOLDERS
    const f = await fixture({ folders: () => folders })
    const { workspace } = unwrap(await f.service.list({ threadId: THREAD, place: 'drawer' }))
    const { session } = unwrap(await f.service.create({ threadId: THREAD, workspaceId: workspace.workspaceId, place: 'drawer' }))
    const request = { threadId: THREAD, workspaceId: workspace.workspaceId, sessionId: session.id }
    folders = undefined // The host is gone from this computer's view.
    unwrap(await f.service.write({ ...request, data: 'ls\r' }))
    unwrap(await f.service.resize({ ...request, cols: 90, rows: 20 }))
    unwrap(await f.service.interrupt(request))
    expect(vi.mocked(f.processes[0]!.pty.write).mock.calls.map(call => call[0])).toEqual(['ls\r', '\x03'])
    expect(f.processes[0]!.pty.resize).toHaveBeenCalledWith(90, 20)
  })

  it('keeps the same workspace when the thread\'s folder moves, so a shell stays on its tab', async () => {
    let folders = FOLDERS
    const f = await fixture({ folders: () => folders })
    const before = unwrap(await f.service.list({ threadId: THREAD })).workspace.workspaceId
    folders = { ...FOLDERS, workingDirectory: '/data/worktrees/moved' }
    const after = unwrap(await f.service.list({ threadId: THREAD })).workspace
    expect(after.workspaceId).toBe(before)
    expect(after.workingDirectory).toBe('/data/worktrees/moved')
  })

  it('reports ssh\'s exit like any shell\'s, and Reopen starts a new one', async () => {
    const f = await fixture()
    const { workspace } = unwrap(await f.service.list({ threadId: THREAD, place: 'drawer' }))
    const { session } = unwrap(await f.service.create({ threadId: THREAD, workspaceId: workspace.workspaceId, place: 'drawer' }))
    f.processes[0]!.exit(255)
    await vi.waitFor(() => expect(f.events).toContainEqual({ type: 'session', session: expect.objectContaining({ id: session.id, status: 'exited', exitCode: 255 }) }))
    const reopened = unwrap(await f.service.reopen({ threadId: THREAD, workspaceId: workspace.workspaceId, sessionId: session.id }))
    expect(reopened.session.status).toBe('running')
    expect(f.spawn).toHaveBeenCalledTimes(2)
  })

  it('refuses a reply\'s command, since it could land in a passphrase prompt', async () => {
    const f = await fixture()
    const { workspace } = unwrap(await f.service.list({ threadId: THREAD, place: 'drawer' }))
    const refused = await f.service.create({ threadId: THREAD, workspaceId: workspace.workspaceId, place: 'drawer', run: 'ls' })
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('refuses a pasted image in plain words and writes nothing', async () => {
    const f = await fixture()
    const { workspace } = unwrap(await f.service.list({ threadId: THREAD, place: 'drawer' }))
    const { session } = unwrap(await f.service.create({ threadId: THREAD, workspaceId: workspace.workspaceId, place: 'drawer' }))
    const refused = await f.service.pasteImage({ threadId: THREAD, workspaceId: workspace.workspaceId, sessionId: session.id, dataUrl: 'data:image/png;base64,AAAA' })
    expect(refused).toMatchObject({ ok: false, error: { code: 'unavailable', message: expect.stringContaining('Nothing was pasted') } })
    expect(f.processes[0]!.pty.write).not.toHaveBeenCalled()
  })

  it('ends every shell of a host that left, and no other', async () => {
    const f = await fixture()
    const { workspace } = unwrap(await f.service.list({ threadId: THREAD, place: 'drawer' }))
    const { session } = unwrap(await f.service.create({ threadId: THREAD, workspaceId: workspace.workspaceId, place: 'drawer' }))
    await f.service.endHost('33333333-3333-4333-8333-333333333333')
    expect(f.processes[0]!.pty.kill).not.toHaveBeenCalled()
    await f.service.endHost(FORGE)
    expect(f.processes[0]!.pty.kill).toHaveBeenCalledOnce()
    expect(f.events).toContainEqual({ type: 'closed', threadId: THREAD, workspaceId: workspace.workspaceId, sessionId: session.id })
    expect(unwrap(await f.service.list({ threadId: THREAD, place: 'drawer' })).sessions).toEqual([])
  })

  it('starts nothing when its host is sent away while the shell is starting, so no shell runs that nobody can end', async () => {
    const held: { service?: TerminalService; ending?: Promise<void> } = {}
    const launch = hostedTerminals({ folders: () => FOLDERS, host: () => ({ target: 'forge' }), ssh: { file: 'ssh' } })
    const f = await fixture({ hosted: { workspace: launch.workspace, launch: (owner, place) => { held.ending = held.service!.endHost(FORGE); return launch.launch(owner, place) } } })
    const service = held.service = f.service
    const { workspace } = unwrap(await service.list({ threadId: THREAD, place: 'drawer' }))
    expect(await service.create({ threadId: THREAD, workspaceId: workspace.workspaceId, place: 'drawer' })).toMatchObject({ ok: false, error: { code: 'session-unavailable' } })
    await held.ending
    expect(f.spawn).not.toHaveBeenCalled()
    expect(unwrap(await service.list({ threadId: THREAD, place: 'drawer' })).sessions).toEqual([])
  })

  it('has no terminal for such a thread where the feature is off, as on stable', async () => {
    const f = await fixture({ hosted: null })
    expect(await f.service.list({ threadId: THREAD })).toMatchObject({ ok: false, error: { code: 'thread-unavailable' } })
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('says so when the host left or has no saved SSH connection, and starts nothing', async () => {
    const gone = await fixture({ folders: () => undefined })
    expect(await gone.service.list({ threadId: THREAD })).toMatchObject({ ok: false, error: { code: 'thread-unavailable', message: expect.stringContaining('Connect it in Settings') } })
    const unsaved = await fixture({ host: () => undefined })
    const { workspace } = unwrap(await unsaved.service.list({ threadId: THREAD }))
    expect(await unsaved.service.create({ threadId: THREAD, workspaceId: workspace.workspaceId })).toMatchObject({ ok: false, error: { code: 'unavailable', message: expect.stringContaining('nothing was started') } })
    expect(unsaved.spawn).not.toHaveBeenCalled()
    expect(unwrap(await unsaved.service.list({ threadId: THREAD })).sessions).toEqual([])
  })
})
