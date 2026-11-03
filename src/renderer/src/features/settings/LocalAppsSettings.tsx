import React, { useEffect, useState, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { LocalAppsBridge, LocalAppsState } from '../../../../shared/localApps'
import type { SettingsPatch } from '../../../../shared/settings'
import { Toggle } from '../../components/Toggle'
import './hosts.css'
import './phones.css'

/** Let apps on this computer connect (ADR-0180), below Phones on Settings > Hosts & phones; shown only on Owl. */
export function LocalAppsSettings({ localApps, onUpdateSettings, bridge = window.sotto?.localApps }: {
  readonly localApps: boolean
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly bridge?: LocalAppsBridge | undefined
}): ReactNode {
  const { t } = useLingui()
  const [state, setState] = useState<LocalAppsState | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.get().then(value => { if (alive) setState(value) }).catch(() => undefined)
    const off = bridge.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; off() }
  }, [bridge])
  const localHostRunning = state?.localHostRunning ?? true
  return <div className="hosts-settings">
    <div className="hosts-card">
      <div className="phones-switch">
        <Toggle setting="local-apps" label={t`Let apps on this computer connect`} checked={localApps} disabled={!bridge || (!localHostRunning && !localApps)}
          onCheckedChange={enabled => { void onUpdateSettings({ localApps: enabled }).then(saved => setSaveFailed(!saved)) }}
          description={t`Apps on this computer can read and send to your threads and Watcher, and answer questions and permissions, without a pairing code.`} />
        {!localHostRunning ? <p className="tt-paragraph"><Trans>Needs the local host. Turn on Run the local host above, then restart Sotto.</Trans></p> : null}
        {saveFailed ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>The setting could not be saved. Nothing was changed. Try again.</Trans></p> : null}
        {localApps && state?.phase === 'failed' ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>Apps on this computer can’t connect. Sotto couldn’t open their listener or save their files in its data folder. Turn this off and on again, or restart Sotto.</Trans></p> : null}
      </div>
    </div>
  </div>
}
