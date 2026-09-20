import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }))
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { AGENT_CHOOSE_PROJECT_DIRECTORY } from '../../../src/shared/agents'

function fixture() {
  const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
  return { ipc, main: createSottoBridge(ipc, 'win32'), widget: createSottoWidgetBridge(ipc, 'win32') }
}

describe('project directory preload bridge', () => {
  it('lists working-copy choices only on main and validates the response', async () => {
    const f = fixture()
    const options = { isGit: true, currentBranch: 'main', branches: ['main'], worktrees: [{ path: 'D:/project', branch: 'main' }] }
    f.ipc.invoke.mockResolvedValueOnce(options).mockResolvedValueOnce({ isGit: 'yes' })
    await expect(f.main.agents!.workingCopyOptions!('project')).resolves.toEqual(options)
    expect(f.ipc.invoke).toHaveBeenLastCalledWith('sotto:agents:working-copy-options', 'project')
    expect('workingCopyOptions' in f.widget.agents!).toBe(false)
    await expect(f.main.agents!.workingCopyOptions!('project')).rejects.toThrow()
  })
  it('exposes the picker only on main and sends no payload', async () => {
    const f = fixture()
    expect(f.main.agents!.chooseProjectDirectory).toBeTypeOf('function')
    expect('chooseProjectDirectory' in f.widget.agents!).toBe(false)
    f.ipc.invoke.mockResolvedValueOnce('D:\\Existing Folder\\project')
    await expect(f.main.agents!.chooseProjectDirectory!()).resolves.toBe('D:\\Existing Folder\\project')
    expect(f.ipc.invoke).toHaveBeenCalledExactlyOnceWith(AGENT_CHOOSE_PROJECT_DIRECTORY)
  })

  it('preserves cancellation and propagates IPC errors', async () => {
    const f = fixture()
    f.ipc.invoke.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('AGENT_MAIN_WINDOW_REQUIRED'))
    await expect(f.main.agents!.chooseProjectDirectory!()).resolves.toBeNull()
    await expect(f.main.agents!.chooseProjectDirectory!()).rejects.toThrow('AGENT_MAIN_WINDOW_REQUIRED')
  })

  it.each([undefined, '', 123, {}, ['D:/folder'], 'x'.repeat(4097)])('rejects malformed responses (%#)', async response => {
    const f = fixture()
    f.ipc.invoke.mockResolvedValueOnce(response)
    await expect(f.main.agents!.chooseProjectDirectory!()).rejects.toThrow()
  })
})
