// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty, IPtyForkOptions } from 'node-pty'
import type { AgentWorktree } from '../../../src/shared/agents'
import { TerminalWorkspaceService, type TerminalWorkspaceDependencies } from '../../../src/main/terminals/service'
import type { WorkspaceTerminalEvent } from '../../../src/shared/terminalWorkspace'
import type { ToolsResult } from '../../../src/shared/tools'

const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')}`
const shellLaunch = { provider: null, modelId: null, reasoning: null, permission: null } as const

async function fixture(options: Partial<Pick<TerminalWorkspaceDependencies, 'env' | 'platform' | 'executableExists' | 'now'>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-terminals-unit-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const project = join(directory, 'project'); await mkdir(project)
  const checkout = join(directory, 'checkout'); await mkdir(checkout)
  const processes: { emit(data: string): void; exit(code: number): void; pty: IPty }[] = []
  const events: WorkspaceTerminalEvent[] = []
  const spawn = vi.fn<(file: string, args: string[], options: IPtyForkOptions) => IPty>(() => {
    let dataListener: (data: string) => void = () => {}, exitListener: (exit: { exitCode: number }) => void = () => {}
    const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: (listener: typeof dataListener) => { dataListener = listener; return { dispose: () => { dataListener = () => {} } } }, onExit: (listener: typeof exitListener) => { exitListener = listener; return { dispose: () => { exitListener = () => {} } } } } as unknown as IPty
    processes.push({ pty, emit: data => dataListener(data), exit: code => exitListener({ exitCode: code }) })
    return pty
  })
  const worktrees = {
    allocate: vi.fn(async (path: string, mode: 'independent' | 'shared'): Promise<AgentWorktree> => mode === 'shared' ? { mode, status: 'ready', path } : { mode, status: 'pending', path: checkout, branch: 'sotto/terminal-1', repositoryRoot: path, baseCommit: 'abc' }),
    ensure: vi.fn(async (metadata: AgentWorktree): Promise<AgentWorktree> => ({ ...metadata, status: 'ready' })),
    workingDirectory: vi.fn(async (metadata: AgentWorktree) => metadata.path!),
  }
  const git = vi.fn(async (_cwd: string, args: string[]) => args.includes('--abbrev-ref') ? 'main\n' : '')
  const createService = () => {
    const service = new TerminalWorkspaceService({
      projects: () => [{ id: 'p1', title: 'Project', path: project }], worktrees, git, spawn, platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' }, executableExists: async () => false,
      emit: event => events.push(event), ...options,
    })
    cleanup.push(async () => service.dispose())
    return service
  }
  return { service: createService(), createService, project, checkout, processes, spawn, events, worktrees, git }
}

/** Opens a terminal and waits for main to finish starting it: every operation settles behind the startup it publishes. */
async function started(service: TerminalWorkspaceService, request: unknown) {
  const opened = unwrap(await service.open(request))
  return unwrap(await service.read({ id: opened.terminal.id }))
}

describe('terminal workspace service', () => {
  it('publishes the terminal before its process exists, then its process and its branch', async () => {
    const f = await fixture()
    const opened = unwrap(await f.service.open({ projectId: 'p1', title: 'Build', workingCopy: 'shared', launch: shellLaunch }))
    // The renderer has the terminal before anything is spawned: no process, no output, no branch yet.
    expect(opened.terminal).toMatchObject({ title: 'Build', projectId: 'p1', workingDirectory: f.project, command: 'powershell', status: 'starting', branch: null, closedAt: null })
    expect(opened.output).toBe('')
    expect(f.events[0]).toMatchObject({ type: 'terminal', terminal: { id: opened.terminal.id, status: 'starting', branch: null } })

    const ready = unwrap(await f.service.read({ id: opened.terminal.id }))
    expect(f.spawn).toHaveBeenCalledWith('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo'], expect.objectContaining({ cwd: f.project, env: expect.objectContaining({ TERM: 'xterm-256color', TERM_PROGRAM: 'Sotto' }) }))
    expect(f.spawn.mock.calls[0]![2]!.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(ready.terminal).toMatchObject({ status: 'running', branch: 'main' })
    expect(ready.output).toBe(`\x1b[2mOpened by Sotto at ${f.project} · powershell\x1b[0m\r\n`)
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'output', id: opened.terminal.id, sequence: 1 }))
    expect(f.events.at(-1)).toMatchObject({ type: 'terminal', terminal: { status: 'running', branch: 'main' } })
    expect(f.worktrees.ensure).not.toHaveBeenCalled()
  })

  it('prefers pwsh when it is on the path, and scans the path only for the first terminal', async () => {
    const executableExists = vi.fn(async (path: string) => path === 'C:\\bin\\pwsh.exe')
    const f = await fixture({ executableExists, env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\one;C:\\two;C:\\bin' } })
    const opened = await started(f.service, { projectId: 'p1', title: 'Build', workingCopy: 'shared', launch: shellLaunch })
    expect(f.spawn).toHaveBeenCalledWith('C:\\bin\\pwsh.exe', ['-NoLogo'], expect.anything())
    expect(opened.terminal.command).toBe('pwsh')
    await started(f.service, { projectId: 'p1', title: 'Tests', workingCopy: 'shared', launch: shellLaunch })
    expect(f.spawn).toHaveBeenLastCalledWith('C:\\bin\\pwsh.exe', ['-NoLogo'], expect.anything())
    // Entries before the shell are visited once for the session; later terminals reuse what that scan found.
    expect(executableExists.mock.calls.filter(([path]) => path === 'C:\\one\\pwsh.exe')).toHaveLength(1)
  })

  it('runs a provider CLI with its mapped flags through the shell, in a worktree Sotto made itself', async () => {
    const f = await fixture()
    const launch = { provider: 'claude' as const, modelId: 'native:claude:model:claude-sonnet-5', reasoning: 'high', permission: 'everything' as const }
    const opened = await started(f.service, { projectId: 'p1', title: 'Agent', workingCopy: 'independent', launch })
    expect(f.worktrees.allocate).toHaveBeenCalledWith(f.project, 'independent')
    expect(f.worktrees.ensure).toHaveBeenCalledOnce()
    // The terminal is published while its checkout is still pending, then again once the folder is there.
    expect(f.events[0]).toMatchObject({ type: 'terminal', terminal: { status: 'starting', workingCopy: 'independent', worktree: { status: 'pending' } } })
    expect(opened.terminal).toMatchObject({ workingDirectory: f.checkout, workingCopy: 'independent', command: 'claude --model claude-sonnet-5 --effort high --dangerously-skip-permissions', worktree: { status: 'ready', branch: 'sotto/terminal-1' } })
    expect(f.spawn).toHaveBeenCalledWith(expect.stringMatching(/powershell\.exe$/u), ['-NoLogo', '-Command', "& 'claude' '--model' 'claude-sonnet-5' '--effort' 'high' '--dangerously-skip-permissions'"], expect.objectContaining({ cwd: f.checkout }))
    expect(opened.output).toContain('· claude --model claude-sonnet-5 --effort high --dangerously-skip-permissions')
  })

  it('runs the CLI through a login shell on macOS', async () => {
    const f = await fixture({ platform: 'darwin', env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } })
    await started(f.service, { projectId: 'p1', title: 'Agent', workingCopy: 'shared', launch: { provider: 'codex', modelId: null, reasoning: null, permission: 'edits' } })
    expect(f.spawn).toHaveBeenCalledWith('/bin/zsh', ['-l', '-i', '-c', "exec 'codex' '--full-auto'"], expect.anything())
    await started(f.service, { projectId: 'p1', title: 'Shell', workingCopy: 'shared', launch: shellLaunch })
    expect(f.spawn).toHaveBeenLastCalledWith('/bin/zsh', ['-l'], expect.anything())
  })

  it('writes, resizes, interrupts, stops and restarts under the same ID, and closes onto the shelf', async () => {
    const f = await fixture()
    const { terminal } = await started(f.service, { projectId: 'p1', title: 'Build', workingCopy: 'shared', launch: shellLaunch, cols: 100, rows: 30 })
    const request = { id: terminal.id }
    unwrap(await f.service.write({ ...request, data: 'ls\r' })); unwrap(await f.service.resize({ ...request, cols: 120, rows: 40 })); unwrap(await f.service.interrupt(request))
    expect(f.processes[0]!.pty.write).toHaveBeenCalledWith('ls\r')
    expect(f.processes[0]!.pty.write).toHaveBeenLastCalledWith('\x03')
    expect(f.processes[0]!.pty.resize).toHaveBeenCalledWith(120, 40)
    f.processes[0]!.emit('hello')
    expect(unwrap(await f.service.read(request))).toMatchObject({ sequence: 2 })
    unwrap(await f.service.stop(request))
    expect(f.processes[0]!.pty.kill).toHaveBeenCalledOnce()
    expect(unwrap(await f.service.read(request)).terminal.status).toBe('exited')
    expect(await f.service.write({ ...request, data: 'x' })).toMatchObject({ ok: false, error: { code: 'not-running' } })
    const restarted = unwrap(await f.service.restart(request))
    expect(restarted.terminal.id).toBe(terminal.id)
    expect(restarted.terminal.status).toBe('running')
    expect(restarted.output).not.toContain('hello')
    expect(f.spawn).toHaveBeenCalledTimes(2)
    expect(f.spawn).toHaveBeenLastCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ cols: 120, rows: 40 }))
    unwrap(await f.service.close(request))
    expect(f.processes[1]!.pty.kill).toHaveBeenCalledOnce()
    const listed = unwrap(await f.service.list()).terminals
    expect(listed).toHaveLength(1)
    expect(listed[0]!.closedAt).toEqual(expect.any(Number))
    expect(listed[0]!.status).toBe('exited')
    // Reopening a closed terminal takes it back off the shelf.
    expect(unwrap(await f.service.restart(request)).terminal.closedAt).toBeNull()
  })

  it('names the shell it opens, restarts a running terminal by ending it first, and keeps nothing across a restart of Sotto', async () => {
    const f = await fixture()
    expect(unwrap(await f.service.list()).shell).toBe('powershell')
    const { terminal } = await started(f.service, { projectId: 'p1', title: 'Build', workingCopy: 'shared', launch: shellLaunch })
    f.processes[0]!.exit(3)
    expect(unwrap(await f.service.read({ id: terminal.id })).terminal).toMatchObject({ status: 'exited', exitCode: 3 })
    unwrap(await f.service.restart({ id: terminal.id }))
    expect(unwrap(await f.service.restart({ id: terminal.id })).terminal).toMatchObject({ status: 'running', exitCode: null })
    expect(f.processes[1]!.pty.kill).toHaveBeenCalledOnce()
    expect(f.spawn).toHaveBeenCalledTimes(3)
    f.service.dispose()
    expect(unwrap(await f.createService().list()).terminals).toEqual([])
  })

  it('marks a terminal whose command cannot start as unavailable instead of running', async () => {
    const f = await fixture()
    const { terminal } = await started(f.service, { projectId: 'p1', title: 'Build', workingCopy: 'shared', launch: shellLaunch })
    f.processes[0]!.exit(0)
    f.spawn.mockImplementationOnce(() => { throw new Error('spawn failed') })
    expect(await f.service.restart({ id: terminal.id })).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(unwrap(await f.service.read({ id: terminal.id })).terminal.status).toBe('unavailable')
    expect(f.events.at(-1)).toMatchObject({ type: 'terminal', terminal: { status: 'unavailable' } })
    // A spawn that fails after open answered carries its failure on the record instead.
    f.spawn.mockImplementationOnce(() => { throw new Error('spawn failed') })
    expect((await started(f.service, { projectId: 'p1', title: 'Other', workingCopy: 'shared', launch: shellLaunch })).terminal.status).toBe('unavailable')
  })

  it('saves a pasted image under the folder as <timestamp>.png and types its path', async () => {
    const f = await fixture({ now: () => Date.UTC(2026, 8, 16, 10, 11, 12, 345) })
    const { terminal } = await started(f.service, { projectId: 'p1', title: 'Build', workingCopy: 'shared', launch: shellLaunch })
    const { path } = unwrap(await f.service.pasteImage({ id: terminal.id, dataUrl: PNG }))
    expect(path).toBe(join(f.project, '.sotto', 'clipboard', '20260916-101112-345.png'))
    expect(unwrap(await f.service.pasteImage({ id: terminal.id, dataUrl: PNG })).path).toBe(join(f.project, '.sotto', 'clipboard', '20260916-101112-345-2.png'))
    expect((await stat(path)).size).toBe(11)
    expect(await readFile(join(f.project, '.sotto', 'clipboard', '.gitignore'), 'utf8')).toBe('*\n')
    expect(f.processes[0]!.pty.write).toHaveBeenCalledWith(/\s/u.test(path) ? `"${path}"` : path)
    expect(await f.service.pasteImage({ id: terminal.id, dataUrl: 'data:image/jpeg;base64,AAAA' })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('refuses a project it does not know, and a checkout that never arrives leaves the terminal unavailable', async () => {
    const f = await fixture()
    expect(await f.service.open({ projectId: 'nope', title: 'x', workingCopy: 'shared', launch: shellLaunch })).toMatchObject({ ok: false, error: { code: 'workspace-unavailable' } })
    f.worktrees.allocate.mockRejectedValueOnce(new Error('Git is unavailable.'))
    expect(await f.service.open({ projectId: 'p1', title: 'x', workingCopy: 'independent', launch: shellLaunch })).toMatchObject({ ok: false, error: { code: 'workspace-unavailable', message: 'Git is unavailable.' } })
    expect(unwrap(await f.service.list()).terminals).toEqual([])
    // A checkout that fails after the terminal is published cannot be taken back; the terminal says it could not start.
    f.worktrees.ensure.mockRejectedValueOnce(new Error('Git is unavailable.'))
    expect((await started(f.service, { projectId: 'p1', title: 'x', workingCopy: 'independent', launch: shellLaunch })).terminal.status).toBe('unavailable')
    expect(f.spawn).not.toHaveBeenCalled()
  })
})
