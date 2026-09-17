import { PROVIDER_LABELS, type AgentProject, type AgentState, type ProviderId } from '../../../shared/agents'
import type { WorkspaceTerminal } from '../../../shared/terminalWorkspace'
import { elapsedLabel } from '../agents/threadFacts'

/** What the sidebar says a terminal is doing; every value derives from main's record and the output clock. */
export type TerminalRowState = 'starting' | 'running' | 'idle' | 'exited' | 'closed'

/** Output within this long ago reads as Running; a quiet terminal is Idle. */
export const TERMINAL_IDLE_AFTER_MS = 4_000

export interface TerminalRow {
  readonly terminal: WorkspaceTerminal
  readonly project: AgentProject | undefined
  readonly providerId: ProviderId | undefined
  /** "Claude Code", "Codex", or "Shell" when no provider was chosen. */
  readonly provider: string
  readonly title: string
  /** How long the terminal has been open: "4 min", "2 h". Empty once closed. */
  readonly since: string
}

export interface TerminalFolder {
  readonly id: string
  readonly project: AgentProject | undefined
  readonly title: string
  readonly rows: readonly TerminalRow[]
  readonly running: number
}

export interface TerminalOrganization {
  readonly open: readonly TerminalFolder[]
  readonly closed: readonly TerminalFolder[]
  readonly matching: number
}

export const isOpenTerminal = (terminal: WorkspaceTerminal): boolean => terminal.closedAt === null

/** A terminal with a process, or on its way to one: it takes input soon and counts among a project's running ones. */
export const isLiveTerminal = (terminal: WorkspaceTerminal): boolean => terminal.status === 'running' || terminal.status === 'starting'

/** The sidebar row's state token, on the same scale the thread rows use so the status dot reads the same. */
export const SIDEBAR_STATE: Readonly<Record<TerminalRowState, string>> = { starting: 'working', running: 'working', idle: 'idle', exited: 'stopped', closed: 'done' }

export function terminalProviderName(providerId: ProviderId | null): string {
  return providerId === null ? 'Shell' : PROVIDER_LABELS[providerId]
}

export function describeTerminals(state: Pick<AgentState, 'host'>, terminals: readonly WorkspaceTerminal[], now: number): TerminalRow[] {
  return terminals.map(terminal => ({
    terminal, project: state.host.projects.find(project => project.id === terminal.projectId),
    providerId: terminal.launch.provider ?? undefined, provider: terminalProviderName(terminal.launch.provider), title: terminal.title,
    since: isOpenTerminal(terminal) ? elapsedLabel(terminal.openedAt, now) : '',
  }))
}

/** Starting, Running, Idle, Exited or Closed, from the record and when its output last moved. */
export function terminalState(terminal: WorkspaceTerminal, lastOutputAt: number, now: number): TerminalRowState {
  if (!isOpenTerminal(terminal)) return 'closed'
  if (terminal.status === 'starting') return 'starting'
  if (terminal.status !== 'running') return 'exited'
  return now - lastOutputAt <= TERMINAL_IDLE_AFTER_MS ? 'running' : 'idle'
}

/** How an ended terminal ended, for the row and the pane's tag. */
export function exitLabel(terminal: WorkspaceTerminal): string {
  if (terminal.status === 'unavailable') return 'Could not start'
  return terminal.exitCode === null || terminal.exitCode === 0 ? 'Exited' : `Exited with code ${terminal.exitCode}`
}

/** The sentence under an ended terminal's header. */
export function exitNote(terminal: WorkspaceTerminal): string {
  return terminal.status === 'unavailable' ? 'The command could not start in this folder.' : 'Its output stays here until you close or restart it.'
}

/** The row's status: Running, the last notable line while it waits, how it ended, or Closed. */
export function terminalStateLabel(terminal: WorkspaceTerminal, state: TerminalRowState, lastLine = ''): string {
  switch (state) {
    case 'starting': return 'Starting'
    case 'running': return 'Running'
    case 'idle': return lastLine || 'Idle'
    case 'closed': return 'Closed'
    default: return exitLabel(terminal)
  }
}

// eslint-disable-next-line no-control-regex -- escape sequences are what this strips.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/gu
/** The last line the terminal printed, with its colours and prompt noise stripped, short enough for a row. */
export function lastNotableLine(output: string, limit = 60): string {
  const lines = output.replace(ANSI, '').split(/\r\n|\r|\n/u)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (!line || /^[\s>$%#›❯]+$/u.test(line)) continue
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
  }
  return ''
}

export function matchesTerminalQuery(row: TerminalRow, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return [row.title, row.provider, row.terminal.command, row.terminal.branch ?? '', row.project?.title ?? ''].some(text => text.toLocaleLowerCase().includes(needle))
}

const newestFirst = (first: TerminalRow, second: TerminalRow): number => (second.terminal.openedAt - first.terminal.openedAt) || first.terminal.id.localeCompare(second.terminal.id)

/**
 * Project folders for Terminal mode: open terminals under their projects, then the Closed shelf. Without a
 * search, every open project shows so a terminal can be started there; a search keeps only matching rows.
 */
export function organizeTerminals(state: Pick<AgentState, 'host'>, rows: readonly TerminalRow[], query: string): TerminalOrganization {
  const needle = query.trim()
  const listed = rows.filter(row => matchesTerminalQuery(row, needle))
  const byProject = new Map<string, TerminalRow[]>()
  for (const row of listed) byProject.set(row.terminal.projectId, [...byProject.get(row.terminal.projectId) ?? [], row])
  const projects = new Map(state.host.projects.map(project => [project.id, project]))
  const ids = new Set([...projects.keys(), ...byProject.keys()])
  const open: TerminalFolder[] = []
  const closed: TerminalFolder[] = []
  for (const id of ids) {
    const project = projects.get(id)
    const all = (byProject.get(id) ?? []).sort(newestFirst)
    const title = project?.title ?? all[0]?.project?.title ?? 'Project'
    const openRows = all.filter(row => isOpenTerminal(row.terminal))
    const closedRows = all.filter(row => !isOpenTerminal(row.terminal))
    if (openRows.length || (needle === '' && project !== undefined && !(project.workspaceSettledAt ?? null))) open.push({ id, project, title, rows: openRows, running: openRows.filter(row => isLiveTerminal(row.terminal)).length })
    if (closedRows.length) closed.push({ id, project, title, rows: closedRows, running: 0 })
  }
  const latest = (folder: TerminalFolder): number => folder.rows[0]?.terminal.openedAt ?? Number.NEGATIVE_INFINITY
  const ordered = (folders: TerminalFolder[]): TerminalFolder[] => folders.sort((first, second) => (latest(second) - latest(first)) || first.title.localeCompare(second.title))
  return { open: ordered(open), closed: ordered(closed), matching: listed.length }
}
