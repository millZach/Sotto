import React, { useState, type ReactNode } from 'react'
import { ChartColumn } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { Toggle } from '../../components/Toggle'
import { ProductEventsDialog } from '../productEvents/ProductEventsDialog'
import { useProductEventsState } from '../productEvents/useProductEventsState'
import { SettingsGroup } from './SettingsGroup'
import '../productEvents/productEvents.css'

/** Settings > Application > Product events (ADR-0179): one switch, with every event a press away. The environment outranks it. */
export function ProductEventsSettings({ settings, onSave }: {
  readonly settings: Pick<AppSettings, 'productEventsEnabled'>
  readonly onSave: (patch: SettingsPatch) => unknown
}): ReactNode {
  const { t } = useLingui()
  const offBy = useProductEventsState()?.offBy ?? null
  const [listOpen, setListOpen] = useState(false)
  return <SettingsGroup id="settings-product-events" title={t({ message: 'Product events', comment: 'A group on Settings > Application. A product event is one fact about how Sotto is used, sent to its developers.' })} icon={ChartColumn}>
    <Toggle setting="product-events" label={t`Send product events`} checked={offBy === null && settings.productEventsEnabled} disabled={offBy !== null} onCheckedChange={checked => void onSave({ productEventsEnabled: checked })}
      description={t`Sends Sotto’s developers which features you use, which provider and public model ran, how each turn ended, how long it took and its token counts. Events carry a random ID for this install and hashed IDs of your Claude and OpenAI accounts. Hashed is not anonymous: those IDs link your computers to one person. It never sends your words, code, file names, paths, repo or branch names, thread IDs or keys. Off stops this computer and its hosts, and drops anything waiting to go.`} />
    <div className="product-events-row">
      {offBy === 'SOTTO_TELEMETRY_ENABLED' ? <p className="product-events-row__locked tt-paragraph"><Trans>Off on this computer because SOTTO_TELEMETRY_ENABLED is set to false.</Trans></p> : null}
      {offBy === 'DO_NOT_TRACK' ? <p className="product-events-row__locked tt-paragraph"><Trans>Off on this computer because DO_NOT_TRACK is set.</Trans></p> : null}
      <button type="button" className="product-events-link tt-focusable" onClick={() => setListOpen(true)}><Trans>See every event</Trans></button>
    </div>
    {listOpen ? <ProductEventsDialog onClose={() => setListOpen(false)} /> : null}
  </SettingsGroup>
}
