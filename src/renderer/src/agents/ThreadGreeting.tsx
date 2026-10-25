import React, { type ReactNode } from 'react'
import { ChevronDown, Folder, FolderPlus, GitBranch, Laptop, Server } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { AgentState } from '../../../shared/agents'
import { branchLabel, branchLabelChosen, toolbarApplies } from './branchToolbar.logic'
import { threadHostName } from './HostBadge'
import type { ThreadRow } from './threadFacts'
import { useOwlFeature } from '../state/owlFeature'
import { PaneMenu } from './PaneMenu'
import { greetingFor, greetingWords, recentProjects } from './threadGreeting.logic'
import { setNewThreadIntent } from './threadIntent'

/**
 * A new thread's greeting: a line picked for it, and where its work will happen. The pane sets it directly above
 * the composer and holds the two in the middle of the pane until the first send. On Owl (`recent-projects`, ADR-0121) the project
 * opens a menu of the other projects used lately; choosing one starts the new thread there instead, as New thread in
 * that project would. Stable shows the project as plain words.
 */
export function ThreadGreeting({ row, state }: { readonly row: ThreadRow; readonly state: Pick<AgentState, 'connections' | 'host'> }): ReactNode {
  const { t } = useLingui()
  const thread = row.thread
  const line = greetingWords(greetingFor(thread.id))
  const switcher = useOwlFeature('recent-projects')
  const branch = toolbarApplies(thread) && branchLabelChosen(thread) ? branchLabel(thread) : null
  const Host = thread.remoteHost ? Server : Laptop
  const projectTitle = row.project?.title
  // Each fact's name is for a screen reader, ahead of the value the eye reads.
  const projectWord = t({ message: 'Project', comment: 'Read before a project\'s name.' })
  return <div className="thread-greeting">
    <h3>{line}</h3>
    <p className="thread-greeting__where">
      {row.project && !switcher ? <span><Folder size={13} aria-hidden="true" /><span className="tt-visually-hidden">{projectWord} </span>{row.project.title}</span> : null}
      {row.project && switcher ? <PaneMenu className="thread-greeting__project" label={t`Change project, now ${projectTitle}`}
        icon={<Folder size={13} aria-hidden="true" />} text={<><span className="tt-visually-hidden">{projectWord} </span><span className="thread-greeting__project-name">{row.project.title}</span><ChevronDown size={12} aria-hidden="true" /></>}
        groups={[
          recentProjects(state, thread).map(project => ({ id: project.id, label: project.title, icon: <Folder size={15} aria-hidden="true" />, run: () => setNewThreadIntent({ projectId: project.id }) })),
          [{ id: 'other', label: t`Choose another folder…`, icon: <FolderPlus size={15} aria-hidden="true" />, run: () => setNewThreadIntent({}) }],
        ]} /> : null}
      {branch !== null ? <span><GitBranch size={13} aria-hidden="true" /><span className="tt-visually-hidden">{t({ message: 'Branch', comment: 'Read before a Git branch\'s name.' })} </span>{branch}</span> : null}
      <span><Host size={13} aria-hidden="true" /><span className="tt-visually-hidden">{t({ message: 'Runs on', comment: 'Read before the computer or host the thread runs on.' })} </span>{threadHostName(state, thread)}</span>
    </p>
  </div>
}
