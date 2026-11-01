import React, { useRef, useState, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { FolderBrowserDialog } from './FolderBrowserDialog'
import { shownWords, type LaterWords } from './interfaceWords'

/** How a save of the folder ended: saved, refused with nothing changed, or sent with no answer back. */
export type FolderSave = 'saved' | 'refused' | 'unconfirmed'

/**
 * Settings → Threads' Default projects directory for one computer: the folder written out, chosen in Add project's
 * folder browser on that computer (the owner's pick B from `prototype/projects-folder-picker`). There is no typing:
 * Choose opens the browser at the saved folder, Clear empties it, and a computer that is not connected keeps its
 * folder shown but cannot change it. `onSave` saves the folder where it was saved before, this computer's
 * configuration or the host's own.
 */
export function ProjectsDirectoryRow({ state, hostId, local, name, connected, value, heading, description, onSave }: {
  readonly state: AgentState
  readonly hostId: string
  /** This computer, rather than a saved host. */
  readonly local: boolean
  /** The saved host's name; unused for this computer. */
  readonly name: string
  readonly connected: boolean
  readonly value: string
  readonly heading: string
  readonly description?: string | undefined
  readonly onSave: (path: string) => Promise<FolderSave>
}): ReactNode {
  const { t } = useLingui()
  const [browsing, setBrowsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<LaterWords | null>(null)
  const [dialogError, setDialogError] = useState<LaterWords | null>(null)
  const choose = useRef<HTMLButtonElement>(null)
  const computerName = name
  const label = local ? t`Default projects directory on this computer` : t({ message: `Default projects directory on ${computerName}`, comment: '{computerName} is the name of a saved host.' })
  const chooseLabel = local
    ? value ? t`Change the default projects directory on this computer` : t`Choose the default projects directory on this computer`
    : value ? t({ message: `Change the default projects directory on ${computerName}`, comment: '{computerName} is the name of a saved host.' })
      : t({ message: `Choose the default projects directory on ${computerName}`, comment: '{computerName} is the name of a saved host.' })
  const clearLabel = local ? t`Clear the default projects directory on this computer`
    : t({ message: `Clear the default projects directory on ${computerName}`, comment: '{computerName} is the name of a saved host.' })
  /** Why a save did not go through: refused, so nothing changed, or never answered, so it may have. */
  const problem = (outcome: Exclude<FolderSave, 'saved'>): LaterWords => outcome === 'refused'
    ? msg`Could not save the folder. Nothing was changed. Try again.`
    : msg`Sotto could not confirm the folder was saved. Check the folder shown in Settings, then try again if it has not changed.`

  const save = async (path: string): Promise<FolderSave> => {
    setSaving(true)
    try { return await onSave(path) } catch { return 'unconfirmed' } finally { setSaving(false) }
  }
  const use = async (path: string): Promise<void> => {
    if (saving) return
    setDialogError(null)
    const outcome = await save(path)
    if (outcome === 'saved') { setError(null); setBrowsing(false) } else setDialogError(problem(outcome))
  }
  const clear = async (): Promise<void> => {
    if (saving) return
    // The Clear button goes once the folder is cleared, so the keyboard stays on Choose, which stays usable while it saves.
    choose.current?.focus()
    const outcome = await save('')
    setError(outcome === 'saved' ? null : problem(outcome))
  }

  return <div className="account-row projects-directory">
    <span className="account-row__heading"><strong>{heading}</strong>{description ? <span>{description}</span> : null}
      <bdi className={value ? 'projects-directory__path' : 'projects-directory__path projects-directory__path--none'}>{value || t`No folder chosen`}</bdi>
    </span>
    <div className="account-row__control">
      {value && connected ? <Button variant="ghost" aria-label={clearLabel} disabled={saving} onClick={() => void clear()}>{t({ message: 'Clear', comment: 'Empties the default projects directory.' })}</Button> : null}
      <Button ref={choose} variant="secondary" data-setting="projects-directory" aria-label={chooseLabel} disabled={!connected}
        onClick={() => { if (saving) return; setDialogError(null); setBrowsing(true) }}>
        <FolderOpen size={15} aria-hidden="true" />{value ? t({ message: 'Change…', comment: 'Opens the folder browser to choose another default projects directory.' }) : t({ message: 'Choose…', comment: 'Opens the folder browser to choose the default projects directory.' })}
      </Button>
    </div>
    {error ? <p className="account-row__note projects-directory__error tt-paragraph" role="alert">{shownWords(error)}</p> : null}
    {browsing ? <FolderBrowserDialog state={state} hostId={hostId} heading={label} startPath={value || undefined} purpose="projects-directory"
      busy={saving} error={dialogError} onUse={choice => { void use(choice.path) }} onClose={() => { if (!saving) setBrowsing(false) }} /> : null}
  </div>
}
