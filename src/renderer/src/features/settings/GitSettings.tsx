import React, { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { FileDiff, FolderMinus, GitCommitHorizontal, GitPullRequest, RefreshCw } from 'lucide-react'
import {
  DEFAULT_MERGE_METHODS, GIT_FETCH_INTERVAL_SECONDS, GIT_MERGE_METHOD_LABELS, GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS, GIT_WRITING_STYLES, WORKTREE_CLEANUP_DAYS,
  type AppSettings, type DefaultMergeMethod, type DiffFileState, type DiffLayout, type GitFetchIntervalSeconds, type GitWritingStyle, type SettingsPatch, type WorktreeCleanupDays,
} from '../../../../shared/settings'
import { Field } from '../../components/Field'
import { SegmentedControl } from '../../components/SegmentedControl'
import { Select } from '../../components/Select'
import { Toggle } from '../../components/Toggle'
import { SettingsGroup } from './SettingsGroup'
import { useOwlFeature } from '../../state/owlFeature'
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

type GitSettingDescriptions = Record<'style' | 'templates' | 'merge' | 'settle' | 'layout' | 'whitespace' | 'fileState' | 'proactive' | 'fetch' | 'autoPull' | 'keepMain', string>

/**
 * What each Git setting will do with the value it holds, one sentence or two each, so a description changes
 * as its value does. The merge method's describes the merge in the pull request checklist (#294), which reads it.
 */
export function gitSettingDescriptions(settings: AppSettings): GitSettingDescriptions {
  const style = {
    repository: 'Follows each repository\'s recent commits and AGENTS.md.',
    conventional: 'Subjects and titles start with a type and scope, like feat(threads):.',
    custom: 'Your instructions go to the thread\'s own model with every draft and win over the repository\'s style.',
  }[settings.gitWritingStyle]
  const drafting = settings.commitMessages || settings.pullRequestText
  const every = settings.gitFetchIntervalSeconds === 60 ? 'minute' : fetchIntervalLabel(settings.gitFetchIntervalSeconds)
  return {
    style: drafting ? style : `${style} Nothing is drafted while Generated commit messages and Generated pull request text are off.`,
    templates: settings.followPullRequestTemplates
      ? 'Drafted pull requests follow the repository\'s template when Sotto finds one.'
      : 'Drafted pull requests use Sotto\'s own sections.',
    merge: settings.defaultMergeMethod === 'last'
      ? 'The pull request checklist starts on the method you used last, or Merge the first time.'
      : `The pull request checklist starts on ${GIT_MERGE_METHOD_LABELS[settings.defaultMergeMethod]}.`,
    settle: settings.autoSettleMergedThreads
      ? 'Settles a thread once its pull request merges, checking GitHub through gh hourly. Folders follow the worktree rules under Application.'
      : 'A merged thread stays put until you settle it.',
    layout: settings.diffLayout === 'stacked'
      ? 'Removed lines above added ones.'
      : 'Old on the left, new on the right.',
    whitespace: settings.diffHideWhitespace
      ? 'Edits that only change spacing are hidden.'
      : 'Every edit shows, spacing included.',
    fileState: settings.diffFileState === 'collapsed'
      ? 'Files start as headers; press one to read it.'
      : 'Files start open.',
    proactive: settings.proactivePanels
      ? 'While Tools is closed, Changes opens on its own when a turn leaves 3 more changed files or 50 more changed lines.'
      : 'Changes opens only when you open it.',
    fetch: settings.gitFetchIntervalSeconds === 0
      ? 'Sotto never fetches, even before a Git action. Ahead and behind use the last fetch.'
      : `Checks origin every ${every} for ahead and behind, while this window is in front.`,
    autoPull: settings.gitAutoPull
      ? 'Fast-forwards a clean folder on the default branch when it falls behind. Nothing is merged or rebased.'
      : 'Shows when the default branch is behind and leaves the pull to you.',
    keepMain: settings.keepMainCurrent
      ? 'Every 15 minutes and after a pull request merges, each project’s folder moves forward to its remote’s default branch when that branch is checked out and has no local changes. Sotto never stashes, resets or rebases.'
      : 'Projects stay where they are until you pull. A project can turn it on for itself in Threads, Project defaults.',
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

/**
 * Settings → Git & worktrees: every Git setting in one section, grouped under the moment it acts (the owner's pick B,
 * September 23, 2026), each description saying what Sotto will do with the value shown. Worktree removal and the
 * thread's own model writing commits and pull requests joined it when Settings was regrouped (October 22, 2026).
 */
export function GitSettings({ settings, onSave }: GitSettingsProps): ReactNode {
  const says = gitSettingDescriptions(settings)
  // Keep main up to date (ADR-0123): an Owl feature, so stable shows no switch for it.
  const keepMain = useOwlFeature('keep-main-current')
  return <div className="git-settings">
    <SettingsGroup id="settings-worktrees" title="Removing worktrees" icon={FolderMinus}>
      <Field label="Remove idle worktrees after" description="Removes a thread's worktree folder once it has been idle this long. The branch stays, sending brings the folder back, and uncommitted work is never removed."><Select value={String(settings.worktreeCleanup.afterDays ?? 'never')} onChange={event => { const value = event.currentTarget.value; void onSave({ worktreeCleanup: { afterDays: value === 'never' ? null : Number(value) as WorktreeCleanupDays } }) }}><option value="never">Never</option>{WORKTREE_CLEANUP_DAYS.map(days => <option key={days} value={String(days)}>{days} days</option>)}</Select></Field>
      <Toggle label="Remove a worktree when its thread is settled" checked={settings.worktreeCleanup.onSettle} onCheckedChange={checked => void onSave({ worktreeCleanup: { onSettle: checked } })} description="Settling removes a clean worktree without asking. One with uncommitted changes still asks." />
      <Toggle label="Remove a worktree once its commits are in the default branch" checked={settings.worktreeCleanup.unchanged} onCheckedChange={checked => void onSave({ worktreeCleanup: { unchanged: checked } })} description="Checked hourly against your local copy of the default branch." />
      <Toggle label="Remove a worktree when its pull request is merged" checked={settings.worktreeCleanup.merged} onCheckedChange={checked => void onSave({ worktreeCleanup: { merged: checked } })} description="Checked hourly with GitHub through gh, using your own sign-in." />
    </SettingsGroup>
    <SettingsGroup title="When a thread commits" icon={GitCommitHorizontal}>
      <WritingStyle settings={settings} onSave={onSave} description={says.style} />
      <Toggle label="Generated commit messages" checked={settings.commitMessages} onCheckedChange={(checked) => void onSave({ commitMessages: checked })} description="Leave a commit message empty and the thread's own model writes it from the staged diff, recent commits and AGENTS.md. Off, it reads “Update project files”." />
    </SettingsGroup>
    <SettingsGroup title="When a pull request is made or merged" icon={GitPullRequest}>
      <Toggle label="Generated pull request text" checked={settings.pullRequestText} onCheckedChange={(checked) => void onSave({ pullRequestText: checked })} description="The thread's own model writes a new pull request's title and body from the branch's commits and diff." />
      <Toggle label="Follow pull request templates" checked={settings.followPullRequestTemplates} onCheckedChange={checked => void onSave({ followPullRequestTemplates: checked })} description={says.templates} />
      <Field label="Default merge method" description={says.merge}>
        <Select value={settings.defaultMergeMethod} onChange={event => void onSave({ defaultMergeMethod: event.currentTarget.value as DefaultMergeMethod })}>
          {DEFAULT_MERGE_METHODS.map(method => <option key={method} value={method}>{mergeMethodLabel(method)}</option>)}
        </Select>
      </Field>
      <Toggle label="Auto-settle merged threads" checked={settings.autoSettleMergedThreads} onCheckedChange={checked => void onSave({ autoSettleMergedThreads: checked })} description={says.settle} />
      {/* ADR-0061 decision 12: the switch governs the agent's tool alone; the user's own Babysit pull request stays either way. */}
      <Toggle label="Let agents babysit pull requests" checked={settings.babysitPullRequests} onCheckedChange={checked => void onSave({ babysitPullRequests: checked })}
        description={settings.babysitPullRequests
          ? 'An agent can hand its pull request to Sotto, which wakes the thread when the pull request needs it.'
          : 'Agents can’t start babysitting, and Sotto stops any they started. You can still babysit one yourself.'} />
    </SettingsGroup>
    <SettingsGroup title="When you read Changes" icon={FileDiff} note="How Changes first opens. A choice made in Changes lasts until you change one of these or restart Sotto.">
      <Field label="Diff layout" description={says.layout}>
        <SegmentedControl label="Diff layout" value={settings.diffLayout} onChange={value => void onSave({ diffLayout: value as DiffLayout })} options={[{ value: 'stacked', label: 'Stacked' }, { value: 'split', label: 'Split' }]} />
      </Field>
      <Toggle label="Hide whitespace changes" checked={settings.diffHideWhitespace} onCheckedChange={checked => void onSave({ diffHideWhitespace: checked })} description={says.whitespace} />
      <Field label="Default diff file state" description={says.fileState}>
        <SegmentedControl label="Default diff file state" value={settings.diffFileState} onChange={value => void onSave({ diffFileState: value as DiffFileState })} options={[{ value: 'expanded', label: 'Expanded' }, { value: 'collapsed', label: 'Collapsed' }]} />
      </Field>
      <Toggle label="Proactive panels" checked={settings.proactivePanels} onCheckedChange={checked => void onSave({ proactivePanels: checked })} description={says.proactive} />
    </SettingsGroup>
    <SettingsGroup title="In the background" icon={RefreshCw}>
      <Field label="Git fetch interval" description={says.fetch}>
        <Select value={String(settings.gitFetchIntervalSeconds)} onChange={event => void onSave({ gitFetchIntervalSeconds: Number(event.currentTarget.value) as GitFetchIntervalSeconds })}>
          {GIT_FETCH_INTERVAL_SECONDS.map(seconds => <option key={seconds} value={String(seconds)}>{fetchIntervalLabel(seconds)}</option>)}
        </Select>
      </Field>
      <Toggle label="Automatically pull" checked={settings.gitAutoPull} onCheckedChange={checked => void onSave({ gitAutoPull: checked })} description={says.autoPull} />
      {keepMain ? <Toggle label="Keep main up to date" checked={settings.keepMainCurrent} onCheckedChange={checked => void onSave({ keepMainCurrent: checked })} description={says.keepMain} /> : null}
    </SettingsGroup>
  </div>
}
