import React, { useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { projectWorkingCopyDefaultKey } from '../../../../shared/clientIdentity'
import { useOptionalAgents } from '../../agents/AgentContext'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { Select } from '../../components/Select'

interface ProjectThreadDefaultsProps {
  readonly settings: AppSettings
  readonly onSave: (patch: SettingsPatch) => Promise<boolean>
}

export function ProjectThreadDefaults({ settings, onSave }: ProjectThreadDefaultsProps): ReactNode {
  const { t } = useLingui()
  const agents = useOptionalAgents()
  const projects = agents?.state?.host.projects ?? []
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const contentId = useId()
  const project = projects.find(item => item.id === selectedId) ?? projects[0]
  const defaultKey = (id: string): string => projectWorkingCopyDefaultKey(agents?.state, id)

  const saveDefault = async (value: string): Promise<void> => {
    if (!project || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    const defaults = { ...settings.projectThreadWorkingCopyDefaults }
    if (value === 'inherit') delete defaults[defaultKey(project.id)]
    else if (value === 'shared' || value === 'independent') defaults[defaultKey(project.id)] = value
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
    <Button ref={button} variant="ghost" data-setting="project-defaults" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />} <Trans>Project defaults</Trans>
    </Button>
    <div id={contentId} hidden={!open}>
      {project ? <div className="settings-rows">
        <Field label={t({ message: 'Project', comment: 'The project whose default is being chosen' })}><Select value={project.id} disabled={saving} onChange={event => setSelectedId(event.currentTarget.value)}>
          {projects.map(item => <option key={item.id} value={item.id}>{item.title} — {item.path}</option>)}
        </Select></Field>
        <Field label={t`New threads in this project work in`}><Select value={settings.projectThreadWorkingCopyDefaults[defaultKey(project.id)] ?? 'inherit'} disabled={saving} onChange={event => void saveDefault(event.currentTarget.value)}>
          <option value="inherit">{settings.threadWorkingCopyDefault === 'shared' ? t`Use global default (Project folder)` : t`Use global default (New worktree)`}</option>
          <option value="shared">{t`Project folder`}</option>
          <option value="independent">{t`New worktree`}</option>
        </Select></Field>
      </div> : <p className="tt-field__description tt-paragraph"><Trans>Add a project in Threads to set its default working copy.</Trans></p>}
    </div>
  </div>
}
