import React, { useCallback, type ReactNode } from 'react'
import { FileText, FolderOpen, Paperclip } from 'lucide-react'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import { blockedPercent, freezeLength, type ActivityRecordingState, type MainLoopReading } from '../../../../shared/mainActivity'
import { useOptionalAgents } from '../../agents/AgentContext'
import { Button } from '../../components/Button'
import { useOptionalApp } from '../../state/AppContext'
import { shownCount } from '../../state/interfaceNumbers'
import './mainActivity.css'
import { attachRecordingToNewThread, recordingSize, useAttachedRecording, useSecondsLeft } from './useMainActivity'

/** What Record a minute saves and where, in the words the mock-up settled on. */
export const RECORDING_PRIVACY = msg`Record a minute saves the function names and timings of main and the window on this computer. No sound, nothing you dictated or typed, and nothing leaves this computer.`
export const CHART_CAPTION = msg`Each bar is one second of the last minute; taller means main was blocked longer.`
/** A second this blocked or more is drawn in the warning colour. */
const WARN_BAR_MS = 500

export function LoopFigures({ reading }: { readonly reading: MainLoopReading }): ReactNode {
  const warn = reading.frozen ? '' : undefined
  return <div className="main-activity__figures">
    <div className="main-activity__figure" data-warn={warn}><b>{blockedPercent(reading.blockedShare)}</b><span><Trans>blocked</Trans></span></div>
    <div className="main-activity__figure" data-warn={warn}><b>{freezeLength(reading.longestFreezeMs)}</b><span><Trans>longest freeze</Trans></span></div>
    <div className="main-activity__figure"><b>{reading.freezesOver100ms}</b><span><Trans>freezes over 100 ms</Trans></span></div>
  </div>
}

export function LoopChart({ reading }: { readonly reading: MainLoopReading }): ReactNode {
  const { t, i18n } = useLingui()
  const width = 10, height = 44
  const blocked = blockedPercent(reading.blockedShare)
  const longest = freezeLength(reading.longestFreezeMs)
  return <figure className="main-activity__chart-figure">
    <svg className="main-activity__chart" viewBox={`0 0 ${reading.bars.length * width} ${height}`} preserveAspectRatio="none" role="img"
      aria-label={t`Main was blocked ${blocked} of the last minute; the longest freeze was ${longest}.`}>
      {reading.bars.map((blocked, index) => {
        const tall = Math.max(2, blocked / 1_000 * height)
        return <rect key={index} x={index * width + 1} y={height - tall} width={width - 2} height={tall} rx={1.5} data-warn={blocked >= WARN_BAR_MS ? '' : undefined} />
      })}
    </svg>
    <figcaption className="main-activity__caption">{i18n._(CHART_CAPTION)}</figcaption>
  </figure>
}

/** The countdown while a recording runs. */
export function RecordingCountdown({ recording }: { readonly recording: Extract<ActivityRecordingState, { phase: 'recording' }> }): ReactNode {
  const { t } = useLingui()
  const total = Math.max(1, Math.round(recording.durationMs / 1_000))
  const left = useSecondsLeft(recording.startedAt, recording.durationMs)
  return <div className="main-activity__recording">
    <div className="main-activity__count" aria-hidden="true">{left} s</div>
    <div className="main-activity__progress" role="progressbar" aria-label={t`Recording`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={total - left}
      aria-valuetext={t`${left} seconds left`} style={{ '--main-activity-progress': (total - left) / total } as React.CSSProperties}><i /></div>
    <p className="main-activity__muted tt-paragraph"><Trans>Recording main and the window. Keep using Sotto as you were, so the minute catches the slowness.</Trans></p>
  </div>
}

/** Seconds left, for the notice's own words. */
export function useRecordingSecondsLeft(recording: ActivityRecordingState): number {
  const running = recording.phase === 'recording'
  return useSecondsLeft(running ? recording.startedAt : null, running ? recording.durationMs : 0)
}

/** Attach to a thread, from wherever the recording shows. */
function useAttach(recording: Extract<ActivityRecordingState, { phase: 'saved' }>, after?: () => void): () => void {
  const agents = useOptionalAgents()
  const navigate = useOptionalApp()?.actions.navigate
  return useCallback(() => {
    const state = agents?.state ?? null
    const active = state?.host.projects.find(project => project.id === state.activeProjectId)
    // A project with no host, or on the connection that is this computer, can read the files where they are.
    const local = active !== undefined && (active.hostId === undefined || state?.connections?.find(connection => connection.hostId === active.hostId)?.kind === 'local')
    attachRecordingToNewThread(recording, local ? active.id : undefined, () => navigate?.('threads'))
    after?.()
  }, [agents, navigate, recording, after])
}

/** A saved recording: its name and size, and what to do with it. `extra` is the surface's own last action. */
export function SavedRecording({ recording, onShowInFolder, onAttached, extra }: {
  readonly recording: Extract<ActivityRecordingState, { phase: 'saved' }>
  readonly onShowInFolder: () => void
  readonly onAttached?: () => void
  readonly extra?: ReactNode
}): ReactNode {
  const attached = useAttachedRecording() === recording.name
  const attach = useAttach(recording, onAttached)
  const { t } = useLingui()
  const files = recording.files.length
  const size = recordingSize(recording.bytes), fileCount = shownCount(files)
  return <div className="main-activity__saved">
    <div className="main-activity__file"><FileText size={16} aria-hidden="true" /><span>{recording.name}</span><small>{plural(files, { one: `${fileCount} file, ${size}`, other: `${fileCount} files, ${size}` })}</small></div>
    {attached
      ? <p className="main-activity__done tt-paragraph" role="status"><Trans>Added to a new thread's composer. It is sent when you send.</Trans></p>
      : <p className="main-activity__muted tt-paragraph">{recording.windowRecorded
        ? t`Saved on this computer, in Sotto's activity recordings folder.`
        : t`Saved on this computer, in Sotto's activity recordings folder. Only main was recorded; the window could not be.`}</p>}
    <div className="main-activity__actions">
      {attached ? null : <Button variant="primary" onClick={attach}><Paperclip size={14} aria-hidden="true" /><Trans>Attach to a thread</Trans></Button>}
      <Button variant="secondary" onClick={onShowInFolder}><FolderOpen size={14} aria-hidden="true" /><Trans>Show in folder</Trans></Button>
      {extra}
    </div>
  </div>
}
