import React, { useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { FileDiff, GitCommitHorizontal, GitPullRequest, RefreshCw } from 'lucide-react'
import {
  DEFAULT_MERGE_METHODS, GIT_FETCH_INTERVAL_SECONDS, GIT_MERGE_METHOD_LABELS, GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS, GIT_WRITING_STYLES,
  type AppSettings, type DefaultMergeMethod, type DiffFileState, type DiffLayout, type GitFetchIntervalSeconds, type GitWritingStyle, type SettingsPatch,
} from '../../../../shared/settings'
import { Field } from '../../components/Field'
import { SegmentedControl } from '../../components/SegmentedControl'
import { Select } from '../../components/Select'
import { Toggle } from '../../components/Toggle'
import './gitSettings.css'

interface GitSettingsProps {
  readonly settings: AppSettings
  readonly onSave: (patch: SettingsPatch, successText?: string) => Promise<boolean>
}

const WRITING_STYLE_LABELS: Record<GitWritingStyle, string> = { repository: 'Repository conventions', conventional: 'Conventional Commits', custom: 'Custom instructions' }
const mergeMethodLabel = (method: DefaultMergeMethod): string => method === 'last' ? 'Last selected' : GIT_MERGE_METHOD_LABELS[method]
const fetchIntervalLabel = (seconds: GitFetchIntervalSeconds): string => seconds === 0 ? 'Off' : seconds < 60 ? `${seconds} seconds` : seconds === 60 ? '1 minute' : `${seconds / 60} minutes`
const MAX_CHARACTERS = GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS.toLocaleString('en-US')

/** How long typing pauses before Custom instructions saves on its own. */
export const CUSTOM_INSTRUCTIONS_SAVE_DELAY_MS = 600

type GitSettingDescriptions = Record<'style' | 'templates' | 'merge' | 'settle' | 'layout' | 'whitespace' | 'fileState' | 'proactive' | 'fetch' | 'autoPull', string>

/**
 * What each Git setting will do with the value it holds, one sentence or two each, so a description changes
 * as its value does. The merge method's describes the merge in the pull request checklist (#294), which reads it.
 */
export function gitSettingDescriptions(settings: AppSettings): GitSettingDescriptions {
  const style = {
    repository: 'The thread\'s own model writes commit messages and pull request text the way each repository\'s recent commits and AGENTS.md do.',
    conventional: 'Each commit subject and pull request title starts with a type and scope, like feat(threads):.',
    custom: 'Sotto sends your instructions to the thread\'s own model with every commit message and pull request draft; they take precedence over the repository\'s style.',
  }[settings.gitWritingStyle]
  const drafting = settings.commitMessages || settings.pullRequestText
  const every = settings.gitFetchIntervalSeconds === 60 ? 'minute' : fetchIntervalLabel(settings.gitFetchIntervalSeconds)
  return {
    style: drafting ? style : `${style} Nothing is drafted while Generated commit messages and Generated pull request text are off under Cleanup.`,
    templates: settings.followPullRequestTemplates
      ? 'When a Git action drafts a pull request, the thread\'s own model follows the repository\'s pull request template, if Sotto finds one.'
      : 'When a Git action drafts a pull request, it skips the template and uses Sotto\'s own sections.',
    merge: settings.defaultMergeMethod === 'last'
      ? 'The merge in the pull request checklist starts on the method you used last, Merge the first time.'
      : `The merge in the pull request checklist starts on ${GIT_MERGE_METHOD_LABELS[settings.defaultMergeMethod]}.`,
    settle: settings.autoSettleMergedThreads
      ? 'Once a thread\'s pull request is merged, Sotto settles the thread. It asks GitHub through gh once an hour and removes no folder unless a worktree rule under Application says so.'
      : 'A thread stays where it is after its pull request merges, until you settle it.',
    layout: settings.diffLayout === 'stacked'
      ? 'Changes starts with each diff stacked, removed lines above added ones.'
      : 'Changes starts with each diff split, old on the left and new on the right.',
    whitespace: settings.diffHideWhitespace
      ? 'Changes starts with edits that only change spacing hidden.'
      : 'Changes starts showing every edit, spacing included.',
    fileState: settings.diffFileState === 'collapsed'
      ? 'Files in Changes start collapsed to their headers. Press one to read it.'
      : 'Files in Changes start expanded.',
    proactive: settings.proactivePanels
      ? 'Changes opens on its own if Tools is closed and a turn leaves its folder with at least 3 more changed files or 50 more changed lines. It counts only while the Threads page is open.'
      : 'Changes opens only when you open it.',
    fetch: settings.gitFetchIntervalSeconds === 0
      ? 'Sotto never fetches on its own. Ahead, behind and the pull request update when you refresh.'
      : `Sotto asks origin every ${every} whether a thread's branch is ahead or behind, while this window is in front.`,
    autoPull: settings.gitAutoPull
      ? 'Sotto pulls a thread\'s folder on the default branch when it is clean and only behind. Fast-forward only; nothing is merged or rebased.'
      : 'Sotto shows when the default branch is behind and leaves the pull to you.',
  }
}

export interface WritingExample {
  readonly commit: string
  readonly pullRequest: string
  readonly note: string
}

const PLAIN_EXAMPLE = 'Let a thread name itself from its first exchange'

/**
 * The example under the style. What a model makes of custom instructions cannot be known without asking one,
 * and Settings asks nothing, so under Custom the example stays the subject the instructions start from and
 * says so, rather than guessing at the answer.
 */
export function writingExample(style: GitWritingStyle, instructions: string): WritingExample {
  if (style === 'conventional') {
    const line = 'feat(threads): name a thread from its first exchange'
    return { commit: line, pullRequest: line, note: 'An example. The thread\'s own model picks the type and scope from the change.' }
  }
  const note = style === 'repository'
    ? 'An example. Each repository\'s recent commits and AGENTS.md set the real style.'
    : instructions.trim()
      ? 'An example before your instructions. The thread\'s own model applies them when it drafts.'
      : 'Nothing written yet, so drafts follow Repository conventions, like this example.'
  return { commit: PLAIN_EXAMPLE, pullRequest: PLAIN_EXAMPLE, note }
}

function Example({ example }: { readonly example: WritingExample }): ReactNode {
  return <div className="git-settings__example" role="group" aria-label="Example">
    <dl>
      <dt>Commit subject</dt><dd>{example.commit}</dd>
      <dt>Pull request title</dt><dd>{example.pullRequest}</dd>
    </dl>
    <p>{example.note}</p>
  </div>
}

/**
 * The style, the Custom instructions field under it while Custom is chosen, and the example. What is typed
 * saves once typing pauses, on leaving the field, when the style changes away from Custom and when Settings
 * closes, so nothing typed is lost mid-sentence. The example reads the text as typed, not as saved.
 */
function WritingStyle({ settings, onSave, description }: GitSettingsProps & { readonly description: string }): ReactNode {
  const saved = settings.gitWritingInstructions
  const [text, setText] = useState(saved)
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ saved, onSave })
  latest.current = { saved, onSave }
  /** Counts the saves sent, so an answer to an older one never outranks a newer one. */
  const sent = useRef(0)
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const value = pending.current
    pending.current = null
    if (value === null || value === latest.current.saved) return
    const sequence = ++sent.current
    // A failed save puts the text back as waiting, so the next pause, blur or change of style tries again, but
    // only while it is still the latest text sent and nothing newer is waiting: a later save supersedes it.
    void latest.current.onSave({ gitWritingInstructions: value }, 'Instructions saved.').then(saved => {
      if (!saved && sequence === sent.current && pending.current === null) pending.current = value
    })
  }, [])
  // A saved value from elsewhere shows only while nothing typed here is waiting to be saved.
  useEffect(() => { if (pending.current === null) setText(saved) }, [saved])
  const custom = settings.gitWritingStyle === 'custom'
  useEffect(() => { if (!custom) flush() }, [custom, flush])
  useEffect(() => flush, [flush])
  const fieldId = useId()
  const limitId = useId()
  return <div className="git-settings__style">
    <Field label="Commit and pull request style" description={description}>
      <Select value={settings.gitWritingStyle} onChange={event => void onSave({ gitWritingStyle: event.currentTarget.value as GitWritingStyle })}>
        {GIT_WRITING_STYLES.map(style => <option key={style} value={style}>{WRITING_STYLE_LABELS[style]}</option>)}
      </Select>
    </Field>
    {!custom ? null : <div className="git-settings__custom">
      <p className="git-settings__custom-label"><label htmlFor={fieldId}>Custom instructions</label> · <span id={limitId}>up to {MAX_CHARACTERS} characters</span></p>
      <textarea id={fieldId} className="tt-input tt-focusable" rows={4} maxLength={GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS} value={text} aria-describedby={limitId}
        placeholder="Start the subject with the area in square brackets..."
        onChange={event => {
          const value = event.currentTarget.value
          setText(value)
          pending.current = value
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(flush, CUSTOM_INSTRUCTIONS_SAVE_DELAY_MS)
        }}
        onBlur={flush} />
    </div>}
    <Example example={writingExample(settings.gitWritingStyle, text)} />
  </div>
}

type GroupIcon = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: 'true' }>

function Group({ title, icon: Icon, note, children }: { readonly title: string; readonly icon: GroupIcon; readonly note?: string; readonly children: ReactNode }): ReactNode {
  const id = useId()
  const noteId = useId()
  return <section className="git-settings__group" aria-labelledby={id} {...(note ? { 'aria-describedby': noteId } : {})}>
    <h3 id={id}><Icon size={16} strokeWidth={1.7} aria-hidden="true" />{title}</h3>
    {note ? <p className="git-settings__group-note" id={noteId}>{note}</p> : null}
    <div className="settings-rows">{children}</div>
  </section>
}

/**
 * Settings → Git: every Git setting in one section, grouped under the moment it acts (the owner's pick B,
 * September 23, 2026), each description saying what Sotto will do with the value shown.
 */
export function GitSettings({ settings, onSave }: GitSettingsProps): ReactNode {
  const says = gitSettingDescriptions(settings)
  return <div className="git-settings">
    <Group title="When a thread commits" icon={GitCommitHorizontal}>
      <WritingStyle settings={settings} onSave={onSave} description={says.style} />
    </Group>
    <Group title="When a pull request is made or merged" icon={GitPullRequest}>
      <Toggle label="Follow pull request templates" checked={settings.followPullRequestTemplates} onCheckedChange={checked => void onSave({ followPullRequestTemplates: checked })} description={says.templates} />
      <Field label="Default merge method" description={says.merge}>
        <Select value={settings.defaultMergeMethod} onChange={event => void onSave({ defaultMergeMethod: event.currentTarget.value as DefaultMergeMethod })}>
          {DEFAULT_MERGE_METHODS.map(method => <option key={method} value={method}>{mergeMethodLabel(method)}</option>)}
        </Select>
      </Field>
      <Toggle label="Auto-settle merged threads" checked={settings.autoSettleMergedThreads} onCheckedChange={checked => void onSave({ autoSettleMergedThreads: checked })} description={says.settle} />
    </Group>
    <Group title="When you read Changes" icon={FileDiff} note="These set where Changes starts. A choice made in Changes holds until one of these settings changes or Sotto restarts.">
      <Field label="Diff layout" description={says.layout}>
        <SegmentedControl label="Diff layout" value={settings.diffLayout} onChange={value => void onSave({ diffLayout: value as DiffLayout })} options={[{ value: 'stacked', label: 'Stacked' }, { value: 'split', label: 'Split' }]} />
      </Field>
      <Toggle label="Hide whitespace changes" checked={settings.diffHideWhitespace} onCheckedChange={checked => void onSave({ diffHideWhitespace: checked })} description={says.whitespace} />
      <Field label="Default diff file state" description={says.fileState}>
        <SegmentedControl label="Default diff file state" value={settings.diffFileState} onChange={value => void onSave({ diffFileState: value as DiffFileState })} options={[{ value: 'expanded', label: 'Expanded' }, { value: 'collapsed', label: 'Collapsed' }]} />
      </Field>
      <Toggle label="Proactive panels" checked={settings.proactivePanels} onCheckedChange={checked => void onSave({ proactivePanels: checked })} description={says.proactive} />
    </Group>
    <Group title="In the background" icon={RefreshCw}>
      <Field label="Git fetch interval" description={says.fetch}>
        <Select value={String(settings.gitFetchIntervalSeconds)} onChange={event => void onSave({ gitFetchIntervalSeconds: Number(event.currentTarget.value) as GitFetchIntervalSeconds })}>
          {GIT_FETCH_INTERVAL_SECONDS.map(seconds => <option key={seconds} value={String(seconds)}>{fetchIntervalLabel(seconds)}</option>)}
        </Select>
      </Field>
      <Toggle label="Automatically pull" checked={settings.gitAutoPull} onCheckedChange={checked => void onSave({ gitAutoPull: checked })} description={says.autoPull} />
    </Group>
  </div>
}
