import type { AgentState } from './agents'
import { withoutThreads } from './watcherVisibility'

/**
 * The state with every owlet left out (ADR-0211): its thread, its drafts and deliveries, and its folder's project, so the
 * Threads page, its Needs you card and its project lists show none of them. Main's records are untouched, and a state
 * with no owlet comes back as it was.
 */
export function withoutOwlets(state: AgentState): AgentState
export function withoutOwlets(state: AgentState | null): AgentState | null
export function withoutOwlets(state: AgentState | null): AgentState | null {
  if (state === null || !state.host.threads.some(thread => thread.owlet !== undefined)) return state
  const hidden = new Set<string>(), owletProjects = new Set<string>(), otherProjects = new Set<string>()
  for (const thread of state.host.threads) {
    if (thread.owlet !== undefined) { hidden.add(thread.id); owletProjects.add(thread.projectId) } else otherProjects.add(thread.projectId)
  }
  const visible = withoutThreads(state, hidden)
  // An owlet's folder is its own; a project another thread also works in stays.
  const gone = new Set([...owletProjects].filter(id => !otherProjects.has(id)))
  if (gone.size === 0) return visible
  return { ...visible, host: { ...visible.host, projects: visible.host.projects.filter(project => !gone.has(project.id)) },
    ...(visible.activeProjectId !== null && gone.has(visible.activeProjectId) ? { activeProjectId: null } : {}) }
}
