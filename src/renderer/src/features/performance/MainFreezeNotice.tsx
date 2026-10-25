import React, { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { useMark } from '../../components/marks'
import { FileText } from 'lucide-react'

import { blockedPercent, freezeLength, mainFreezeNoticeVisible, type MainActivityBridge, type MainActivityState } from '../../../../shared/mainActivity'
import { Button } from '../../components/Button'
import { useOptionalApp } from '../../state/AppContext'
import { useOwlFeature } from '../../state/owlFeature'
import { LoopChart, LoopFigures, RECORDING_PRIVACY, RecordingCountdown, SavedRecording, useRecordingSecondsLeft } from './MainActivityParts'
import { useMainActivity, useMainActivityCommand } from './useMainActivity'

/**
 * The main freeze notice (#1233, variant A of the mock-up): a pill in the title row, left of the window controls, while
 * main is frozen, while a recording runs, or while a saved recording waits. It opens a popover with the numbers, the
 * minute's chart, Record a minute and Not now; Escape, a press outside or Tab out of it closes it. An Owl feature: stable has no bridge
 * and this renders nothing.
 */
export function MainFreezeNotice({ bridge = window.sotto?.mainActivity, frame }: {
  readonly bridge?: MainActivityBridge | undefined
  /** A class for a box drawn around the notice only while it shows, where no window controls stand beside it. */
  readonly frame?: string | undefined
}): ReactNode {
  const enabled = useOwlFeature('main-freeze')
  if (!enabled || !bridge) return null
  return <MainFreezeNoticeView bridge={bridge} frame={frame} />
}

function MainFreezeNoticeView({ bridge, frame }: { readonly bridge: MainActivityBridge; readonly frame: string | undefined }): ReactNode {
  const [open, setOpen] = useState(false)
  const state = useMainActivity(open, bridge)
  const noticeSetting = useOptionalApp()?.settings?.mainFreezeNotice ?? true
  const visible = mainFreezeNoticeVisible(state, noticeSetting)
  useMark('main-freeze', visible && state !== null)
  // Nothing left to show: the popover goes with the pill.
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  if (!visible || state === null) return null
  const notice = <NoticeBody bridge={bridge} state={state} open={open} setOpen={setOpen} />
  return frame ? <div className={frame}>{notice}</div> : notice
}

function NoticeBody({ bridge, state, open, setOpen }: { readonly bridge: MainActivityBridge; readonly state: MainActivityState; readonly open: boolean; readonly setOpen: (open: boolean) => void }): ReactNode {
  const command = useMainActivityCommand(bridge)
  const container = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const panelId = useId()
  const { reading, recording } = state
  const left = useRecordingSecondsLeft(recording)

  // A press anywhere else closes the popover and leaves focus where the press put it.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open, setOpen])
  // Opening moves focus into the popover, to its heading, so a screen reader starts with what it says.
  useEffect(() => { if (open) heading.current?.focus() }, [open, recording.phase])

  const close = (): void => { setOpen(false); pill.current?.focus() }
  // Escape closes it wherever focus is while it is open. Focus inside the notice, or lost with nothing focused, goes back
  // to the pill; focus somewhere else stays where it is.
  useEffect(() => {
    if (!open) return
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      const focused = document.activeElement
      setOpen(false)
      if (focused === null || focused === document.body || container.current?.contains(focused)) pill.current?.focus()
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [open, setOpen])
  // Tab out of the notice closes the popover, as Sotto's other menus do. Focus lost to nothing (a control that went
  // away as the popover changed, or the window losing focus) leaves it open.
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null
    if (open && next !== null && !event.currentTarget.contains(next)) setOpen(false)
  }
  const send = (type: 'record' | 'discard' | 'not-now' | 'close' | 'show-in-folder'): void => { void command({ type }) }

  let text: string, label: string, tone: 'warn' | 'quiet' = 'quiet'
  if (recording.phase === 'recording') { text = `Recording, ${left} s`; label = `Recording a minute, ${left} seconds left. ${open ? 'Hide' : 'Show'} the recording` }
  else if (recording.phase === 'saved') { text = 'Recording saved'; label = `Activity recording saved. ${open ? 'Hide' : 'Show'} it` }
  else if (recording.phase === 'failed') { text = 'Recording not saved'; label = `The activity recording was not saved. ${open ? 'Hide' : 'Show'} why` }
  else { text = 'Main is slow'; tone = 'warn'; label = `Main is slow: blocked ${blockedPercent(reading.blockedShare)} of the last minute. ${open ? 'Hide' : 'Show'} details` }

  let body: ReactNode
  if (recording.phase === 'recording') {
    body = <>
      <h2 ref={heading} tabIndex={-1}>Recording a minute</h2>
      <RecordingCountdown recording={recording} />
      <div className="main-activity__actions"><Button variant="secondary" onClick={() => { send('discard'); close() }}>Stop without saving</Button></div>
    </>
  } else if (recording.phase === 'saved') {
    body = <>
      <h2 ref={heading} tabIndex={-1}>Activity recording saved</h2>
      <SavedRecording recording={recording} onShowInFolder={() => send('show-in-folder')} onAttached={() => setOpen(false)}
        extra={<Button variant="ghost" aria-label="Close: the recording stays in its folder" onClick={() => { send('close'); setOpen(false) }}>Close</Button>} />
    </>
  } else if (recording.phase === 'failed') {
    body = <>
      <h2 ref={heading} tabIndex={-1}>Recording not saved</h2>
      <p>{recording.message}</p>
      <div className="main-activity__actions">
        <Button variant="primary" onClick={() => send('record')}>Record a minute</Button>
        <Button variant="ghost" onClick={() => { send('close'); setOpen(false) }}>Close</Button>
      </div>
    </>
  } else {
    body = <>
      <h2 ref={heading} tabIndex={-1}>Sotto's main process is slow</h2>
      <p>It was blocked {blockedPercent(reading.blockedShare)} of the last minute. The longest freeze was {freezeLength(reading.longestFreezeMs)}. Threads, typing and the window may lag until it recovers.</p>
      <LoopFigures reading={reading} />
      <LoopChart reading={reading} />
      <p className="main-activity__privacy">{RECORDING_PRIVACY}</p>
      <div className="main-activity__actions">
        <Button variant="primary" onClick={() => send('record')}>Record a minute</Button>
        <Button variant="ghost" aria-label="Not now: hide this until main recovers and freezes again" onClick={() => { send('not-now'); setOpen(false) }}>Not now</Button>
      </div>
    </>
  }

  return <div ref={container} className="main-freeze" onBlur={onBlur}>
    <button ref={pill} type="button" className="main-freeze__pill tt-focusable" data-tone={tone} aria-expanded={open} aria-haspopup="dialog"
      aria-controls={open ? panelId : undefined} aria-label={label} onClick={() => setOpen(!open)}>
      {recording.phase === 'recording'
        ? <span className="main-freeze__ring" aria-hidden="true" style={{ '--main-activity-progress': 1 - left / Math.max(1, recording.durationMs / 1_000) } as React.CSSProperties} />
        : recording.phase === 'idle' ? <span className="main-freeze__dot" aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
      <span>{text}</span>
    </button>
    {open ? <div id={panelId} className="main-freeze__popover main-activity" role="dialog" aria-label="Main process">{body}</div> : null}
  </div>
}
