import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { msg, ph } from '@lingui/core/macro'
import { GitFork, Laptop, Server } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS, type AgentModel, type AgentWorkingCopyOptions, type AgentCommand, type AgentState, type ProviderId } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import { NATIVE_FORKS, sameFolderForks } from '../../../shared/threadStarts'
import { Button } from '../components/Button'
import { Select } from '../components/Select'
import { clockLabel } from './threadFacts'
import { leftToRight, shownWords, type LaterWords } from './interfaceWords'
import './threadStart.css'

/**
 * Fork from here (#1028, E5b; Zach's pick B of the continue prototype, in place): the newest reply of each finished turn
 * offers a fork, and the press draws its card into the transcript under that reply, with everything below it marked as
 * not carried. Codex and Claude Code fork with their own copy of the conversation up to the reply; every other provider
 * has no fork of its own, so its new thread starts from a handover of the conversation up to the reply.
 */

/** What the transcript offers a thread's replies, or nothing: the feature is off, or the thread can't fork. */
export interface ForkOptions {
  readonly threadId: string
  readonly threadTitle: string
  readonly provider: ProviderId
  readonly projectId: string
  readonly where: string
  readonly remote: boolean
  readonly models: readonly AgentModel[]
  readonly modelId: string
  readonly command: (command: AgentCommand) => Promise<AgentState | null>
  /** The branch the thread works on, from its own Git status, so a new worktree starts from its work. */
  readonly sourceBranch?: { readonly currentBranch: string | null } | undefined
  /** The project's working-copy choices, read on this computer only, while the thread's status has not arrived. */
  readonly workingCopyOptions?: ((projectId: string) => Promise<AgentWorkingCopyOptions>) | undefined
  /** The reply the card is open under, if any; at most one at a time. */
  readonly openAt: string | null
  readonly open: (messageId: string | null) => void
  /** The messages after the open reply, which the fork does not carry. */
  readonly after: ReadonlySet<string>
  /** No fork while a turn runs: a fork carries finished turns. */
  readonly busy: boolean
}
export const ForkContext = createContext<ForkOptions | null>(null)
export function useForkOptions(): ForkOptions | null { return useContext(ForkContext) }

/** The press under a reply. */
export function ForkPress({ messageId, at }: { readonly messageId: string; readonly at: string }): ReactNode {
  const { t } = useLingui()
  const options = useForkOptions()
  if (!options) return null
  const open = options.openAt === messageId
  const time = clockLabel(Date.parse(at))
  const label = options.busy ? t`Fork from here: wait for this turn to finish first`
    : t`Fork from here: a new thread with this conversation up to this reply, ${time}`
  return <button type="button" className="thread-message__fork tt-focusable" aria-label={label} title={options.busy ? t`Wait for this turn to finish before forking` : t`Fork from here`}
    aria-expanded={open} aria-disabled={options.busy || undefined} data-fork-at={messageId}
    onClick={() => { if (!options.busy) options.open(open ? null : messageId) }}
    onKeyDown={event => { if (open && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); options.open(null) } }}>
    <GitFork size={14} aria-hidden="true" /><span>{t`Fork from here`}</span></button>
}

/** The card under the reply it forks at, and the line that says what stays behind. */
export function ForkCard({ messageId, at }: { readonly messageId: string; readonly at: string }): ReactNode {
  const options = useForkOptions()
  return options?.openAt === messageId ? <ForkForm key={messageId} options={options} messageId={messageId} at={at} /> : null
}

function ForkForm({ options, messageId, at }: { readonly options: ForkOptions; readonly messageId: string; readonly at: string }): ReactNode {
  const { t } = useLingui()
  const native = NATIVE_FORKS.has(options.provider)
  const [modelId, setModelId] = useState<string | undefined>(() => forkModel(options.models, options.provider, options.modelId))
  const [copy, setCopy] = useState<'shared' | 'independent'>('shared')
  const [git, setGit] = useState<{ readonly currentBranch: string | null } | null>(options.sourceBranch ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LaterWords | null>(null)
  const start = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLElement>(null)
  const { workingCopyOptions: read, remote, projectId, sourceBranch } = options
  // Focus goes to Fork, or to the card itself while there is nothing to press, so Escape always reaches it.
  useEffect(() => { (start.current?.disabled ? card.current : start.current)?.focus() }, [])
  // The thread's Git status may arrive while the card is open: its worktree is offered then.
  const sourceRepository = sourceBranch !== undefined, sourceCurrent = sourceBranch?.currentBranch ?? null
  useEffect(() => { if (sourceRepository) setGit({ currentBranch: sourceCurrent }) }, [sourceRepository, sourceCurrent])
  useEffect(() => {
    if (sourceBranch || remote || !read) return
    let current = true
    void read(projectId).then(value => { if (current) setGit(value.isGit ? { currentBranch: value.currentBranch } : null) }, () => undefined)
    return () => { current = false }
  }, [read, remote, projectId, sourceBranch])
  const name = PROVIDER_LABELS[options.provider]
  const close = (): void => {
    // Back to this transcript's own press: a fork and its source show the same reply under the same ID.
    const transcript = card.current?.closest('.thread-transcript') ?? card.current?.parentElement
    options.open(null)
    requestAnimationFrame(() => transcript?.querySelector<HTMLButtonElement>(`[data-fork-at="${CSS.escape(messageId)}"]`)?.focus())
  }
  const fork = async (): Promise<void> => {
    if (busy || !modelId) return
    setBusy(true); setError(null)
    try {
      const result = await options.command({ type: 'fork-thread', threadId: options.threadId, messageId, newThreadId: crypto.randomUUID(),
        ...(native ? { modelId } : {}), workingCopy: copy, ...(copy === 'independent' && git?.currentBranch ? { baseBranch: git.currentBranch } : {}) })
      if (result === null) setError(msg`Sotto could not confirm this. Look for the new thread in the list before trying again.`)
      else if (result.error) setError(result.error)
      else options.open(null)
    } finally { setBusy(false) }
  }
  const choices = options.models.filter(model => model.ready && model.providerId === options.provider)
  // A Claude Code fork lives where its source's session does, so it starts in the thread's own folder.
  const worktree = git && !sameFolderForks(options.provider)
  const time = clockLabel(Date.parse(at))
  const branch = git?.currentBranch
  const threadTitle = options.threadTitle
  return <>
    <section ref={card} tabIndex={-1} className="fork-card" aria-label={t`Fork from here`} onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault(); event.stopPropagation(); close()
    }}>
      <h4><GitFork size={15} aria-hidden="true" />{t`Fork from here`}</h4>
      <p className="tt-paragraph">{native ? t`A new ${name} thread with everything above this line, through ${name}’s own fork. What’s below stays here, and this thread stays as it is.`
        : t`${name} has no fork of its own, so the new ${name} thread starts from a handover of this conversation up to ${time}. It goes with your first message. What’s below stays here.`}</p>
      <div className="agent-continue__choices">
        {native ? <Select aria-label={t`Model for the forked thread`} value={modelId ?? ''} onChange={event => setModelId(event.target.value)}>
          {choices.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </Select> : null}
        <Select aria-label={t`Working copy for the forked thread`} value={copy} onChange={event => setCopy(event.target.value === 'independent' ? 'independent' : 'shared')}>
          <option value="shared">{t({ message: 'Same folder', comment: 'Where a continued thread works: the folder this thread works in.' })}</option>
          {worktree ? <option value="independent">{branch ? t`New worktree from ${ph({ branch: leftToRight(branch) })}` : t`New worktree`}</option> : null}
        </Select>
        <span className="agent-continue__where">{options.remote ? <Server size={14} aria-hidden="true" /> : <Laptop size={14} aria-hidden="true" />}{options.where}</span>
      </div>
      {native ? <p className="agent-continue__fine tt-paragraph"><Trans>Files aren’t rewound: the new thread sees the folder as it is now.</Trans></p>
        : <p className="agent-continue__fine tt-paragraph"><Trans>Carries the conversation up to this reply. Leaves out what follows, and the records of its work, such as tool calls.</Trans></p>}
      <div className="agent-continue__actions">
        <Button ref={start} variant="primary" disabled={busy || !modelId} onClick={() => void fork()}>{busy ? t`Forking…` : native ? t({ message: 'Fork', comment: 'Starts the forked thread.' }) : t`Start the ${name} thread`}</Button>
        <Button variant="ghost" onClick={close}><Trans>Cancel</Trans></Button>
      </div>
      {error ? <p className="agent-continue__error tt-paragraph" role="alert">{shownWords(error)}</p> : null}
    </section>
    <p className="fork-card__stays tt-paragraph"><Trans>Not carried: this stays in {threadTitle}</Trans></p>
  </>
}

/** The model a fork starts on: the thread's own, where its provider still has it ready. */
export function forkModel(models: readonly AgentModel[], provider: ProviderId, modelId: string): string | undefined {
  const ready = models.filter(model => model.ready && model.providerId === provider)
  return resolveModel(ready, modelId)?.id ?? ready[0]?.id
}
