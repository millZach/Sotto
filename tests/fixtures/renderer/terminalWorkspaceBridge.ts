import { vi } from 'vitest'
import type { TerminalWorkspaceBridge, WorkspaceTerminal, WorkspaceTerminalEvent } from '../../../src/shared/terminalWorkspace'
import { bridgePublication } from './bridgePublication'

export function workspaceTerminal(id: string, patch: Partial<WorkspaceTerminal> = {}): WorkspaceTerminal {
  return structuredClone({ id, projectId: 'workshop', title: 'Build', launch: { provider: 'claude', modelId: 'claude:sonnet', reasoning: null, permission: 'ask' },
    workingCopy: 'shared', workingDirectory: 'C:/workshop', branch: 'main', command: 'claude --model claude:sonnet', status: 'running', cols: 80, rows: 24,
    exitCode: null, openedAt: 1, closedAt: null, ...patch })
}

/** Sidebar terminals use IDs and launch records, unlike the tool/drawer bridge's workspace and session IDs. */
export function terminalWorkspaceBridgeFixture(options: { terminals?: WorkspaceTerminal[]; shell?: string;
  commands?: Partial<Omit<TerminalWorkspaceBridge, 'onEvent'>> } = {}) {
  const events = bridgePublication<WorkspaceTerminalEvent>()
  let terminals = structuredClone(options.terminals ?? [])
  const bridge: TerminalWorkspaceBridge = {
    list: vi.fn<TerminalWorkspaceBridge['list']>(async () => ({ ok: true, value: { terminals, shell: options.shell ?? 'pwsh' } })),
    read: vi.fn<TerminalWorkspaceBridge['read']>(async ({ id }) => ({ ok: true, value: { terminal: terminals.find(item => item.id === id)!, output: '', sequence: 0 } })),
    open: vi.fn(), write: vi.fn(), resize: vi.fn(), interrupt: vi.fn(), stop: vi.fn(), restart: vi.fn(), close: vi.fn(), pasteImage: vi.fn(),
    onEvent: events.subscribe, ...options.commands,
  }
  return { ...events, bridge, setTerminals: (next: WorkspaceTerminal[]) => { terminals = next } }
}
