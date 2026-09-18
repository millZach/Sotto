import { useCallback, useEffect, useRef, useState } from 'react'

import type { UpdateStatus } from '../../../../shared/contracts'
import { UPDATES_UNSUPPORTED_MESSAGE, updateProblem, type UpdateAction } from './updateControlLogic'

export interface UpdateNotice {
  readonly tone: 'success' | 'error'
  readonly title: string
  readonly detail: string | null
  /** When set, the notice can point at this version's release page. */
  readonly version?: string
}

export interface UpdateFlowOptions {
  readonly status: UpdateStatus | null
  /** Counts the application menu's "Check for Updates…" presses; each one runs a check here. */
  readonly checkRequest: number
  readonly check: () => Promise<UpdateStatus | null>
  readonly download: () => Promise<boolean>
  readonly install: () => Promise<boolean>
  readonly notify: (notice: UpdateNotice) => void
}

export interface UpdateFlow {
  readonly busy: boolean
  /** The version waiting on the restart confirmation, or null while nothing is asked. */
  readonly pendingInstall: string | null
  /** A press of the update control: the same three verbs Settings offers as buttons. */
  readonly activate: (action: Exclude<UpdateAction, 'none'>) => void
  /** Runs a check and says how it went; null while another press is still being answered. */
  readonly check: () => Promise<UpdateStatus | null>
  /** Downloads the offered release and says how it went; false while another press is still being answered. */
  readonly download: () => Promise<boolean>
  readonly confirmInstall: () => Promise<boolean>
  readonly cancelInstall: () => void
}

/**
 * What a press of the update control sets in motion, and what the window says
 * about it afterwards. Every outcome the user asked for gets one sentence: a
 * download that lands, and any check, download, or install that could not be
 * completed. Automatic checks stay silent; their result is the control itself.
 * Settings' update buttons run through the same flow, so both places share one
 * busy state and one set of toasts.
 */
export function useUpdateFlow({ status, checkRequest, check, download, install, notify }: UpdateFlowOptions): UpdateFlow {
  const [busy, setBusy] = useState(false)
  const [pendingInstall, setPendingInstall] = useState<string | null>(null)
  const statusRef = useRef(status)
  statusRef.current = status
  const busyRef = useRef(false)

  /** One press at a time; a press that lands while another is answered is dropped and answers `null`. */
  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | null> => {
    if (busyRef.current) return null
    busyRef.current = true
    setBusy(true)
    try {
      return await operation()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  const runCheck = useCallback(() => run(async () => {
    const result = await check()
    if (result === null || result.phase.phase === 'unsupported') {
      notify({ tone: 'error', title: 'Could not check for updates', detail: UPDATES_UNSUPPORTED_MESSAGE })
    } else if (result.phase.phase === 'failed') {
      notify({ tone: 'error', title: 'Could not check for updates', detail: result.phase.problem })
    }
    return result
  }), [check, notify, run])

  const runDownload = useCallback(async (): Promise<boolean> => (await run(async () => {
    const version = statusRef.current?.phase.phase === 'available' ? statusRef.current.phase.version : null
    const ok = await download()
    if (ok) {
      notify({ tone: 'success', title: 'Update downloaded', detail: 'Restart Sotto from the update control to install it.', ...(version === null ? {} : { version }) })
    } else {
      notify({ tone: 'error', title: 'Could not download update', detail: updateProblem(statusRef.current) })
    }
    return ok
  })) ?? false, [download, notify, run])

  const activate = useCallback((action: Exclude<UpdateAction, 'none'>): void => {
    if (action === 'check') void runCheck()
    else if (action === 'download') void runDownload()
    else if (statusRef.current?.phase.phase === 'downloaded') setPendingInstall(statusRef.current.phase.version)
  }, [runCheck, runDownload])

  const confirmInstall = useCallback(async (): Promise<boolean> => (await run(async () => {
    const ok = await install()
    if (!ok) notify({ tone: 'error', title: 'Could not install update', detail: updateProblem(statusRef.current) })
    return ok
  })) ?? false, [install, notify, run])

  const cancelInstall = useCallback((): void => setPendingInstall(null), [])

  // The menu item is the same press as the control, made from outside the window.
  const runCheckRef = useRef(runCheck)
  runCheckRef.current = runCheck
  useEffect(() => {
    if (checkRequest > 0) void runCheckRef.current()
  }, [checkRequest])

  return { busy, pendingInstall, activate, check: runCheck, download: runDownload, confirmInstall, cancelInstall }
}
