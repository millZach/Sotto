// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty, IPtyForkOptions } from 'node-pty'
import { TerminalWorkspaceService } from '../../../src/main/terminals/service'
import { registerTerminalWorkspaceIpc, type TerminalVisibilityWindow } from '../../../src/main/terminals/ipc'
import type { PrepareTerminalAgentHooksOptions, TerminalAgentHookEvent } from '../../../src/main/terminals/hooks'
import type { IpcInvocationEvent } from '../../../src/main/ipc/registerIpc'
import type { ToolsResult } from '../../../src/shared/tools'

const unwrap = <T>(result: ToolsResult<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value }
const disposals: (() => void)[] = []
afterEach(() => { for (const dispose of disposals.splice(0)) dispose() })
const launch = { provider: 'claude', modelId: null, reasoning: null, permission: 'ask' } as const
const screen = (body: string) => `\x1b[2J\x1b[HClaude Code v2.1.295\r\n${body}`
const idle = screen('❯ \r\n? for shortcuts'), working = screen('✻ Working… (esc to interrupt)')

function fixture() {
  const runs: { options: PrepareTerminalAgentHooksOptions; runId: string; dispose: ReturnType<typeof vi.fn> }[] = []
  const processes: { data(data: string): void; exit(): void; pty: IPty }[] = []
  const spawn = vi.fn<(file: string, args: string[], options: IPtyForkOptions) => IPty>(() => {
    let onData: (data: string) => void = () => {}, onExit: (exit: { exitCode: number }) => void = () => {}
    const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: (listener: typeof onData) => { onData = listener; return { dispose() { onData = () => {} } } }, onExit: (listener: typeof onExit) => { onExit = listener; return { dispose() { onExit = () => {} } } } } as unknown as IPty
    processes.push({ pty, data: value => onData(value), exit: () => onExit({ exitCode: 0 }) }); return pty
  })
  const emit = vi.fn()
  const service = new TerminalWorkspaceService({ projects: () => [{ id: 'p', title: 'Project', path: '/project' }],
    worktrees: { allocate: vi.fn(), ensure: vi.fn(), workingDirectory: vi.fn() }, spawn, emit, platform: 'darwin', env: { SHELL: '/bin/zsh' },
    prepareHooks: async options => { const run = { options, runId: randomUUID(), dispose: vi.fn() }; runs.push(run); return { ...run, args: ['--settings', '/private/run-settings.json'], env: { SOTTO_PRIVATE_HOOK_SECRET: 'private' }, answer: () => false } },
  })
  disposals.push(() => service.dispose())
  const open = async () => { const { terminal } = unwrap(await service.open({ projectId: 'p', title: 'Agent', workingCopy: 'shared', launch })); unwrap(await service.read({ id: terminal.id })); processes.at(-1)!.data(idle); return terminal.id }
  const state = async (id: string) => unwrap(await service.read({ id })).terminal.agentState
  const send = (index: number, kind: TerminalAgentHookEvent['kind']) => { const run = runs[index]!; run.options.onEvent({ terminalId: 'terminal', runId: run.runId, eventId: randomUUID(), kind, state: kind === 'working' ? 'working' : 'idle' }) }
  return { service, processes, runs, spawn, emit, open, state, send }
}

describe('main-owned terminal visibility and lifecycle', () => {
  it('merges visible pane sets and clears unread globally, including unfocused panes', async () => {
    const f = fixture(), first = await f.open(), second = await f.open(), desktop = {}, phone = {}
    unwrap(await f.service.visibility({ ids: [first, second] }, desktop))
    for (const process of f.processes) { process.data(working); process.data(idle) }
    expect(await f.state(first)).toBe('idle'); expect(await f.state(second)).toBe('idle')
    unwrap(await f.service.visibility({ ids: [] }, desktop)); f.processes[1]!.data(working); f.processes[1]!.data(idle)
    expect(await f.state(second)).toBe('just-finished')
    unwrap(await f.service.visibility({ ids: [second] }, phone)); expect(await f.state(second)).toBe('idle')
    f.service.withdrawVisibility(phone); expect(await f.state(second)).toBe('idle')
  })
  it('withdraws a hidden/disconnected window even before the renderer can send an empty set', async () => {
    const f = fixture(), id = await f.open(), client = {}; let visible = true
    unwrap(await f.service.visibility({ ids: [id] }, client, () => visible))
    visible = false; f.processes[0]!.data(working); f.processes[0]!.data(idle)
    expect(await f.state(id)).toBe('just-finished')
    visible = true; f.service.refreshVisibility(); expect(await f.state(id)).toBe('idle')
    f.service.withdrawVisibility(client); f.processes[0]!.data(working); f.processes[0]!.data(idle)
    expect(await f.state(id)).toBe('just-finished')
  })
  it('ends a run on actual exit/Stop and discards callbacks from a Closed/Reopened process', async () => {
    const f = fixture(), id = await f.open()
    f.send(0, 'working'); f.processes[0]!.exit(); f.send(0, 'completed'); expect(await f.state(id)).toBe('exited')
    expect(f.runs[0]!.dispose).toHaveBeenCalledOnce()
    unwrap(await f.service.restart({ id })); f.processes[1]!.data(idle); f.send(0, 'working'); expect(await f.state(id)).toBe('idle')
    f.send(1, 'working'); unwrap(await f.service.stop({ id })); expect(await f.state(id)).toBe('exited')
    unwrap(await f.service.close({ id })); unwrap(await f.service.restart({ id })); f.processes[2]!.data(idle)
    f.send(1, 'completed'); expect(await f.state(id)).toBe('idle'); expect(new Set(f.runs.map(run => run.runId)).size).toBe(3)
  })
  it('keeps hook launch overrides and secrets out of public terminal records and banners', async () => {
    const f = fixture(), id = await f.open(), snapshot = unwrap(await f.service.read({ id }))
    expect(f.spawn.mock.calls[0]![1].join(' ')).toContain('/private/run-settings.json')
    expect(f.spawn.mock.calls[0]![2].env).toHaveProperty('SOTTO_PRIVATE_HOOK_SECRET', 'private')
    expect(JSON.stringify(snapshot)).not.toContain('/private/run-settings.json'); expect(JSON.stringify(snapshot)).not.toContain('private')
    expect(snapshot.terminal.command).toBe('claude')
  })
  it('a failed CLI launch has Exited agent state, even with lifecycle unavailable', async () => {
    const f = fixture(); f.spawn.mockImplementationOnce(() => { throw new Error('spawn failed') })
    const { terminal } = unwrap(await f.service.open({ projectId: 'p', title: 'Agent', workingCopy: 'shared', launch }))
    expect(unwrap(await f.service.read({ id: terminal.id })).terminal).toMatchObject({ status: 'unavailable', agentState: 'exited' })
    expect(f.runs[0]!.dispose).toHaveBeenCalledOnce()
  })
  it('IPC binds visibility to the trusted actual window and responds to minimise/restore/close', async () => {
    const f = fixture(), id = await f.open(), url = 'file:///main.html', mainFrame = { parent: null, url }
    const sender = { mainFrame, getURL: () => url, isDestroyed: () => false }
    const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
    const listeners = new Map<string, () => void>(); let minimised = false
    const window: TerminalVisibilityWindow = { isVisible: () => true, isMinimized: () => minimised, isDestroyed: () => false, on: (name, fn) => { listeners.set(name, fn) }, removeListener: name => { listeners.delete(name) },
      webContents: { on: (name, fn) => { listeners.set(name, fn) }, removeListener: name => { listeners.delete(name) } },
    }
    const unregister = registerTerminalWorkspaceIpc({ handle: (channel, fn) => { handlers.set(channel, fn) }, removeHandler: channel => { handlers.delete(channel) } }, f.service, () => [{ role: 'main', url, webContents: sender }], () => window)
    disposals.push(unregister)
    const report = handlers.get('sotto:terminals:visibility')!
    await report({ sender, senderFrame: mainFrame }, { ids: [id] })
    minimised = true; listeners.get('minimize')!(); f.processes[0]!.data(working); f.processes[0]!.data(idle)
    expect(await f.state(id)).toBe('just-finished')
    minimised = false; listeners.get('restore')!(); expect(await f.state(id)).toBe('idle')
    listeners.get('render-process-gone')!(); f.processes[0]!.data(working); f.processes[0]!.data(idle)
    expect(await f.state(id)).toBe('just-finished')
    await report({ sender, senderFrame: mainFrame }, { ids: [id] }); expect(await f.state(id)).toBe('idle')
    listeners.get('closed')!(); f.processes[0]!.data(working); f.processes[0]!.data(idle)
    expect(await f.state(id)).toBe('just-finished'); expect(listeners.size).toBe(0)
  })
})
