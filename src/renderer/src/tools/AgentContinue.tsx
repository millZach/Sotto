import React, { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CornerDownRight, Laptop, Server } from 'lucide-react'
import { PROVIDER_LABELS, publicProviderEntityId, type AgentModel, type AgentWorkingCopyOptions, type ProviderId } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import type { SubagentRow } from '../../../shared/subagents'
import { AGENT_FORK_GONE } from '../../../shared/threadStarts'
import { Button } from '../components/Button'
import { Select } from '../components/Select'
import type { AgentConnection } from '../agents/AgentContext'
import '../agents/threadStart.css'

/**
 * Continue as a thread, in an agent's row of the Agents roster (#1028, Zach's pick B of the continue prototype, in place):
 * the press opens a form in the row itself. A Codex agent is forked by Codex into a new thread, its task carried
 * encrypted; a Claude Code agent, or a Codex agent Codex no longer has, starts a new thread from a thin handover of its
 * task and result. The agent and its row stay as they are. Nothing is sent to any provider until the new thread's first
 * message.
 */

/** What the roster's thread offers its agents, or nothing: the feature is off, or the provider reports no agents of its own. */
export interface AgentContinueOptions {
  /** The thread the agents belong to, as this window names it. */
  readonly threadId: string
  readonly threadTitle: string
  readonly provider: ProviderId
  readonly projectId: string
  /** Where the new thread runs: This computer, or the paired host's name. */
  readonly where: string
  readonly remote: boolean
  /** The models of the thread's own host. */
  readonly models: readonly AgentModel[]
  readonly sourceModelId: string
  readonly command: AgentConnection['command']
  /** The working-copy choices of the project, read on this computer only. */
  readonly workingCopyOptions?: ((projectId: string) => Promise<AgentWorkingCopyOptions>) | undefined
}
export const AgentContinueContext = createContext<AgentContinueOptions | null>(null)

/** The model the new thread starts on: the agent's own where its host has it ready, else its thread's. */
export function agentStartModel(options: Pick<AgentContinueOptions, 'models' | 'provider' | 'sourceModelId'>, row: Pick<SubagentRow, 'model'>, fork: boolean): string | undefined {
  const ready = options.models.filter(model => model.ready && (!fork || model.providerId === options.provider))
  const own = row.model ? resolveModel(ready, publicProviderEntityId(options.provider, 'model', row.model)) : undefined
  return own?.id ?? resolveModel(ready, options.sourceModelId)?.id ?? ready.find(model => model.providerId === options.provider)?.id ?? ready[0]?.id
}

type Stage = 'closed' | 'open' | 'gone'

export function AgentContinue({ row }: { readonly row: SubagentRow }): ReactNode {
  const options = useContext(AgentContinueContext)
  const [stage, setStage] = useState<Stage>('closed')
  const [modelId, setModelId] = useState<string | undefined>()
  const [copy, setCopy] = useState<'shared' | 'independent'>('shared')
  const [git, setGit] = useState<{ readonly currentBranch: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const press = useRef<HTMLButtonElement>(null)
  const start = useRef<HTMLButtonElement>(null)
  const formId = useId()
  // Focus follows the stage it opened: the form's first action, or the press again once it closes.
  const focusNext = useRef<'start' | 'press' | null>(null)
  useEffect(() => {
    const next = focusNext.current
    focusNext.current = null
    if (next === 'start') start.current?.focus()
    else if (next === 'press') press.current?.focus()
  }, [stage])
  if (!options || row.kind === 'workflow') return null
  const fork = options.provider === 'codex'
  const label = `Continue ${row.title || 'this agent'} as its own thread`
  if (row.status === 'running') {
    return <div className="agent-continue"><div className="agent-continue__actions">
      <Button variant="secondary" aria-disabled="true" aria-label={label} aria-describedby={`${formId}-why`}><CornerDownRight size={15} aria-hidden="true" />Continue as a thread</Button>
      <span id={`${formId}-why`} className="agent-continue__why">It’s still working. Continue it once it finishes.</span></div></div>
  }
  const close = (): void => { focusNext.current = 'press'; setStage('closed'); setError(null) }
  const openForm = (): void => {
    setError(null); setModelId(agentStartModel(options, row, options.provider === 'codex')); setCopy('shared')
    focusNext.current = 'start'; setStage('open')
    if (!options.remote && options.workingCopyOptions && git === null) {
      void options.workingCopyOptions(options.projectId).then(read => setGit(read.isGit ? { currentBranch: read.currentBranch } : null), () => setGit(null))
    }
  }
  const go = async (withHandover: boolean): Promise<void> => {
    // The handover in place of a fork Codex refused starts on the agent's provider, as the fork would have.
    const model = withHandover ? agentStartModel(options, row, true) : modelId
    if (busy || !model) return
    setBusy(true); setError(null)
    try {
      const result = await options.command({ type: 'continue-agent', threadId: options.threadId, agentId: row.id, newThreadId: crypto.randomUUID(), modelId: model,
        ...(withHandover ? { handover: true } : {}), workingCopy: copy, ...(copy === 'independent' && git?.currentBranch ? { baseBranch: git.currentBranch } : {}) })
      if (result === null) { setError('Sotto could not confirm this. Look for the new thread in the list before trying again.'); return }
      if (result.error === AGENT_FORK_GONE) { focusNext.current = 'start'; setStage('gone'); return }
      if (result.error) { setError(result.error); return }
      setStage('closed')
    } finally { setBusy(false) }
  }
  const onKeyDown = (event: React.KeyboardEvent): void => {
    // Escape closes the form first, and focus goes back to the press that opened it; the row stays open.
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault(); event.stopPropagation(); close()
  }
  const ready = options.models.filter(model => model.ready)
  const choices = fork ? ready.filter(model => model.providerId === options.provider) : ready
  const providers = [...new Set(choices.map(model => model.providerId).filter((id): id is ProviderId => id !== undefined))]
  const where = <span className="agent-continue__where">{options.remote ? <Server size={14} aria-hidden="true" /> : <Laptop size={14} aria-hidden="true" />}{options.where}</span>
  const working = <Select aria-label="Working copy for the new thread" value={copy} onChange={event => setCopy(event.target.value === 'independent' ? 'independent' : 'shared')}>
    <option value="shared">Same folder</option>
    {git ? <option value="independent">{git.currentBranch ? `New worktree from ${git.currentBranch}` : 'New worktree'}</option> : null}
  </Select>
  return <div className="agent-continue" onKeyDown={onKeyDown}>
    {stage === 'closed' ? <div className="agent-continue__actions">
      <Button ref={press} variant="secondary" aria-label={label} onClick={openForm}><CornerDownRight size={15} aria-hidden="true" />Continue as a thread</Button>
    </div> : null}
    {stage === 'open' ? <section id={formId} className="agent-continue__form" aria-label={fork ? 'Fork it into a new Codex thread' : 'Continue it from a handover'}>
      <h4>{fork ? `Fork it into a new ${PROVIDER_LABELS[options.provider]} thread` : 'Continue it from a handover'}</h4>
      <p>{fork ? 'Codex copies this agent’s own conversation, task included, into a new thread. Codex keeps the task encrypted; the fork carries it and Sotto never reads it. The agent here stays as it is.'
        : `This handover is thin. ${PROVIDER_LABELS[options.provider]} keeps a subagent’s working history inside its own session, where Sotto can’t fork it, so the new thread knows only the task and the result.`}</p>
      <div className="agent-continue__choices">
        <Select aria-label={fork ? 'Model for the forked thread' : 'Provider and model for the new thread'} value={modelId ?? ''} onChange={event => setModelId(event.target.value)}>
          {providers.length > 1 ? providers.map(provider => <optgroup key={provider} label={PROVIDER_LABELS[provider]}>
            {choices.filter(model => model.providerId === provider).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</optgroup>)
            : choices.map(model => <option key={model.id} value={model.id}>{fork ? model.name : `${PROVIDER_LABELS[model.providerId ?? options.provider]} · ${model.name}`}</option>)}
        </Select>
        {working}{where}
      </div>
      {fork ? null : <p className="agent-continue__fine">Carries the task and the result. Leaves out everything the agent did on the way. It goes with your first message.</p>}
      <div className="agent-continue__actions">
        <Button ref={start} variant="primary" disabled={busy || !modelId} onClick={() => void go(false)}>{busy ? 'Starting…' : 'Start the thread'}</Button>
        <Button variant="ghost" onClick={close}>Cancel</Button>
      </div>
      {error ? <p className="agent-continue__error" role="alert">{error}</p> : null}
    </section> : null}
    {stage === 'gone' ? <section className="agent-continue__form" data-tone="error" aria-label="Codex can’t fork this agent">
      <h4>Codex can’t fork this agent</h4>
      <p role="alert">{AGENT_FORK_GONE}</p>
      <div className="agent-continue__actions">
        <Button ref={start} variant="primary" disabled={busy} onClick={() => void go(true)}>{busy ? 'Starting…' : 'Start from a handover'}</Button>
        <Button variant="ghost" onClick={close}>Cancel</Button>
      </div>
      {error ? <p className="agent-continue__error">{error}</p> : null}
    </section> : null}
  </div>
}
