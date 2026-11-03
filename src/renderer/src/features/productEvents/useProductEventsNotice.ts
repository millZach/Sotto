import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { useProductEventsState } from './useProductEventsState'

const OFF_MESSAGE_MS = 6_000

export interface ProductEventsNoticeControl {
  /** The switch is on, this build can send, and neither a press nor Escape has answered yet. */
  readonly open: boolean
  /** Saves the press. False leaves the notice up, since nothing was saved. */
  answer(turnOff: boolean): Promise<boolean>
  /** Escape: until the next start, with nothing saved and nothing sent. */
  putOff(): void
  /** "Turn off" was pressed a moment ago, which the corner says once. */
  readonly turnedOff: boolean
  clearTurnedOff(): void
}

/** The one-time notice's state (ADR-0179). Turning the switch off in Settings takes an unanswered notice down, and turning it back on asks again. Once answered it never asks: the switch alone decides, until Reset settings. */
export function useProductEventsNotice(settings: Pick<AppSettings, 'productEventsEnabled' | 'productEventsNoticeAnswered'> | null, save: (patch: SettingsPatch) => Promise<boolean>): ProductEventsNoticeControl {
  const state = useProductEventsState()
  const [putOff, setPutOff] = useState(false)
  const [turnedOff, setTurnedOff] = useState(false)
  const clearTurnedOff = useCallback(() => setTurnedOff(false), [])
  useEffect(() => {
    if (!turnedOff) return
    const timer = setTimeout(clearTurnedOff, OFF_MESSAGE_MS)
    return () => clearTimeout(timer)
  }, [turnedOff, clearTurnedOff])
  const answer = useCallback(async (turnOff: boolean): Promise<boolean> => {
    const saved = await save(turnOff ? { productEventsEnabled: false, productEventsNoticeAnswered: true } : { productEventsNoticeAnswered: true }).catch(() => false)
    if (saved && turnOff) setTurnedOff(true)
    return saved
  }, [save])
  return {
    open: state?.canSend === true && settings !== null && settings.productEventsEnabled && !settings.productEventsNoticeAnswered && !putOff,
    answer, putOff: useCallback(() => setPutOff(true), []), turnedOff, clearTurnedOff,
  }
}
