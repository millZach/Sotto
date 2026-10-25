// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'
import { FilesService } from '../../../src/main/files/service'
import { CheckoutMutations } from '../../../src/main/agents/checkoutMutations'
import { RUN_QUIET_MS, RUN_START_CAP_MS, TerminalService, type TerminalDependencies } from '../../../src/main/tools/terminal'
import * as clipboard from '../../../src/main/terminals/clipboard'
import { TERMINAL_MAX_OUTPUT, type TerminalEvent } from '../../../src/shared/terminal'
import type { ToolsResult } from '../../../src/shared/tools'
import { deferred } from '../../fixtures/deferred'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { initializeGitRepository } from '../../fixtures/gitRepository'

const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(options: Pick<TerminalDependencies, 'env' | 'platform' | 'executableExists' | 'acquireStart' | 'projectFolder' | 'runCommandEnabled'> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-terminal-unit-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const other = join(directory, 'other'); await mkdir(other)
  let cwd = directory
  const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'project', workingDirectory: threadId === 'b' ? other : cwd }), copyPath: vi.fn(), reveal: vi.fn() })
  const processes: { emit(data: string): void; exit(code: number): void; pty: IPty }[] = []
  const events: TerminalEvent[] = []
  const spawn = vi.fn(() => {
    let dataListener: (data: string) => void = () => {}, exitListener: (exit: { exitCode: number }) => void = () => {}
    const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: (listener: typeof dataListener) => { dataListener = listener; return { dispose: () => { dataListener = () => {} } } }, onExit: (listener: typeof exitListener) => { exitListener = listener; return { dispose: () => { exitListener = () => {} } } } } as unknown as IPty
    processes.push({ pty, emit: data => dataListener(data), exit: code => exitListener({ exitCode: code }) })
    return pty
  })
  const createService = () => {
    const service = new TerminalService({ files, directory, spawn, platform: 'win32', env: { SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' }, ...options, emit: event => events.push(event) })
    cleanup.push(async () => service.dispose())
    return service
  }
  const service = createService()
  const owner = unwrap(await service.list({ threadId: 'a' })).workspace
  const target = { threadId: owner.threadId, workspaceId: owner.workspaceId }
  return { service, createService, target, files, processes, spawn, events, directory, change: () => { cwd = other } }
}
describe('persistent terminal service', () => {
  it('keeps Enter and a second paste behind image staging in main', async () => {
    const f = await fixture(), first = unwrap(await f.service.create(f.target))
    const request = { ...f.target, sessionId: first.session.id }
    const staging = Promise.withResolvers<string>(), entered = Promise.withResolvers<void>()
    const save = vi.spyOn(clipboard, 'saveTerminalImage').mockImplementationOnce(() => { entered.resolve(); return staging.promise }).mockResolvedValue('second.png')
    const pending = f.service.pasteImage({ ...request, dataUrl: 'data:image/png;base64,AAAA' })
    await entered.promise
    const next = f.service.pasteImage({ ...request, dataUrl: 'data:image/png;base64,BBBB' })
    const enter = f.service.write({ ...request, data: '\r' })
    try { expect(f.processes[0]!.pty.write).not.toHaveBeenCalled() }
    finally { staging.resolve('first.png'); await Promise.all([pending, next, enter]); save.mockRestore() }
    expect(vi.mocked(f.processes[0]!.pty.write).mock.calls.map(args => args[0])).toEqual(["'first.png'", "'second.png'", '\r'])
  })
  it.each(['tools', 'drawer'] as const)('saves a pasted PNG and types its quoted path in %s, refusing invalid images and other owners', async place => {
    const f = await fixture()
    const snapshot = unwrap(await f.service.create({ ...f.target, place }))
    const request = { ...f.target, sessionId: snapshot.session.id }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`
    expect(await f.service.pasteImage({ ...request, dataUrl: 'data:image/png;base64,ZmFrZQ==' })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(await f.service.pasteImage({ ...request, threadId: 'b', dataUrl })).toMatchObject({ ok: false, error: { code: 'session-unavailable' } })
    expect(f.processes[0]!.pty.write).not.toHaveBeenCalled()
    unwrap(await f.service.pasteImage({ ...request, dataUrl }))
    const directory = join(f.directory, '.sotto', 'clipboard')
    const [image] = (await readdir(directory)).filter(name => name.endsWith('.png'))
    const path = join(directory, image!)
    expect(await readFile(path)).toEqual(png)
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('*\n')
    expect(f.processes[0]!.pty.write).toHaveBeenCalledWith(`'${path}'`)
    f.processes[0]!.exit(0)
    expect(await f.service.pasteImage({ ...request, dataUrl })).toMatchObject({ ok: false, error: { code: 'not-running' } })
    expect(f.processes[0]!.pty.write).toHaveBeenCalledOnce()
  })
  it.each([
    ['remove-folder', 'Sotto is removing this folder.'],
    ['git-action', 'A Git action is running in this folder.'],
    ['automatic-pull', 'Sotto is pulling this folder.'],
    ['checkpoint-revert', 'Sotto is reverting a checkpoint in this folder.'],
  ] as const)('reports terminal-specific recovery when %s holds the checkout', async (kind, operation) => {
    const checkouts = new CheckoutMutations()
    const f = await fixture({ acquireStart: owner => checkouts.acquire(owner.workingDirectory, 'send', { kind: 'terminal-start' }) })
    const release = await checkouts.acquire(f.directory, 'mutation', { kind })
    try {
      expect(await f.service.create(f.target)).toEqual({ ok: false, error: { code: 'busy', message: `${operation} The terminal did not start. Try again when it finishes.` } })
      expect(f.spawn).not.toHaveBeenCalled()
      expect(unwrap(await f.service.list(f.target)).capacity.count).toBe(0)
    } finally { release() }
    expect(unwrap(await f.service.create(f.target)).session.status).toBe('running')
  })
  it('does not spawn a new Tools shell while its checkout is reserved for removal', async () => {
    const f = await fixture({ acquireStart: async () => { throw new Error('Sotto is removing this folder') } })
    expect(await f.service.create(f.target)).toMatchObject({ ok: false })
    expect(f.spawn).not.toHaveBeenCalled()
    expect(unwrap(await f.service.list(f.target)).capacity.count).toBe(0)
  })
  it('releases its checkout reservation after starting a shell', async () => {
    const release = vi.fn(), acquireStart = vi.fn(async () => release)
    const f = await fixture({ acquireStart })
    unwrap(await f.service.create(f.target))
    expect(acquireStart).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'a' }))
    expect(release).toHaveBeenCalledOnce()
  })
  it('reports the total across both places and all threads, including ended shells', async () => {
    const f = await fixture()
    const other = unwrap(await f.service.list({ threadId: 'b', place: 'drawer' })).workspace
    const first = unwrap(await f.service.create(f.target))
    unwrap(await f.service.create({ threadId: other.threadId, workspaceId: other.workspaceId, place: 'drawer' }))
    f.processes[0]!.exit(0)
    expect(unwrap(await f.service.list(f.target))).toMatchObject({ sessions: [{ id: first.session.id, status: 'exited' }], capacity: { count: 2 } })
    unwrap(await f.service.close({ ...f.target, sessionId: first.session.id }))
    expect(f.events.at(-2)).toMatchObject({ type: 'capacity', capacity: { count: 1 } })
    expect(unwrap(await f.service.list(f.target)).capacity.count).toBe(1)
  })
  it('uses PowerShell 7 on PATH for both Tools and drawer shells', async () => {
    const f = await fixture({ env: { PATH: 'C:\\one;C:\\bin' }, executableExists: async path => path === 'C:\\bin\\pwsh.exe' })
    for (const place of ['tools', 'drawer'] as const) unwrap(await f.service.create({ ...f.target, place }))
    expect(f.spawn).toHaveBeenCalledTimes(2)
    for (const call of f.spawn.mock.calls) expect(call).toEqual(['C:\\bin\\pwsh.exe', ['-NoLogo'], expect.anything()])
  })
  it('keeps writes in request order while another session can pass a held workspace validation', async () => {
    const f = await fixture()
    const first = unwrap(await f.service.create(f.target)), other = unwrap(await f.service.create(f.target))
    const request = { ...f.target, sessionId: first.session.id }
    const release = deferred<void>(), entered = deferred<void>()
    const resolved = await f.files.resolveWorkspace('a')
    if (!resolved.ok) throw new Error(resolved.error.message)
    const owner = resolved.value
    const validation = vi.spyOn(f.files, 'resolveWorkspace').mockResolvedValue({ ok: true, value: owner })
    validation.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { ok: true, value: owner } })
    const pending = f.service.write({ ...request, data: 'S' })
    await entered.promise
    const next = f.service.write({ ...request, data: 'e' })
    try {
      unwrap(await f.service.write({ ...request, sessionId: other.session.id, data: 'independent' }))
      expect(f.processes[1]!.pty.write).toHaveBeenCalledWith('independent')
      expect(f.processes[0]!.pty.write).not.toHaveBeenCalled()
    } finally { release.resolve(); await Promise.all([pending, next]) }
    expect(unwrap(await pending)).toBeUndefined()
    expect(unwrap(await next)).toBeUndefined()
    expect(vi.mocked(f.processes[0]!.pty.write).mock.calls.map(args => args[0])).toEqual(['S', 'e'])
  })

  it('does not send held or queued input after the old terminal closes', async () => {
    const f = await fixture(), first = unwrap(await f.service.create(f.target))
    const request = { ...f.target, sessionId: first.session.id }
    const release = deferred<void>(), entered = deferred<void>()
    const original = f.files.resolveWorkspace.bind(f.files)
    vi.spyOn(f.files, 'resolveWorkspace').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return original(...args) })
    const pending = f.service.write({ ...request, data: 'old' })
    await entered.promise
    const next = f.service.write({ ...request, data: 'queued' })
    try { unwrap(await f.service.close(request)); unwrap(await f.service.create(f.target)) }
    finally { release.resolve() }
    expect(await pending).toMatchObject({ ok: false, error: { code: 'session-unavailable' } })
    expect(await next).toMatchObject({ ok: false, error: { code: 'session-unavailable' } })
    for (const process of f.processes) expect(process.pty.write).not.toHaveBeenCalled()
  })

  it.each(['win32', 'darwin', 'linux'] as const)('starts a color-capable interactive shell independently of launcher color overrides on %s', async platform => {
    const env = Object.freeze({
      SystemRoot: 'C:\\Windows', SHELL: '/bin/zsh', PATH: '/custom/bin', USER_THEME: 'custom',
      NO_COLOR: '1', FORCE_COLOR: '0', CLICOLOR: '0', CLICOLOR_FORCE: '0',
      TERM: 'dumb', COLORTERM: '', TERM_PROGRAM: 'launcher',
      ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect'
    })
    const original = { ...env }
    const f = await fixture({ platform, env })
    unwrap(await f.service.create(f.target))
    expect(f.spawn).toHaveBeenCalledWith(expect.any(String), platform === 'win32' ? ['-NoLogo'] : ['-l'], expect.objectContaining({ env: {
      SystemRoot: 'C:\\Windows', SHELL: '/bin/zsh', PATH: '/custom/bin', USER_THEME: 'custom',
      TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Sotto'
    } }))
    expect(env).toEqual(original)
  })
  it.each(['win32', 'linux'] as const)('respects %s environment key casing when replacing terminal capabilities', async platform => {
    const inherited = { No_Color: '1', Force_Color: '0', CliColor: '0', CliColor_Force: '0', Term: 'dumb', ColorTerm: '', Term_Program: 'launcher' }
    const f = await fixture({ platform, env: inherited })
    unwrap(await f.service.create(f.target))
    expect(f.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ env: {
      ...(platform === 'win32' ? {} : inherited), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Sotto'
    } }))
  })
  it('owns multiple real-PTY adapters across focus with input, resize, interrupt, bounded ordered output and exit', async () => {
    const f = await fixture()
    const first = unwrap(await f.service.create(f.target)), second = unwrap(await f.service.create(f.target))
    const request = { ...f.target, sessionId: first.session.id }
    expect(f.spawn).toHaveBeenCalledWith('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo'], expect.objectContaining({ cwd: first.session.workspace.workingDirectory, env: { SystemRoot: 'C:\\Windows', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Sotto' } }))
    unwrap(await f.service.write({ ...request, data: 'echo hello\r' })); unwrap(await f.service.resize({ ...request, cols: 110, rows: 35 })); unwrap(await f.service.interrupt(request))
    expect(f.processes[0]!.pty.write).toHaveBeenLastCalledWith('\x03')
    expect(f.processes[0]!.pty.resize).toHaveBeenCalledWith(110, 35)
    f.processes[0]!.emit('x'.repeat(TERMINAL_MAX_OUTPUT + 300))
    const snapshot = unwrap(await f.service.read(request))
    expect(snapshot.output.length).toBe(TERMINAL_MAX_OUTPUT)
    expect(snapshot.sequence).toBe(9)
    expect(unwrap(await f.service.list({ threadId: 'b' })).sessions).toEqual([])
    expect(unwrap(await f.service.list({ threadId: 'a' })).sessions.map(s => s.id)).toEqual([first.session.id, second.session.id])
    f.processes[0]!.exit(7)
    expect(unwrap(await f.service.read(request)).session).toMatchObject({ status: 'exited', exitCode: 7 })
    expect(await f.service.write({ ...request, data: 'oops' })).toMatchObject({ ok: false, error: { code: 'not-running' } })
    unwrap(await f.service.close(request))
    expect(unwrap(await f.service.list({ threadId: 'a' })).sessions).toHaveLength(1)
  })
  it('rejects cross-thread and changed-directory input, but permits closing the owned old process', async () => {
    const f = await fixture(), created = unwrap(await f.service.create(f.target))
    const request = { ...f.target, sessionId: created.session.id }
    expect(await f.service.write({ ...request, threadId: 'b', data: 'bad' })).toMatchObject({ ok: false, error: { code: 'session-unavailable' } })
    f.change()
    expect(await f.service.write({ ...request, data: 'bad' })).toMatchObject({ ok: false, error: { code: 'workspace-changed' } })
    unwrap(await f.service.close(request))
    expect(f.processes[0]!.pty.kill).toHaveBeenCalledOnce()
  })
  it('marks restart records interrupted and explicitly creates a replacement without resuming the dead process', async () => {
    const f = await fixture(), created = unwrap(await f.service.create(f.target))
    f.service.dispose()
    const restored = f.createService(), listing = unwrap(await restored.list({ threadId: 'a' }))
    expect(listing.sessions[0]!.status).toBe('interrupted')
    expect(f.spawn).toHaveBeenCalledTimes(1)
    const replacement = unwrap(await restored.reopen({ ...f.target, sessionId: created.session.id }))
    expect(replacement.session.id).not.toBe(created.session.id)
    expect(replacement.output).toBe('')
    expect(replacement.session.status).toBe('running')
    expect(unwrap(await restored.list({ threadId: 'a' })).sessions).toHaveLength(1)
  })
  it('reopens a dead shell at the session limit and retains its hint when replacement fails', async () => {
    const f = await fixture()
    for (let count = 0; count < 32; count++) unwrap(await f.service.create(f.target))
    f.service.dispose()
    const restored = f.createService()
    const original = unwrap(await restored.list(f.target)).sessions[0]!
    const request = { ...f.target, sessionId: original.id }
    f.spawn.mockImplementationOnce(() => { throw new Error('Shell missing') })
    expect(await restored.reopen(request)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(unwrap(await restored.read(request)).session.status).toBe('interrupted')
    const replacement = unwrap(await restored.reopen(request))
    expect(replacement.session.id).not.toBe(original.id)
    expect(unwrap(await restored.list(f.target)).sessions).toHaveLength(32)
    const restarted = f.createService()
    expect(unwrap(await restarted.list(f.target)).sessions).toHaveLength(32)
  })
  it.each(['tools', 'drawer'] as const)('pastes images and resizes a restored %s shell while the shared slots remain full', async place => {
    const f = await fixture()
    const original = unwrap(await f.service.create({ ...f.target, place })).session
    for (let count = 1; count < 32; count++) unwrap(await f.service.create({ ...f.target, place: count % 2 ? 'tools' : 'drawer' }))
    f.service.dispose()
    const restored = f.createService()
    expect(unwrap(await restored.read({ ...f.target, sessionId: original.id }))).toMatchObject({ session: { status: 'interrupted' }, output: '' })
    expect(await restored.create({ ...f.target, place })).toMatchObject({ ok: false, error: { code: 'busy' } })
    const replacement = unwrap(await restored.reopen({ ...f.target, sessionId: original.id }))
    const request = { ...f.target, sessionId: replacement.session.id }
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    unwrap(await restored.pasteImage({ ...request, dataUrl }))
    unwrap(await restored.resize({ ...request, cols: 72, rows: 20 }))
    expect(f.processes.at(-1)!.pty.write).toHaveBeenCalledWith(expect.stringContaining('.sotto'))
    expect(f.processes.at(-1)!.pty.resize).toHaveBeenCalledWith(72, 20)
    expect(unwrap(await restored.list({ ...f.target, place })).capacity.count).toBe(32)
    unwrap(await restored.close(request))
    expect(unwrap(await restored.list({ ...f.target, place })).capacity.count).toBe(31)
  })
  it('keeps a drawer shell apart from a Tools shell, lists each by its own place, and counts either as running', async () => {
    const f = await fixture()
    const tools = unwrap(await f.service.create(f.target))
    const drawer = unwrap(await f.service.create({ ...f.target, place: 'drawer' }))
    expect(tools.session.place).toBe('tools')
    expect(drawer.session.place).toBe('drawer')
    expect(unwrap(await f.service.list(f.target)).sessions.map(s => s.id)).toEqual([tools.session.id])
    expect(unwrap(await f.service.list({ ...f.target, place: 'drawer' })).sessions.map(s => s.id)).toEqual([drawer.session.id])
    expect(f.service.hasRunningTerminal('a')).toBe(true)
    unwrap(await f.service.close({ ...f.target, sessionId: tools.session.id }))
    // Only the Tools shell closed; the drawer's own shell still keeps the folder in use.
    expect(f.service.hasRunningTerminal('a')).toBe(true)
    unwrap(await f.service.close({ ...f.target, sessionId: drawer.session.id }))
    expect(f.service.hasRunningTerminal('a')).toBe(false)
  })
  it('starts a drawer shell in the project folder and a Tools shell in the working copy', async () => {
    const project = await mkdtemp(join(tmpdir(), 'sotto-terminal-project-'))
    cleanup.push(() => rm(project, { recursive: true, force: true }))
    const projectFolder = vi.fn((projectId: string) => projectId === 'project' ? project : undefined)
    const f = await fixture({ projectFolder })
    await initializeGitRepository(project)
    await initializeGitRepository(f.directory)
    const tools = unwrap(await f.service.create(f.target))
    unwrap(await f.service.create({ ...f.target, place: 'drawer' }))
    expect(f.spawn).toHaveBeenNthCalledWith(1, expect.any(String), expect.any(Array), expect.objectContaining({ cwd: tools.session.workspace.workingDirectory }))
    expect(f.spawn).toHaveBeenNthCalledWith(2, expect.any(String), expect.any(Array), expect.objectContaining({ cwd: project }))
    expect(projectFolder).toHaveBeenCalledWith('project')
  })
  it.each(['project', 'working-copy'] as const)('refuses a drawer start while its %s folder is reserved and releases every start reservation', async folder => {
    const project = await mkdtemp(join(tmpdir(), 'sotto-terminal-project-'))
    cleanup.push(() => rm(project, { recursive: true, force: true }))
    const checkouts = new CheckoutMutations()
    const acquireStart = vi.fn(async (owner: Parameters<NonNullable<TerminalDependencies['acquireStart']>>[0]) =>
      checkouts.acquire(owner.workingDirectory, 'send', { kind: 'terminal-start' }))
    const f = await fixture({ projectFolder: () => project, acquireStart })
    // Temp folders may be inside the machine's home checkout; give each fixture its own identity.
    await initializeGitRepository(project)
    await initializeGitRepository(f.directory)
    const release = await checkouts.acquire(folder === 'project' ? project : f.directory, 'mutation', { kind: 'remove-folder' })
    try {
      expect(await f.service.create({ ...f.target, place: 'drawer' })).toEqual({ ok: false, error: { code: 'busy', message: 'Sotto is removing this folder. The terminal did not start. Try again when it finishes.' } })
      expect(f.spawn).not.toHaveBeenCalled()
      expect(unwrap(await f.service.list(f.target)).capacity.count).toBe(0)
      if (folder === 'project') (await checkouts.acquire(f.directory, 'mutation'))()
    } finally { release() }
    acquireStart.mockClear()
    unwrap(await f.service.create({ ...f.target, place: 'drawer' }))
    expect(acquireStart.mock.calls.map(([owner]) => owner.workingDirectory)).toEqual([f.directory, project])
    for (const directory of [f.directory, project]) (await checkouts.acquire(directory, 'mutation'))()
  })
  it('starts a drawer shell in the working copy when the project folder is gone', async () => {
    const f = await fixture({ projectFolder: () => join(tmpdir(), 'sotto-terminal-missing-project', 'gone') })
    const created = unwrap(await f.service.create({ ...f.target, place: 'drawer' }))
    expect(f.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ cwd: created.session.workspace.workingDirectory }))
  })
  it('reopens a drawer shell back into the drawer, never into Tools', async () => {
    const f = await fixture()
    const created = unwrap(await f.service.create({ ...f.target, place: 'drawer' }))
    f.service.dispose()
    const restored = f.createService()
    const replacement = unwrap(await restored.reopen({ ...f.target, sessionId: created.session.id }))
    expect(replacement.session.place).toBe('drawer')
    expect(unwrap(await restored.list(f.target)).sessions).toEqual([])
    expect(unwrap(await restored.list({ ...f.target, place: 'drawer' })).sessions.map(s => s.id)).toEqual([replacement.session.id])
  })
  it('types a reply\'s command into a new drawer shell once it goes quiet, and names the tab after its first line (ADR-0139)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanup.push(async () => { vi.useRealTimers() })
    const f = await fixture({ runCommandEnabled: true })
    const created = unwrap(await f.service.create({ ...f.target, place: 'drawer', run: 'npm run typecheck' }))
    const shell = f.processes[0]!
    // The profile is still printing: nothing is typed until its output has stopped for RUN_QUIET_MS.
    expect(shell.pty.write).not.toHaveBeenCalled()
    shell.emit('Last login: today\r\n')
    vi.advanceTimersByTime(RUN_QUIET_MS - 1)
    shell.emit('~/work ❯ ')
    vi.advanceTimersByTime(RUN_QUIET_MS - 1)
    expect(shell.pty.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(vi.mocked(shell.pty.write).mock.calls).toEqual([['npm run typecheck\r']])
    vi.advanceTimersByTime(RUN_START_CAP_MS)
    expect(shell.pty.write).toHaveBeenCalledOnce()
    expect(created.session).toMatchObject({ place: 'drawer', title: 'npm run typecheck', status: 'running' })
    const block = unwrap(await f.service.create({ ...f.target, place: 'drawer', run: `santactl status\nosqueryi --version${' x'.repeat(200)}` }))
    f.processes[1]!.emit('$ ')
    vi.advanceTimersByTime(RUN_QUIET_MS)
    expect(vi.mocked(f.processes[1]!.pty.write).mock.calls).toEqual([[`santactl status\rosqueryi --version${' x'.repeat(200)}\r`]])
    expect(block.session.title).toBe('santactl status')
    const long = unwrap(await f.service.create({ ...f.target, place: 'drawer', run: `echo ${'y'.repeat(400)}` }))
    expect(long.session.title).toHaveLength(256)
    // The saved record and the published session carry the same title, so a reload names the tab the same way.
    expect(f.events.some(event => event.type === 'session' && event.session.id === created.session.id && event.session.title === 'npm run typecheck')).toBe(true)
  })
  it('types the command RUN_START_CAP_MS after spawning when the shell never goes quiet, or prints nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanup.push(async () => { vi.useRealTimers() })
    const f = await fixture({ runCommandEnabled: true })
    unwrap(await f.service.create({ ...f.target, place: 'drawer', run: 'git status' }))
    unwrap(await f.service.create({ ...f.target, place: 'drawer', run: 'git log' }))
    const [chatty, silent] = f.processes
    for (let elapsed = 0; elapsed < RUN_START_CAP_MS - 100; elapsed += 100) { chatty!.emit('.'); vi.advanceTimersByTime(100) }
    expect(chatty!.pty.write).not.toHaveBeenCalled()
    expect(silent!.pty.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(chatty!.pty.write).toHaveBeenCalledWith('git status\r')
    expect(silent!.pty.write).toHaveBeenCalledWith('git log\r')
  })
  it('types nothing into a shell that exits or is closed before it is ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanup.push(async () => { vi.useRealTimers() })
    const f = await fixture({ runCommandEnabled: true })
    unwrap(await f.service.create({ ...f.target, place: 'drawer', run: 'git status' }))
    const closed = unwrap(await f.service.create({ ...f.target, place: 'drawer', run: 'git log' }))
    f.processes[0]!.emit('zsh: profile error\r\n')
    f.processes[0]!.exit(1)
    unwrap(await f.service.close({ ...f.target, sessionId: closed.session.id }))
    vi.advanceTimersByTime(RUN_START_CAP_MS)
    expect(f.processes[0]!.pty.write).not.toHaveBeenCalled()
    expect(f.processes[1]!.pty.write).not.toHaveBeenCalled()
  })
  it('types the command only after the session is saved, and never when the save fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanup.push(async () => { vi.useRealTimers() })
    const f = await fixture({ runCommandEnabled: true })
    const saving = Promise.withResolvers<void>()
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementationOnce(() => saving.promise)
    cleanup.push(async () => { write.mockRestore() })
    const created = f.service.create({ ...f.target, place: 'drawer', run: 'git status' })
    await vi.waitFor(() => expect(f.processes).toHaveLength(1))
    f.processes[0]!.emit('$ ')
    vi.advanceTimersByTime(RUN_START_CAP_MS)
    expect(f.processes[0]!.pty.write).not.toHaveBeenCalled()
    saving.resolve()
    unwrap(await created)
    expect(f.processes[0]!.pty.write).toHaveBeenCalledExactlyOnceWith('git status\r')

    write.mockRejectedValueOnce(new Error('disk full'))
    expect(await f.service.create({ ...f.target, place: 'drawer', run: 'git log' })).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    f.processes[1]!.emit('$ ')
    vi.advanceTimersByTime(RUN_START_CAP_MS)
    expect(f.processes[1]!.pty.write).not.toHaveBeenCalled()
    expect(f.processes[1]!.pty.kill).toHaveBeenCalled()
  })
  it('names a reopened shell after its shell again, not the command it was started with', async () => {
    const f = await fixture({ runCommandEnabled: true })
    const created = unwrap(await f.service.create({ ...f.target, place: 'drawer', run: 'npm run dev' }))
    f.processes[0]!.exit(0)
    const reopened = unwrap(await f.service.reopen({ ...f.target, sessionId: created.session.id }))
    const shellName = reopened.session.shell.split(/[\\/]/u).at(-1)
    expect(reopened.session.title).toBe(shellName)
    expect(unwrap(await f.service.list({ ...f.target, place: 'drawer' })).sessions.map(session => session.title)).toEqual([shellName])
    expect(f.processes[1]!.pty.write).not.toHaveBeenCalled()
  })
  it.each([
    ['a Tools shell', { runCommandEnabled: true }, { place: 'tools' as const }],
    ['a request with no place', { runCommandEnabled: true }, {}],
    ['the feature off', { runCommandEnabled: false }, { place: 'drawer' as const }],
    ['the feature unset', {}, { place: 'drawer' as const }],
  ])('refuses a command for %s without starting a shell', async (_name, options, request) => {
    const f = await fixture(options)
    expect(await f.service.create({ ...f.target, ...request, run: 'git status' })).toEqual({ ok: false, error: { code: 'invalid-request', message: 'This tool request is invalid. Refresh the tools panel.' } })
    expect(f.spawn).not.toHaveBeenCalled()
    expect(unwrap(await f.service.list(f.target)).capacity.count).toBe(0)
  })
  it('refuses a command carrying control characters', async () => {
    const f = await fixture({ runCommandEnabled: true })
    for (const run of ['git status\r', 'echo \u001b[2J', '']) expect(await f.service.create({ ...f.target, place: 'drawer', run })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it('refuses a command at the shared limit with the usual words, typing nothing', async () => {
    const f = await fixture({ runCommandEnabled: true })
    for (let index = 0; index < 32; index++) unwrap(await f.service.create(f.target))
    expect(await f.service.create({ ...f.target, place: 'drawer', run: 'git status' })).toMatchObject({ ok: false, error: { code: 'busy', message: expect.stringContaining('share 32 terminals') } })
    expect(f.spawn).toHaveBeenCalledTimes(32)
  })
  it('reads an older record with no place as a Tools shell', async () => {
    const f = await fixture()
    const owner = unwrap(await f.service.list(f.target)).workspace
    const legacy = {
      id: '11111111-1111-4111-8111-111111111111', workspace: owner, title: 'PowerShell', shell: 'pwsh.exe',
      status: 'interrupted', cols: 80, rows: 24, exitCode: null, createdAt: 1,
    }
    await writeFile(join(f.directory, 'terminal-sessions.json'), JSON.stringify([legacy]), 'utf8')
    const restored = f.createService()
    const sessions = unwrap(await restored.list(f.target)).sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.place).toBe('tools')
    expect(unwrap(await restored.list({ ...f.target, place: 'drawer' })).sessions).toEqual([])
  })
})
