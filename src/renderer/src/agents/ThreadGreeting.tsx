import React, { type ReactNode } from 'react'
import { Folder, GitBranch, Laptop, Server } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import { branchLabel, toolbarApplies } from './branchToolbar.logic'
import { threadHostName } from './HostBadge'
import type { ThreadRow } from './threadFacts'
import { greetingFor } from './threadGreeting.logic'

/**
 * A new thread's greeting: a line picked for it, and where its work will happen. The pane sets it directly above
 * the composer and holds the two in the middle of the pane until the first send.
 */
export function ThreadGreeting({ row, state }: { readonly row: ThreadRow; readonly state: Pick<AgentState, 'connections'> }): ReactNode {
  const thread = row.thread
  const line = greetingFor(thread.id)
  const branch = toolbarApplies(thread) ? branchLabel(thread) : null
  const Host = thread.remoteHost ? Server : Laptop
  return <div className="thread-greeting">
    <h3>{line}</h3>
    <p className="thread-greeting__where">
      {row.project ? <span><Folder size={13} aria-hidden="true" /><span className="tt-visually-hidden">Project </span>{row.project.title}</span> : null}
      {branch !== null && branch !== 'Select ref' ? <span><GitBranch size={13} aria-hidden="true" /><span className="tt-visually-hidden">Branch </span>{branch}</span> : null}
      <span><Host size={13} aria-hidden="true" /><span className="tt-visually-hidden">Runs on </span>{threadHostName(state, thread)}</span>
    </p>
  </div>
}
