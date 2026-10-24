import React, { type ReactNode } from 'react'

import { blockedPercent, freezeLength, type MainActivityBridge } from '../../../../shared/mainActivity'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Toggle } from '../../components/Toggle'
import { LoopChart, LoopFigures, RECORDING_PRIVACY, RecordingCountdown, SavedRecording } from './MainActivityParts'
import { useMainActivity, useMainActivityCommand } from './useMainActivity'

/**
 * Settings > Performance (#1233): main's numbers for the last minute, Record a minute, and the switch for the notice.
 * Part of the `main-freeze` Owl feature; Settings lists the section only while the feature is on. The numbers are read
 * once a second only while the section is the one showing.
 */
export function PerformanceSettings({ visible, settings, onUpdateSettings, bridge = window.sotto?.mainActivity }: {
  readonly visible: boolean
  readonly bridge?: MainActivityBridge | undefined
  readonly settings: AppSettings
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
}): ReactNode {
  const state = useMainActivity(visible, bridge)
  const command = useMainActivityCommand(bridge)
  if (state === null) return <p className="main-activity__muted">Reading main's numbers…</p>
  const { reading, recording } = state
  const status = reading.frozen
    ? `Main was blocked ${blockedPercent(reading.blockedShare)} of the last minute. The longest freeze was ${freezeLength(reading.longestFreezeMs)}. Threads, typing and the window may lag until it recovers.`
    : `Main is keeping up. It was blocked ${blockedPercent(reading.blockedShare)} of the last minute, and the longest freeze was ${freezeLength(reading.longestFreezeMs)}.`
  let control: ReactNode, wide: ReactNode = null
  if (recording.phase === 'recording') {
    control = <Button variant="secondary" onClick={() => void command({ type: 'discard' })}>Stop without saving</Button>
    wide = <RecordingCountdown recording={recording} />
  } else if (recording.phase === 'saved') {
    control = <Button variant="ghost" onClick={() => void command({ type: 'record' })}>Record another minute</Button>
    wide = <SavedRecording recording={recording} onShowInFolder={() => void command({ type: 'show-in-folder' })} />
  } else {
    control = <Button variant="secondary" onClick={() => void command({ type: 'record' })}>{recording.phase === 'failed' ? 'Record a minute again' : 'Record a minute'}</Button>
    if (recording.phase === 'failed') wide = <p className="main-activity__failure" role="alert">{recording.message}</p>
  }
  return <div className="settings-rows main-activity">
    <div className="main-activity__row">
      <h3 className="main-activity__label">Main process, last minute</h3>
      <p className="main-activity__status" data-warn={reading.frozen ? '' : undefined} aria-live="polite">{status}</p>
      <LoopFigures reading={reading} />
      <LoopChart reading={reading} />
    </div>
    <div className="main-activity__row">
      <div className="main-activity__grid">
        <div><h3 className="main-activity__label">Record a minute of activity</h3><p className="main-activity__muted">{RECORDING_PRIVACY}</p></div>
        {control}
      </div>
      {wide}
    </div>
    <Toggle setting="main-freeze-notice" label="Tell me when main freezes" checked={settings.mainFreezeNotice} onCheckedChange={checked => void onUpdateSettings({ mainFreezeNotice: checked })}
      description="Shows a notice in the window's top row while main is blocked for more than half of the last minute." />
  </div>
}
