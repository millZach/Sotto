import React, { useEffect, useState, type ReactNode } from 'react'
import {
  DEFAULT_MERGE_METHODS, GIT_MERGE_METHOD_LABELS, GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS, GIT_WRITING_STYLES,
  type AppSettings, type DefaultMergeMethod, type DiffFileState, type DiffLayout, type GitWritingStyle, type SettingsPatch,
} from '../../../../shared/settings'
import { Field } from '../../components/Field'
import { SegmentedControl } from '../../components/SegmentedControl'
import { Select } from '../../components/Select'
import { Toggle } from '../../components/Toggle'

interface GitSettingsProps {
  readonly settings: AppSettings
  readonly onSave: (patch: SettingsPatch, successText?: string) => Promise<boolean>
}

const WRITING_STYLE_LABELS: Record<GitWritingStyle, string> = { repository: 'Repository conventions', conventional: 'Conventional Commits', custom: 'Custom instructions' }
const mergeMethodLabel = (method: DefaultMergeMethod): string => method === 'last' ? 'Last selected' : GIT_MERGE_METHOD_LABELS[method]

/** How commit messages and pull request text are written, under Cleanup beside the switches that turn them on. */
export function GitWritingSettings({ settings, onSave }: GitSettingsProps): ReactNode {
  const [instructions, setInstructions] = useState(settings.gitWritingInstructions)
  useEffect(() => { setInstructions(settings.gitWritingInstructions) }, [settings.gitWritingInstructions])
  return <>
    <Field label="Commit and pull request style" description="How generated commit messages and pull request text are written. Repository conventions follows the repository's recent commits and its AGENTS.md.">
      <Select value={settings.gitWritingStyle} onChange={event => void onSave({ gitWritingStyle: event.currentTarget.value as GitWritingStyle })}>
        {GIT_WRITING_STYLES.map(style => <option key={style} value={style}>{WRITING_STYLE_LABELS[style]}</option>)}
      </Select>
    </Field>
    {settings.gitWritingStyle !== 'custom' ? null : <div className="settings-input-action">
      <Field label="Custom instructions" description={`Sent to the thread's own model with every commit message and pull request draft, in place of the repository's style. Up to ${GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS.toLocaleString('en-US')} characters.`}>
        <textarea className="tt-input" rows={4} maxLength={GIT_WRITING_INSTRUCTIONS_MAX_CHARACTERS} value={instructions}
          onChange={event => setInstructions(event.currentTarget.value)}
          onBlur={() => { if (instructions !== settings.gitWritingInstructions) void onSave({ gitWritingInstructions: instructions }, 'Instructions saved.') }} />
      </Field>
    </div>}
    <Toggle label="Follow pull request templates" checked={settings.followPullRequestTemplates} onCheckedChange={checked => void onSave({ followPullRequestTemplates: checked })} description="Fill in the repository's pull request template when it has one. Off, the template is not read and the draft uses Sotto's own sections." />
  </>
}

/** What Git does on its own and how Changes starts, under Application beside the fetch interval and the worktree rules. */
export function GitBehaviourSettings({ settings, onSave }: GitSettingsProps): ReactNode {
  return <>
    <Toggle label="Automatically pull" checked={settings.gitAutoPull} onCheckedChange={checked => void onSave({ gitAutoPull: checked })} description="When a thread's folder is on the default branch, has no changes and is only behind its remote, pull it each time Sotto checks the remote. The pull is fast-forward only; nothing is merged or rebased." />
    <Field label="Default merge method" description="The method a pull request's merge starts on. Last selected starts on the one you used last.">
      <Select value={settings.defaultMergeMethod} onChange={event => void onSave({ defaultMergeMethod: event.currentTarget.value as DefaultMergeMethod })}>
        {DEFAULT_MERGE_METHODS.map(method => <option key={method} value={method}>{mergeMethodLabel(method)}</option>)}
      </Select>
    </Field>
    <Field label="Diff layout" description="How Changes shows a file's diff until you change it there.">
      <SegmentedControl label="Diff layout" value={settings.diffLayout} onChange={value => void onSave({ diffLayout: value as DiffLayout })} options={[{ value: 'stacked', label: 'Stacked' }, { value: 'split', label: 'Split' }]} />
    </Field>
    <Toggle label="Hide whitespace changes" checked={settings.diffHideWhitespace} onCheckedChange={checked => void onSave({ diffHideWhitespace: checked })} description="Changes starts with edits that only change spacing hidden." />
    <Field label="Default diff file state" description="Whether each file in Changes starts expanded or collapsed to its name.">
      <SegmentedControl label="Default diff file state" value={settings.diffFileState} onChange={value => void onSave({ diffFileState: value as DiffFileState })} options={[{ value: 'expanded', label: 'Expanded' }, { value: 'collapsed', label: 'Collapsed' }]} />
    </Field>
    <Toggle label="Auto-settle merged threads" checked={settings.autoSettleMergedThreads} onCheckedChange={checked => void onSave({ autoSettleMergedThreads: checked })} description="Settle a thread once its branch's pull request is merged. Asks GitHub through gh once an hour, the way the merged worktree rule does. Settling removes no folder unless a worktree rule above says so." />
    <Toggle label="Proactive panels" checked={settings.proactivePanels} onCheckedChange={checked => void onSave({ proactivePanels: checked })} description="Open Changes on its own after a turn that changed at least 3 files or 50 lines, when the Tools panel is closed." />
  </>
}
