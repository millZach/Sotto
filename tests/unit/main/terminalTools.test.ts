// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'
import { FilesService } from '../../../src/main/files/service'
import { TerminalService, type TerminalDependencies } from '../../../src/main/tools/terminal'
import * as clipboard from '../../../src/main/terminals/clipboard'
import { TERMINAL_MAX_OUTPUT, type TerminalEvent } from '../../../src/shared/terminal'
import type { ToolsResult } from '../../../src/shared/tools'

const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(options: Pick<TerminalDependencies, 'env' | 'platform'> = {}) {
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
    expect(vi.mocked(f.processes[0]!.pty.write).mock.calls.map(args => args[0])).toEqual(['first.png', 'second.png', '\r'])
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
    expect(f.processes[0]!.pty.write).toHaveBeenCalledWith(/\s/u.test(path) ? `"${path}"` : path)
    f.processes[0]!.exit(0)
    expect(await f.service.pasteImage({ ...request, dataUrl })).toMatchObject({ ok: false, error: { code: 'not-running' } })
    expect(f.processes[0]!.pty.write).toHaveBeenCalledOnce()
  })
  it('keeps writes in request order while another session can pass a held workspace validation', async () => {
    const f = await fixture()
    const first = unwrap(await f.service.create(f.target)), other = unwrap(await f.service.create(f.target))
    const request = { ...f.target, sessionId: first.session.id }
    const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
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
    const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
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
