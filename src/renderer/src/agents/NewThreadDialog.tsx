import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Laptop, Server, X } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { defaultNewThreadModelId, hostForThread, isSubscriptionReasoning, type AgentProject, type AgentState } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import './newThread.css'
import { beginNewThread, type ThreadCreationStart } from './newThread'
import { creationErrorWords } from './draftThreads'
import { shownWords, type LaterWords } from './interfaceWords'
import { projectForFolder, useProjectChooser } from './ProjectChooser'
import { listedHosts } from './HostBadge'

export { folderKey } from './ProjectChooser'
export type { ThreadCreationStart } from './newThread'

/**
 * New thread. The pen on a project row and the empty Threads page's button already know their project and skip
 * this dialog, opening the thread at once through `beginNewThread` on the defaults from Settings → Threads, with
 * no further form to fill in (issue #347); the sidebar's top New thread button does the same once a project is
 * chosen here.
 */
export function NewThreadDialog({ state, command, onClose, onCreated, onCreating }: {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly onClose: () => void
  readonly onCreated: () => void
  /**
   * Present when the caller shows the thread itself: the dialog issues the command and hands the creation over
   * at once instead of waiting for it, and `onCreated` is not called.
   */
  readonly onCreating?: ((start: ThreadCreationStart) => void) | undefined
}): ReactNode {
  const { t } = useLingui()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // With threads from more than one host listed, New thread starts by choosing the host; its projects follow.
  const hosts = listedHosts(state)
  const [hostId, setHostId] = useState<string | undefined>(() => hosts.length ? state.hostId ?? hosts[0]?.hostId : undefined)
  const chosenHost = hosts.find(item => item.hostId === (hostId ?? state.hostId))
  // A new folder becomes a project on the host chosen above, since it is added there rather than on any thread's host.
  const projectHost = hostForThread(state.host, { hostId: chosenHost?.hostId ?? state.hostId })
  const [creating, setCreating] = useState(false)
  const creationInFlight = useRef(false)
  // Sotto's words kept as messages and read when shown; main's refusal as written.
  const [error, setError] = useState<LaterWords | null>(null)
  const latestState = useRef(state)
  latestState.current = state
  const completed = useRef(false)
  // A missing acknowledgement is not permission to issue another mutation.
  // Keep attempts even when the user goes back and chooses the same folder.
  const attemptedFolders = useRef(new Set<string>())
  const startThread = (project: AgentProject): void => {
    setError(null)
    setCreating(true)
    void beginNewThread(latestState.current, command, project).then(start => {
      if ('error' in start) { creationInFlight.current = false; setCreating(false); setError(start.error); return }
      completed.current = true
      // A caller that shows the thread itself takes over from here; one that only awaits keeps the dialog
      // locked until the command answers, since it is what closes the dialog on success.
      if (onCreating) { onCreating(start); return }
      void start.created.then(creationError => {
        setCreating(false)
        if (creationError !== null) { completed.current = false; creationInFlight.current = false; setError(creationErrorWords(creationError)) } else onCreated()
      })
    })
  }
  const chooser = useProjectChooser(state, choice => {
    if (creationInFlight.current || completed.current) return
    setError(null)
    creationInFlight.current = true
    if (choice.project) { startThread(choice.project); return }
    const provider = isSubscriptionReasoning(state.configuration.reasoning) ? state.configuration.reasoning
      : resolveModel(projectHost.models, defaultNewThreadModelId(state.configuration, projectHost.models, state.reasoningAccounts))?.providerId
    setCreating(true)
    void (async () => {
      if (chosenHost && chosenHost.hostId !== latestState.current.hostId) await window.sotto?.hosts?.command({ type: 'select', hostId: chosenHost.hostId })
      const found = await projectForFolder({ folder: choice.folder, isNew: choice.isNew === true, command, latest: () => latestState.current, attempted: attemptedFolders.current, providerId: provider, hostId: chosenHost?.hostId })
      if (found.project === null) { creationInFlight.current = false; setCreating(false); setError(found.error); return }
      startThread(found.project)
    })()
  }, { hostId: chosenHost?.hostId, disabled: creating })
  const focusSearch = useRef(chooser.focusSearch)
  focusSearch.current = chooser.focusSearch
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    if (element?.showModal) element.showModal()
    else element?.setAttribute('open', '')
    focusSearch.current()
    return () => {
      element?.close?.()
      // A thread is on its way: the caller is opening it and taking focus with it.
      if (!completed.current && previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return <dialog ref={dialog} className="new-thread-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!creating) onClose() }}
    onClick={event => { if (event.target === event.currentTarget && !creating) onClose() }}>
    <h2 id={titleId} className="tt-visually-hidden">{t`New thread`}</h2>
    <header className="new-thread-dialog__search">
      {chooser.search}
      <Button variant="ghost" iconOnly aria-label={t`Close new thread dialog`} disabled={creating} onClick={onClose}><X size={16} /></Button>
    </header>
      {hosts.length > 1 ? <div className="new-thread-hosts" role="group" aria-label={t({ message: 'Host', comment: 'The computer a new thread starts on.' })}>
        {hosts.map(item => <button key={item.hostId} type="button" className="tt-focusable" aria-pressed={item.hostId === chosenHost?.hostId} onClick={() => setHostId(item.hostId)}>
          {item.kind === 'local' ? <Laptop size={15} aria-hidden="true" /> : <Server size={15} aria-hidden="true" />}{item.name}</button>)}
      </div> : null}
      {chooser.choices}
      {creating ? <p role="status" className="new-thread-dialog__empty tt-paragraph">{t`Opening the thread…`}</p> : null}
      {error && <p className="agent-error tt-paragraph" role="alert">{shownWords(error)}</p>}
    <footer className="new-thread-dialog__keys"><span><kbd>↑</kbd><kbd>↓</kbd> {t({ message: 'Navigate', comment: 'A keyboard hint: the arrow keys move through the list.' })}</span><span><kbd>Enter</kbd> {t({ message: 'Select', comment: 'A keyboard hint: Enter picks the highlighted item.' })}</span><span><kbd>Esc</kbd> {t({ message: 'Close', comment: 'A keyboard hint: Escape closes the dialog.' })}</span></footer>
  </dialog>
}
