import { FolderOpen, FolderPlus } from 'lucide-react'
import React, { type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { AgentProject, AgentState } from '../../../../shared/agents'
import { useOptionalAgents, type AgentConnection } from '../../agents/AgentContext'
import { useAddProject } from '../../agents/addProject'
import { Button } from '../../components/Button'
import { liveAgentState, localHostId, localProjects, localProviders } from './localAgents'

export interface ProjectStepProps {
  readonly heading: ReactNode
}

function ProjectList({ projects }: { readonly projects: readonly AgentProject[] }): ReactNode {
  return (
    <ul className="onboarding-projects" aria-label="Projects">
      {projects.map(project => (
        <li key={project.id} className="onboarding-project">
          <FolderOpen aria-hidden="true" size={20} />
          <span><strong>{project.title}</strong><span className="onboarding-project__path">{project.path}</span></span>
        </li>
      ))}
    </ul>
  )
}

/** Add project as the sidebar runs it, once main's state is live and an agent is connected to make the project with. */
function AddProject({ state, command, another }: { readonly state: AgentState; readonly command: AgentConnection['command']; readonly another: boolean }): ReactNode {
  // Setup lists and counts this computer's projects, so the folder is chosen on this computer.
  const addProject = useAddProject(state, command, { hostId: localHostId(state) })
  return (
    <>
      <Button variant={another ? 'secondary' : 'primary'} disabled={addProject.adding} onClick={() => void addProject.add()}>
        <FolderPlus aria-hidden="true" size={17} />
        {another ? 'Add another folder' : 'Choose a folder'}
      </Button>
      {addProject.error ? <p className="onboarding-recovery" role="alert">{addProject.error}</p> : null}
      {addProject.dialog ? createPortal(addProject.dialog, document.body) : null}
    </>
  )
}

/**
 * Setup's first project: a folder, usually a Git repository, that threads start in. It uses Add project as the
 * sidebar does, so a folder chosen here is the same project the sidebar lists. Adding one needs a connected agent;
 * projects this computer already has are listed either way.
 */
export function ProjectStep({ heading }: ProjectStepProps): ReactNode {
  const agents = useOptionalAgents()
  const state = liveAgentState(agents?.state)
  const projects = state ? localProjects(state) : []
  const connected = state ? localProviders(state).some(provider => provider.connection === 'connected') : false
  return (
    <section aria-labelledby="onboarding-heading">
      {heading}
      {projects.length > 0 ? <ProjectList projects={projects} /> : null}
      {state && agents && connected
        ? <AddProject state={state} command={agents.command} another={projects.length > 0} />
        : <p className="onboarding-recovery" role="status">
          {projects.length > 0
            ? 'Connect a coding agent to add another project. Go back to Coding agents, or add one from the sidebar later.'
            : 'Connect a coding agent first: a project starts its threads with one. Go back to Coding agents, or skip this and add a project from the sidebar later.'}
        </p>}
      <p className="onboarding-aside">
        {projects.length > 0
          ? 'New threads share the project folder. Choose New worktree when you start one to give it a checkout of its own.'
          : 'You can add more projects from the sidebar at any time.'}
      </p>
    </section>
  )
}
