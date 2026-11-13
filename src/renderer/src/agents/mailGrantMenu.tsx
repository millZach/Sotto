import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Hand } from 'lucide-react'
import type { PluginsBridge, ThreadMailGrant } from '../../../shared/plugins'
import { useOwlFeature } from '../state/owlFeature'
import type { PaneMenuItem } from './PaneMenu'

/**
 * A thread's mail grants in its ··· menu (ADR-0205, decision 8; Zach's pick B of the tag
 * `prototype/plugin-mail-grants`, November 13, 2026): for each mail account the thread has been let read, **Ask
 * before this thread reads** it, which ends the grant so the thread asks again. The row is there only while the
 * thread can read the account, as the browser's own row is, and only for a thread on this computer: a thread on a
 * paired host keeps its grant on that host.
 *
 * `problem` says so when a grant could not be ended. It then still stands.
 */
export function useMailGrantMenu(threadId: string, here: boolean, bridge: PluginsBridge | undefined = window.sotto?.plugins): { readonly items: PaneMenuItem[]; readonly problem: string | null } {
  const { t } = useLingui()
  const on = useOwlFeature('plugins') && here && bridge !== undefined
  const [grants, setGrants] = useState<readonly ThreadMailGrant[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  // Only the newest read's answer is shown, and none after the pane has gone to another thread.
  const asked = useRef(0)
  const read = useCallback((): void => {
    if (!on || !bridge) return
    const mine = ++asked.current
    void bridge.mailGrants(threadId).then(value => { if (asked.current === mine) setGrants(value) }, () => { if (asked.current === mine) setGrants([]) })
  }, [on, bridge, threadId])
  useEffect(() => {
    setGrants([]); setProblem(null)
    if (!on || !bridge) return
    read()
    // Main says only that some grant changed; the menu reads this thread's again.
    const off = bridge.onMailGrantsChanged(read)
    return () => { asked.current += 1; off() }
  }, [on, bridge, read])
  const stop = (grant: ThreadMailGrant): void => {
    if (!bridge) return
    const name = grant.name
    setProblem(null)
    const failed = (): void => { setProblem(t`Sotto could not stop this thread reading ${name}, so it can still read it. Try again.`) }
    void bridge.stopMailGrant({ threadId, accountId: grant.accountId }).then(stopped => { if (stopped) read(); else failed() }, failed)
  }
  const items = !on ? [] : grants.map((grant): PaneMenuItem => {
    const name = grant.name
    return { id: `mail-grant-${grant.accountId}`, label: t`Ask before this thread reads ${name}`, icon: <Hand size={15} aria-hidden="true" />, run: () => stop(grant) }
  })
  return { items, problem }
}
