import React, { useMemo, useRef, useState, type ReactNode } from 'react'
import { ph } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'

import type { AgentModel, AgentProject, AgentRuntimeMode, AgentThread } from '../../../../shared/agents'
import { TASK_NAME_MAX, TASK_PROMPT_MAX, type PlaybookView, type TaskSpec } from '../../../../shared/scheduledTasks'
import { effortLabel } from '../../agents/effortNames'
import { RUNTIME_LABELS } from '../../agents/permissionPresentation'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { SegmentedControl } from '../../components/SegmentedControl'
import { Select } from '../../components/Select'
import { Toggle } from '../../components/Toggle'
import { draftOf, emptyDraft, specOf, type DraftProblem, type ScheduleKind, type TaskDraft } from '../../state/scheduledTasks'

const RUNTIME_MODES: readonly AgentRuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

/**
 * The form a scheduled task is written and changed in, on Settings › Scheduled tasks (ADR-0218): its name, what it runs
 * (a prompt or a playbook), where (a new thread in a project on a model, or one thread), when (once, every so often, or
 * on days of the week at set times in a time zone), what to do with a missed or overlapping time, and the triggers from
 * outside: a signed webhook, or new GitHub issues and pull requests. Escape closes it without saving.
 */
export function ScheduledTaskEditor({ spec, projects, models, threads, playbooks, saving, onSave, onCancel }: {
  readonly spec: TaskSpec | null
  readonly projects: readonly AgentProject[]
  readonly models: readonly AgentModel[]
  readonly threads: readonly AgentThread[]
  readonly playbooks: readonly PlaybookView[]
  readonly saving: boolean
  readonly onSave: (spec: TaskSpec) => void
  readonly onCancel: () => void
}): ReactNode {
  const { t } = useLingui()
  const [draft, setDraft] = useState<TaskDraft>(() => spec ? draftOf(spec, Date.now())
    : emptyDraft(Date.now(), { projectId: projects[0]?.id, modelId: models.find(model => model.ready)?.id ?? models[0]?.id, playbookId: playbooks.find(item => item.name)?.id }))
  const [problem, setProblem] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]): void => { setDraft(current => ({ ...current, [key]: value })); setProblem(null) }
  const playbook = playbooks.find(item => item.id === draft.playbookId)
  const model = models.find(item => item.id === draft.modelId)
  const zones = useMemo(() => { try { return Intl.supportedValuesOf('timeZone') } catch { return [] } }, [])
  const weekdayNames = useMemo(() => {
    const format = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' })
    // 2026-11-02 is a Monday.
    return WEEKDAYS.map(day => format.format(new Date(Date.UTC(2026, 10, 1 + day))))
  }, [])

  const problemWords = (key: DraftProblem, input?: string): string => {
    switch (key) {
      case 'name': return t`Give the task a name.`
      case 'prompt': return t`Write the prompt it sends.`
      case 'playbook': return t`Choose a playbook. Add one to the playbooks folder first if none is listed.`
      case 'project': return t`Choose the project its threads start in.`
      case 'model': return t`Choose the model its threads use.`
      case 'thread': return t`Choose the thread it sends to.`
      case 'once-at': return t`Choose a time to come.`
      case 'every': return t`Choose an interval between 5 minutes and 28 days.`
      case 'days': return t`Choose at least one day.`
      case 'times': return t`Write up to 12 times as hours and minutes, such as 09:00, 17:30.`
      case 'github-kinds': return t`Choose issues, pull requests or both.`
      case 'repository': return t`Write the repository as owner/name, or leave it empty to use the project’s.`
      case 'input': return t`${ph({ input: input ?? '' })} should be a number.`
    }
  }

  const save = (): void => {
    const inputTypes = Object.fromEntries((playbook?.inputs ?? []).map(input => [input.name, input.type]))
    const made = specOf(draft, Date.now(), inputTypes)
    if ('problem' in made) { setProblem(problemWords(made.problem, made.input)); return }
    onSave(made.spec)
  }

  const scheduleOptions: { value: ScheduleKind; label: string }[] = [
    { value: 'weekly', label: t`On days of the week` },
    { value: 'every', label: t`Every so often` },
    { value: 'once', label: t`Once` },
    { value: 'none', label: t`Only when started` },
  ]

  return <form ref={form} className="tasks-editor" aria-label={spec ? t`Change ${ph({ name: spec.name })}` : t`New scheduled task`}
    onSubmit={event => { event.preventDefault(); if (!saving) save() }}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onCancel() } }}>
    <Field label={t`Name`}>
      <input className="tt-input" value={draft.name} maxLength={TASK_NAME_MAX} autoFocus onChange={event => set('name', event.currentTarget.value)} placeholder={t`Morning review`} />
    </Field>

    <fieldset className="tasks-editor__set">
      <legend>{t`What it runs`}</legend>
      <SegmentedControl label={t`What it runs`} value={draft.workKind} onChange={value => set('workKind', value as TaskDraft['workKind'])}
        options={[{ value: 'prompt', label: t`A prompt` }, { value: 'playbook', label: t`A playbook` }]} />
      {draft.workKind === 'prompt'
        ? <Field label={t`Prompt`} description={t`Sent as written, as Sotto’s message. A webhook’s or GitHub’s data goes below it, marked as outside words.`}>
          <textarea className="tasks-editor__prompt tt-input" rows={5} maxLength={TASK_PROMPT_MAX} value={draft.prompt} onChange={event => set('prompt', event.currentTarget.value)} />
        </Field>
        : <>
          <Field label={t`Playbook`} {...playbooks.length ? {} : { description: t`No playbooks yet. Add the example or write one in the playbooks folder.` }}>
            <Select value={draft.playbookId} onChange={event => set('playbookId', event.currentTarget.value)}>
              <option value="">{t`Choose a playbook`}</option>
              {playbooks.map(item => <option key={item.id} value={item.id} disabled={!item.name}>{item.name ?? t`${ph({ file: item.id })} (can’t be read)`}</option>)}
            </Select>
          </Field>
          {playbook?.inputs.map(input => <Field key={input.name} label={input.required ? t`${ph({ input: input.name })} (required)` : input.name}
            description={input.description ?? t`Filled from a webhook’s or GitHub’s data when it names ${ph({ input: input.name })}, unless you set it here.`}>
            {input.type === 'boolean'
              ? <Select value={draft.inputs[input.name] ?? ''} onChange={event => set('inputs', { ...draft.inputs, [input.name]: event.currentTarget.value })}>
                <option value="">{t`Not set`}</option><option value="true">{t`Yes`}</option><option value="false">{t`No`}</option>
              </Select>
              : <input className="tt-input" inputMode={input.type === 'number' ? 'decimal' : undefined} value={draft.inputs[input.name] ?? ''}
                onChange={event => set('inputs', { ...draft.inputs, [input.name]: event.currentTarget.value })} />}
          </Field>)}
        </>}
    </fieldset>

    <fieldset className="tasks-editor__set">
      <legend>{t`Where it runs`}</legend>
      {draft.workKind === 'prompt'
        ? <SegmentedControl label={t`Where it runs`} value={draft.targetKind} onChange={value => set('targetKind', value as TaskDraft['targetKind'])}
          options={[{ value: 'new-thread', label: t`A new thread each time` }, { value: 'thread', label: t`One thread` }]} />
        : null}
      {draft.targetKind === 'thread' && draft.workKind === 'prompt'
        ? <Field label={t`Thread`} description={t`Each run waits until the thread is free, and never answers its questions.`}>
          <Select value={draft.threadId} onChange={event => set('threadId', event.currentTarget.value)}>
            <option value="">{t`Choose a thread`}</option>
            {threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
          </Select>
        </Field>
        : <div className="tasks-editor__row">
          <Field label={t`Project`}>
            <Select value={draft.projectId} onChange={event => set('projectId', event.currentTarget.value)}>
              <option value="">{t`Choose a project`}</option>
              {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
            </Select>
          </Field>
          <Field label={t`Model`}>
            <Select value={draft.modelId} onChange={event => { set('modelId', event.currentTarget.value); set('reasoningEffort', '') }}>
              <option value="">{t`Choose a model`}</option>
              {models.map(item => <option key={item.id} value={item.id}>{item.ready ? `${item.provider} · ${item.name}` : t`${ph({ provider: item.provider })} · ${ph({ model: item.name })} (not connected)`}</option>)}
            </Select>
          </Field>
          {model?.reasoningEfforts?.length
            ? <Field label={t`Effort`}>
              <Select value={draft.reasoningEffort} onChange={event => set('reasoningEffort', event.currentTarget.value)}>
                <option value="">{t`The model’s default`}</option>
                {model.reasoningEfforts.map(effort => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
              </Select>
            </Field>
            : null}
          <Field label={t`Permissions`} description={t`Its threads ask you as any thread would. A scheduled task never answers for you.`}>
            <Select value={draft.runtimeMode} onChange={event => set('runtimeMode', event.currentTarget.value)}>
              <option value="">{t`As new threads start`}</option>
              {RUNTIME_MODES.map(mode => <option key={mode} value={mode}>{RUNTIME_LABELS[mode]}</option>)}
            </Select>
          </Field>
          {draft.workKind === 'prompt'
            ? <Field label={t`Working copy`}>
              <Select value={draft.workingCopy} onChange={event => set('workingCopy', event.currentTarget.value as TaskDraft['workingCopy'])}>
                <option value="shared">{t`The project’s checkout`}</option>
                <option value="independent">{t`A worktree of its own`}</option>
              </Select>
            </Field>
            : null}
        </div>}
    </fieldset>

    <fieldset className="tasks-editor__set">
      <legend>{t`When it runs`}</legend>
      <Field label={t`Schedule`}>
        <Select value={draft.scheduleKind} onChange={event => set('scheduleKind', event.currentTarget.value as ScheduleKind)}>
          {scheduleOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </Field>
      {draft.scheduleKind === 'once'
        ? <Field label={t`At`}><input className="tt-input" type="datetime-local" value={draft.onceAt} onChange={event => set('onceAt', event.currentTarget.value)} /></Field>
        : null}
      {draft.scheduleKind === 'every'
        ? <div className="tasks-editor__row">
          <Field label={t`Every`}><input className="tt-input tasks-editor__number" type="number" min={1} step="any" value={draft.everyAmount} onChange={event => set('everyAmount', event.currentTarget.value)} /></Field>
          <Field label={t`Unit`}>
            <Select value={draft.everyUnit} onChange={event => set('everyUnit', event.currentTarget.value as TaskDraft['everyUnit'])}>
              <option value="minutes">{t`Minutes`}</option><option value="hours">{t`Hours`}</option><option value="days">{t`Days`}</option>
            </Select>
          </Field>
        </div>
        : null}
      {draft.scheduleKind === 'weekly'
        ? <>
          <div className="tasks-editor__days" role="group" aria-label={t`Days`}>
            {WEEKDAYS.map((day, index) => <label key={day} className="tasks-editor__day">
              <input type="checkbox" className="tt-focusable" checked={draft.days.includes(day)}
                onChange={event => set('days', event.currentTarget.checked ? [...draft.days, day] : draft.days.filter(item => item !== day))} />
              <span>{weekdayNames[index]}</span>
            </label>)}
          </div>
          <div className="tasks-editor__row">
            <Field label={t`Times`} description={t`Hours and minutes, such as 09:00, 17:30`}>
              <input className="tt-input" value={draft.times} onChange={event => set('times', event.currentTarget.value)} />
            </Field>
            <Field label={t`Time zone`} description={t`Times follow this zone’s clock, summer time included.`}>
              <input className="tt-input" list="tasks-editor-zones" value={draft.timeZone} onChange={event => set('timeZone', event.currentTarget.value)} />
            </Field>
            <datalist id="tasks-editor-zones">{zones.map(zone => <option key={zone} value={zone} />)}</datalist>
          </div>
        </>
        : null}
      <div className="tasks-editor__row">
        {draft.scheduleKind !== 'none'
          ?
          <Field label={t`A missed time`} description={t`One that passed while Sotto was closed or scheduled tasks were off.`}>
            <Select value={draft.missed} onChange={event => set('missed', event.currentTarget.value as TaskDraft['missed'])}>
              <option value="run-once">{t`Run once, late`}</option><option value="skip">{t`Skip it`}</option>
            </Select>
          </Field>
          : null}
          <Field label={t`A trigger that comes while the last run is going`}>
            <Select value={draft.overlap} onChange={event => set('overlap', event.currentTarget.value as TaskDraft['overlap'])}>
              <option value="skip">{t`Skip it`}</option><option value="queue">{t`Run once the last run ends`}</option>
            </Select>
          </Field>
      </div>
    </fieldset>

    <fieldset className="tasks-editor__set">
      <legend>{t`Started from outside`}</legend>
      <Toggle label={t`A signed webhook`} checked={draft.webhook} onCheckedChange={checked => set('webhook', checked)}
        description={t`A program on this computer posts JSON to the task’s address, signed with its secret. What it sends is data for the run, never an instruction.`} />
      <Toggle label={t`New GitHub issues or pull requests`} checked={draft.github} onCheckedChange={checked => set('github', checked)}
        description={t`Sotto asks GitHub through gh every couple of minutes while scheduled tasks are on. Only ones opened after you save start runs.`} />
      {draft.github
        ? <div className="tasks-editor__row">
          <label className="tasks-editor__day"><input type="checkbox" className="tt-focusable" checked={draft.githubIssues} onChange={event => set('githubIssues', event.currentTarget.checked)} /><span>{t`Issues`}</span></label>
          <label className="tasks-editor__day"><input type="checkbox" className="tt-focusable" checked={draft.githubPullRequests} onChange={event => set('githubPullRequests', event.currentTarget.checked)} /><span>{t`Pull requests`}</span></label>
          <Field label={t`Repository`} description={t`owner/name. Empty uses the project’s.`}>
            <input className="tt-input" value={draft.githubRepository} onChange={event => set('githubRepository', event.currentTarget.value)} placeholder="owner/name" />
          </Field>
          <Field label={t`Only with the label`}>
            <input className="tt-input" maxLength={50} value={draft.githubLabel} onChange={event => set('githubLabel', event.currentTarget.value)} />
          </Field>
        </div>
        : null}
    </fieldset>

    <p className="tasks-status tasks-status--error tt-paragraph" role="alert">{problem ?? ''}</p>
    <div className="tasks-editor__foot">
      <Button variant="primary" type="submit" disabled={saving}>{saving ? t`Saving…` : t`Save task`}</Button>
      <Button variant="ghost" type="button" onClick={onCancel}>{t`Cancel`}</Button>
    </div>
  </form>
}
