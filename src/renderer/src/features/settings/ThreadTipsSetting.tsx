import React, { type ReactNode } from 'react'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { SettingsPatch } from '../../../../shared/settings'
import { tipsSetAside, useTipsSetAside, type TipsSetAsideStore } from '../../agents/tipsSetAside'
import { Button } from '../../components/Button'
import { Toggle } from '../../components/Toggle'
import { shownCount } from '../../state/interfaceNumbers'
import './threadTips.css'

/**
 * Settings › Threads › In a thread, Show tips while threads work (ADR-0159; Owl only), with Show hidden tips again under
 * it (Zach's pick, October 28, 2026). Hidden and used tips are kept on this computer, so the button clears them here.
 */
export function ThreadTipsSetting({ checked, onSave, store = tipsSetAside }: {
  readonly checked: boolean
  readonly onSave: (patch: SettingsPatch) => unknown
  readonly store?: TipsSetAsideStore
}): ReactNode {
  const { t } = useLingui()
  const count = useTipsSetAside(store).size
  return <div className="thread-tips-setting">
    <Toggle setting="thread-tips" label={t`Show tips while threads work`} checked={checked} onCheckedChange={next => void onSave({ threadTips: next })}
      description={checked
        ? t`One short tip under a working thread, and under Watcher while it works, about Sotto and the thread’s provider. A tip you hide or use does not come back.`
        : t`No tips under a working thread or Watcher.`} />
    <p className="thread-tips-setting__again tt-paragraph">
      <Button variant="secondary" disabled={count === 0} onClick={() => store.clear()}><Trans>Show hidden tips again</Trans></Button>
      <span>{count === 0 ? t`No tips are hidden.` : plural(count, { one: `${{ tips: shownCount(count) }} tip hidden or used.`, other: `${{ tips: shownCount(count) }} tips hidden or used.` })}</span>
    </p>
  </div>
}
