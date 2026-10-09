import { describe, expect, it } from 'vitest'
import type { WorkspaceTerminal } from '../../../src/shared/terminalWorkspace'
import { SIDEBAR_STATE, describeTerminals, isOpenTerminal, lastNotableLine, organizeTerminals, terminalState, terminalStateLabel } from '../../../src/renderer/src/terminals/terminalFacts'
import { threadsStateFixture } from './liveAgentState'

const NOW = 1_700_000_000_000
const ID = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`

function terminal(n: number, patch: Partial<WorkspaceTerminal> = {}): WorkspaceTerminal {
  return {
    id: ID(n), projectId: 'workshop', title: `Terminal ${n}`, launch: { provider: 'claude', modelId: 'claude:sonnet', reasoning: null, permission: 'ask' },
    workingCopy: 'shared', workingDirectory: 'C:/workshop', branch: 'main', command: 'claude --model claude:sonnet', status: 'running', cols: 80, rows: 24,
    exitCode: null, openedAt: NOW - 5 * 60_000, closedAt: null, ...patch,
  }
}

describe('terminal rows', () => {
  it('names the provider, or Shell, and says how long the terminal has been open', () => {
    const rows = describeTerminals(threadsStateFixture(), [terminal(1), terminal(2, { launch: { provider: null, modelId: null, reasoning: null, permission: null }, closedAt: NOW })], NOW)
    expect(rows.map(row => [row.provider, row.since, row.project?.title])).toEqual([['Claude Code', '5 min', 'workshop'], ['Shell', '', 'workshop']])
  })

  it('reads Starting before the process, Running from recent output, Idle from quiet, and the exit from the record', () => {
    // A terminal main has published but not yet spawned is open, and says so.
    const starting = terminal(1, { status: 'starting', branch: null })
    expect(isOpenTerminal(starting)).toBe(true)
    expect(terminalState(starting, Number.NEGATIVE_INFINITY, NOW)).toBe('starting')
    expect(terminalStateLabel(starting, 'starting')).toBe('Starting')
    expect(SIDEBAR_STATE.starting).toBe('working')
    const shell = terminal(1, { launch: { provider: null, modelId: null, reasoning: null, permission: null } })
    expect(terminalState(shell, NOW - 1_000, NOW)).toBe('running')
    expect(terminalState(shell, NOW - 60_000, NOW)).toBe('idle')
    expect(terminalState(terminal(1, { status: 'exited', exitCode: 2 }), NOW, NOW)).toBe('exited')
    expect(terminalState(terminal(1, { closedAt: NOW }), NOW, NOW)).toBe('closed')
    expect(terminalStateLabel(terminal(1, { status: 'exited', exitCode: 2 }), 'exited')).toBe('Exited with code 2')
    expect(terminalStateLabel(terminal(1, { status: 'unavailable' }), 'exited')).toBe('Could not start')
    expect(terminalStateLabel(terminal(1), 'idle')).toBe('Idle')
    expect(terminalStateLabel(shell, 'idle', 'Port 5173 in use')).toBe('Port 5173 in use')
  })

  it('takes the last notable line from the output, without colours, prompts or blank lines', () => {
    expect(lastNotableLine('\x1b[32mready\x1b[0m\r\nPort 5173 in use\r\n\r\nPS C:\\workshop> ')).toBe('PS C:\\workshop>')
    expect(lastNotableLine('Port 5173 in use\r\n\r\n> ')).toBe('Port 5173 in use')
    expect(lastNotableLine('')).toBe('')
    expect(lastNotableLine(`${'x'.repeat(80)}\n`)).toHaveLength(60)
  })

  it('reads an agent state only from main, regardless of recent output or a quiet interval', () => {
    const labels = { starting: 'Starting', working: 'Working', idle: 'Idle', 'needs-you': 'Needs you', 'just-finished': 'Just finished', exited: 'Exited' } as const
    for (const [agentState, label] of Object.entries(labels)) {
      const record = terminal(1, { agentState: agentState as WorkspaceTerminal['agentState'] })
      expect(terminalState(record, NOW, NOW)).toBe(agentState)
      expect(terminalState(record, NOW - 24 * 60 * 60_000, NOW)).toBe(agentState)
      expect(terminalStateLabel(record, terminalState(record, NOW, NOW), 'An old permission prompt?')).toBe(label)
    }
    expect(terminalState(terminal(1, { status: 'exited', agentState: 'just-finished' }), NOW, NOW)).toBe('exited')
    expect(terminalState(terminal(1, { closedAt: NOW, agentState: 'needs-you' }), NOW, NOW)).toBe('closed')
    expect(terminalState(terminal(1), NOW, NOW)).toBe('idle')
    expect(terminalStateLabel(terminal(1), 'idle', 'Unclassified output')).toBe('Idle')
  })

  it('keeps plain shells on their Running and Idle clock, apart from agent states', () => {
    const shell = terminal(1, { launch: { provider: null, modelId: null, reasoning: null, permission: null }, agentState: 'needs-you' })
    expect(terminalState(shell, NOW, NOW)).toBe('running')
    expect(terminalState(shell, NOW - 60_000, NOW)).toBe('idle')
    expect(terminalStateLabel(shell, 'idle', 'Server ready')).toBe('Server ready')
  })

  it('groups open terminals by project, newest first, and keeps closed ones on their own shelf', () => {
    const state = threadsStateFixture()
    const rows = describeTerminals(state, [terminal(1, { openedAt: NOW - 60_000 }), terminal(2, { status: 'starting' }), terminal(3, { closedAt: NOW })], NOW)
    const organization = organizeTerminals(state, rows, '')
    const workshop = organization.open.find(folder => folder.id === 'workshop')!
    expect(workshop.rows.map(row => row.title)).toEqual(['Terminal 1'])
    expect(organization.working.map(row => row.title)).toEqual(['Terminal 2'])
    expect(workshop.running).toBe(1)
    // Every open project is listed so a terminal can be started there.
    expect(organization.open.map(folder => folder.id)).toEqual(expect.arrayContaining(state.host.projects.filter(project => !project.workspaceSettledAt).map(project => project.id)))
    expect(organization.closed.map(folder => folder.rows.map(row => row.title))).toEqual([['Terminal 3']])
  })

  it('puts current requests across projects first, then starting and working agents, with no duplicated rows', () => {
    const state = threadsStateFixture()
    const other = state.host.projects.find(project => project.id !== 'workshop')!
    const records = [
      terminal(1, { agentState: 'idle' }),
      terminal(2, { projectId: other.id, agentState: 'needs-you' }),
      terminal(3, { agentState: 'working' }),
      terminal(4, { agentState: 'needs-you', openedAt: NOW }),
      terminal(5, { status: 'starting', agentState: 'starting' }),
      terminal(6, { agentState: 'just-finished' }),
      terminal(7, { closedAt: NOW, agentState: 'needs-you' }),
      terminal(8, { launch: { provider: null, modelId: null, reasoning: null, permission: null } }),
    ]
    const organization = organizeTerminals(state, describeTerminals(state, records, NOW), '')
    expect(organization.needsYou.map(row => row.title)).toEqual(['Terminal 4', 'Terminal 2'])
    expect(organization.working.map(row => row.title)).toEqual(['Terminal 3', 'Terminal 5'])
    expect(organization.open.flatMap(folder => folder.rows).map(row => row.title)).toEqual(['Terminal 1', 'Terminal 6', 'Terminal 8'])
    expect(organization.closed.flatMap(folder => folder.rows).map(row => row.title)).toEqual(['Terminal 7'])
    expect(organization.matching).toBe(8)
    const filtered = organizeTerminals(state, describeTerminals(state, records, NOW), 'Terminal 2')
    expect(filtered.needsYou.map(row => row.project?.title)).toEqual([other.title])
    expect(filtered.working).toEqual([])
    expect(filtered.open).toEqual([])
  })

  it('searches titles, providers, commands and branches, and drops empty projects while searching', () => {
    const state = threadsStateFixture()
    const rows = describeTerminals(state, [terminal(1, { title: 'Build' }), terminal(2, { title: 'Tests', branch: 'sotto/terminal-2' })], NOW)
    expect(organizeTerminals(state, rows, 'sotto/').open.map(folder => folder.rows.map(row => row.title))).toEqual([['Tests']])
    expect(organizeTerminals(state, rows, 'claude').matching).toBe(2)
    expect(organizeTerminals(state, rows, 'nothing').open).toEqual([])
  })
})
