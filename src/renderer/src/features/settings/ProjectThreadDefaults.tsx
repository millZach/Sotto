import React, { useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { useOptionalAgents } from '../../agents/AgentContext'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { Select } from '../../components/Select'

interface ProjectThreadDefaultsProps {
  readonly settings: AppSettings
  readonly onSave: (patch: SettingsPatch) => Promise<boolean>
}

export function ProjectThreadDefaults({ settings, onSave }: ProjectThreadDefaultsProps): ReactNode {
  const agents = useOptionalAgents()
  const projects = agents?.state?.host.projects ?? []
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const contentId = useId()
  const project = projects.find(item => item.id === selectedId) ?? projects[0]

  const saveDefault = async (value: string): Promise<void> => {
    if (!project || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    const defaults = { ...settings.projectThreadWorkingCopyDefaults }
    if (value === 'inherit') delete defaults[project.id]
    else if (value === 'shared' || value === 'independent') defaults[project.id] = value
    try {
      await onSave({ projectThreadWorkingCopyDefaults: defaults })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return <div onKeyDown={event => {
    if (event.key !== 'Escape' || !open) return
    event.stopPropagation()
    setOpen(false)
    button.current?.focus()
  }}>
    <Button ref={button} variant="ghost" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />} Project defaults
    </Button>
    <div id={contentId} hidden={!open}>
      {project ? <div className="settings-rows">
        <Field label="Project"><Select value={project.id} disabled={saving} onChange={event => setSelectedId(event.currentTarget.value)}>
          {projects.map(item => <option key={item.id} value={item.id}>{item.title} — {item.path}</option>)}
        </Select></Field>
        <Field label="New threads in this project work in"><Select value={settings.projectThreadWorkingCopyDefaults[project.id] ?? 'inherit'} disabled={saving} onChange={event => void saveDefault(event.currentTarget.value)}>
          <option value="inherit">Use global default ({settings.threadWorkingCopyDefault === 'shared' ? 'Project folder' : 'New worktree'})</option>
          <option value="shared">Project folder</option>
          <option value="independent">New worktree</option>
        </Select></Field>
      </div> : <p className="tt-field__description">Add a project in Threads to set its default working copy.</p>}
    </div>
  </div>
}
