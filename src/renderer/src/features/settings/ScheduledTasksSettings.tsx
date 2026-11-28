import React, { useMemo, useState, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { ph, plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { BookOpen, CalendarClock, FolderOpen, Hand, History, ListChecks, Plus, Webhook } from 'lucide-react'

import type { AgentModel, AgentState, AgentThread } from '../../../../shared/agents'
import type { RunView, ScheduledTaskCommand, ScheduledTaskResult, ScheduledTasksBridge, TaskProblem, TaskSpec, TaskView } from '../../../../shared/scheduledTasks'
import { isThreadClosed } from '../../../../shared/threadActivity'
import { useOptionalAgents } from '../../agents/AgentContext'
import { localeFormatter } from '../../agents/localeFormat'
import { localHostId, localProjects } from '../../agents/localAgents'
import { PaneMenu } from '../../agents/PaneMenu'
import { Button } from '../../components/Button'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { Toggle } from '../../components/Toggle'
import { useOptionalApp } from '../../state/AppContext'
import { scheduledTasksBridge, useScheduledTasks } from '../../state/scheduledTasks'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { ScheduledTaskEditor } from './ScheduledTaskEditor'
import { SettingsGroup } from './SettingsGroup'
import './scheduledTasks.css'

type Status = { readonly text: string; readonly error: boolean }
const when = localeFormatter({ dateStyle: 'medium', timeStyle: 'short' })
const clock = (iso: string): string => when(new Date(iso))

/** This computer's models, whichever host is selected for new work. */
function localModels(state: AgentState): readonly AgentModel[] {
  const local = localHostId(state)
  const client = state.host.clientHosts?.find(host => host.hostId === local)
  return (client?.models ?? (state.connections?.length ? [] : state.host.models)).filter(model => !model.hiddenFromMenu)
}

/** This computer's open threads. */
function localThreads(state: AgentState): readonly AgentThread[] {
  const local = localHostId(state)
  return state.host.threads.filter(thread => thread.remoteHost !== true && (local === undefined || thread.hostId === undefined || thread.hostId === local) && !isThreadClosed(thread))
}

/**
 * Settings › Scheduled tasks (ADR-0218, the Owl feature `scheduled-tasks`): the **Run scheduled tasks** switch, the runs
 * waiting for the user's answer, every task with Run now, Pause and its editor, the history of runs, the playbooks in the
 * playbooks folder, and the webhook listener. It follows the Mods and Council pages' layout of titled groups, so it has
 * no mock-up of its own. A webhook secret never reaches this page: New secret puts it on the clipboard from main.
 */
export function ScheduledTasksSettings({ settings, onUpdateSettings, shown, bridge = scheduledTasksBridge(), agentState: givenState }: {
  readonly settings: AppSettings
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly shown: boolean
  readonly bridge?: ScheduledTasksBridge | undefined
  /** The agents' state, where no agents context gives it. */
  readonly agentState?: AgentState | null
}): ReactNode {
  const { t } = useLingui()
  const state = useScheduledTasks(shown, bridge)
  const agents = useOptionalAgents()
  const app = useOptionalApp()
  const agentState = givenState !== undefined ? givenState : agents?.state ?? null
  const projects = useMemo(() => agentState ? localProjects(agentState) : [], [agentState])
  const models = useMemo(() => agentState ? localModels(agentState) : [], [agentState])
  const threads = useMemo(() => agentState ? localThreads(agentState) : [], [agentState])
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({})
  const [removing, setRemoving] = useState<TaskView | null>(null)

  const tasks = state?.tasks ?? []
  const runs = state?.runs ?? []
  const waiting = runs.filter(run => run.state === 'waiting' || run.state === 'held')
  const off = !settings.scheduledTasksEnabled
  const editingTask = editing && editing !== 'new' ? tasks.find(task => task.id === editing) : undefined

  const send = async (command: ScheduledTaskCommand): Promise<ScheduledTaskResult | undefined> => {
    if (!bridge || busy) return undefined
    setBusy(true)
    try {
      const result = await bridge.command(command)
      setStatus(result.message ? { text: result.message, error: !result.ok } : result.ok ? null : { text: t`That could not be done. Nothing was changed.`, error: true })
      return result
    } catch {
      setStatus({ text: t`That could not be done. Nothing was changed. Try again.`, error: true })
      return undefined
    } finally { setBusy(false) }
  }

  const save = async (spec: TaskSpec): Promise<void> => {
    const result = await send({ type: 'save', ...editingTask ? { id: editingTask.id } : {}, spec })
    if (result?.ok) setEditing(null)
  }

  const openThread = (threadId: string): void => {
    void agents?.command({ type: 'select-thread', threadId }).catch(() => undefined)
    app?.actions.navigate('threads')
  }

  const problemWords = (problem: TaskProblem): string => {
    switch (problem) {
      case 'project-gone': return t`Its project is no longer on this computer. Choose another.`
      case 'model-gone': return t`Its model is no longer offered here. Choose another.`
      case 'provider-off': return t`Its provider is not connected, so its runs fail until it is.`
      case 'thread-gone': return t`Its thread is no longer on this computer. Choose another.`
      case 'playbook-gone': return t`Its playbook is no longer in the playbooks folder.`
      case 'playbook-broken': return t`Its playbook can’t be read. See Playbooks below.`
      case 'playbook-changed': return t`Its playbook changed since you allowed its commands. Its next command waits for you.`
      case 'remote': return t`Its thread is on another computer. A task runs only on the computer that keeps it.`
    }
  }

  const scheduleWords = (task: TaskView): string => {
    const schedule = task.schedule
    if (!schedule) return t`Only when started`
    if (schedule.kind === 'once') return t`Once, at ${ph({ time: clock(schedule.at) })}`
    if (schedule.kind === 'every') {
      const minutes = schedule.minutes, hours = minutes / 60, days = minutes / 1440
      if (minutes % 1440 === 0) return plural(days, { one: 'Every day', other: 'Every # days' })
      if (minutes % 60 === 0) return plural(hours, { one: 'Every hour', other: 'Every # hours' })
      return plural(minutes, { one: 'Every minute', other: 'Every # minutes' })
    }
    const format = new Intl.DateTimeFormat(i18n.locale, { weekday: 'short', timeZone: 'UTC' })
    const weekdays = new Intl.ListFormat(i18n.locale, { style: 'narrow', type: 'conjunction' }).format(schedule.days.map(day => format.format(new Date(Date.UTC(2026, 10, 1 + day)))))
    const times = schedule.times.join(', ')
    return t`${weekdays} at ${times} (${ph({ zone: schedule.timeZone })})`
  }

  const triggerWords = (run: RunView): string => {
    switch (run.trigger) {
      case 'schedule': return t`On schedule`
      case 'late': return t`Late, for a missed time`
      case 'manual': return t`Run now`
      case 'webhook': return t`Webhook`
      case 'github': return run.eventRef ? t`GitHub ${ph({ issue: run.eventRef })}` : t`GitHub`
      case 'missed': return t`Missed`
    }
  }

  const stateWords = (run: RunView): string => {
    if (run.state !== 'done') {
      switch (run.state) {
        case 'queued': return t`Waiting to start`
        case 'running': return run.wait === 'card' ? t`Its thread is asking you` : t`Running`
        case 'waiting': return t`Waiting for you`
        case 'held': return t`Held for you`
      }
    }
    switch (run.outcome) {
      case 'finished': return t`Finished`
      case 'failed': return t`Failed`
      case 'stopped': return t`Stopped`
      case 'cancelled': return t`Cancelled`
      case 'declined': return t`Declined`
      case 'unknown': return t`Ended unknown`
      case 'skipped': return t`Skipped`
      case 'missed': return t`Missed`
      default: return t`Ended`
    }
  }

  const waitingCard = (run: RunView): ReactNode => {
    const step = run.steps.find(item => item.state === 'waiting' || item.state === 'uncertain') ?? run.steps.find(item => item.state === 'pending')
    const key = `${run.id}:${step?.id ?? ''}`
    const firstThread = run.threadIds[0]
    return <div key={run.id} className="tasks-wait" data-wait={run.wait}>
      <p className="tasks-wait__title"><strong>{run.taskName}</strong>{step && run.steps.length > 1 ? <> · {step.title}</> : null}</p>
      {run.wait === 'decision' && step
        ? <>
          <p className="tasks-wait__question tt-paragraph">{step.question}</p>
          {step.noteLabel
            ? <label className="tasks-wait__note">
              <span>{step.noteRequired ? t`${ph({ label: step.noteLabel })} (required)` : step.noteLabel}</span>
              <textarea className="tt-input tt-focusable" rows={2} maxLength={4000} value={notes[key] ?? ''} onChange={event => { const value = event.currentTarget.value; setNotes(current => ({ ...current, [key]: value })) }} />
            </label>
            : null}
          <div className="tasks-actions">
            <Button variant="primary" disabled={busy} onClick={() => void send({ type: 'decide', run: run.id, step: step.id, choice: 'approve', ...notes[key]?.trim() ? { note: notes[key]!.trim() } : {} })}>{t`Go on`}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void send({ type: 'decide', run: run.id, step: step.id, choice: 'decline' })}>{t`Decline`}</Button>
          </div>
        </>
        : null}
      {run.wait === 'confirm' && step
        ? <>
          <p className="tt-paragraph">{step.note}</p>
          {step.command ? <pre className="tasks-code">{step.command}</pre> : null}
          <div className="tasks-actions">
            <Button variant="primary" disabled={busy} onClick={() => void send({ type: 'decide', run: run.id, step: step.id, choice: 'approve' })}>{t`Allow once`}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void send({ type: 'decide', run: run.id, step: step.id, choice: 'decline' })}>{t`Don’t run it`}</Button>
          </div>
        </>
        : null}
      {run.wait === 'allow' && run.playbook
        ? <>
          <p className="tt-paragraph">{t`The playbook ${ph({ playbook: run.playbook.name })} runs commands on this computer. Allow this version of it to run them for this task.`}</p>
          <div className="tasks-actions">
            <Button variant="primary" disabled={busy} onClick={() => void send({ type: 'allow-playbook', id: run.taskId, revision: run.playbook!.revision })}>{t`Allow this version`}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void send({ type: 'cancel-run', run: run.id })}>{t`Cancel the run`}</Button>
          </div>
        </>
        : null}
      {run.wait === 'uncertain' && step
        ? <>
          <p className="tt-paragraph">{step.note ?? t`Sotto can’t tell whether this step took effect.`} {t`It was not done again on its own. Look at its thread, then choose.`}</p>
          <div className="tasks-actions">
            <Button variant="secondary" disabled={busy} onClick={() => void send({ type: 'resolve', run: run.id, step: step.id, choice: 'again' })}>{t`Do it again`}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void send({ type: 'resolve', run: run.id, step: step.id, choice: 'continue' })}>{t`Go on as done`}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => void send({ type: 'cancel-run', run: run.id })}>{t`Cancel the run`}</Button>
          </div>
        </>
        : null}
      {firstThread ? <button type="button" className="tasks-link tt-focusable" onClick={() => openThread(step?.threadId ?? firstThread)}>{t`Open thread`}</button> : null}
    </div>
  }

  const taskRow = (task: TaskView): ReactNode => {
    const work = task.work
    const playbook = work.kind === 'playbook' ? state?.playbooks.find(item => item.id === work.playbookId) : undefined
    const needsAllow = playbook?.revision && playbook.steps.some(step => step.kind === 'code') && task.allowedRevision !== playbook.revision
    const details = [scheduleWords(task), task.webhook ? t`webhook` : '', task.github ? t`GitHub` : ''].filter(Boolean).join(' · ')
    return <div key={task.id} className="tasks-row" data-paused={task.paused || undefined} data-problem={task.problem}>
      <div className="tasks-row__main">
        <p className="tasks-row__name">{task.name}{task.paused ? <span className="tasks-badge">{t`Paused`}</span> : null}</p>
        <p className="tasks-row__line tt-paragraph">{details}</p>
        {task.nextAt && !task.paused && !off ? <p className="tasks-row__line tt-paragraph">{t`Next: ${ph({ time: clock(task.nextAt) })}`}</p> : null}
        {task.problem ? <p className="tasks-row__problem tt-paragraph">{problemWords(task.problem)}</p> : null}
        {task.githubProblem ? <p className="tasks-row__problem tt-paragraph">{task.githubProblem}</p> : null}
        {task.webhook && task.webhookPath
          ? <p className="tasks-row__line tt-paragraph">{state?.webhooks.address ? <code className="tasks-address">{state.webhooks.address}{task.webhookPath}</code> : t`Its address shows once the webhook listener runs.`}
            {' '}{task.webhookSecret ? '' : t`No secret yet: make one from More.`}</p>
          : null}
      </div>
      <div className="tasks-actions">
        <Button variant="secondary" disabled={busy || off || task.paused} onClick={() => void send({ type: 'run-now', id: task.id })}>{t`Run now`}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void send({ type: task.paused ? 'resume' : 'pause', id: task.id })}>{task.paused ? t`Resume` : t`Pause`}</Button>
        <PaneMenu className="tasks-row__more" label={t`More for ${ph({ name: task.name })}`} groups={[[
          { id: 'edit', label: t`Change`, run: () => setEditing(task.id) },
          ...task.webhook ? [{ id: 'secret', label: task.webhookSecret ? t`New webhook secret` : t`Make a webhook secret`, run: () => void send({ type: 'new-secret', id: task.id }) }] : [],
          ...needsAllow && playbook?.revision ? [{ id: 'allow', label: t`Allow its playbook’s commands`, run: () => void send({ type: 'allow-playbook', id: task.id, revision: playbook.revision! }) }] : [],
        ], [
          { id: 'remove', label: t`Remove`, tone: 'danger' as const, run: () => setRemoving(task) },
        ]]} />
      </div>
    </div>
  }

  const runRow = (run: RunView): ReactNode => {
    const active = run.state !== 'done'
    const resumable = run.state === 'done' && (run.outcome === 'failed' || run.outcome === 'stopped' || run.outcome === 'unknown') && run.steps.length + run.threadIds.length > 0
    return <li key={run.id} className="tasks-run" data-state={run.state} data-outcome={run.outcome}>
      <div className="tasks-run__head">
        <span className="tasks-run__name">{run.taskName}</span>
        <span className="tasks-badge">{stateWords(run)}</span>
      </div>
      <p className="tasks-row__line tt-paragraph">{triggerWords(run)} · {clock(run.dueAt ?? run.createdAt)}{run.endedAt && run.startedAt ? ` → ${clock(run.endedAt)}` : ''}</p>
      {run.note ? <p className="tasks-row__line tt-paragraph">{run.note}</p> : null}
      {run.steps.length
        ? <details className="tasks-run__steps">
          <summary className="tt-focusable">{t`Steps`}</summary>
          <ol>{run.steps.map(step => <li key={step.id} data-state={step.state}>
            <span>{step.title}</span> <span className="tasks-step-state">{step.state === 'done' ? t`done` : step.state === 'failed' ? t`failed` : step.state === 'running' || step.state === 'dispatching' ? t`running` : step.state === 'waiting' ? t`waiting for you` : step.state === 'uncertain' ? t`uncertain` : step.state === 'cancelled' ? t`cancelled` : t`not started`}</span>
            {step.attempts > 1 ? <span className="tasks-step-state"> · {t`try ${ph({ attempt: step.attempts })} of ${ph({ attempts: step.maxAttempts })}`}</span> : null}
            {step.note ? <p className="tt-paragraph">{step.note}</p> : null}
            {step.output ? <pre className="tasks-code">{step.output}</pre> : null}
          </li>)}</ol>
        </details>
        : null}
      <div className="tasks-actions">
        {run.threadIds[0] ? <Button variant="ghost" onClick={() => openThread(run.threadIds[run.threadIds.length - 1]!)}>{t`Open thread`}</Button> : null}
        {active ? <Button variant="ghost" disabled={busy} onClick={() => void send({ type: 'cancel-run', run: run.id })}>{t`Cancel`}</Button> : null}
        {resumable ? <Button variant="secondary" disabled={busy || off} onClick={() => void send({ type: 'resume-run', run: run.id })}>{t`Go on from where it stopped`}</Button> : null}
      </div>
    </li>
  }

  return <>
    <div className="settings-section__heading">
      <h2>{t({ message: 'Scheduled tasks', comment: 'A Settings page, named in its rail and its heading: prompts and playbooks Sotto starts on a schedule. Other messages name it as "Settings > Scheduled tasks".' })}</h2>
      <p className="tt-paragraph">{t`Prompts and playbooks that start on their own`}</p>
    </div>

    <SettingsGroup title={t`Run scheduled tasks`} icon={CalendarClock} rows={false}>
      <div className="tasks-card">
        <Toggle setting="scheduled-tasks" label={t`Run scheduled tasks on this computer`} checked={settings.scheduledTasksEnabled} disabled={state?.available === false}
          onCheckedChange={enabled => { void onUpdateSettings({ scheduledTasksEnabled: enabled }).then(saved => { if (!saved) setStatus({ text: t`The switch could not be saved. Try again.`, error: true }) }) }}
          description={t`Off, nothing starts and every task and run is kept. A time that passes while it is off counts as missed.`} />
        {state?.available === false ? <p className="tasks-status tasks-status--error tt-paragraph">{state.unavailable}</p> : null}
        {state?.storageProblem ? <p className="tasks-status tasks-status--error tt-paragraph">{state.storageProblem}</p> : null}
      </div>
      <p className={`tasks-status tt-paragraph${status?.error ? ' tasks-status--error' : ''}`} role="status">{status?.text ?? ''}</p>
    </SettingsGroup>

    {waiting.length
      ? <SettingsGroup title={t`Waiting for you`} icon={Hand} rows={false} note={t`Only you answer these. A webhook, an issue or an agent can’t.`}>
        <div className="tasks-list">{waiting.map(waitingCard)}</div>
      </SettingsGroup>
      : null}

    <SettingsGroup title={t`Tasks`} icon={ListChecks} rows={false}>
      <div className="tasks-list">
        {state === undefined ? <p className="tasks-empty tt-paragraph">{t`Reading scheduled tasks…`}</p>
          : tasks.length === 0 && editing === null ? <p className="tasks-empty tt-paragraph">{t`No scheduled tasks yet.`}</p>
            : tasks.map(task => editing === task.id ? null : taskRow(task))}
        {editing !== null
          ? <ScheduledTaskEditor key={editing} spec={editingTask ?? null} projects={projects} models={models} threads={threads} playbooks={state?.playbooks ?? []}
            saving={busy} onSave={spec => void save(spec)} onCancel={() => setEditing(null)} />
          : null}
      </div>
      {editing === null
        ? <div className="tasks-foot">
          <Button variant="primary" data-setting="scheduled-tasks-new" disabled={!bridge || state === undefined || state.available === false || Boolean(state.storageProblem)} onClick={() => setEditing('new')}>
            <Plus size={14} aria-hidden="true" />{t`New task`}
          </Button>
        </div>
        : null}
    </SettingsGroup>

    <SettingsGroup title={t`Runs`} icon={History} rows={false}>
      {runs.length === 0 ? <p className="tasks-empty tt-paragraph">{t`No runs yet.`}</p> : <ul className="tasks-runs">{runs.slice(0, 60).map(runRow)}</ul>}
    </SettingsGroup>

    <SettingsGroup title={t`Playbooks`} icon={BookOpen} rows={false} note={t`A playbook is a JSON file of ordered steps: agent turns, commands and your decisions. Sotto reads it from the playbooks folder; nothing from outside can add a step.`}>
      <div className="tasks-list">
        {(state?.playbooks ?? []).length === 0 ? <p className="tasks-empty tt-paragraph">{t`No playbooks yet.`}</p>
          : state!.playbooks.map(playbook => <div key={playbook.id} className="tasks-row" data-problem={playbook.problem ? 'broken' : undefined}>
            <div className="tasks-row__main">
              <p className="tasks-row__name">{playbook.name ?? playbook.id}</p>
              <p className="tasks-row__line tt-paragraph">{playbook.problem ?? playbook.description ?? t`In ${ph({ file: playbook.id })}.json`}</p>
              {playbook.steps.length ? <p className="tasks-row__line tt-paragraph">{playbook.steps.map(step => step.title).join(' → ')}</p> : null}
            </div>
          </div>)}
      </div>
      <div className="tasks-foot">
        <Button variant="secondary" data-setting="scheduled-tasks-example" disabled={!bridge || busy || state?.available === false} onClick={() => void send({ type: 'add-example' })}>{t`Add the example playbook`}</Button>
        <Button variant="ghost" data-setting="scheduled-tasks-folder" disabled={!bridge || state?.available === false} onClick={() => void send({ type: 'open-playbooks' })}><FolderOpen size={14} aria-hidden="true" />{t`Open playbooks folder`}</Button>
      </div>
    </SettingsGroup>

    <SettingsGroup title={t`Webhooks`} icon={Webhook} rows={false}>
      <div className="tasks-card">
        <p className="tt-paragraph">{state?.webhooks.listening && state.webhooks.address
          ? t`Listening on ${ph({ address: state.webhooks.address })}, on this computer only.`
          : t`Not listening. The listener starts on this computer only while scheduled tasks are on and a task has its webhook on.`}</p>
        {state?.webhooks.problem ? <p className="tasks-status tasks-status--error tt-paragraph">{state.webhooks.problem}</p> : null}
        {state && !state.credentials ? <p className="tasks-status tasks-status--error tt-paragraph">{t`This computer’s credential store is locked or missing, so no webhook secret can be kept.`}</p> : null}
        <p className="tt-paragraph tasks-note">{t`POST a JSON object to a task’s address with X-Sotto-Delivery (a new ID each time), X-Sotto-Timestamp (Unix seconds) and X-Sotto-Signature: sha256= and the HMAC-SHA256 of timestamp.delivery.body with the task’s secret. A delivery ID seen before starts nothing again.`}</p>
      </div>
    </SettingsGroup>

    {removing
      ? <ConfirmationDialog title={t`Remove ${ph({ name: removing.name })}?`} description={t`Its schedule, triggers and history are removed, and a run still going is cancelled. The threads its runs made are kept.`}
        confirmLabel={t`Remove`} cancelLabel={t`Keep it`} danger onCancel={() => setRemoving(null)}
        onConfirm={async () => { const result = await send({ type: 'remove', id: removing.id }); if (result?.ok) setRemoving(null); return result?.ok === true }} />
      : null}
  </>
}
